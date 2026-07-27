/**
 * GET /api/factors  (alias: GET /api/feed) — the sidebar feed.
 *
 * Cursor-paginated and viewport-clipped. This path drives the sidebar and
 * nothing else; it must never feed the shader, which is `/api/field`.
 *
 * Citations come back inline via a `LATERAL` + `json_agg` in one round trip
 * rather than an N+1 per page.
 *
 * Viewport filtering intersects a PostGIS envelope rather than testing
 * `lat/lon BETWEEN`, which returns zero rows across the antimeridian and
 * degenerates near the poles. A viewport crossing the date line is split into
 * two envelopes.
 *
 * Recent mode keysets on the immutable `seq`; magnitude mode is a bounded top-N
 * snapshot. See pagination.ts for why neither keys on a column that ingestion
 * mutates.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';
import { z } from 'zod';
import {
  FactorByIdResponseSchema,
  FeedResponseSchema,
  SortModeSchema,
  ViewportSchema,
} from '../../shared/schema.js';
import type { Factor, FeedResponse, Viewport } from '../../shared/types.js';
import type { Database } from '../db.js';
import {
  CursorError,
  encodeCursor,
  factorInViewport,
  FULL_GLOBE_VIEWPORT,
  resolveCursor,
  type RecentCursor,
} from '../pagination.js';
import { SEED_FACTORS } from '../../shared/seed.js';

/** Feed page size. */
const FEED_PAGE_SIZE = 50;

/** Guards the `:id` param so a non-uuid never reaches a `::uuid` cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Magnitude mode is a bounded top-N snapshot, not deep pagination (:
 * `abs(effect)` is Phase-D-mutated and unsafe as a keyset key). This caps the
 * "heaviest disruptions" view at a fixed budget.
 */
const MAGNITUDE_CAP = 200;

/* -------------------------------------------------------------------------- */
/* Query-param contract                                                       */
/* -------------------------------------------------------------------------- */

/**
 * GET query string. Viewport arrives as four optional scalars (a nested object
 * does not travel cleanly in a query string). It is all-or-nothing: absent →
 * whole globe; all four → a clipped viewport; a partial set → 400.
 */
const FeedQuerySchema = z.object({
  sortMode: SortModeSchema.default('recent'),
  cursor: z.string().optional(),
  minLat: z.coerce.number().gte(-90).lte(90).optional(),
  maxLat: z.coerce.number().gte(-90).lte(90).optional(),
  minLon: z.coerce.number().gte(-180).lte(180).optional(),
  maxLon: z.coerce.number().gte(-180).lte(180).optional(),
});

/** Shape of one row from the feed SQL: the whole factor as JSON + keyset fields. */
interface FeedRow {
  factor: Factor;
  seq: string;
  id: string;
}

/* -------------------------------------------------------------------------- */
/* SQL fragments (DB mode)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * PostGIS viewport predicate. Intersects each factor's `geog` (cast to
 * planar geometry in lon/lat) with the viewport envelope. When `minLon > maxLon`
 * the viewport crosses the antimeridian, so the test is a UNION of the
 * `[minLon, 180]` and `[-180, maxLon]` envelopes — never `Math.min/max`, which
 * would select the complement of the viewport.
 *
 * Note: `geog::geometry` is a functional expression, so the plain GiST index on
 * `geog` does not serve it; recent mode is bounded by the `seq` index + LIMIT,
 * and the migration may add a functional index if selectivity demands it.
 */
function viewportFilter(vp: Viewport): RawBuilder<unknown> {
  // A placeless factor has a NULL geog, and ST_Intersects would drop it from
  // every page. It is nowhere in particular, so it can never be out of view.
  if (vp.minLon <= vp.maxLon) {
    return sql`(f.geog IS NULL OR ST_Intersects(f.geog::geometry, ST_MakeEnvelope(${vp.minLon}, ${vp.minLat}, ${vp.maxLon}, ${vp.maxLat}, 4326)))`;
  }
  return sql`(
      f.geog IS NULL
   OR ST_Intersects(f.geog::geometry, ST_MakeEnvelope(${vp.minLon}, ${vp.minLat}, 180, ${vp.maxLat}, 4326))
   OR ST_Intersects(f.geog::geometry, ST_MakeEnvelope(-180, ${vp.minLat}, ${vp.maxLon}, ${vp.maxLat}, 4326))
  )`;
}

