/**
 * In-memory implementation of the ingestion ports (`IngestionRepository` /
 * `IngestionTx` from `pipeline.ts`).
 *
 * This is the OFFLINE counterpart to `pgRepository.ts`: it lets the full A→D loop
 * run — research → embed → dedupe → gate → resolve → persist — with no Postgres
 * and no network, so the wiring is provable offline (used by the `--once` CLI
 * offline cycle in `worker.ts` and by `pipeline.test.ts`). It is deliberately
 * simple: a single process, no real locking (the loop is single-threaded here),
 * exact cosine distance over stored embeddings for Phase C.
 *
 * It is NOT a production store — no durability, no concurrency, no SQL. It exists
 * to exercise the pipeline contract deterministically, mirroring how the other
 * modules ship a clearly-labelled offline stub beside their live path.
 */
import { randomUUID } from 'node:crypto';
import type {
  EscalationWriteInput,
  IngestionRepository,
  IngestionTx,
  NewFactorInput,
  QuarantineEntry,
} from './pipeline.js';
import type { FactorCandidate } from './dedupe.js';
import type { TippingPoint, VerificationState } from '../../shared/types.js';

/** A persisted factor as the in-memory store holds it (the fields we can inspect). */
export interface StoredFactor {
  id: string;
  name: string;
  description: string;
  effect: number;
  significance: number;
  lat: number | null;
  lon: number | null;
  spatialPath: string;
  verificationState: VerificationState;
  reputabilityScore: number | undefined;
  reputabilityReasoning: string | undefined;
  tippingPoint: TippingPoint | undefined;
  embedding: number[];
  citationCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The repository plus inspection handles the offline cycle + tests read back. */
export interface MemoryIngestionRepository extends IngestionRepository {
  /** All persisted factors, insertion order. */
  factors(): StoredFactor[];
  /** All quarantined entries. */
  quarantined(): QuarantineEntry[];
}

/** Cosine distance between two vectors (0 = identical). Assumes finite inputs. */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 1;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return 1 - sim;
}

/** Construct a fresh in-memory ingestion repository. */
export function createMemoryIngestionRepository(): MemoryIngestionRepository {
  const factors: StoredFactor[] = [];
  const byId = new Map<string, StoredFactor>();
  const contentHashes = new Set<string>();
  const sourceUrls = new Set<string>();
  const quarantine: QuarantineEntry[] = [];

  const tx: IngestionTx = {
    async findNearestFactors(embedding: number[], k: number): Promise<FactorCandidate[]> {
      return factors
        .map((f) => ({
          id: f.id,
          effect: f.effect,
          significance: f.significance,
          createdAt: f.createdAt,
          citationCount: f.citationCount,
          distance: cosineDistance(embedding, f.embedding),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, k);
    },

    async insertFactor(input: NewFactorInput): Promise<string> {
      const id = randomUUID();
      const now = new Date();
      const stored: StoredFactor = {
        id,
        name: input.name,
        description: input.description,
        effect: input.effect,
        significance: input.significance,
        lat: input.lat,
        lon: input.lon,
        spatialPath: input.spatialPath,
        verificationState: input.verificationState,
        reputabilityScore: input.reputabilityScore,
        reputabilityReasoning: input.reputabilityReasoning,
        tippingPoint: input.tippingPoint,
        embedding: input.embedding,
        citationCount: 1,
        createdAt: now,
        updatedAt: now,
      };
      factors.push(stored);
      byId.set(id, stored);
      contentHashes.add(input.citation.contentHash);
      if (input.citation.sourceUrl) sourceUrls.add(input.citation.sourceUrl);
      return id;
    },

    async escalateFactor(input: EscalationWriteInput): Promise<void> {
      const parent = byId.get(input.parentId);
      if (!parent) throw new Error(`escalateFactor: unknown parent ${input.parentId}`);
      // Mirror the DB projection: fold the recalculated metrics in, bump updated_at,
      // count the new citation.
      parent.effect = input.effect;
      parent.significance = input.significance;
      parent.citationCount += 1;
      parent.updatedAt = new Date();
      contentHashes.add(input.citation.contentHash);
      if (input.citation.sourceUrl) sourceUrls.add(input.citation.sourceUrl);
    },
  };

  return {
    async existsByContentHash(hash: string): Promise<boolean> {
      return contentHashes.has(hash);
    },
    async existsBySourceUrl(url: string): Promise<boolean> {
      return sourceUrls.has(url);
    },
    async withBucketLock<T>(_bucketKey: string, fn: (tx: IngestionTx) => Promise<T>): Promise<T> {
      // Single-threaded offline: no real advisory lock is needed for correctness.
      return fn(tx);
    },
    async quarantine(entry: QuarantineEntry): Promise<void> {
      quarantine.push(entry);
    },
    factors(): StoredFactor[] {
      return [...factors];
    },
    quarantined(): QuarantineEntry[] {
      return [...quarantine];
    },
  };
}
