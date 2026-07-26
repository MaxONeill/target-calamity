/**
 * Re-score `significance` against the scale rubric.
 *
 * The original instruction to the extractor was, in full: "significance is in
 * [0, 1] (weight/confidence)". No rubric, no anchors, and it conflated magnitude
 * with confidence â€” which is scored separately by the reputability gate. Given
 * an unanchored [0,1] and a corpus where everything is newsworthy, the model
 * clustered everything high: 88 of 89 verified factors between 0.40 and 0.93,
 * 22 of them at exactly 0.70, and the bottom half of the range unused.
 *
 * The visible symptom: global coral-reef collapse and an Iberian lynx recovery
 * both scored 0.90. One is a planetary biome; the other is one species in one
 * country.
 *
 * This matters more than a display detail. `significance` is triple-loaded â€” it
 * is the field-bake weight, the domain force weight, AND `p` in the Clock's
 * first-crossing model. A corpus that does not discriminate makes all three
 * indiscriminate.
 *
 *   npm run backfill:significance             # re-score every verified factor
 *   DRY_RUN=1 npm run backfill:significance   # report only, no calls, no writes
 *   LIMIT=20 npm run backfill:significance    # cap the number re-scored
 *
 * Prefer the env forms: npm swallows flags it recognises even after `--`.
 *
 * COST: one LLM call per factor, NO retrieval. Judged from the factor's own
 * name, description and spatial path â€” scale is a property of what the factor
 * says, so re-reading its sources would buy nothing and cost Firecrawl credits.
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

const CONCURRENCY = 3;

/** Movement smaller than this is noise in the rubric's own terms â€” skip the write. */
const MIN_DELTA = 0.05;

/** Factors judged per call, alongside the reference anchors. */
const BATCH_SIZE = 12;

/**
 * The scale, expressed as fixed reference points.
 *
 * These are NOT factors and are never stored. They are the definition of the
 * scale, versioned in code, and they appear in every batch so that separately
 * scored batches land on one common scale â€” the thing plain batch-ranking cannot
 * give you.
 *
 * Absolute scoring failed twice here: asked for a number against a rubric, the
 * model regresses to its prior and clusters. Two rewrites moved the cluster
 * (0.70-0.90, then 0.75 "continental") without dispersing it, because the task
 * itself invites a shrug. Ranking does not: placing an item ABOVE or BELOW
 * "recovery of one species in one country" is a judgement with an answer, and
 * the spread falls out of the ordering rather than being asked for.
 */
interface Anchor {
  id: string;
  text: string;
  score: number;
}

const ANCHORS: readonly Anchor[] = [
  { id: 'A1', score: 0.97, text: 'Collapse of a major ocean circulation system, altering climate across continents' },
  { id: 'A2', score: 0.9, text: 'Loss of a planetary biome, such as the world\'s warm-water coral reefs' },
  { id: 'A3', score: 0.72, text: 'A worldwide economic condition that reshapes how societies function' },
  { id: 'A4', score: 0.5, text: 'A major policy change in one large country, with effects confined to it' },
  { id: 'A5', score: 0.25, text: 'Recovery of a single species within one country' },
  { id: 'A6', score: 0.06, text: 'One organisation launching an initiative at a single site' },
];

/** Model output: the whole batch in order, most significant first. */
const RankingSchema = z.object({
  /** Every item id exactly once â€” factors and anchors interleaved. */
  ranked: z.array(z.string()),
});

/** Band a final score falls in, so the stored label stays consistent with it. */
function bandOf(score: number): string {
  if (score >= 0.9) return 'planetary';
  if (score >= 0.7) return 'continental';
  if (score >= 0.4) return 'national';
  if (score >= 0.15) return 'subnational';
  return 'site';
}

/**
 * Turn a ranking into scores by interpolating between the anchors it contains.
 *
 * An item sitting between two anchors takes a score between theirs, by its
 * position in the gap. This is what makes separate batches comparable: the
 * anchors are the same every time, so "just above the single-species anchor"
 * means the same number in every batch.
 *
 * Returns null when the ranking is unusable â€” a missing or duplicated id, or
 * anchors that came back out of their own known order. The latter is the useful
 * signal: if the model cannot order six statements whose order is definitional,
 * its ordering of the real factors is not worth writing to the database.
 */
