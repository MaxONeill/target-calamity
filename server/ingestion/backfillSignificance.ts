/**
 * Re-score `significance` against the scale rubric.
 *
 * The original instruction to the extractor was, in full: "significance is in
 * [0, 1] (weight/confidence)". No rubric, no anchors, and it conflated magnitude
 * with confidence — which is scored separately by the reputability gate. Given
 * an unanchored [0,1] and a corpus where everything is newsworthy, the model
 * clustered everything high: 88 of 89 verified factors between 0.40 and 0.93,
 * 22 of them at exactly 0.70, and the bottom half of the range unused.
 *
 * The visible symptom: global coral-reef collapse and an Iberian lynx recovery
 * both scored 0.90. One is a planetary biome; the other is one species in one
 * country.
 *
 * This matters more than a display detail. `significance` is triple-loaded — it
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
 * name, description and spatial path — scale is a property of what the factor
 * says, so re-reading its sources would buy nothing and cost another round of retrieval.
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

const CONCURRENCY = 4;

/** Movement smaller than this is noise in the rubric's own terms — skip the write. */
const MIN_DELTA = 0.05;

const SignificanceSchema = z.object({
  /** The scale band, named. Forces the tier decision before the number. */
  scale: z.enum(['planetary', 'continental', 'national', 'subnational', 'site']),
  significance: z.number(),
  reasoning: z.string(),
});

/**
 * Bands the number must fall inside for its declared scale.
 *
 * Naming the tier first and clamping to it is what stops the drift back to 0.8:
 * a free number regresses to the model's prior, whereas a tier is a discrete
 * decision it has to defend. The clamp means a mis-typed number cannot quietly
 * reintroduce the compression this backfill exists to remove.
 */
const BANDS: Record<z.infer<typeof SignificanceSchema>['scale'], [number, number]> = {
  planetary: [0.9, 1.0],
  continental: [0.7, 0.85],
  national: [0.4, 0.65],
  subnational: [0.15, 0.35],
  site: [0.02, 0.14],
};

const SCORE_SYSTEM =
  'You score SIGNIFICANCE for a reality tracker: how much of the system a factor ' +
  'moves. Not how newsworthy or morally serious it is, and NOT how confident you ' +
  'are in the source — credibility is scored separately and must not enter here. ' +
  'TWO THINGS ARE BEING JUDGED TOGETHER, and confusing them is the main error: ' +
  'BREADTH (how much of the world it touches) and DEPTH (how structurally it ' +
  'changes what it touches). A condition can be worldwide and still shallow. ' +
  'Choose the band, then a number inside it: ' +
  'planetary (0.90-1.00) — RESERVED for altering a named Earth-system subsystem ' +
  'or a global life-support supply: the climate system, ocean circulation, ice ' +
  'sheets, a major biome, the global food, water or energy supply. A social, ' +
  'economic or political condition occurring worldwide is NOT planetary, however ' +
  'grave: global inequality, disinformation, or a governance failure is broad but ' +
  'does not alter an Earth-system subsystem. ' +
  'continental (0.70-0.85) — multi-national in reach AND structural in effect; ' +
  'a globally dominant sector, or a worldwide social/economic condition that ' +
  'genuinely reshapes how societies function. ' +
  'national (0.40-0.65) — one country, one sector, or one biome region. ' +
  'subnational (0.15-0.35) — part of a country, a single species, one ecosystem. ' +
  'site (0.02-0.14) — a single location or organisation. ' +
  'Worked contrasts: global coral-reef collapse is PLANETARY (a biome is lost). ' +
  'An Iberian lynx recovery is SUBNATIONAL — a real success, one species, one ' +
  'country. Global inequality driving financial instability is CONTINENTAL at ' +
  'most, not planetary: it is worldwide but it does not move an Earth system. ' +
  'A risk assessment, a funding shortfall, a governance gap, or a policy proposal ' +
  'describes our CAPACITY TO RESPOND rather than the state of the system, and is ' +
  'capped at continental. ' +
  'A single-country finding is national UNLESS that country demonstrably moves a ' +
  'global system (Chinese or US emissions, say), which you must justify. ' +
  'CALIBRATION: in a balanced corpus roughly 1 in 10 findings is planetary, 2 in ' +
  '10 continental, 4 in 10 national, and 3 in 10 subnational or site. If you find ' +
  'yourself calling most things planetary, you are rating importance, not scale.';

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
     ORDER BY id ASC
  `.execute(db);
  return rows;
}

export async function backfillSignificance(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[significance] no DATABASE_URL — nothing to do, exiting.');
    return;
  }
  if (!hasLiveCredentials()) {
    logger.warn('[significance] no FIREWORKS_API_KEY — cannot re-score. Exiting.');
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

    logger.info(
      `[significance] ${rows.length} factor(s) to re-score (1 LLM call each, no retrieval).`,
    );
    if (dryRun || rows.length === 0) {
      logger.info(
        dryRun ? '[significance] dry run — no calls, no writes.' : '[significance] nothing to do.',
      );
      return;
    }

    const client = getLlmClient();
    const model = ingestModel();
    let done = 0;
    let moved = 0;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < rows.length) {
        const row = rows[cursor++]!;
        try {
          const out = await structuredCompletion({
            client,
            model,
            system: SCORE_SYSTEM,
            user:
              `NAME: ${row.name}\n\nDESCRIPTION: ${row.description}\n\n` +
              `SPATIAL PATH: ${row.spatial_path}`,
            schema: SignificanceSchema,
            schemaName: 'SignificanceScore',
          });
          done += 1;
          if (!out) continue;

          const [lo, hi] = BANDS[out.scale];
          const next = Math.min(hi, Math.max(lo, out.significance));
          const delta = next - row.significance;

          await sql`
            UPDATE factors
               SET significance = ${next},
                   significance_scale = ${out.scale}
             WHERE id = ${row.id}::uuid
          `.execute(db);

          if (Math.abs(delta) >= MIN_DELTA) moved += 1;
          logger.info(
            `[significance] ${row.significance.toFixed(2)} → ${next.toFixed(2)} ` +
              `(${out.scale.padEnd(11)}) ${row.name.slice(0, 44)}`,
          );
        } catch (err) {
          done += 1;
          logger.error(`[significance] failed for ${row.id}: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    logger.info(`[significance] done — ${done} scored, ${moved} moved by ≥${MIN_DELTA}.`);
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
  backfillSignificance().catch((err: unknown) => {
    console.error('[significance] fatal:', err);
    process.exitCode = 1;
  });
}
