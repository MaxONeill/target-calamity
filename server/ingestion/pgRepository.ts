/**
 * Concrete, Postgres-backed implementation of the ingestion ports.
 *
 * `pipeline.ts` defines `IngestionRepository` / `IngestionTx` as injected seams
 * and ships only offline stubs. THIS file is the real adapter the §3 loop runs
 * against in DB mode — the "owned in server/db" implementation the ports refer
 * to. It is written against the schema in `db/migrations/001_init.sql` +
 * `002_ingestion.sql` and follows the write-path contract documented at the end
 * of `001_init.sql`:
 *
 *   - INSERT a new factor  → INSERT factors (genesis revision auto-written by
 *     trigger) + INSERT its first citation, in one transaction.
 *   - ESCALATE a factor    → INSERT citation + INSERT factor_revisions
 *     ('escalation' | 'de-escalation'); the projection trigger folds the new
 *     weights into `factors` and bumps updated_at. NEVER UPDATE effect/
 *     significance directly.
 *
 * Both write paths issue `pg_notify('factor_updates', <delta json>)` inside the
 * same transaction, so the SSE route's LISTEN client (server/routes/stream.ts)
 * receives the delta ONLY if the write commits (NOTIFY is transactional). This is
 * the emitter that stream.ts documents "the ingestion worker" as providing.
 *
 * Phase C (`findNearestFactors`) uses the  index-served query shape
 * (`ORDER BY embedding <=> :q LIMIT :k`), and raises `hnsw.ef_search` for the
 * dedup workload (a missed neighbour = a false "no collision" = a duplicate).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db.js';
import type {
  EscalationWriteInput,
  IngestionRepository,
  IngestionTx,
  NewFactorInput,
  QuarantineEntry,
} from './pipeline.js';
import type { EscalationDirectionality, FactorCandidate } from './dedupe.js';

/** The Postgres NOTIFY channel the SSE route LISTENs on. */
const NOTIFY_CHANNEL = 'factor_updates';

/**
 * Recall floor for the dedup k-NN scan. Well above pgvector's default 40 because
 * a missed neighbour here silently produces a duplicate factor (finding 8/30).
 */
const DEDUP_EF_SEARCH = 200;

/** Map the resolver's directionality to the DB's `revision_reason` CHECK domain. */
function revisionReason(
  directionality: EscalationDirectionality | null,
): 'escalation' | 'de-escalation' {
  return directionality === 'de-escalating' ? 'de-escalation' : 'escalation';
}

/** pgvector text literal for a dense vector: `[a,b,c]`. Cast `::halfvec` at use. */
function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

type Executor = Kysely<DB> | Transaction<DB>;

interface CandidateRow {
  id: string;
  effect: number;
  significance: number;
  created_at: Date;
  citation_count: string | number;
  distance: number;
}

async function findNearestFactors(
  ex: Executor,
  embedding: number[],
  k: number,
): Promise<FactorCandidate[]> {
  const vec = vectorLiteral(embedding);
  const { rows } = await sql<CandidateRow>`
    SELECT
      f.id                AS id,
      f.effect            AS effect,
      f.significance      AS significance,
      f.created_at        AS created_at,
      (SELECT COUNT(*) FROM citations ct WHERE ct.factor_id = f.id) AS citation_count,
      (f.embedding <=> ${vec}::halfvec) AS distance
    FROM factors f
    WHERE f.embedding IS NOT NULL
    ORDER BY f.embedding <=> ${vec}::halfvec
    LIMIT ${k}
  `.execute(ex);

  return rows.map((r) => ({
    id: r.id,
    effect: r.effect,
    significance: r.significance,
    createdAt: r.created_at,
    citationCount: Number(r.citation_count),
    distance: r.distance,
  }));
}

async function insertFactor(
  trx: Transaction<DB>,
  input: NewFactorInput,
): Promise<string> {
  const vec = vectorLiteral(input.embedding);
  // Dated tipping point persisted as JSONB; NULL when the draft had none.
  const tippingPointJson = input.tippingPoint ? JSON.stringify(input.tippingPoint) : null;
  // Reputability audit trail; NULL when the gate did not run (offline/ungated).
  const reputabilityScore = input.reputabilityScore ?? null;
  const reputabilityReasoning = input.reputabilityReasoning ?? null;
  const { rows } = await sql<{ id: string }>`
    INSERT INTO factors
      (spatial_path, name, description, embedding,
       effect, significance, lat, lon, verification_state, tipping_point,
       reputability_score, reputability_reasoning)
    VALUES
      (${input.spatialPath}::ltree, ${input.name}, ${input.description}, ${vec}::halfvec,
       ${input.effect}, ${input.significance}, ${input.lat}, ${input.lon}, ${input.verificationState},
       ${tippingPointJson}::jsonb,
       ${reputabilityScore}, ${reputabilityReasoning})
    RETURNING id
  `.execute(trx);

  const id = rows[0]?.id;
  if (!id) throw new Error('insertFactor: INSERT ... RETURNING id produced no row');

  // First citation — carries the  content hash so a re-ingest is caught.
  await sql`
    INSERT INTO citations (factor_id, source_url, publisher, quote_snippet, content_hash)
    VALUES (${id}::uuid, ${input.citation.sourceUrl}, ${input.citation.publisher},
            ${input.citation.quoteSnippet}, ${input.citation.contentHash})
  `.execute(trx);

  // Genesis factor_revisions row is written by the AFTER INSERT trigger — do NOT
  // insert one here (that would duplicate the genesis / recurse the projection).

  await notifyFactorDelta(trx, {
    type: 'insert',
    id,
    effect: input.effect,
    significance: input.significance,
    verificationState: input.verificationState,
  });

  return id;
}