export function scoresFromRanking(
  ranked: readonly string[],
  factorIds: readonly string[],
): Map<string, number> | null {
  const expected = new Set<string>([...factorIds, ...ANCHORS.map((a) => a.id)]);
  if (ranked.length !== expected.size) return null;
  if (new Set(ranked).size !== ranked.length) return null;
  for (const id of ranked) if (!expected.has(id)) return null;

  const anchorScore = new Map(ANCHORS.map((a) => [a.id, a.score]));
  const anchorPositions: { index: number; score: number }[] = [];
  ranked.forEach((id, index) => {
    const score = anchorScore.get(id);
    if (score !== undefined) anchorPositions.push({ index, score });
  });
  if (anchorPositions.length !== ANCHORS.length) return null;

  // Anchors must descend: the ranking is most-significant-first and their true
  // order is known. Out of order means the ranking is noise.
  for (let i = 1; i < anchorPositions.length; i++) {
    if (anchorPositions[i]!.score >= anchorPositions[i - 1]!.score) return null;
  }

  const out = new Map<string, number>();
  ranked.forEach((id, index) => {
    if (anchorScore.has(id)) return;

    const below = [...anchorPositions].reverse().find((a) => a.index < index);
    const above = anchorPositions.find((a) => a.index > index);

    if (!below) {
      // Ranked above every anchor: cap just above the top anchor rather than
      // inventing a new ceiling.
      out.set(id, Math.min(1, anchorPositions[0]!.score + 0.02));
      return;
    }
    if (!above) {
      out.set(id, Math.max(0.02, anchorPositions[anchorPositions.length - 1]!.score - 0.02));
      return;
    }
    const span = above.index - below.index;
    const t = span === 0 ? 0.5 : (index - below.index) / span;
    out.set(id, below.score + t * (above.score - below.score));
  });
  return out;
}

const RANK_SYSTEM =
  'You rank findings by SIGNIFICANCE for a reality tracker: how much of the ' +
  'system each one moves. Not how newsworthy or morally serious it is, and NOT ' +
  'how confident you are in the source â€” credibility is scored elsewhere and must ' +
  'not enter here. ' +
  'Two things are being weighed together, and confusing them is the main error: ' +
  'BREADTH (how much of the world it touches) and DEPTH (how structurally it ' +
  'changes what it touches). A condition can be worldwide and still shallow: a ' +
  'global economic or political problem is broad, but it does not alter an ' +
  'Earth-system subsystem the way losing a biome does. ' +
  'A risk assessment, funding shortfall, governance gap, or policy proposal ' +
  'describes our CAPACITY TO RESPOND rather than the state of the system, and ' +
  'ranks below an equivalent-breadth change in the system itself. ' +
  'Some items are REFERENCE POINTS defining the scale. Rank everything â€” real ' +
  'findings and reference points together â€” in ONE list, most significant first. ' +
  'The reference points are your ruler: place each finding above or below them. ' +
  'Return every id exactly once, and nothing else.';

interface Row {
  id: string;
  name: string;
  description: string;
  spatial_path: string;
  significance: number;
}

async function rowsToScore(db: Database, force: boolean): Promise<Row[]> {
  const { rows } = await sql<Row>`
    SELECT id, name, description, spatial_path::text AS spatial_path, significance
      FROM factors
     -- Pending rows included: they are excluded from the aggregate today, but a
     -- promotion would admit whatever score they carry, and the Iberian lynx was
     -- sitting at 0.90 precisely because pending rows were never re-scored.
     WHERE verification_state <> 'rejected'
       AND (${force} OR significance_scale IS NULL)
     ORDER BY significance DESC, id ASC
  `.execute(db);
  return rows;
}

