/**
 * The interfaces the loop depends on instead of concrete infrastructure.
 *
 * Every one has both a Postgres implementation and an in-memory or
 * deterministic offline counterpart, which is what keeps the whole pipeline
 * runnable — and testable — with no network and no database.
 */
import type { TippingPoint, VerificationState } from '../../shared/types.js';
import type { Domain } from '../../shared/domains.js';
import type {
  EscalationDirectionality,
  FactorCandidate,
  ResolverVerdict,
} from './dedupe.js';
import type { EmbeddingClient } from './embeddings.js';
import type { ExtractedFactorDraft, InboundIntelItem } from './types.js';

/** Phase A. Structured extraction over one untrusted intel item. */
export interface FactorExtractor {
  extract(item: InboundIntelItem): Promise<ExtractedFactorDraft[]>;
}

/** What the entity-resolution prompt is shown about one candidate. */
export interface ResolutionCandidateView {
  id: string;
  name: string;
  description: string;
  effect: number;
  significance: number;
  distance: number;
}

/** The full Phase D resolution request (inbound vs the candidate set). */
export interface ResolutionRequest {
  incoming: {
    name: string;
    description: string;
    effect: number;
    significance: number;
    spatialPath: string;
  };
  candidates: ResolutionCandidateView[];
}

/**
 * Phase D. The resolver ONLY classifies (/finding 28): independent event
 * vs escalation of a named candidate + directionality. It never computes stored
 * numbers — that is the server's deterministic job (, in `dedupe.ts`).
 */
export interface EntityResolver {
  resolve(request: ResolutionRequest): Promise<ResolverVerdict>;
}

/* -------------------------------------------------------------------------- */
/* Repository port (the only DB surface the loop needs)                       */
/* -------------------------------------------------------------------------- */

/** A citation row to append, carrying the item's content hash for idempotency. */
export interface CitationWriteInput {
  publisher: string;
  sourceUrl: string | null;
  quoteSnippet: string;
  /** Recorded so a re-ingest of the same item is caught by `existsByContentHash`. */
  contentHash: string;
}

/**
 * A supporting source that is NOT the deciding citation.
 *
 * Deliberately has no `contentHash` field at all, rather than a nullable one.
 * The hash is the per-finding idempotency key: exactly one citation per finding
 * may carry it, or an unrelated finding sharing a source would read as already
 * seen and be skipped. Omitting the field makes that impossible to get wrong,
 * where a nullable one would only make it unlikely.
 */
export interface CorroboratingCitation {
  publisher: string;
  sourceUrl: string | null;
  quoteSnippet: string;
}

/** The classified inbound metrics persisted for replay. */
export interface RevisionInput {
  effect: number;
  significance: number;
  directionality: EscalationDirectionality | null;
  /** 'insert' | 'escalation' plus optional model rationale. */
  reason: string;
}

/** Everything needed to insert a brand-new factor (the "No Collision" branch). */
export interface NewFactorInput {
  name: string;
  description: string;
  effect: number;
  significance: number;
  /** WGS84 degrees, or null for a placeless factor. Both or neither. */
  lat: number | null;
  lon: number | null;
  spatialPath: string;
  /** 512-dim vector, stored as `halfvec(512)` by the repository. */
  embedding: number[];
  /** LLM-ingested factors land unreviewed. */
  verificationState: VerificationState;
  /** Causal domains linking the factor to the thresholds it moves. */
  domains: readonly Domain[];
  /** Dated tipping-point threshold, when the draft carried one. */
  tippingPoint?: TippingPoint | undefined;
  /**
   * The reputability gate's audit trail: the deciding source's
   * score + reasoning. Persisted to `factors.reputability_score` /
   * `reputability_reasoning` (migration 004) so the verified/pending decision is
   * auditable. Absent for offline/ungated inserts.
   */
  reputabilityScore?: number | undefined;
  reputabilityReasoning?: string | undefined;
  citation: CitationWriteInput;
  /**
   * The OTHER sources the gate saw and scored, beyond the deciding one.
   *
   * The extraction returns several sources per finding and the gate scores every
   * one of them, but only the best was ever persisted — so a claim backed by
   * three reputable publishers displayed a single citation, and the reader had
   * no way to know corroboration existed. In the live set that left 89 of 104
   * factors showing exactly one source, which described our write path rather
   * than the evidence.
   *
   * These are written with a NULL `content_hash` — see {@link CorroboratingCitation},
   * which has no such field so it cannot be given one. The unique index is
   * partial (`WHERE content_hash IS NOT NULL`), so nulls coexist freely.
   */
  corroborating?: readonly CorroboratingCitation[] | undefined;
  /** Seeds the first `factor_revisions` row. */
  revision: RevisionInput;
}

