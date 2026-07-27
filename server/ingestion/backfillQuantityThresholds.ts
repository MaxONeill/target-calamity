/**
 * Backfill: give existing factors the quantity threshold the literature states
 * for them.
 *
 * This is the step that closes the chain. AMOC collapse, Greenland and West
 * Antarctic ice-sheet collapse and the permafrost carbon feedback are all
 * already in the factor set carrying NO threshold, because the extraction used
 * to demand a year and the literature publishes degrees. Each is asked, once,
 * whether its sources state a threshold against a measurable quantity.
 *
 *   npm run backfill:quantities            # search every UNCHECKED candidate
 *   DRY_RUN=1 npm run backfill:quantities # list candidates, no calls, no writes
 *   LIMIT=10 npm run backfill:quantities  # cap the number searched (cost)
 *   FORCE=1 npm run backfill:quantities   # re-include previously-empty rows
 *
 * Prefer the ENV forms. npm swallows flags it recognises even after `--`, and
 * both `--dry-run` and `--limit` have been observed not to reach the script —
 * which, for a command that spends a Firecrawl search per row, has meant runs
 * costing ~50 searches when they were meant to cost none.
 *
 * COST: one Firecrawl search per candidate. Rows that come back empty are
 * stamped `threshold_checked_at` and skipped thereafter, so a re-run costs
 * nothing until new factors arrive. FORCE=1 is the way back in when the
 * extraction or the gate has changed enough to be worth re-asking.
 *
 * Candidates are ADVERSE factors with no tipping point at all. A factor that
 * already carries one is left alone: overwriting a published year with a
 * model-recalled threshold would trade a cited fact for a recollection.
 *
 * Resumable but NOT self-correcting: a row that gets no threshold is retried on
 * the next run, since "no verdict" and "no threshold" are indistinguishable in
 * the data. That is the cost of not storing negatives, and it is bounded by
 * --limit.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import * as z from 'zod/v4';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import {
  firecrawlSearch,
  hasRetrievalCredentials,
  publisherFromUrl,
  type RetrievedDocument,
} from './firecrawlClient.js';
import {
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';
import { scoreSource, REPUTABILITY_VERIFY_THRESHOLD } from './reputability.js';
import { renderSourceBlocks } from './websearch.js';

/** Serial, not concurrent: each row now costs a retrieval as well as a turn. */
const CONCURRENCY = 2;

const QuantityJudgementSchema = z.object({
  /** False when the sources state no measurable threshold for this factor. */
  found: z.boolean(),
  quantity: z.string(),
  value: z.number(),
  unit: z.string(),
  baseline: z.string().nullable(),
  lowValue: z.number().nullable(),
  highValue: z.number().nullable(),
  /** Crossing it ends the possibility of correction. Same test as closesWindow. */
  closesWindow: z.boolean(),
  /** 1-based index of the SOURCE block the threshold was read from. */
  sourceIndex: z.number(),
  /** The sentence in the source that states the threshold. Never paraphrased. */
  quote: z.string(),
  reasoning: z.string(),
});

const JUDGE_SYSTEM =
  'You extract a TIPPING THRESHOLD stated against a measurable quantity, FROM THE ' +
  'RETRIEVED SOURCES BELOW — how the tipping-point literature usually publishes ' +
  'one. Examples of the form: "the Greenland ice sheet destabilises at about ' +
  '1.5 degC of warming above pre-industrial", "Amazon dieback beyond 20-25% ' +
  'deforested". ' +
  'Set found=true ONLY when a source in front of you STATES the threshold. Do not ' +
  'answer from background knowledge: a number you recall but cannot point at in a ' +
  'source is exactly what this must not produce, because it anchors a countdown ' +
  'that claims every input is traceable to a citation. ' +
  'quantity is what is measured, value/unit where the threshold sits, ' +
  'lowValue/highValue the published range (null if none), and baseline the ' +
  'reference the value is measured against (e.g. "pre-industrial (1850-1900)"), ' +
  'null if the source does not state one. NEVER guess a baseline: the same ' +
  'quantity on two baselines can differ enough to move a date by decades. ' +
  'sourceIndex is the SOURCE block the threshold came from, and quote is the ' +
  'sentence stating it, copied verbatim. ' +
  'closesWindow is TRUE only if crossing it means human action can NO LONGER ' +
  'restore the prior state — self-sustaining or irreversible on a policy ' +
  'timescale. Severity is not the test; irreversibility is. ' +
  'Set found=false when the sources give no threshold for THIS factor. Most ' +
  'factors have none, and saying so is the correct answer.';

/** Aimed at the assessment literature, where thresholds are stated. */
function thresholdQuery(name: string): string {
  return `${name} tipping point threshold assessment published critical value`;
}

