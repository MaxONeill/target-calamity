/**
 * Kysely (ADR-24) over a node-postgres `Pool`, plus the hand-written `DB`
 * interface mirroring `db/migrations/001_init.sql`.
 *
 * ADR-24: keyset pagination is the code most likely to break silently, so the
 * SQL that drives it is typed. The complex projections (json_agg / LATERAL /
 * PostGIS) are written as raw `sql` templates — still Kysely, still typed via
 * `sql<Row>` and still auto-parameterized, but without fighting the query
 * builder over hierarchical JSON. This interface is the source of truth for the
 * column shapes those templates read.
 *
 * The interface encodes the schema AS CORRECTED BY THE ADRs, not the literal
 * spec DDL. Deviations are flagged inline with their ADR number.
 */
import { Kysely, PostgresDialect } from 'kysely';
import type { ColumnType, Generated, GeneratedAlways } from 'kysely';
import pg from 'pg';
import type { VerificationState, ZoneLevel } from '../shared/types.js';

const { Pool } = pg;

/** A UUID rendered as its canonical text form (pg returns `uuid` as string). */
type UUID = string;

/**
 * A `timestamptz` column. We never read these columns raw — every SELECT
 * formats them with `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` so full
 * microsecond precision survives (confirmed defect #25: the pg driver would
 * otherwise coerce to a millisecond-precision JS `Date`). The type therefore
 * reflects what the driver hands back for a bare select — a `Date` — while
 * accepting `Date | string` on write.
 */
type Timestamptz = ColumnType<Date, Date | string, Date | string>;

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

interface FactorsTable {
  id: Generated<UUID>;

  /**
   * SPEC DEVIATION (ADR-15a / defects #13 & #21): the spec paginates on
   * `updated_at`, which Phase D (ADR-19) rewrites to NOW() on every escalation.
   * A row below the live cursor that escalates jumps above it and is skipped
   * for the rest of the scroll session — biased toward the most active factors.
   * `seq` is an insert-only monotonic identity assigned once and NEVER bumped;
   * the feed keysets on it instead. Kept out of the wire contract entirely.
   */
  seq: GeneratedAlways<string>; // BIGINT IDENTITY; pg returns int8 as string.

  spatial_path: string; // LTREE, rendered ::text on the wire.
  name: string;
  description: string;

  /**
   * SPEC DEVIATION (ADR-12): `VECTOR(1536)` becomes `halfvec(512)` (Matryoshka
   * truncation). Server-side only — never selected onto the wire (FactorSchema
   * has no embedding field). Typed permissively as its text representation.
   */
  embedding: ColumnType<string | null, string | null, string | null>;

  /** SPEC DEVIATION (ADR-9): `NUMERIC` → `REAL`. CHECK [-1,1] (ADR-11a). */
  effect: number;
  /** SPEC DEVIATION (ADR-9): `NUMERIC` → `REAL`. CHECK [0,1] (ADR-11). */
  significance: number;
  /** SPEC DEVIATION (ADR-9): `NUMERIC(8,6)` → `DOUBLE PRECISION`. Degrees, CHECK [-90,90]. */
  lat: number;
  /** SPEC DEVIATION (ADR-9): `NUMERIC(9,6)` → `DOUBLE PRECISION`. Degrees, CHECK [-180,180]. */
  lon: number;

  /**
   * SPEC DEVIATION (ADR-8): the lat/lon BETWEEN viewport filter is replaced by
   * PostGIS. `geog geography(Point,4326)` is derived from (lon,lat) and carries
   * a GiST index; the feed query intersects it with the viewport envelope,
   * which fixes the antimeridian and near-pole failure modes structurally.
   * Never crosses the wire.
   */
  geog: ColumnType<string, string, string>;

  /** SPEC DEVIATION (ADR-10): generated from `nlevel(spatial_path)`, not stored free-text. */
  zone_level: GeneratedAlways<ZoneLevel>;

  /** SPEC DEVIATION (ADR-20): ingested factors land `pending`; the field bake takes only `verified`. */
  verification_state: Generated<VerificationState>;

  gestalt_channel_address: ColumnType<Buffer | null, Buffer | null, Buffer | null>;

