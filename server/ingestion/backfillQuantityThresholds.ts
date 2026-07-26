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
 *   npm run backfill:quantities                 # judge every candidate row
 *   npm run backfill:quantities -- --plan       # list candidates, no calls
 *   npm run backfill:quantities -- --limit 10   # cap the number judged (cost)
 *
 * `--plan`, not `--dry-run`: npm claims the latter as its own config and eats it
 * before the script sees it. DRY_RUN=1 works everywhere.
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
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import * as z from 'zod/v4';
import { createDatabase, type Database } from '../db.js';
import {
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';

const CONCURRENCY = 4;

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
  reasoning: z.string(),
});

const JUDGE_SYSTEM =
  'You identify whether a factor has a TIPPING THRESHOLD stated against a ' +
  'measurable quantity — how the tipping-point literature usually publishes one. ' +
  'Examples: "the Greenland ice sheet destabilises at about 1.5 degC of warming ' +
  'above pre-industrial", "AMOC collapse becomes likely around 4 degC", "Amazon ' +
  'dieback beyond 20-25% deforested". ' +
  'Set found=true ONLY if a real, published threshold exists for THIS factor. ' +
  'quantity is what is measured, value/unit where the threshold sits, ' +
  'lowValue/highValue the published range (null if none), and baseline the ' +
  'reference the value is measured against (e.g. "pre-industrial (1850-1900)"), ' +
  'null if none is stated. NEVER guess a baseline: the same quantity on two ' +
  'baselines can differ enough to move a date by decades. ' +
  'closesWindow is TRUE only if crossing it means human action can NO LONGER ' +
  'restore the prior state — self-sustaining or irreversible on a policy ' +
  'timescale. Severity is not the test; irreversibility is. ' +
  'Set found=false for ongoing pressures, counter-forces, and anything whose ' +
  'threshold you would have to invent. Most factors have none, and saying so is ' +
  'the correct answer. Give one sentence of reasoning either way.';

interface Row {
  id: string;
  name: string;
  description: string;
}

async function candidateRows(db: Database): Promise<Row[]> {
  const { rows } = await sql<Row>`
    SELECT id, name, description
      FROM factors
     WHERE tipping_point IS NULL
       AND effect <= 0
       AND verification_state = 'verified'
     ORDER BY (ABS(effect * significance)) DESC, id ASC
  `.execute(db);
  return rows;
}

async function writeThreshold(
  db: Database,
  id: string,
  verdict: z.infer<typeof QuantityJudgementSchema>,
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

  const tippingPoint: Record<string, unknown> = { quantityThreshold };
  // Only the affirmative judgement is stored; absent already means "does not
  // anchor", so writing false would grow the row for no signal.
  if (verdict.closesWindow) tippingPoint.closesWindow = true;

  await sql`
    UPDATE factors
       SET tipping_point = ${sql.val(JSON.stringify(tippingPoint))}::jsonb
     WHERE id = ${id}::uuid
       AND tipping_point IS NULL
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
  if (!hasLiveCredentials()) {
    logger.warn(
      '[quantities] no FIREWORKS_API_KEY — a published threshold cannot be ' +
        'recalled deterministically, and inventing one would date the Clock off a ' +
        'number no source states. Exiting.',
    );
    return;
  }

  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number.parseInt(args[limitArg + 1] ?? '', 10) : NaN;

  const { db, pool } = createDatabase(databaseUrl);
  try {
    let rows = await candidateRows(db);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

    logger.info(`[quantities] ${rows.length} threshold-less adverse factor(s) to check.`);
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
          const verdict = await structuredCompletion({
            client,
            model,
            system: JUDGE_SYSTEM,
            user: `NAME: ${row.name}\n\nDESCRIPTION: ${row.description}`,
            schema: QuantityJudgementSchema,
            schemaName: 'QuantityThresholdJudgement',
          });
          done += 1;
          if (!verdict || !verdict.found) continue;
          if (
            !Number.isFinite(verdict.value) ||
            verdict.quantity.trim() === '' ||
            verdict.unit.trim() === ''
          ) {
            logger.warn(`[quantities] incomplete threshold for ${row.id} — skipped.`);
            continue;
          }

          await writeThreshold(db, row.id, verdict);
          found += 1;
          if (verdict.closesWindow) anchors += 1;
          logger.info(
            `[quantities] ${verdict.closesWindow ? 'ANCHOR ' : '—      '} ` +
              `${verdict.value} ${verdict.unit} ${verdict.quantity.slice(0, 40)} ` +
              `· ${row.name.slice(0, 40)}`,
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