interface Row {
  id: string;
  name: string;
  description: string;
}

/**
 * Rows worth spending a search on: adverse, verified, no threshold, and not
 * already searched-and-empty.
 *
 * That last clause is what makes re-running affordable. Each candidate costs a
 * Firecrawl search, and without it every previously-empty factor is researched
 * again — one run checked 48 rows to gain a single threshold. `--force` exists
 * for when the extraction or the gate has changed enough that old negatives are
 * worth revisiting, which is a deliberate decision rather than the default.
 */
async function candidateRows(db: Database, force: boolean): Promise<Row[]> {
  const { rows } = await sql<Row>`
    SELECT id, name, description
      FROM factors
     WHERE tipping_point IS NULL
       AND effect <= 0
       AND verification_state = 'verified'
       AND (${force} OR threshold_checked_at IS NULL)
     ORDER BY (ABS(effect * significance)) DESC, id ASC
  `.execute(db);
  return rows;
}

/**
 * Record that a search happened and found nothing, so the next run skips it.
 * Only negatives are stamped — a positive is self-evident from `tipping_point`
 * no longer being NULL, which the candidate query already excludes.
 */
async function markChecked(db: Database, id: string): Promise<void> {
  await sql`
    UPDATE factors SET threshold_checked_at = NOW()
     WHERE id = ${id}::uuid AND tipping_point IS NULL
  `.execute(db);
}

/**
 * Persist the threshold AND the source it was read from.
 *
 * The citation is the point of this backfill. A threshold anchors the countdown,
 * so it is the last thing that should be the one input without provenance —
 * `label` names the source inline for the Why panel, and the citation row puts
 * it in the same audit trail as every other claim.
 */