/** Inline citations: newest-first, one round trip, no N+1. */
const CITATIONS_LATERAL = sql`
  LEFT JOIN LATERAL (
    SELECT json_agg(
             json_build_object(
               'id',          ct.id,
               'factorId',    ct.factor_id,
               'sourceUrl',   ct.source_url,
               'publisher',   ct.publisher,
               'quoteSnippet', ct.quote_snippet,
               'analystNotes', ct.analyst_notes,
               'retrievedAt', to_char(ct.retrieved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             )
             ORDER BY ct.retrieved_at DESC
           ) AS citations
    FROM citations ct
    WHERE ct.factor_id = f.id
  ) c ON true`;

/**
 * Inline researched efforts, same one-round-trip shape as citations.
 *
 * A separate LATERAL rather than a second join on the same subquery: joining
 * two one-to-many tables directly would cross-multiply, and the citation
 * aggregate would silently multiply by the effort count.
 *
 * Insertion order, deliberately not a ranking — reporting who is working on
 * something is defensible, ordering them by promise is not.
 */
const EFFORTS_LATERAL = sql`
  LEFT JOIN LATERAL (
    SELECT json_agg(
             json_build_object(
               'id',          o.id,
               'name',        o.name,
               'description', o.description,
               'stage',       o.stage,
               'sourceUrl',   l.source_url,
               'publisher',   l.publisher,
               'quote',       l.quote,
               -- Reach across the whole set, so the panel can say this body
               -- also works on other thresholds. Counted over ALL its links,
               -- not just this one.
               'linkCount',   (SELECT count(*) FROM organisation_links l2
                                WHERE l2.organisation_id = o.id),
               -- What it has measurably achieved. These are real factors with a
               -- real effect, and they are how an effort reaches the Clock.
               'outcomes',    COALESCE((
                 SELECT json_agg(json_build_object(
                          'factorId', pf.id, 'name', pf.name,
                          'effect', pf.effect, 'significance', pf.significance))
                   FROM organisation_links pl
                   JOIN factors pf ON pf.id = pl.factor_id
                  WHERE pl.organisation_id = o.id AND pl.relation = 'produced'
               ), '[]'::json)
             )
             ORDER BY l.created_at, o.id
           ) AS efforts
    FROM organisation_links l
    JOIN organisations o ON o.id = l.organisation_id
    -- Relation 'addresses' only. A factor's own outcome link would otherwise
    -- list the organisation beneath the very achievement it produced.
    -- (No backticks in here: this is a template literal.)
    WHERE l.factor_id = f.id AND l.relation = 'addresses'
  ) e ON true`;

/**
 * The whole factor assembled server-side as JSON. Timestamps are formatted to
 * microsecond ISO-8601 text and `spatial_path` is rendered ::text.
 */
const FACTOR_JSON = sql`
  json_build_object(
    'id',                    f.id,
    'spatialPath',           f.spatial_path::text,
    'name',                  f.name,
    'description',           f.description,
    'effect',                f.effect,
    'significance',          f.significance,
    'lat',                   f.lat,
    'lon',                   f.lon,
    'zoneLevel',             f.zone_level,
    'verificationState',     f.verification_state,
    'createdAt',             to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt',             to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'citations',             COALESCE(c.citations, '[]'::json),
    'efforts',               COALESCE(e.efforts, '[]'::json),
    'tippingPoint',          f.tipping_point,
    'locationKind',          f.location_kind,
    'locationNote',          f.location_note,
    'reputabilityScore',     f.reputability_score,
    'reputabilityReasoning', f.reputability_reasoning
  )`;

/**
 * The tipping-point column is NULL for most factors, and `TippingPointSchema` is
 * `.optional()` (not `.nullable()`), so a literal `"tippingPoint": null` from the
 * JSON assembly would be REJECTED by the contract. Drop the key when it is null so
 * the property is simply absent. node-postgres has already parsed the
 * jsonb into an object, so no JSON.parse is needed here.
 */
function stripNullTippingPoint(factor: Factor): Factor {
  if (factor.tippingPoint == null) {
    const { tippingPoint: _omit, ...rest } = factor;
    return rest;
  }
  return factor;
}

/**
 * The reputability audit-trail columns are NULL for seed/curated
 * factors and for anything ingested before migration 004, and both schema fields
 * are `.optional()` (never `.nullable()`), so a literal `null` from the JSON
 * assembly would be REJECTED by the contract. Drop each key when it is null so the
 * property is simply absent — same pattern as {@link stripNullTippingPoint}.
 */
