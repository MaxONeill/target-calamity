/**
 * Assess what it would take to reverse a threshold that has already been
 * crossed.
 *
 * A crossed threshold is a DEBT, not a terminal state. Reversing warm-water
 * reef loss is not impossible — it is centuries of recovery conditional on
 * sustained cooling. Ice-sheet collapse is harder again. Collapsing that
 * gradient into "the window is shut" throws away the only thing a reader can
 * act on, and it is not what the sources say either.
 *
 * THIS DOES NOT MOVE THE COUNTDOWN. The Clock is a function of the threshold
 * dates alone, and a crossed threshold contributes to it exactly as it did the
 * day before it was crossed — a forecast that lurched because a date it
 * predicted arrived would be badly calibrated, not updated. This pass explains
 * the state; it does not adjust it.
 *
 *   npm run backfill:recovery            # assess newly-crossed thresholds
 *   DRY_RUN=1 npm run backfill:recovery  # list candidates, no calls, no writes
 *   LIMIT=3 npm run backfill:recovery    # cap the number assessed (cost)
 *   FORCE=1 npm run backfill:recovery    # re-assess ones already done
 *
 * Prefer the env forms: npm swallows flags it recognises even after `--`.
 *
 * COST: one web search plus one LLM turn per crossed threshold. The
 * candidate set is tiny — only anchors whose estimated year is in the past —
 * and already-assessed rows are skipped, so a re-run is usually free.
 *
 * WHICH THRESHOLDS COUNT AS CROSSED is decided by the Clock's own dating logic,
 * imported rather than reimplemented. A quantity-stated threshold is only dated
 * by reading its projection, and a second copy of that arithmetic here would
 * drift from the model and assess the wrong rows.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import * as z from 'zod/v4';
import { deriveClock, type ClockFactorInput, type Projection } from '../../src/lib/clock/clockModel.js';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import {
  retrieveDocuments,
  hasRetrievalCredentials,
  publisherFromUrl,
} from './retrieval.js';
import {
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';
import { scoreSource, REPUTABILITY_VERIFY_THRESHOLD } from './reputability.js';
import { renderSourceBlocks } from './websearch.js';

const RecoveryAssessmentSchema = z.object({
  /** False when the sources say nothing usable about reversing this. */
  found: z.boolean(),
  /**
   * Published restoration timescale in years, or null.
   *
   * NEVER derived from `effort`. Turning "requires large-scale carbon removal"
   * into a number of years would be an unsourced figure that reads like a
   * sourced one — the exact failure this product removed elsewhere.
   */
  timescaleYears: z.number().nullable(),
  timescaleLowYears: z.number().nullable(),
  timescaleHighYears: z.number().nullable(),
  /** What reversal demands, in the source's framing. */
  effort: z.string(),
  /** Why this is the assessment. Shown to the reader, not just logged. */
  reasoning: z.string(),
  /** The sentence this was read from, verbatim. */
  quote: z.string(),
  sourceIndex: z.number(),
});

const ASSESS_SYSTEM =
  'A threshold in this system has already been crossed. From the RETRIEVED ' +
  'SOURCES BELOW, assess what REVERSING it would take — returning the system to ' +
  'the state it held before the crossing. ' +
  'Crossing is not the end of the story: reef loss, permafrost thaw and ice-sheet ' +
  'retreat all have published recovery behaviour, usually slow and usually ' +
  'conditional on the driving pressure being removed first. Say what those ' +
  'conditions are. ' +
  'effort states what reversal demands, in the source\'s own framing — sustained ' +
  'net-negative emissions, active restoration, cooling held below some level, or ' +
  'that no known pathway exists. ' +
  'timescaleYears is the PUBLISHED restoration timescale in years, with ' +
  'timescaleLowYears/timescaleHighYears when the source gives a range. Use null ' +
  'when the source states no timescale. NEVER estimate one from how hard the ' +
  'effort sounds: an invented number here reads exactly like a measured one and ' +
  'is worse than an honest gap. ' +
  'reasoning is one or two plain sentences a non-expert can follow, because it ' +
  'is shown to the reader. quote is the sentence you read this from, copied ' +
  'verbatim, and sourceIndex is its SOURCE block. ' +
  'Set found=false if the sources do not discuss reversing or recovering this.';