export async function backfillSignificance(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[significance] no DATABASE_URL â€” nothing to do, exiting.');
    return;
  }
  if (!hasLiveCredentials()) {
    logger.warn('[significance] no FIREWORKS_API_KEY â€” cannot re-score. Exiting.');
    return;
  }

  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const force = args.includes('--force') || process.env.FORCE === '1';
  const limitArg = args.indexOf('--limit');
  const limitRaw = limitArg >= 0 ? args[limitArg + 1] : process.env.LIMIT;
  const limit = Number.parseInt(limitRaw ?? '', 10);

  const { db, pool } = createDatabase(databaseUrl);
  try {
    let rows = await rowsToScore(db, force);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

    // Batches interleave the same anchors every time, which is what puts
    // separately-ranked batches on one scale.
    //
    // Rows are DEALT round-robin, not sliced. `rowsToScore` orders by current
    // significance, so slicing would make every batch internally homogeneous —
    // batch 1 all the 0.95s, batch 9 all the low ones. Ranking near-identical
    // items forces the model to invent an order, and the ends of that invented
    // order get extreme scores. That is exactly how "inequality as a driver of
    // financial crisis" came back at 0.11, ranked below a single-site
    // initiative: nothing in its batch was genuinely smaller, so something had
    // to be last. Dealing spreads each batch across the range, so the ordering
    // it is asked for is one that actually exists.
    const batchCount = Math.max(1, Math.ceil(rows.length / BATCH_SIZE));
    const batches: Row[][] = Array.from({ length: batchCount }, () => []);
    rows.forEach((row, i) => batches[i % batchCount]!.push(row));

    logger.info(
      `[significance] ${rows.length} factor(s) in ${batches.length} batch(es) of ` +
        `${BATCH_SIZE} â€” one LLM call each, no retrieval.`,
    );
    if (dryRun || rows.length === 0) {
      logger.info(dryRun ? '[significance] dry run â€” no calls, no writes.' : '[significance] nothing to do.');
      return;
    }

    const client = getLlmClient();
    const model = ingestModel();
    let scored = 0;
    let moved = 0;
    let rejected = 0;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batches.length) {
        const batchIndex = cursor++;
        const batch = batches[batchIndex]!;
        try {
          // Anchors spread through the list rather than grouped at either end,
          // so their positions do not hint at an ordering before the model has
          // done the work.
          const items: { id: string; text: string }[] = [];
          const stride = Math.max(1, Math.ceil(batch.length / (ANCHORS.length + 1)));
          let anchorIdx = 0;
          batch.forEach((row, i) => {
            if (i % stride === 0 && anchorIdx < ANCHORS.length) {
              const a = ANCHORS[anchorIdx++]!;
              items.push({ id: a.id, text: `[REFERENCE] ${a.text}` });
            }
            items.push({
              id: row.id,
              text: `${row.name} â€” ${row.description.slice(0, 400)} (scope: ${row.spatial_path})`,
            });
          });
          while (anchorIdx < ANCHORS.length) {
            const a = ANCHORS[anchorIdx++]!;
            items.push({ id: a.id, text: `[REFERENCE] ${a.text}` });
          }

          const out = await structuredCompletion({
            client,
            model,
            system: RANK_SYSTEM,
            user: items.map((it) => `${it.id}: ${it.text}`).join('\n\n'),
            schema: RankingSchema,
            schemaName: 'SignificanceRanking',
          });

          const scores = out ? scoresFromRanking(out.ranked, batch.map((r) => r.id)) : null;
          if (!scores) {
            // Rather than fall back to an absolute score â€” the very thing this
            // replaces â€” an unusable ranking leaves the batch untouched. Those
            // rows stay unscored and a re-run picks them up.
            rejected += 1;
            logger.warn(
              `[significance] batch ${batchIndex + 1} produced an unusable ranking ` +
                `(missing, duplicated, or anchors out of order) â€” left unscored.`,
            );
            continue;
          }

          for (const row of batch) {
            const next = scores.get(row.id);
            if (next === undefined) continue;
            const band = bandOf(next);
            await sql`
              UPDATE factors
                 SET significance = ${next}, significance_scale = ${band}
               WHERE id = ${row.id}::uuid
            `.execute(db);
            scored += 1;
            if (Math.abs(next - row.significance) >= MIN_DELTA) moved += 1;
            logger.info(
              `[significance] ${row.significance.toFixed(2)} â†’ ${next.toFixed(2)} ` +
                `(${band.padEnd(11)}) ${row.name.slice(0, 44)}`,
            );
          }
        } catch (err) {
          rejected += 1;
          logger.error(`[significance] batch ${batchIndex + 1} failed: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    logger.info(
      `[significance] done â€” ${scored} scored, ${moved} moved by â‰¥${MIN_DELTA}, ` +
        `${rejected} batch(es) rejected.`,
    );
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  backfillSignificance().catch((err: unknown) => {
    console.error('[significance] fatal:', err);
    process.exitCode = 1;
  });
}