async function escalateFactor(
  trx: Transaction<DB>,
  input: EscalationWriteInput,
): Promise<void> {
  // 1. Append the citation that justified this escalation, capturing its id.
  const { rows } = await sql<{ id: string }>`
    INSERT INTO citations (factor_id, source_url, publisher, quote_snippet, content_hash)
    VALUES (${input.parentId}::uuid, ${input.citation.sourceUrl}, ${input.citation.publisher},
            ${input.citation.quoteSnippet}, ${input.citation.contentHash})
    RETURNING id
  `.execute(trx);
  const citationId = rows[0]?.id ?? null;

  // 2. Append the revision. The AFTER INSERT projection trigger folds the new
  //    weights into `factors` and the BEFORE UPDATE trigger bumps updated_at.
  await sql`
    INSERT INTO factor_revisions
      (factor_id, effect, significance, revision_reason, citation_id)
    VALUES
      (${input.parentId}::uuid, ${input.effect}, ${input.significance},
       ${revisionReason(input.revision.directionality)}, ${citationId})
  `.execute(trx);

  await notifyFactorDelta(trx, {
    type: 'escalation',
    id: input.parentId,
    effect: input.effect,
    significance: input.significance,
  });
}

interface FactorDelta {
  type: 'insert' | 'escalation';
  id: string;
  effect: number;
  significance: number;
  verificationState?: string;
}

/** Emit the delta on the LISTEN/NOTIFY channel; delivered on transaction commit. */
async function notifyFactorDelta(
  trx: Transaction<DB>,
  delta: FactorDelta,
): Promise<void> {
  await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(delta)})`.execute(trx);
}

/**
 * Build the concrete repository over a Kysely instance. The advisory lock in
 * `withBucketLock` — not the isolation level — provides the Phase C→D mutual
 * exclusion; the resolver call happens inside it, so the lock is
 * held across a network round trip (acceptable for this workload; see the
 * ingestion README tradeoff note).
 */
export function createPgIngestionRepository(db: Kysely<DB>): IngestionRepository {
  return {
    async existsByContentHash(hash: string): Promise<boolean> {
      const { rows } = await sql<{ one: number }>`
        SELECT 1 AS one FROM citations WHERE content_hash = ${hash} LIMIT 1
      `.execute(db);
      return rows.length > 0;
    },

    async existsBySourceUrl(url: string): Promise<boolean> {
      const { rows } = await sql<{ one: number }>`
        SELECT 1 AS one FROM citations WHERE source_url = ${url} LIMIT 1
      `.execute(db);
      return rows.length > 0;
    },

    async withBucketLock<T>(
      bucketKey: string,
      fn: (tx: IngestionTx) => Promise<T>,
    ): Promise<T> {
      return db.transaction().execute(async (trx) => {
        // Serialize the Phase C→D critical section for this spatial bucket.
        await sql`SELECT pg_advisory_xact_lock(hashtext(${bucketKey}))`.execute(trx);
        // Raise recall for the dedup k-NN scan for the life of this transaction.
        await sql`SET LOCAL hnsw.ef_search = ${sql.lit(DEDUP_EF_SEARCH)}`.execute(trx);

        const tx: IngestionTx = {
          findNearestFactors: (embedding, k) => findNearestFactors(trx, embedding, k),
          insertFactor: (input) => insertFactor(trx, input),
          escalateFactor: (input) => escalateFactor(trx, input),
        };
        return fn(tx);
      });
    },

    async quarantine(entry: QuarantineEntry): Promise<void> {
      await sql`
        INSERT INTO ingestion_quarantine (reason, publisher, source_url, payload)
        VALUES (${entry.reason}, ${entry.publisher}, ${entry.sourceUrl},
                ${JSON.stringify(entry.payload ?? null)}::jsonb)
      `.execute(db);
    },
  };
}
