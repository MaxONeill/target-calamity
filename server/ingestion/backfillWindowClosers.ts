/**
 * One-time backfill: judge `tippingPoint.closesWindow` on thresholds that
 * predate the field.
 *
 * The Clock anchors ONLY on thresholds whose crossing ends the possibility of
 * correction (see `closesWindow` in shared/schema.ts). Rows ingested before that
 * judgement existed carry no value, and absent means "does not anchor" — so
 * until this runs, every pre-existing threshold is inert and the countdown
 * suppresses. RUN THIS BEFORE DEPLOYING the first-crossing model, not after.
 *
 * Unlike backfillDomains there is no deterministic fallback: whether crossing a
 * threshold forecloses recovery is a judgement about the source's claim, and a
 * keyword rule guessing at it is exactly the kind of invented input this product
 * refuses. A missing key therefore leaves the Clock suppressed, which is the
 * honest failure.
 *
 *   npm run backfill:closers                  # judge every unjudged threshold
 *   npm run backfill:closers -- --limit 20    # cap the number of rows (cost)
 *   npm run backfill:closers -- --plan        # count only, no calls, no writes
 *
 * Use `--plan`, NOT `--dry-run`: npm claims `--dry-run` as its own config and
 * swallows it even after `--`, so the script never sees it and runs for real —
 * spending money and writing rows. `--dry-run` is still honoured when invoking
 * the file directly (`npx tsx server/ingestion/backfillWindowClosers.ts
 * --dry-run`), and DRY_RUN=1 works everywhere.
 *
 * Idempotent and resumable: it selects only rows carrying a tipping point with
 * no `closesWindow` key, so a re-run picks up whatever an interrupted run left.
 * Re-running never revisits a judged row, so a wrong call has to be corrected by
 * hand — deliberate, since silently re-judging would make the Clock unstable
 * between runs.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import * as z from 'zod/v4';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import {
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';

/** How many rows to judge concurrently. Small — this is a background chore. */
const CONCURRENCY = 4;

const WindowJudgementSchema = z.object({
  closesWindow: z.boolean(),
  reasoning: z.string(),
});

const JUDGE_SYSTEM =
  'You judge whether a dated threshold CLOSES THE COURSE-CORRECTION WINDOW for a ' +
  'reality tracker. Answer TRUE only if crossing this threshold means human action ' +
  'can NO LONGER restore the prior state — the change becomes self-sustaining or ' +
  'irreversible on a policy timescale. Examples of TRUE: an ice-sheet or AMOC ' +
  'collapse, rainforest dieback past the point of self-recovery, permafrost carbon ' +
  'release that sustains itself. Answer FALSE for a dated event that is severe but ' +
  'still correctable or reversible, or that is a projection of accumulating damage ' +
  'rather than a point of no return: a species-loss or pollution-tonnage milestone, ' +
  'an economic, demographic or technological threshold, a "by 2050 we will have X" ' +
  'projection. Severity is NOT the test — irreversibility is. If the description ' +
  'does not support the stronger claim, answer FALSE. Give one sentence of reasoning.';

interface Row {
  id: string;
  name: string;
  description: string;
  label: string | null;
  central_year: number | null;
}

async function judge(
  client: ReturnType<typeof getLlmClient>,
  model: string,
  row: Row,
): Promise<{ closesWindow: boolean; reasoning: string } | null> {
  const threshold = [
    row.label ? `THRESHOLD: ${row.label}` : null,
    row.central_year !== null ? `YEAR: ${row.central_year}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await structuredCompletion({
    client,
    model,
    system: JUDGE_SYSTEM,
    user: `NAME: ${row.name}\n\nDESCRIPTION: ${row.description}\n\n${threshold}`,
    schema: WindowJudgementSchema,
    schemaName: 'WindowJudgement',
    // No maxTokens override — the ingest model's thinking tokens count against
    // the budget, so a small cap starves the output (see backfillDomains).
  });
  return result ?? null;
}

async function unjudgedRows(db: Database): Promise<Row[]> {
  const { rows } = await sql<Row>`
    SELECT id, name, description,
           tipping_point->>'label' AS label,
           (tipping_point->>'centralYear')::float AS central_year
      FROM factors
     WHERE tipping_point IS NOT NULL
       AND NOT (tipping_point ? 'closesWindow')
     ORDER BY created_at ASC
  `.execute(db);
  return rows;
}

/**
 * Merge the judgement into the existing JSONB rather than replacing it, so a
 * concurrent write to another key cannot be clobbered. Only `true` is stored:
 * absent already means "does not anchor", so persisting `false` would grow every
 * row for no signal — but it IS written here, because this backfill needs to
 * distinguish "judged, no" from "not yet judged" for its own resumability.
 */
async function writeJudgement(db: Database, id: string, closesWindow: boolean): Promise<void> {
  await sql`
    UPDATE factors
       SET tipping_point = tipping_point || ${sql.val(JSON.stringify({ closesWindow }))}::jsonb
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function backfillWindowClosers(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[closers] no DATABASE_URL — nothing to backfill, exiting.');
    return;
  }
  if (!hasLiveCredentials()) {
    logger.warn(
      '[closers] no FIREWORKS_API_KEY — cannot judge irreversibility, and there is ' +
        'no safe deterministic fallback for it. Every unjudged threshold stays ' +
        'non-anchoring, so the Clock will report no baseline. Exiting.',
    );
    return;
  }

  const args = process.argv.slice(2);
  // `--plan` exists because npm eats `--dry-run` before the script sees it.
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number.parseInt(args[limitArg + 1] ?? '', 10) : NaN;

  const { db, pool } = createDatabase(databaseUrl);
  try {
    let rows = await unjudgedRows(db);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

    logger.info(`[closers] ${rows.length} unjudged threshold(s).`);
    if (dryRun || rows.length === 0) {
      logger.info(dryRun ? '[closers] dry run — no calls made.' : '[closers] nothing to do.');
      return;
    }

    const client = getLlmClient();
    const model = ingestModel();
    let done = 0;
    let anchors = 0;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < rows.length) {
        const row = rows[cursor++]!;
        try {
          const verdict = await judge(client, model, row);
          if (!verdict) {
            done += 1;
            logger.warn(`[closers] no verdict for ${row.id} — left unjudged, re-runnable.`);
            continue;
          }
          await writeJudgement(db, row.id, verdict.closesWindow);
          if (verdict.closesWindow) anchors += 1;
          logger.info(
            `[closers] ${(++done).toString().padStart(3)}/${rows.length}  ` +
              `${verdict.closesWindow ? 'ANCHOR ' : '—      '}  ` +
              `${row.name.slice(0, 44)}  · ${verdict.reasoning.slice(0, 80)}`,
          );
        } catch (err) {
          done += 1;
          logger.error(`[closers] failed for ${row.id}: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    logger.info(
      `[closers] done — ${done} judged, ${anchors} close the window, ` +
        `${done - anchors} are dated but correctable.`,
    );
    // Open clients fetched the field once; without this they keep rendering
    // the values this run replaced.
    await notifyFieldChanged(db);
  } finally {
    await pool.end();
  }
}

// Run when invoked directly (npm run backfill:closers), not when imported.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  backfillWindowClosers().catch((err: unknown) => {
    console.error('[closers] fatal:', err);
    process.exitCode = 1;
  });
}
