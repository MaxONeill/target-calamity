/**
 * Draining the submission queue — the deliberate, observed half of the flow.
 *
 * `POST /api/factors/submit` does nothing that costs money (migration 019). It
 * runs the free checks, applies the deterministic noise heuristic, and writes a
 * `queued` row. Everything expensive lives here:
 *
 *   1. LIVE noise classification   one constrained model call per row
 *   2. The ingestion pipeline      retrieval + extraction + embeddings + write
 *
 * NOT REACHABLE OVER HTTP, BY CONSTRUCTION. Nothing in `server/routes/` imports
 * this module, and it registers no Fastify route. It is a process you start:
 *
 *   npm run submissions:drain -- --limit 5
 *
 * That is the same shape as every other paid job in this repo (`ingest:once`,
 * `backfill:*`, `research:*`) and it is the point — the operator, not a
 * submitter, decides when money is spent. See the README section this script's
 * `--help` mirrors for how to point it at production.
 *
 * WHY THE HEURISTIC RUNS AGAIN HERE. The submit-time heuristic is triage, not a
 * judgement: it is biased toward `plausible` so it never rejects a real claim it
 * merely failed to recognise. The model is the actual filter, and it sees rows
 * the heuristic waved through. A row the model rejects is stamped `vetted_at`
 * exactly like an accepted one, so it is never re-classified and never re-paid
 * for.
 *
 * ORDER, AGAIN, IS COST. Classification is one small call; the pipeline is
 * retrieval plus extraction plus embeddings. So every row is classified first
 * and only survivors reach the pipeline — the same discipline the request path
 * follows, for the same reason.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDatabase, type AppContext } from '../db.js';
import {
  classifySubmission,
  isNoise,
  shouldAutoBan,
  type NoiseAssessment,
} from '../ingestion/noiseFilter.js';
import { hasLiveCredentials } from '../ingestion/llmClient.js';
import { hasRetrievalCredentials } from '../ingestion/retrieval.js';
import { createPgSubmissionStore, type QueuedSubmission, type SubmissionStore } from './store.js';
import { vetSubmission, type Logger } from './vetting.js';

/** Default page size. Small on purpose: this spends money, so opt into more. */
export const DEFAULT_DRAIN_LIMIT = 10;

export interface DrainDeps {
  store: SubmissionStore;
  /** The LIVE classifier. Injected so tests never reach a provider. */
  classify: (input: {
    claim: string;
    sourceUrl: string;
    note?: string | undefined;
  }) => Promise<NoiseAssessment>;
  /** Runs the ingestion pipeline for one submission. Injected for the same reason. */
  vet: (submission: {
    claim: string;
    sourceUrl: string;
    note?: string | undefined;
  }) => Promise<unknown>;
  logger?: Logger;
}

export interface DrainOptions {
  limit?: number;
  /**
   * Classify and report, but change nothing and run no pipeline. Note this
   * still makes the classification call — it is a preview of the VERDICTS, not
   * a free one. `--list` is the free option.
   */
  dryRun?: boolean;
}

export interface DrainReport {
  examined: number;
  accepted: number;
  rejected: number;
  banned: number;
  /** Rows whose pipeline run threw. Left queued deliberately — see below. */
  failed: number;
}

/**
 * Drain up to `limit` queued submissions. Pure of the CLI and of any provider;
 * every side effect goes through {@link DrainDeps}, so the whole thing is
 * exercisable offline.
 */