function stripNullReputability(factor: Factor): Factor {
  let out = factor;
  if (out.reputabilityScore == null) {
    const { reputabilityScore: _s, ...rest } = out;
    out = rest;
  }
  if (out.reputabilityReasoning == null) {
    const { reputabilityReasoning: _r, ...rest } = out;
    out = rest;
  }
  return out;
}

/**
 * Same treatment for the placement columns, added in migration 018.
 *
 * `location_kind` is NULL on every placeless factor and `location_note` on every
 * MEASURED one — a source placed it, so there is no editorial reason to record.
 * Both schema fields are `.optional()` and never `.nullable()`, so a literal
 * null failed the contract, `FactorByIdResponseSchema.parse` threw, and the
 * selected-factor hook swallowed it and left the record null. The visible
 * symptom was the detail panel falling back to "sources are loading or
 * unavailable" on pins whose record was sitting right there — a parse failure
 * wearing the costume of a slow network.
 */
function stripNullPlacement(factor: Factor): Factor {
  let out = factor;
  if (out.locationKind == null) {
    const { locationKind: _k, ...rest } = out;
    out = rest;
  }
  if (out.locationNote == null) {
    const { locationNote: _n, ...rest } = out;
    out = rest;
  }
  return out;
}

/** Strip every never-`null` optional key the JSON assembly may have set to null. */
function mapFactorRow(factor: Factor): Factor {
  return stripNullPlacement(stripNullReputability(stripNullTippingPoint(factor)));
}

async function recentFeedDb(
  db: Database,
  viewport: Viewport,
  cursor: RecentCursor | null,
): Promise<FeedResponse> {
  const conditions: RawBuilder<unknown>[] = [viewportFilter(viewport)];
  if (cursor) {
    // Keyset over the immutable insert-only key. `seq` is unique, so `id` is a
    // belt-and-suspenders tiebreak that matches the (seq DESC, id DESC) index.
    conditions.push(sql`(f.seq, f.id) < (${cursor.seq}::bigint, ${cursor.id}::uuid)`);
  }
  const where = sql`WHERE ${sql.join(conditions, sql` AND `)}`;

  const { rows } = await sql<FeedRow>`
    SELECT ${FACTOR_JSON} AS factor, f.seq::text AS seq, f.id AS id
    FROM factors f
    ${CITATIONS_LATERAL}
    ${EFFORTS_LATERAL}
    ${where}
    ORDER BY f.seq DESC, f.id DESC
    LIMIT ${FEED_PAGE_SIZE}
  `.execute(db);

  let nextCursor: string | null = null;
  if (rows.length === FEED_PAGE_SIZE) {
    const last = rows[rows.length - 1];
    if (last) {
      nextCursor = encodeCursor({ mode: 'recent', seq: last.seq, id: last.id, viewport });
    }
  }
  return { factors: rows.map((r) => mapFactorRow(r.factor)), nextCursor };
}

async function magnitudeFeedDb(db: Database, viewport: Viewport): Promise<FeedResponse> {
  const where = sql`WHERE ${viewportFilter(viewport)}`;
  const { rows } = await sql<FeedRow>`
    SELECT ${FACTOR_JSON} AS factor, f.seq::text AS seq, f.id AS id
    FROM factors f
    ${CITATIONS_LATERAL}
    ${EFFORTS_LATERAL}
    ${where}
    ORDER BY ABS(f.effect) DESC, f.id DESC
    LIMIT ${MAGNITUDE_CAP}
  `.execute(db);
  // Bounded snapshot: never paginated.
  return { factors: rows.map((r) => mapFactorRow(r.factor)), nextCursor: null };
}

/** One factor by id, with its citations. Null when no such row exists. */
async function factorByIdDb(db: Database, id: string): Promise<Factor | null> {
  const { rows } = await sql<{ factor: Factor }>`
    SELECT ${FACTOR_JSON} AS factor
    FROM factors f
    ${CITATIONS_LATERAL}
    ${EFFORTS_LATERAL}
    WHERE f.id = ${id}::uuid
    LIMIT 1
  `.execute(db);
  const row = rows[0];
  return row ? mapFactorRow(row.factor) : null;
}

/* -------------------------------------------------------------------------- */
/* Seed mode (no DATABASE_URL)                                                 */
/* -------------------------------------------------------------------------- */

