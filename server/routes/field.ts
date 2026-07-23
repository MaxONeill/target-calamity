/**
 * GET /api/field — the shader's input set.
 *
 * Deliberately has NO camera and NO cursor parameters. The field is a function
 * of the data alone, so two clients holding the same `fieldEpoch` are provably
 * rendering the same planet (confirmed defect #5: the spec fed the shader from
 * the paginated, viewport-clipped cache, making the heatmap a function of
 * scroll position and camera angle).
 *
 * Returns verified factors ranked by actual field influence — ABS(effect *
 * significance), the numerator of the accumulation kernel — capped at a fixed
 * rendering budget. `, id ASC` is a MANDATORY tiebreak: without it Postgres has
 * no stable order for ties and two clients can receive different sets. Backed by
 * `idx_factors_field_rank ON factors ((ABS(effect*significance)) DESC, id ASC)`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { FieldResponseSchema } from '../../shared/schema.js';
import type { FieldPin, FieldResponse, GlobalFactor } from '../../shared/types.js';
import type { Database } from '../db.js';
import { SEED_FACTORS } from '../../shared/seed.js';

/** Rendering-budget constant, independent of feed state. */
const FIELD_CAPACITY = 2048;

/**
 * Minimum field influence to be worth baking. Pins whose ABS(effect *
 * significance) rounds to nothing contribute nothing to the accumulation and
 * only waste a texel slot.
 */
const WEIGHT_FLOOR = 1e-6;

/** One-row wrapper: the whole response assembled as JSON in the database. */
interface FieldQueryRow {
  payload: FieldResponse;
}

/**
 * Drop a null `tippingPoint` so the property is simply absent — `TippingPointSchema`
 * is `.optional()` (not `.nullable()`), so a literal `null` from the JSON assembly
 * would be rejected. The pin must CARRY its tipping point so the Clock,
 * which reads the FIELD set, gets it in DB mode too.
 */
function stripNullTippingPoint<T extends { tippingPoint?: unknown }>(entry: T): T {
  if (entry.tippingPoint == null) {
    const { tippingPoint: _omit, ...rest } = entry;
    return rest as T;
  }
  return entry;
}

async function fieldDb(db: Database): Promise<FieldResponse> {
  const { rows } = await sql<FieldQueryRow>`
    WITH picked AS (
      SELECT id, name, effect, significance, lat, lon, tipping_point, updated_at
      FROM factors
      WHERE verification_state = 'verified'
        AND ABS(effect * significance) >= ${WEIGHT_FLOOR}
      ORDER BY ABS(effect * significance) DESC, id ASC
      LIMIT ${FIELD_CAPACITY}
    )
    SELECT json_build_object(
      'pins', COALESCE(
        json_agg(
          json_build_object(
            'id', id, 'effect', effect, 'significance', significance, 'lat', lat, 'lon', lon,
            'tippingPoint', tipping_point
          )
          ORDER BY ABS(effect * significance) DESC, id ASC
        ) FILTER (WHERE lat IS NOT NULL),
        '[]'::json
      ),
      'globalFactors', COALESCE(
        json_agg(
          json_build_object(
            'id', id, 'name', name, 'effect', effect, 'significance', significance,
            'tippingPoint', tipping_point
          )
          ORDER BY ABS(effect * significance) DESC, id ASC
        ) FILTER (WHERE lat IS NULL),
        '[]'::json
      ),
      'fieldEpoch', to_char(COALESCE(MAX(updated_at), NOW()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) AS payload
    FROM picked
  `.execute(db);

  const first = rows[0];
  if (!first) {
    return { pins: [], globalFactors: [], fieldEpoch: new Date().toISOString() };
  }
  return {
    ...first.payload,
    pins: first.payload.pins.map(stripNullTippingPoint),
    globalFactors: first.payload.globalFactors.map(stripNullTippingPoint),
  };
}

function fieldSeed(): FieldResponse {
  const picked = SEED_FACTORS.filter(
    (f) => f.verificationState === 'verified' && Math.abs(f.effect * f.significance) >= WEIGHT_FLOOR,
  )
    .sort((a, b) => {
      const wa = Math.abs(a.effect * a.significance);
      const wb = Math.abs(b.effect * b.significance);
      if (wb !== wa) return wb - wa;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // id ASC
    })
    .slice(0, FIELD_CAPACITY);

  // Copy tippingPoint through so the Clock (which reads the field set) anchors to
  // it in seed mode too. Spread it only when present, to keep the key
  // absent (not null) under exactOptionalPropertyTypes / the `.optional()` schema.
  const pins: FieldPin[] = picked
    .filter((f): f is typeof f & { lat: number; lon: number } => f.lat !== null && f.lon !== null)
    .map((f) => ({
      id: f.id,
      effect: f.effect,
      significance: f.significance,
      lat: f.lat,
      lon: f.lon,
      ...(f.tippingPoint ? { tippingPoint: f.tippingPoint } : {}),
    }));

  const globalFactors: GlobalFactor[] = picked
    .filter((f) => f.lat === null || f.lon === null)
    .map((f) => ({
      id: f.id,
      name: f.name,
      effect: f.effect,
      significance: f.significance,
      ...(f.tippingPoint ? { tippingPoint: f.tippingPoint } : {}),
    }));

  // fieldEpoch = MAX(updated_at) over the set (ISO strings sort lexically in UTC).
  const first = picked[0];
  const fieldEpoch = first
    ? picked.reduce((max, f) => (f.updatedAt > max ? f.updatedAt : max), first.updatedAt)
    : new Date().toISOString();

  return { pins, globalFactors, fieldEpoch };
}

export default async function fieldRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/field', async (_req: FastifyRequest, _reply: FastifyReply): Promise<FieldResponse> => {
    const ctx = fastify.appCtx;
    const response = ctx.mode === 'db' ? await fieldDb(ctx.db) : fieldSeed();
    // Re-validate our own response against the shared contract.
    return FieldResponseSchema.parse(response);
  });
}