/** Aimed at recovery literature rather than at the crossing itself. */
function recoveryQuery(name: string): string {
  return `${name} recovery reversibility restoration timescale can it recover`;
}

interface FactorRow {
  id: string;
  name: string;
  effect: number;
  significance: number;
  domains: string[] | null;
  tipping_point: Record<string, unknown> | null;
  verification_state: string;
}

interface ProjectionRow {
  id: string;
  quantity: string;
  unit: string;
  baseline: string | null;
  assumes_future_action: boolean | null;
  points: { year: number; value: number }[];
}

/**
 * Crossed anchors that have not been assessed yet.
 *
 * The crossing test comes from `deriveClock` rather than from SQL: a
 * quantity-stated threshold has no year of its own, it is dated by reading a
 * projection, and duplicating that arithmetic here would drift from the model
 * and assess the wrong rows.
 */
async function crossedRows(
  db: Database,
  force: boolean,
  referenceYear: number,
): Promise<{ id: string; name: string }[]> {
  const { rows } = await sql<FactorRow>`
    SELECT id, name, effect, significance, domains, tipping_point, verification_state
      FROM factors
     WHERE verification_state <> 'rejected'
  `.execute(db);

  const { rows: projRows } = await sql<ProjectionRow>`
    SELECT id, quantity, unit, baseline, assumes_future_action, points FROM projections
  `.execute(db);

  const projections: Projection[] = projRows.map((p) => ({
    id: p.id,
    quantity: p.quantity,
    unit: p.unit,
    points: p.points,
    ...(p.baseline !== null ? { baseline: p.baseline } : {}),
    ...(p.assumes_future_action !== null
      ? { assumesFutureAction: p.assumes_future_action }
      : {}),
  }));

  const byLabel = new Map<string, { id: string; name: string; assessed: boolean }>();
  const factors: ClockFactorInput[] = rows.map((r) => {
    const tp = r.tipping_point as ClockFactorInput['tippingPoint'];
    const label =
      (tp?.label as string | undefined) ??
      (tp?.quantityThreshold
        ? `${tp.quantityThreshold.value} ${tp.quantityThreshold.unit} — ${tp.quantityThreshold.quantity}`
        : null);
    if (label) {
      byLabel.set(label, {
        id: r.id,
        name: r.name,
        assessed: tp?.recovery !== undefined && tp?.recovery !== null,
      });
    }
    return {
      effect: Number(r.effect),
      significance: Number(r.significance),
      domains: (r.domains ?? []) as never,
      verificationState: r.verification_state as never,
      ...(tp ? { tippingPoint: tp } : {}),
    };
  });

  const model = deriveClock(factors, projections, referenceYear);
  const out: { id: string; name: string }[] = [];
  for (const t of model.thresholds) {
    if (!t.anchors || !t.crossed) continue;
    const match = t.label === null ? undefined : byLabel.get(t.label);
    if (!match) continue;
    if (!force && match.assessed) continue;
    out.push({ id: match.id, name: match.name });
  }
  return out;
}

/** Merge into the existing JSONB so a concurrent write to another key survives. */
async function writeRecovery(
  db: Database,
  id: string,
  recovery: Record<string, unknown>,
): Promise<void> {
  await sql`
    UPDATE factors
       SET tipping_point = tipping_point || ${sql.val(JSON.stringify({ recovery }))}::jsonb
     WHERE id = ${id}::uuid AND tipping_point IS NOT NULL
  `.execute(db);
}