async function writeThreshold(
  db: Database,
  id: string,
  verdict: z.infer<typeof QuantityJudgementSchema>,
  doc: RetrievedDocument,
): Promise<void> {
  const quantityThreshold: Record<string, unknown> = {
    quantity: verdict.quantity.trim().slice(0, 300),
    value: verdict.value,
    unit: verdict.unit.trim().slice(0, 60),
  };
  const baseline = verdict.baseline?.trim();
  if (baseline) quantityThreshold.baseline = baseline.slice(0, 300);
  if (verdict.lowValue !== null && Number.isFinite(verdict.lowValue)) {
    quantityThreshold.lowValue = verdict.lowValue;
  }
  if (verdict.highValue !== null && Number.isFinite(verdict.highValue)) {
    quantityThreshold.highValue = verdict.highValue;
  }

  const publisher = publisherFromUrl(doc.url, doc.title);
  const tippingPoint: Record<string, unknown> = {
    quantityThreshold,
    label: `${verdict.value} ${verdict.unit.trim()} ${verdict.quantity.trim()} (${publisher})`.slice(
      0,
      500,
    ),
  };
  // Only the affirmative judgement is stored; absent already means "does not
  // anchor", so writing false would grow the row for no signal.
  if (verdict.closesWindow) tippingPoint.closesWindow = true;

  await sql`
    UPDATE factors
       SET tipping_point = ${sql.val(JSON.stringify(tippingPoint))}::jsonb
     WHERE id = ${id}::uuid
       AND tipping_point IS NULL
  `.execute(db);

  // content_hash is the per-finding idempotency key, so re-running never
  // duplicates a citation for the same source+quote.
  const quote = verdict.quote.trim().slice(0, 2000);
  // Hashed here, not in SQL: this schema deliberately does not install pgcrypto
  // (gen_random_uuid is core from PG13), so digest() does not exist.
  const contentHash = createHash('sha256').update(`${doc.url}|${quote}`).digest('hex');
  await sql`
    INSERT INTO citations (factor_id, source_url, publisher, quote_snippet, content_hash)
    VALUES (${id}::uuid, ${doc.url}, ${publisher}, ${quote}, ${contentHash})
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export async function backfillQuantityThresholds(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[quantities] no DATABASE_URL — nothing to backfill, exiting.');
    return;
  }
  if (!hasLiveCredentials() || !hasRetrievalCredentials()) {
    logger.warn(
      '[quantities] needs BOTH FIREWORKS_API_KEY and FIRECRAWL_API_KEY. The ' +
        'threshold must be READ from a retrieved source, not recalled: a number ' +
        'nobody can point at in a citation would anchor the countdown while the ' +
        'product claims every input is traceable. Exiting.',
    );
    return;
  }

  // npm swallows flags it recognises — --limit and --dry-run have both been
  // observed not to arrive — so every switch has an env-var form, and those are
  // the ones to trust when a run costs money.
  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const force = args.includes('--force') || process.env.FORCE === '1';
  const limitArg = args.indexOf('--limit');
  const limitRaw = limitArg >= 0 ? args[limitArg + 1] : process.env.LIMIT;
  const limit = Number.parseInt(limitRaw ?? '', 10);

  // Honour the operator's cost ceiling instead of hardcoding one. This is the
  // multiplier on every search: pages retrieved and scraped per call.
  const maxResults = Number.parseInt(process.env.FIRECRAWL_MAX_RESULTS ?? '', 10);

  const { db, pool } = createDatabase(databaseUrl);
  try {
    let rows = await candidateRows(db, force);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

    logger.info(
      `[quantities] ${rows.length} unchecked adverse factor(s)` +
        `${force ? ' (--force: previously-empty rows re-included)' : ''}. ` +
        `Each costs one Firecrawl search.`,
    );
    if (dryRun || rows.length === 0) {
      logger.info(dryRun ? '[quantities] plan only — no calls made.' : '[quantities] nothing to do.');
      return;
    }

    const client = getLlmClient();
    const model = ingestModel();
    let done = 0;
    let found = 0;
    let anchors = 0;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < rows.length) {
        const row = rows[cursor++]!;
        try {
          const docs = await firecrawlSearch(
            thresholdQuery(row.name),
            process.env.FIRECRAWL_API_KEY as string,
            // Omitted when unset so firecrawlSearch applies its own default,
            // rather than this file inventing a competing one.
            Number.isFinite(maxResults) && maxResults > 0 ? { maxResults } : {},
          );
          done += 1;
          // From here on, every exit that does not write a threshold marks the
          // row checked. Missing one of them leaks the saving: the search has
          // already been paid for, and the next run would pay again.
          if (docs.length === 0) {
            await markChecked(db, row.id);
            continue;
          }

          const verdict = await structuredCompletion({
            client,
            model,
            system: JUDGE_SYSTEM,
            user:
              `FACTOR: ${row.name}\n\nDESCRIPTION: ${row.description}\n\n` +
              renderSourceBlocks(docs),
            schema: QuantityJudgementSchema,
            schemaName: 'QuantityThresholdJudgement',
          });
          if (!verdict || !verdict.found) {
            await markChecked(db, row.id);
            continue;
          }
          if (
            !Number.isFinite(verdict.value) ||
            verdict.quantity.trim() === '' ||
            verdict.unit.trim() === ''
          ) {
            logger.warn(`[quantities] incomplete threshold for ${row.id} — skipped.`);
            await markChecked(db, row.id);
            continue;
          }

          // A source index naming no retrieved document means the threshold was
          // recalled rather than read. That is the exact failure this rewrite
          // exists to stop, so it is dropped rather than stored unsourced.
          const doc = docs[verdict.sourceIndex - 1];
          if (!doc) {
            logger.warn(
              `[quantities] "${row.name.slice(0, 40)}" cited source ${verdict.sourceIndex}, ` +
                `which does not exist — dropped as unsourced.`,
            );
            await markChecked(db, row.id);
            continue;
          }

          const score = await scoreSource({
            url: doc.url,
            publisher: publisherFromUrl(doc.url, doc.title),
            claim: `${row.name} crosses a threshold at ${verdict.value} ${verdict.unit} ${verdict.quantity}`,
            quoteSnippet: verdict.quote,
          });
          if (score.score < REPUTABILITY_VERIFY_THRESHOLD) {
            logger.warn(
              `[quantities] rejected ${doc.url} for "${row.name.slice(0, 32)}" ` +
                `(reputability ${score.score.toFixed(2)})`,
            );
            // Marked too: the best source retrieval could find did not clear the
            // bar, and a re-run would retrieve the same pages. `--force` is the
            // way back in once the gate itself changes.
            await markChecked(db, row.id);
            continue;
          }

          await writeThreshold(db, row.id, verdict, doc);
          found += 1;
          if (verdict.closesWindow) anchors += 1;
          logger.info(
            `[quantities] ${verdict.closesWindow ? 'ANCHOR ' : '—      '} ` +
              `${verdict.value} ${verdict.unit} ${verdict.quantity.slice(0, 34)} ` +
              `· ${row.name.slice(0, 34)} · ${publisherFromUrl(doc.url, doc.title)}`,
          );
        } catch (err) {
          done += 1;
          logger.error(`[quantities] failed for ${row.id}: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    logger.info(
      `[quantities] done — ${done} checked, ${found} carry a measurable threshold, ` +
        `${anchors} of those close the window.`,
    );
    // Open clients fetched the field once; without this they keep rendering
    // the values this run replaced.
    await notifyFieldChanged(db);
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  backfillQuantityThresholds().catch((err: unknown) => {
    console.error('[quantities] fatal:', err);
    process.exitCode = 1;
  });
}