/** Everything needed to escalate an existing parent (the "Collision" branch). */
export interface EscalationWriteInput {
  parentId: string;
  /** New stored metrics from the recalculation. */
  effect: number;
  significance: number;
  citation: CitationWriteInput;
  /** Appends a `factor_revisions` row capturing the classified inbound values. */
  revision: RevisionInput;
  /**
   * The inbound report's own attributes, merged into the parent so an escalation
   * CAPTURES new data rather than discarding it. The citation is always
   * appended; these fields fill gaps the parent left, monotonically:
   *
   * - `tippingPoint` is adopted only when the parent has none (never overwrites
   *   an existing threshold).
   * - `verificationState: 'verified'` promotes a `pending` parent; a `pending`
   *   report never demotes a `verified` parent.
   * - the reputability score/reasoning replace the parent's only when higher, so
   *   the audit trail reflects the most credible source seen.
   *
   * Name and description are deliberately NOT merged: the first-seen values stay
   * canonical, and accumulating sources are captured as citations.
   */
  tippingPoint?: TippingPoint | undefined;
  verificationState?: VerificationState | undefined;
  reputabilityScore?: number | undefined;
  reputabilityReasoning?: string | undefined;
  /** New domains from the inbound report; unioned into the parent's set. */
  domains?: readonly Domain[] | undefined;
}

/**
 * The transactional handle passed to {@link IngestionRepository.withBucketLock}.
 * Every Phase C read and Phase D write for one inbound item happens through it,
 * inside the same advisory-locked transaction.
 */
export interface IngestionTx {
  /**
   * Phase C. Top-k nearest by EXACT cosine distance, index-served
   * (`ORDER BY embedding <=> :q LIMIT :k`; see `SIMILARITY_QUERY_SHAPE`).
   */
  findNearestFactors(embedding: number[], k: number): Promise<FactorCandidate[]>;
  /** Insert factor + first citation + initial revision atomically. Returns id. */
  insertFactor(input: NewFactorInput): Promise<string>;
  /** Append revision + citation and update the factor projection atomically. */
  escalateFactor(input: EscalationWriteInput): Promise<void>;
}

/** A rejected item routed away from `factors` with a reason. */
export interface QuarantineEntry {
  reason: string;
  publisher: string;
  sourceUrl: string | null;
  /** Best-effort payload snapshot for later inspection. */
  payload: unknown;
}

/**
 * The database surface the loop depends on. The concrete Kysely/Postgres-backed
 * implementation is `createPgIngestionRepository` in `./pgRepository.ts` (used by
 * the `./worker.ts` entrypoint); this interface is the seam that keeps ingestion
 * decoupled from it and testable offline via an in-memory fake.
 */
export interface IngestionRepository {
  /**  idempotency: has an item with this content hash already been ingested? */
  existsByContentHash(hash: string): Promise<boolean>;
  /**  idempotency: has this exact source URL already been ingested? */
  existsBySourceUrl(url: string): Promise<boolean>;
  /**
   * Run `fn` inside a READ COMMITTED transaction holding
   * `pg_advisory_xact_lock(hashtext(bucketKey))`, so concurrent inbound items in
   * the same spatial/temporal bucket serialize through the Phase C→D critical
   * section. The advisory lock — not the isolation level — provides
   * mutual exclusion.
   */
  withBucketLock<T>(
    bucketKey: string,
    fn: (tx: IngestionTx) => Promise<T>,
  ): Promise<T>;
  /** Route a rejected item to the quarantine table (never to `factors`). */
  quarantine(entry: QuarantineEntry): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Optional source-trust gate                                    */
/* -------------------------------------------------------------------------- */

/**
 * Optional publisher/domain allowlist. When provided, a factor whose citation
 * fails the check is quarantined rather than inserted. Left undefined, the gate
 * is a no-op — provenance policy is a deployment decision, so this is a hook,
 * not a hard-coded list.
 */
export type SourceAllowlist = (citation: {
  publisher: string;
  sourceUrl: string | null;
}) => boolean;

/* -------------------------------------------------------------------------- */
/* Dependencies + result                                                      */
/* -------------------------------------------------------------------------- */

export interface PipelineDeps {
  repository: IngestionRepository;
  embeddings: EmbeddingClient;
  extractor: FactorExtractor;
  resolver: EntityResolver;
  allowlist?: SourceAllowlist | undefined;
  logger?: Pick<Console, 'warn' | 'error' | 'info'> | undefined;
}

/** Per-batch outcome counts. Every inbound factor lands in exactly one bucket. */
export interface BatchResult {
  /** Inbound items skipped by content-hash/URL idempotency. */
  skippedDuplicateItems: number;
  /**
   * Extracted factors skipped because their SOURCE was already ingested.
   * The live research path re-runs the same topics every cycle on purpose, so
   * idempotency for it is per-FINDING (source URL / content hash), applied after
   * extraction — not per-topic, which would wrongly skip re-research entirely.
   */
  skippedDuplicateFactors: number;
  /** Drafts rejected by value validation or the allowlist. */
  quarantined: number;
  /** New factors inserted (No Collision branch). */
  inserted: number;
  /** Existing factors escalated (Collision branch). */
  escalated: number;
  /** Factor drafts extracted and embedded this batch. */
  processedFactors: number;
}

