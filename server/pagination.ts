/**
 * Opaque, mode-tagged keyset cursors.
 *
 * A cursor is an internal, server-owned token: the client never inspects or
 * constructs one, it only echoes back the `nextCursor` string it was handed.
 * The wire form is base64url(JSON). The client sends `sortMode` and `viewport`
 * as their own params, and the cursor carries copies of both so the server can
 * 400 a cursor that disagrees with the request (a sort toggle or viewport
 * change invalidates the cursor and the feed restarts from page one).
 *
 * `recent` keysets on the immutable insert-only `seq`, not on `updated_at`.
 * Ingestion rewrites `updated_at = NOW()` when a factor escalates, so keying on
 * it would silently skip escalating rows for the rest of a scroll session.
 * `seq` is also an exact integer transmitted as a decimal string, which avoids
 * the microsecond truncation a timestamp suffers across a JSON round trip.
 *
 * `magnitude` is not deep-paginated at all. `abs(effect)` is mutated by the same
 * path, so it is no safer a key; the feed serves magnitude as a single bounded
 * top-N snapshot with `nextCursor = null`, and there is never a magnitude cursor
 * to resume from.
 */
import { CursorSchema } from '../shared/schema.js';
import type { Cursor, SortMode, Viewport } from '../shared/types.js';

/* -------------------------------------------------------------------------- */
/* Cursor payload (THE shared shape)                                          */
/* -------------------------------------------------------------------------- */

/**
 * The cursor payload IS the shared `CursorSchema` (recent → immutable `seq`,
 * magnitude → bounded `absEffect` snapshot). Importing it — rather than
 * redeclaring a parallel schema — is what stops the shared contract and the
 * server's real cursor from drifting again (they contradicted each other before:
 * the shared schema keyed `recent` on `updatedAt`, which  forbids).
 */
const CursorPayloadSchema = CursorSchema;

export type CursorPayload = Cursor;
export type RecentCursor = Extract<Cursor, { mode: 'recent' }>;
export type MagnitudeCursor = Extract<Cursor, { mode: 'magnitude' }>;

/** Thrown for any malformed / mismatched cursor. Routes map it to HTTP 400. */
export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorError';
  }
}

/* -------------------------------------------------------------------------- */
/* Encode / decode                                                            */
/* -------------------------------------------------------------------------- */

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(token: string): CursorPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('cursor is not valid base64url-encoded JSON');
  }
  const parsed = CursorPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CursorError('cursor payload failed schema validation');
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Viewport helpers                                                           */
/* -------------------------------------------------------------------------- */

/** The whole globe — used when a request omits an explicit viewport. */
export const FULL_GLOBE_VIEWPORT: Viewport = {
  minLat: -90,
  maxLat: 90,
  minLon: -180,
  maxLon: 180,
};

export function viewportsEqual(a: Viewport, b: Viewport): boolean {
  return (
    a.minLat === b.minLat && a.maxLat === b.maxLat && a.minLon === b.minLon && a.maxLon === b.maxLon
  );
}

/**
 * In-memory viewport test for seed mode, mirroring the PostGIS envelope in
 * `factors.ts`. `minLon > maxLon` is the legal antimeridian-crossing signal
 * (ViewportSchema): the longitude test becomes a UNION of two arcs rather than
 * a single interval. Latitude never wraps.
 */
export function factorInViewport(lat: number | null, lon: number | null, vp: Viewport): boolean {
  // A placeless factor is nowhere in particular, so it is in every viewport.
  // This mirrors the `geog IS NULL` branch of the DB-mode predicate.
  if (lat === null || lon === null) return true;
  if (lat < vp.minLat || lat > vp.maxLat) return false;
  if (vp.minLon <= vp.maxLon) {
    return lon >= vp.minLon && lon <= vp.maxLon;
  }
  return lon >= vp.minLon || lon <= vp.maxLon; // crosses the antimeridian
}

/* -------------------------------------------------------------------------- */
/* Request-time resolution                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Decode a cursor and assert it belongs to this request. Returns `null` for the
 * first page (no cursor). Throws {@link CursorError} on a malformed token, a
 * sort-mode mismatch, or a viewport mismatch — the caller returns 400 and the
 * client restarts from page one.
 *
 * Never emits a predicate over a NULL cursor: a `null`
 * return tells the query builder to omit the keyset predicate entirely.
 */
export function resolveCursor(
  token: string | undefined,
  mode: SortMode,
  viewport: Viewport,
): CursorPayload | null {
  if (token === undefined || token === '') return null;
  const cursor = decodeCursor(token);
  if (cursor.mode !== mode) {
    throw new CursorError(
      `cursor sort mode "${cursor.mode}" does not match requested sort mode "${mode}"`,
    );
  }
  if (!viewportsEqual(cursor.viewport, viewport)) {
    throw new CursorError('cursor viewport does not match the requested viewport');
  }
  return cursor;
}
