/**
 * Give placeless factors a REPRESENTATIVE point on the globe.
 *
 * 78 of 114 verified factors had no coordinates, so the globe was showing an
 * absence of research rather than an absence of events. Most of them are about
 * somewhere — warm-water coral reefs are not nowhere — but the source described
 * a phenomenon rather than a point, so nothing could be pinned.
 *
 * WHY THIS IS NOT FABRICATION, and the line it has to stay on. A representative
 * point is an EDITORIAL CHOICE about where a distributed phenomenon is best
 * shown, not a claim that anyone measured it there. That is only honest while
 * the distinction survives to the reader, so it does: `location_kind` travels
 * with the coordinates to the wire, the pin is rendered visibly thinner, and the
 * detail panel says the source did not place it and gives the reason. A
 * representative pin that looked identical to a measured one WOULD be a
 * fabrication, which is why the column is NOT NULL-able independently of lat.
 *
 * REFUSING IS A REAL ANSWER and the prompt is built around it. "1.9 billion
 * vaccine doses delivered globally" and "global inequality" have no honest
 * point; an equator pin for them would be worse than the gap it fills. The
 * model is told to return placeable=false for those, and roughly a third of the
 * set should come back that way.
 *
 *   npm run backfill:locations             # place the unplaced
 *   DRY_RUN=1 npm run backfill:locations   # list candidates, no calls, no writes
 *   LIMIT=20 npm run backfill:locations    # cap the batch
 *   FORCE=1 npm run backfill:locations     # re-place representative ones too
 *
 * COST: NO RETRIEVAL. One LLM turn per factor and nothing else — this asks where
 * coral reefs are, not what is true about them, so there is nothing to cite. The
 * factor's own citation is untouched, because the claim has not changed; only
 * where we draw it has.
 *
 * FORCE never re-places a `measured` factor. A source put that pin there and an
 * editorial guess must not overwrite evidence.
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

const PlacementSchema = z.object({
  /**
   * False when no single point can honestly stand for this factor. Expected
   * often: a worldwide count, a market, a norm, an institution.
   */
  placeable: z.boolean(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  /** Lower-case ISO-3166 alpha-2 when the point sits in one country, else null. */
  countryCode: z.string().nullable(),
  /** The place in words — "Great Barrier Reef", "the Sahel", "Amazon basin". */
  placeName: z.string(),
  /** Why this point stands for this factor. Shown to the reader. */
  reason: z.string(),
});

const PLACE_SYSTEM =
  'You choose where on a globe a factor should be DRAWN. This is a cartographic ' +
  'decision, not a factual claim: the number in the factor is already sourced, ' +
  'and you are only deciding where to put the marker. It will be labelled to the ' +
  'reader as a representative location, not a measurement. ' +
  'Choose the most RECOGNISABLE, CANONICAL place that the phenomenon is actually ' +
  'about. Warm-water coral reef loss belongs on the Great Barrier Reef or the ' +
  'Coral Triangle, not in the middle of the Pacific. Permafrost thaw belongs in ' +
  'the Siberian or Alaskan Arctic. Amazon dieback belongs in the Amazon basin. ' +
  'Sahel drought belongs in the Sahel. Prefer a real named feature — a reef, a ' +
  'basin, an ice sheet, a mountain range, a city, a country — over an arbitrary ' +
  'point in open ocean, unless the ocean IS the subject (a gyre, a current, a ' +
  'garbage patch), in which case place it on that feature. ' +
  'THE TEST, and apply it in this order. Does this phenomenon happen in the ' +
  'PHYSICAL WORLD, in places a map can show? Then PLACE IT, at the most ' +
  'canonical example, even when it happens in many places and even when the ' +
  'title says "global". Global coral decline still happens on reefs; put it on ' +
  'a reef. Species extinction happens in biodiversity hotspots; put it in one. ' +
  'Freshwater collapse happens in river basins; pick the most affected. A ' +
  'distributed physical phenomenon is exactly what a representative point is ' +
  'FOR — it is not a reason to refuse. ' +
  'RETURN placeable=false only when the subject is genuinely ASPATIAL: a count ' +
  'or total aggregated over the whole world (doses delivered, deaths averted, ' +
  'members recruited), a global average or index, an economic or market ' +
  'condition, an international agreement, a norm, an institution, a policy ' +
  'position, or a well-mixed property of the whole atmosphere such as the global ' +
  'mean temperature or an atmospheric concentration. For those, no point means ' +
  'anything and a pin would mislead. ' +
  'Do not refuse merely because the phenomenon is widespread, or because the ' +
  'word "global" appears in the title. Ask only whether it HAPPENS SOMEWHERE. ' +
  'lat and lon are decimal degrees, lat in [-90, 90] and lon in [-180, 180]. ' +
  'countryCode is lower-case ISO-3166 alpha-2 when the point falls inside one ' +
  'country, and null for an ocean, a multi-country region or a global feature. ' +
  'placeName names the place a person would recognise. reason is ONE plain ' +
  'sentence saying why that point stands for this factor — it is shown to the ' +
  'reader beside the pin, so write it for them, not as a note to yourself.';