export async function backfillRecovery(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[recovery] no DATABASE_URL — nothing to do, exiting.');
    return;
  }
  if (!hasLiveCredentials() || !hasRetrievalCredentials()) {
    logger.warn(
      '[recovery] needs BOTH FIREWORKS_API_KEY and a search key (SERPER_API_KEY or BRAVE_API_KEY). What reversal ' +
        'takes must be READ from sources, not recalled — an invented recovery ' +
        'timescale reads exactly like a measured one. Exiting.',
    );
    return;
  }

  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const force = args.includes('--force') || process.env.FORCE === '1';
  const limitRaw = process.env.LIMIT;
  const limit = Number.parseInt(limitRaw ?? '', 10);
  const referenceYear = new Date().getUTCFullYear();

  const { db, pool } = createDatabase(databaseUrl);
  try {
    let rows = await crossedRows(db, force, referenceYear);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

    logger.info(
      `[recovery] ${rows.length} crossed anchor(s) to assess` +
        `${force ? ' (--force: re-assessing)' : ''}. One search + one turn each.`,
    );
    for (const r of rows) logger.info(`[recovery]   ${r.name.slice(0, 60)}`);
    if (dryRun || rows.length === 0) {
      logger.info(dryRun ? '[recovery] dry run — no calls, no writes.' : '[recovery] nothing to do.');
      return;
    }

    const client = getLlmClient();
    const model = ingestModel();
    let assessed = 0;

    for (const row of rows) {
      try {
        const docs = await retrieveDocuments(
          recoveryQuery(row.name),
        );
        if (docs.length === 0) {
          logger.warn(`[recovery] no sources for "${row.name.slice(0, 40)}".`);
          continue;
        }

        const out = await structuredCompletion({
          client,
          model,
          system: ASSESS_SYSTEM,
          user: `CROSSED THRESHOLD: ${row.name}\n\n${renderSourceBlocks(docs)}`,
          schema: RecoveryAssessmentSchema,
          schemaName: 'RecoveryAssessment',
        });
        if (!out || !out.found) continue;

        const doc = docs[out.sourceIndex - 1];
        if (!doc || out.effort.trim() === '' || out.quote.trim() === '') {
          logger.warn(`[recovery] unusable assessment for "${row.name.slice(0, 40)}".`);
          continue;
        }

        const publisher = publisherFromUrl(doc.url, doc.title);
        const score = await scoreSource({
          url: doc.url,
          publisher,
          claim: `reversing ${row.name} requires ${out.effort}`,
          quoteSnippet: out.quote,
        });
        if (score.score < REPUTABILITY_VERIFY_THRESHOLD) {
          logger.warn(
            `[recovery] rejected ${doc.url} (reputability ${score.score.toFixed(2)}) ` +
              `for "${row.name.slice(0, 36)}"`,
          );
          continue;
        }

        const recovery: Record<string, unknown> = {
          effort: out.effort.trim().slice(0, 1000),
          reasoning: out.reasoning.trim().slice(0, 2000),
          quote: out.quote.trim().slice(0, 2000),
          sourceUrl: doc.url,
          publisher,
        };
        // Absent stays absent. A source giving effort but no timescale yields no
        // number, and the UI shows the gap rather than filling it.
        if (out.timescaleYears !== null && Number.isFinite(out.timescaleYears)) {
          recovery.timescaleYears = out.timescaleYears;
        }
        if (out.timescaleLowYears !== null && Number.isFinite(out.timescaleLowYears)) {
          recovery.timescaleLowYears = out.timescaleLowYears;
        }
        if (out.timescaleHighYears !== null && Number.isFinite(out.timescaleHighYears)) {
          recovery.timescaleHighYears = out.timescaleHighYears;
        }

        await writeRecovery(db, row.id, recovery);
        assessed += 1;
        logger.info(
          `[recovery] ${row.name.slice(0, 40)} · ` +
            `${recovery.timescaleYears ?? '(no timescale stated)'} yr · ` +
            `${out.effort.slice(0, 60)} · ${publisher}`,
        );
      } catch (err) {
        logger.error(`[recovery] failed for ${row.id}: ${(err as Error).message}`);
      }
    }

    logger.info(`[recovery] done — ${assessed}/${rows.length} assessed.`);
    await notifyFieldChanged(db);
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  backfillRecovery().catch((err: unknown) => {
    console.error('[recovery] fatal:', err);
    process.exitCode = 1;
  });
}