export async function drainQueue(
  deps: DrainDeps,
  options: DrainOptions = {},
): Promise<DrainReport> {
  const logger = deps.logger ?? console;
  const limit = options.limit ?? DEFAULT_DRAIN_LIMIT;
  const dryRun = options.dryRun ?? false;

  const rows = await deps.store.queued(limit);
  const report: DrainReport = { examined: 0, accepted: 0, rejected: 0, banned: 0, failed: 0 };
  if (rows.length === 0) {
    logger.info('[drain] queue is empty — nothing to do.');
    return report;
  }

  logger.info(`[drain] ${rows.length} queued submission(s)${dryRun ? ' — DRY RUN' : ''}.`);

  for (const row of rows) {
    report.examined += 1;
    const label = `${row.id.slice(0, 8)} ${row.claim.slice(0, 60)}`;

    const input = {
      claim: row.claim,
      sourceUrl: row.sourceUrl,
      ...(row.note !== undefined ? { note: row.note } : {}),
    };

    // --- 1. LIVE classification ------------------------------------------
    const assessment = await deps.classify(input);
    const verdict = `${assessment.verdict} (${assessment.confidence.toFixed(2)}, ${assessment.provenance})`;

    if (isNoise(assessment)) {
      const reason = `drain/${verdict}: ${assessment.reason}`;
      logger.info(`[drain] REJECT  ${label} — ${verdict}`);
      if (!dryRun) {
        await deps.store.markVetted(row.id, 'rejected_noise', reason);
        if (shouldAutoBan(assessment)) {
          // The ban is applied at drain time, so it takes effect from the
          // submitter's NEXT attempt. Their queued row is already rejected.
          await deps.store.ban({ identity: row.identity, reason });
          report.banned += 1;
          logger.warn(`[drain] BAN     ${label} — ${verdict}`);
        }
      }
      report.rejected += 1;
      continue;
    }

    // --- 2. The pipeline (the expensive half) ------------------------------
    logger.info(`[drain] VET     ${label} — ${verdict}`);
    if (dryRun) {
      report.accepted += 1;
      continue;
    }

    // A row is left QUEUED on any failure: `vetted_at` stays unstamped, so the
    // next run picks it up again. A failed retrieval is usually transient, and
    // burning the row would silently drop a submission that was never judged.
    let result: unknown;
    try {
      result = await deps.vet(input);
    } catch (err) {
      report.failed += 1;
      logger.error(`[drain] FAILED  ${label} — ${String(err)} (left queued for retry)`);
      continue;
    }

    // `vetSubmission` CATCHES ITS OWN ERRORS and returns null rather than
    // throwing, because it was written for the fire-and-forget caller that had
    // already answered the submitter. So the catch above is not enough: without
    // this check a pipeline that blew up mid-write still stamped the row
    // `accepted`, which is the exact silent-loss failure the queue exists to
    // prevent. Observed for real — a constraint violation in the factor insert
    // reported "1 vetted, 0 failed" while writing nothing.
    if (result === null || result === undefined) {
      report.failed += 1;
      logger.error(
        `[drain] FAILED  ${label} — pipeline returned no result; see its own error ` +
          'log above (left queued for retry)',
      );
      continue;
    }

    await deps.store.markVetted(row.id, 'accepted', `drain/${verdict}: pipeline run`);
    report.accepted += 1;
  }

  logger.info(
    `[drain] done — ${report.examined} examined, ${report.accepted} vetted, ` +
      `${report.rejected} rejected (${report.banned} banned), ${report.failed} failed.`,
  );
  return report;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

interface CliArgs {
  limit: number;
  dryRun: boolean;
  list: boolean;
  allowOffline: boolean;
  help: boolean;
}

export function parseDrainArgs(argv: readonly string[]): CliArgs {
  const has = (flag: string): boolean => argv.includes(flag);
  const limitIdx = argv.indexOf('--limit');
  const rawLimit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : NaN;
  return {
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_DRAIN_LIMIT,
    dryRun: has('--dry-run'),
    list: has('--list'),
    allowOffline: has('--allow-offline'),
    help: has('--help') || has('-h'),
  };
}

const USAGE = `
Drain the anonymous submission queue. Spends money — nothing here is automatic.

  npm run submissions:drain -- [options]

  --list             Show the queue and exit. Free: no model call, no pipeline.
  --dry-run          Classify and report verdicts, but write nothing and run no
                     pipeline. NOT free — it still makes the classification call.
  --limit N          Process at most N rows (default ${String(DEFAULT_DRAIN_LIMIT)}), oldest first.
  --allow-offline    Run without provider credentials. Refused by default,
                     because the offline path writes PLACEHOLDER factors sourced
                     from example.org into the database.
  -h, --help         This text.

Requires DATABASE_URL. To drain production, point it at production:

  DATABASE_URL='postgres://…' npm run submissions:drain -- --list
`.trim();

async function main(): Promise<void> {
  const args = parseDrainArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    // The queue is a Postgres table. In seed mode the store is in-memory and
    // resets on restart, so there is nothing durable to drain.
    throw new Error(
      'DATABASE_URL is not set. The submission queue lives in Postgres; seed mode ' +
        'keeps submissions in memory and forgets them on restart, so there is ' +
        'nothing to drain.',
    );
  }

  const live = hasLiveCredentials() && hasRetrievalCredentials();
  if (!live && !args.allowOffline && !args.list) {
    throw new Error(
      'Refusing to drain without FIREWORKS_API_KEY and a search key. Without them ' +
        'the classifier degrades to the same heuristic the submit path already ran, ' +
        'and the pipeline writes PLACEHOLDER factors (example.org sources) that sit ' +
        'pending in the database. Set the keys, or pass --allow-offline if that is ' +
        'genuinely what you want.',
    );
  }

  const { db, pool } = createDatabase(connectionString);
  try {
    const store = createPgSubmissionStore(db);

    if (args.list) {
      const rows: QueuedSubmission[] = await store.queued(args.limit);
      if (rows.length === 0) {
        console.log('[drain] queue is empty.');
        return;
      }
      console.log(`[drain] ${String(rows.length)} queued submission(s), oldest first:\n`);
      for (const r of rows) {
        console.log(`  ${r.createdAt.toISOString()}  ${r.id}`);
        console.log(`    ${r.claim}`);
        console.log(`    ${r.sourceUrl}\n`);
      }
      return;
    }

    const ctx: AppContext = { mode: 'db', db, pool };
    await drainQueue(
      {
        store,
        classify: (input) => classifySubmission(input),
        vet: (submission) => vetSubmission(ctx, submission),
      },
      { limit: args.limit, dryRun: args.dryRun },
    );
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('[drain] fatal:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