interface Row {
  id: string;
  name: string;
  description: string;
  spatial_path: string;
}

async function candidates(db: Database, force: boolean): Promise<Row[]> {
  // Never `measured`: a source placed those, and an editorial guess must not
  // overwrite evidence. FORCE only re-opens our own previous guesses.
  const { rows } = await sql<Row>`
    SELECT id, name, description, spatial_path::text AS spatial_path
      FROM factors
     WHERE verification_state <> 'rejected'
       AND (location_kind IS NULL OR (${force} AND location_kind = 'representative'))
     ORDER BY ABS(effect * significance) DESC, id
  `.execute(db);
  return rows;
}

export async function backfillLocations(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[locations] no DATABASE_URL — nothing to do, exiting.');
    return;
  }
  if (!hasLiveCredentials()) {
    logger.warn(
      '[locations] no FIREWORKS_API_KEY — the offline stub cannot reason about ' +
        'geography, and a stubbed coordinate would be an invented place. Exiting.',
    );
    return;
  }

  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const force = args.includes('--force') || process.env.FORCE === '1';
  const limit = Number.parseInt(process.env.LIMIT ?? '', 10);

  const { db, pool } = createDatabase(databaseUrl);
  try {
    let rows = await candidates(db, force);
    const total = rows.length;
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

    logger.info(
      `[locations] ${rows.length} of ${total} unplaced factor(s)${force ? ' (--force)' : ''}. ` +
        'One LLM turn each, no retrieval.',
    );
    if (rows.length < total) {
      logger.info(`[locations] ${total - rows.length} left for a later run (LIMIT).`);
    }
    if (dryRun || rows.length === 0) {
      for (const r of rows) logger.info(`[locations]   ${r.name.slice(0, 78)}`);
      logger.info(
        dryRun ? '[locations] dry run — no calls, no writes.' : '[locations] nothing to do.',
      );
      return;
    }

    const client = getLlmClient();
    const model = ingestModel();
    let placed = 0;
    let refused = 0;

    for (const row of rows) {
      try {
        const out = await structuredCompletion({
          client,
          model,
          system: PLACE_SYSTEM,
          user: `FACTOR: ${row.name}\nDESCRIPTION: ${row.description}\nCURRENT PATH: ${row.spatial_path}`,
          schema: PlacementSchema,
          schemaName: 'Placement',
        });

        if (!out?.placeable || out.lat === null || out.lon === null) {
          refused += 1;
          // Left placeless deliberately, and worth seeing: the set of factors
          // with no honest point is a real property of the corpus, not a
          // failure of this pass.
          logger.info(`[locations] no honest point for "${row.name.slice(0, 56)}"`);
          continue;
        }

        // Range-checked rather than trusted. A latitude of 120 is not a place,
        // and letting it through would put a pin at a pole-adjacent artefact of
        // the projection rather than anywhere real.
        if (Math.abs(out.lat) > 90 || Math.abs(out.lon) > 180) {
          logger.warn(
            `[locations] out-of-range ${out.lat},${out.lon} for "${row.name.slice(0, 40)}" — skipped.`,
          );
          continue;
        }

        const cc = out.countryCode?.trim().toLowerCase() ?? '';
        // Only NARROW the path — global.au is more specific than global. An
        // existing country path is never widened by a guess about the point.
        const spatialPath =
          /^[a-z]{2}$/.test(cc) && row.spatial_path === 'global'
            ? `global.${cc}`
            : row.spatial_path;

        const note = `${out.placeName.trim().slice(0, 120)} — ${out.reason.trim().slice(0, 400)}`;

        await sql`
          UPDATE factors
             SET lat = ${out.lat}, lon = ${out.lon},
                 spatial_path = ${spatialPath}::ltree,
                 location_kind = 'representative',
                 location_note = ${note}
           WHERE id = ${row.id}::uuid
        `.execute(db);

        placed += 1;
        logger.info(
          `[locations] ${row.name.slice(0, 40)} → ${out.placeName.slice(0, 32)} ` +
            `(${out.lat.toFixed(1)}, ${out.lon.toFixed(1)})`,
        );
      } catch (err) {
        logger.error(`[locations] "${row.name.slice(0, 40)}" failed: ${(err as Error).message}`);
      }
    }

    logger.info(
      `[locations] done — ${placed} placed representatively, ${refused} left placeless on purpose.`,
    );
    if (placed > 0) await notifyFieldChanged(db);
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  backfillLocations().catch((err: unknown) => {
    console.error('[locations] fatal:', err);
    process.exitCode = 1;
  });
}
