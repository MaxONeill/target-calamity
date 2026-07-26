/**
 * GET /api/field — the shader's input set.
 *
 * Deliberately has NO camera and NO cursor parameters. The field is a function
 * of the data alone, so two clients holding the same `fieldEpoch` are provably
 * rendering the same planet.
 *
 * Returns verified factors ranked by actual field influence — ABS(effect *
 * significance), the numerator of the accumulation kernel — capped at a fixed
 * rendering budget. `, id ASC` is a MANDATORY tiebreak: without it Postgres has
 * no stable order for ties and two clients can receive different sets. Backed by
 * `idx_factors_field_rank ON factors ((ABS(effect*significance)) DESC, id ASC)`.
 *
 * Each entry carries server-derived causal `domains` (see `shared/domains.ts`),
 * which the Clock uses to link factor forces to the tipping points they act on.
 * Deriving them here keeps the field lean — the domain tags cross the wire, not
 * the description they were derived from.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { FieldResponseSchema } from '../../shared/schema.js';
import type { FieldPin, FieldResponse, GlobalFactor, TippingPoint } from '../../shared/types.js';
import { classifyDomains, isDomain, type Domain } from '../../shared/domains.js';
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

/** Raw factor row the field set is projected from. */
interface FieldRow {
  id: string;
  name: string;
  description: string;
  spatial_path: string;
  effect: number;
  significance: number;
  lat: number | null;
  lon: number | null;
  tipping_point: TippingPoint | null;
  /** Stored LLM-assigned tags; `[]` on rows predating classification. */
  domains: string[] | null;
  updated_at: string;
}

/**
 * The factor's causal domains: the stored (LLM-assigned) tags when present,
 * else the deterministic keyword classifier as a fallback for rows that predate
 * classification (seed mode, offline stub, un-re-ingested rows).
 */
function domainsOf(row: FieldRow): Domain[] {
  const stored = (row.domains ?? []).filter(isDomain);
  return stored.length > 0 ? stored : classifyDomains(row.name, row.description, row.spatial_path);
}

/** Spread the tipping point only when present, to satisfy the `.optional()` (never-null) schema. */
function tippingPointField(tp: TippingPoint | null | undefined): { tippingPoint?: TippingPoint } {
  return tp ? { tippingPoint: tp } : {};
}

/** Project the located rows to lean field pins with their domain tags. */
function toPins(rows: readonly FieldRow[]): FieldPin[] {
  return rows
    .filter((r): r is FieldRow & { lat: number; lon: number } => r.lat !== null && r.lon !== null)
    .map((r) => ({
      id: r.id,
      effect: r.effect,
      significance: r.significance,
      lat: r.lat,
      lon: r.lon,
      domains: domainsOf(r),
      ...tippingPointField(r.tipping_point),
    }));
}

/** Project the placeless rows to global factors with their domain tags. */
function toGlobalFactors(rows: readonly FieldRow[]): GlobalFactor[] {
  return rows
    .filter((r) => r.lat === null || r.lon === null)
    .map((r) => ({
      id: r.id,
      name: r.name,
      effect: r.effect,
      significance: r.significance,
      domains: domainsOf(r),
      ...tippingPointField(r.tipping_point),
    }));
}

function fieldEpochOf(rows: readonly { updated_at: string }[]): string {
  if (rows.length === 0) return new Date().toISOString();
  return rows.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), rows[0]!.updated_at);
}

/** Raw projections row. `points` is JSONB; the rest are plain columns. */
interface ProjectionRow {
  id: string;
  quantity: string;
  unit: string;
  baseline: string | null;
  scenario: string | null;
  assumes_future_action: boolean | null;
  points: { year: number; value: number }[];
  source_url: string;
  source_title: string | null;
}

/**
 * Every projection, shaped for the wire.
 *
 * Unfiltered on purpose: a threshold is matched to a projection on the CLIENT
 * (see `deriveClock`), so narrowing here to "only the ones currently referenced"
 * would require running the match twice, in two languages, and any drift
 * between them would silently drop an anchor. The set is small — one row per
 * quantity, not per factor — so sending it whole is cheaper than the bug.
 *
 * SQL nulls are stripped rather than passed through: the schemas are
 * `.optional()` and never `.nullable()`, per the project's read-path rule.
 */
async function projectionsDb(db: Database): Promise<FieldResponse['projections']> {
  const { rows } = await sql<ProjectionRow>`
    SELECT id, quantity, unit, baseline, scenario, assumes_future_action,
           points, source_url, source_title
      FROM projections
     ORDER BY quantity ASC, id ASC
  `.execute(db);

  return rows.map((r) => ({
    id: r.id,
    quantity: r.quantity,
    unit: r.unit,
    points: r.points,
    sourceUrl: r.source_url,
    ...(r.baseline !== null ? { baseline: r.baseline } : {}),
    ...(r.scenario !== null ? { scenario: r.scenario } : {}),
    ...(r.assumes_future_action !== null
      ? { assumesFutureAction: r.assumes_future_action }
      : {}),
    ...(r.source_title !== null ? { sourceTitle: r.source_title } : {}),
  }));
}

async function fieldDb(db: Database): Promise<FieldResponse> {
  const { rows } = await sql<FieldRow>`
    SELECT id, name, description, spatial_path::text AS spatial_path,
           effect, significance, lat, lon, tipping_point, domains,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    FROM factors
    WHERE verification_state = 'verified'
      AND ABS(effect * significance) >= ${WEIGHT_FLOOR}
    ORDER BY ABS(effect * significance) DESC, id ASC
    LIMIT ${FIELD_CAPACITY}
  `.execute(db);

  return {
    pins: toPins(rows),
    globalFactors: toGlobalFactors(rows),
    projections: await projectionsDb(db),
    fieldEpoch: fieldEpochOf(rows),
  };
}

function fieldSeed(): FieldResponse {
  const rows: FieldRow[] = SEED_FACTORS.filter(
    (f) => f.verificationState === 'verified' && Math.abs(f.effect * f.significance) >= WEIGHT_FLOOR,
  )
    .sort((a, b) => {
      const wa = Math.abs(a.effect * a.significance);
      const wb = Math.abs(b.effect * b.significance);
      if (wb !== wa) return wb - wa;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // id ASC
    })
    .slice(0, FIELD_CAPACITY)
    .map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      spatial_path: f.spatialPath,
      effect: f.effect,
      significance: f.significance,
      lat: f.lat,
      lon: f.lon,
      tipping_point: f.tippingPoint ?? null,
      domains: null,
      updated_at: f.updatedAt,
    }));

  return {
    pins: toPins(rows),
    globalFactors: toGlobalFactors(rows),
    // Seed mode has no projections table. Seed thresholds are year-stated, so
    // nothing in the curated set needs one — but the field MUST still carry the
    // key, or the client's schema parse diverges between modes.
    projections: [],
    fieldEpoch: fieldEpochOf(rows),
  };
}

export default async function fieldRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/field', async (_req: FastifyRequest, _reply: FastifyReply): Promise<FieldResponse> => {
    const ctx = fastify.appCtx;
    const response = ctx.mode === 'db' ? await fieldDb(ctx.db) : fieldSeed();
    // Re-validate our own response against the shared contract.
    return FieldResponseSchema.parse(response);
  });
}