  created_at: Timestamptz; // NOT NULL (ADR-11).
  updated_at: Timestamptz; // NOT NULL (ADR-11); mutated by Phase D — NOT a cursor key.
}

interface CitationsTable {
  id: Generated<UUID>;
  /** SPEC DEVIATION (ADR-11): NOT NULL — the header claims "one-to-many strict". */
  factor_id: UUID;
  source_url: string | null;
  publisher: string;
  quote_snippet: string;
  analyst_notes: string | null;
  /** ADR-21 ingest idempotency key (002_ingestion.sql). NULL for seed/curated rows. */
  content_hash: ColumnType<string | null, string | null, string | null>;
  retrieved_at: Timestamptz;
}

/**
 * SPEC DEVIATION (ADR-13): the spec calls the store "event-sourced" but keeps a
 * single mutable table and overwrites `effect`/`significance` in place. This
 * append-only revision log makes the claim true and gives Phase D an audit
 * trail. `factors` is the current-state projection of the newest revision.
 */
interface FactorRevisionsTable {
  id: Generated<UUID>;
  factor_id: UUID;
  effect: number;
  significance: number;
  reason: string | null; // 'insert' | 'escalation:<rationale>'
  citation_id: UUID | null;
  changed_at: Timestamptz;
}

/**
 * Anonymous Phase-1 submissions (ADR-45, migration 005). Note what is NOT here:
 * effect, significance, verification_state, lat, lon, tipping_point. A submitter
 * supplies a claim and a source and nothing else — every stored number is
 * assigned downstream by the vetting pipeline.
 *
 * `ip_hash` / `device_hash` are salted SHA-256 digests
 * (`sha256(SUBMISSION_SALT || value)`); there is deliberately no column holding a
 * raw IP or device id anywhere in the schema.
 */
interface SubmissionsTable {
  id: Generated<UUID>;
  ip_hash: string;
  device_hash: string;
  claim: string;
  source_url: string;
  note: string | null;
  /** CHECK: 'accepted'|'rejected_noise'|'quarantined'|'rate_limited'|'duplicate'. */
  status: string;
  /** Operator-facing explanation; never returned to the submitter. */
  reason: string | null;
  created_at: Timestamptz;
}

/**
 * The shadow-ban list (ADR-45). A hit means the submitter keeps receiving the
 * ordinary success response while their submissions land `quarantined` and never
 * reach the pipeline. Either half may be NULL (CHECK: not both).
 */
interface BannedSubmittersTable {
  id: Generated<UUID>;
  ip_hash: string | null;
  device_hash: string | null;
  reason: string;
  created_at: Timestamptz;
}

export interface DB {
  factors: FactorsTable;
  citations: CitationsTable;
  factor_revisions: FactorRevisionsTable;
  submissions: SubmissionsTable;
  banned_submitters: BannedSubmittersTable;
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

export type PgPool = pg.Pool;
export type Database = Kysely<DB>;

/**
 * Build a Kysely instance and its underlying pool from a connection string.
 * The pool is returned alongside so the SSE route can check out a dedicated
 * `LISTEN` client (ADR-17) and the bootstrap can drain it on shutdown.
 */
export function createDatabase(connectionString: string): { db: Database; pool: PgPool } {
  const pool = new Pool({ connectionString });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

/* -------------------------------------------------------------------------- */
/* App context (shared across routes)                                         */
/* -------------------------------------------------------------------------- */

/** Live-database mode: a real Postgres is configured via `DATABASE_URL`. */
export interface DbContext {
  mode: 'db';
  db: Database;
  pool: PgPool;
}

/**
 * Seed mode: no `DATABASE_URL`. The API serves `SEED_FACTORS` from
 * `shared/seed.ts` so the whole app is runnable without Postgres. Routes branch
 * on `mode` and run the equivalent in-memory query.
 */
export interface SeedContext {
  mode: 'seed';
}

export type AppContext = DbContext | SeedContext;

// Make `fastify.appCtx` visible and typed at every route call site.
declare module 'fastify' {
  interface FastifyInstance {
    appCtx: AppContext;
  }
}