function feedSeed(
  sortMode: 'recent' | 'magnitude',
  viewport: Viewport,
  cursor: RecentCursor | null,
): FeedResponse {
  // Array position is the implicit insert order; seq = index + 1, mirroring the
  // DB's insert-only identity so the same keyset logic applies.
  const visible = SEED_FACTORS.map((f, i) => ({ f, seq: i + 1 })).filter((x) =>
    factorInViewport(x.f.lat, x.f.lon, viewport),
  );

  if (sortMode === 'magnitude') {
    const page = [...visible]
      .sort((a, b) => {
        const d = Math.abs(b.f.effect) - Math.abs(a.f.effect);
        if (d !== 0) return d;
        return a.f.id < b.f.id ? 1 : a.f.id > b.f.id ? -1 : 0; // id DESC
      })
      .slice(0, MAGNITUDE_CAP);
    return { factors: page.map((x) => x.f), nextCursor: null };
  }

  let ordered = [...visible].sort((a, b) => b.seq - a.seq); // seq DESC
  if (cursor) {
    const boundary = Number(cursor.seq);
    ordered = ordered.filter((x) => x.seq < boundary);
  }
  const page = ordered.slice(0, FEED_PAGE_SIZE);

  let nextCursor: string | null = null;
  if (page.length === FEED_PAGE_SIZE) {
    const last = page[page.length - 1];
    if (last) {
      nextCursor = encodeCursor({
        mode: 'recent',
        seq: String(last.seq),
        id: last.f.id,
        viewport,
      });
    }
  }
  return { factors: page.map((x) => x.f), nextCursor };
}

/* -------------------------------------------------------------------------- */
/* Route                                                                       */
/* -------------------------------------------------------------------------- */

export default async function factorsRoutes(fastify: FastifyInstance): Promise<void> {
  const handler = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FeedResponse | undefined> => {
    const parsed = FeedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid query parameters', detail: parsed.error.flatten() });
      return undefined;
    }
    const { sortMode, cursor: cursorToken } = parsed.data;

    // Resolve the viewport: all-or-nothing.
    const partsPresent = [
      parsed.data.minLat,
      parsed.data.maxLat,
      parsed.data.minLon,
      parsed.data.maxLon,
    ].filter((v) => v !== undefined).length;
    let viewport: Viewport;
    if (partsPresent === 0) {
      viewport = FULL_GLOBE_VIEWPORT;
    } else if (partsPresent === 4) {
      viewport = ViewportSchema.parse({
        minLat: parsed.data.minLat,
        maxLat: parsed.data.maxLat,
        minLon: parsed.data.minLon,
        maxLon: parsed.data.maxLon,
      });
    } else {
      reply
        .code(400)
        .send({ error: 'viewport requires all of minLat, maxLat, minLon, maxLon or none' });
      return undefined;
    }

    // Resolve the cursor against this request (mode + viewport must match).
    let cursor;
    try {
      cursor = resolveCursor(cursorToken, sortMode, viewport);
    } catch (err) {
      if (err instanceof CursorError) {
        reply.code(400).send({ error: err.message });
        return undefined;
      }
      throw err;
    }

    const ctx = fastify.appCtx;
    let response: FeedResponse;
    if (ctx.mode === 'db') {
      response =
        sortMode === 'magnitude'
          ? await magnitudeFeedDb(ctx.db, viewport)
          : await recentFeedDb(ctx.db, viewport, cursor?.mode === 'recent' ? cursor : null);
    } else {
      response = feedSeed(sortMode, viewport, cursor?.mode === 'recent' ? cursor : null);
    }

    // Re-validate our own response against the shared contract.
    return FeedResponseSchema.parse(response);
  };

  fastify.get('/api/factors', handler);
  fastify.get('/api/feed', handler); // shared-contract alias

  // One factor by id, with citations. The detail view calls this when a selected
  // pin or ring arc is not in the loaded feed pages, so it can show the full
  // record instead of lean field metrics.
  fastify.get('/api/factors/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      reply.code(400).send({ error: 'invalid factor id' });
      return undefined;
    }

    const ctx = fastify.appCtx;
    const factor =
      ctx.mode === 'db'
        ? await factorByIdDb(ctx.db, id)
        : (SEED_FACTORS.find((f) => f.id === id) ?? null);

    if (!factor) {
      reply.code(404).send({ error: 'factor not found' });
      return undefined;
    }
    return FactorByIdResponseSchema.parse({ factor });
  });
}
