/**
 * The Reconciliation Loop — Phase A → D orchestration.
 *
 * This module wires the four phases together and owns the *impure* concerns:
 * idempotency, batching, value validation, quarantine, and the transactional
 * critical section. The decision math lives in `dedupe.ts` (pure) and the
 * vectorization in `embeddings.ts`; this file coordinates them.
 *
 *   Phase A — Extraction    : `FactorExtractor` turns one untrusted intel item
 *                             into structured factor drafts (: JSON-schema
 *                             constrained, NOT free-text parsing). We then
 *                             validate every VALUE and quarantine
 *                             anything out of domain.
 *   Phase B — Vectorization : one BATCHED embedding call for the whole page of
 *                             surviving drafts, 512-dim.
 *   Phase C — Similarity    : top-k nearest as CANDIDATES, never a
 *                             distance predicate.
 *   Phase D — Resolution    : the resolver classifies; the server computes the
 *                             new metrics and writes exactly one target
 *, landing new factors as `pending`
 * and appending a `factor_revisions` row
 * for audit/replay.
 *
 * Everything the loop touches outside itself is an injected PORT (repository,
 * embedding client, extractor, resolver). The ingestion module owns none of the
 * database code, so it depends on interfaces it defines here rather than on
 * `server/db`; the offline stubs below make the whole loop runnable with no
 * network and no Postgres.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TippingPoint, VerificationState } from '../../shared/types.js';
import { TippingPointSchema, VerificationStateSchema } from '../../shared/schema.js';
import type { CandidateFactor } from './websearch.js';
import {
  type EmbeddingClient,
  createEmbeddingClient,
  type EmbeddingEnv,
} from './embeddings.js';
import {
  CANDIDATE_TOP_K,
  type EscalationDirectionality,
  type FactorCandidate,
  type ResolutionOutcome,
  type ResolverVerdict,
  filterCandidates,
  resolveOutcome,
} from './dedupe.js';

/* -------------------------------------------------------------------------- */
/* Inbound + extracted shapes                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One raw item off the inbound intel stream. `rawText`
 * is UNTRUSTED third-party content — the extractor prompt must treat it as data,
 * never as instructions (finding 27, prompt-injection boundary).
 */
export interface InboundIntelItem {
  /** Optional upstream identifier, for logging only. */
  externalId?: string | undefined;
  /** Untrusted source text to extract factors from. */
  rawText: string;
  sourceUrl: string | null;
  publisher: string;
  retrievedAt: Date;
}

/**
 * A structured factor as returned by the Phase A extractor, before value
 * validation. `zone_level` is intentionally absent — it is a generated column
 * derived from `spatial_path`, so the pipeline never sets it.
 */
export interface ExtractedFactorDraft {
  name: string;
  description: string;
  effect: number;
  significance: number;
  lat: number;
  lon: number;
  spatialPath: string;
  /**
   * The verification state Phase A already resolved for this draft: the
   * live path sets `verified`/`pending` from the reputability gate; the offline
   * stubs omit it and it defaults to `pending`. Escalations never change an
   * existing parent's state — this only seeds a NEW factor's insert.
   */
  verificationState?: VerificationState;
  /**
   * A dated tipping-point threshold, present only when Phase A extracted
   * a concrete dated/near-dated one. Persisted to `factors.tipping_point` on insert
   * so the Clock countdown baseline can anchor to it. Escalations never touch it.
   * Explicit `| undefined` (not a bare optional) so a zod-parsed draft and the
   * conditionally-built extractor output assign cleanly under exactOptionalPropertyTypes.
   */
  tippingPoint?: TippingPoint | undefined;
  /**
   * The reputability gate's audit trail: the DECIDING (max-scoring)
   * source's credibility score `∈ [0, 1]` and its reasoning, carried onto the
   * persisted factor so the verified/pending decision is auditable. The live gate
   * sets both; the offline stubs omit them. Explicit `| undefined` for clean
   * assignment under exactOptionalPropertyTypes. Escalations never touch them —
   * they only seed a NEW factor's insert, alongside `verificationState`.
   */
  reputabilityScore?: number | undefined;
  reputabilityReasoning?: string | undefined;
  citation: {
    publisher: string;
    sourceUrl: string | null;
    quoteSnippet: string;
  };
}

/**
 * Value-level validation of a Phase A draft (finding 27: JSON-schema constrains
 * SHAPE, not VALUES). Ranges mirror the DB CHECK constraints and
 * the shared contract; `spatialPath` is enforced rooted-at-`global` with depth
 * ≤ 2 (: `<@ 'global'` and `nlevel <= 2`). `.finite()` on the numbers
 * rejects `NaN`/`±Infinity` before they can poison the field or the feed.
 */
export const ExtractedFactorSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().min(1).max(20_000),
  effect: z.number().finite().gte(-1).lte(1),
  significance: z.number().finite().gte(0).lte(1),
  lat: z.number().finite().gte(-90).lte(90),
  lon: z.number().finite().gte(-180).lte(180),
  // 'global' or 'global.<segment>' — one root, at most one child (Phase 1).
  spatialPath: z.string().regex(/^global(\.[a-z0-9_]+)?$/, {
    message: "spatialPath must be 'global' or 'global.<code>' (depth <= 2)",
  }),
  // Defaults to 'pending' so any draft of unknown provenance stays off the
  // Clock aggregate until the reputability gate says otherwise.
  verificationState: VerificationStateSchema.default('pending'),
  // Optional dated threshold; most drafts have none. `.optional()` (not
  // `.nullable()`) mirrors the shared contract and satisfies exactOptionalPropertyTypes.
  tippingPoint: TippingPointSchema.optional(),
  // Reputability audit trail: deciding source's score + reasoning.
  // Optional — present only when the live gate ran; the offline stubs omit it.
  reputabilityScore: z.number().finite().gte(0).lte(1).optional(),
  reputabilityReasoning: z.string().optional(),
  citation: z.object({
    publisher: z.string().min(1).max(500),
    sourceUrl: z.string().url().nullable(),
    quoteSnippet: z.string().min(1).max(5_000),
  }),
});

/* -------------------------------------------------------------------------- */
/* Phase A / D LLM ports                                                      */
/* -------------------------------------------------------------------------- */

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
  lat: number;
  lon: number;
  spatialPath: string;
  /** 512-dim vector, stored as `halfvec(512)` by the repository. */
  embedding: number[];
  /** LLM-ingested factors land unreviewed. */
  verificationState: VerificationState;
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
  /** Seeds the first `factor_revisions` row. */
  revision: RevisionInput;
}

/** Everything needed to escalate an existing parent (the "Collision" branch). */
export interface EscalationWriteInput {
  parentId: string;
  /** New stored metrics from the  recalculation. */
  effect: number;
  significance: number;
  citation: CitationWriteInput;
  /** Appends a `factor_revisions` row capturing the classified inbound values. */
  revision: RevisionInput;
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

/* -------------------------------------------------------------------------- */
/* Content hashing                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Idempotency key for an inbound item, computed BEFORE embedding so a re-ingest
 * of the same article never costs an API call. Prefers the canonical
 * source URL; falls back to a hash of publisher + normalized text when the item
 * has no URL.
 */
export function contentHash(item: InboundIntelItem): string {
  const basis = item.sourceUrl
    ? `url:${item.sourceUrl.trim().toLowerCase()}`
    : `text:${item.publisher.trim().toLowerCase()}::${normalizeText(item.rawText)}`;
  return createHash('sha256').update(basis).digest('hex');
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Idempotency key for one EXTRACTED factor. The live research engine
 * re-researches topics every cycle, so the meaningful dedupe unit is the finding,
 * not the topic: key on the citation's canonical source URL, falling back to
 * publisher + normalized name/description when a finding has no URL. Re-surfacing
 * the same source next cycle hits `existsBySourceUrl`/`existsByContentHash` and is
 * skipped; a genuinely new source flows on to Phase C, where embedding similarity
 * (not this hash) decides insert vs escalate.
 */
export function draftContentHash(draft: ExtractedFactorDraft): string {
  const url = draft.citation.sourceUrl;
  const basis = url
    ? `url:${url.trim().toLowerCase()}`
    : `factor:${draft.citation.publisher.trim().toLowerCase()}::${normalizeText(
        draft.name,
      )}::${normalizeText(draft.description)}`;
  return createHash('sha256').update(basis).digest('hex');
}

/**
 * The serialization bucket for the Phase C→D critical section:
 * spatial path + a coarse 1° geographic cell. Two inbound reports of the same
 * event fall in the same bucket and therefore serialize, closing the
 * check-then-insert race that content-hash dedupe (different sources, different
 * hashes) cannot.
 */
export function bucketKey(draft: ExtractedFactorDraft): string {
  const latCell = Math.floor(draft.lat);
  const lonCell = Math.floor(draft.lon);
  return `${draft.spatialPath}:${latCell}:${lonCell}`;
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

interface PreparedFactor {
  draft: ExtractedFactorDraft;
  item: InboundIntelItem;
  contentHash: string;
  embeddingText: string;
}

/**
 * Construct the reconciliation pipeline. Returns `processBatch`, which runs the
 * full A→D loop over a page of inbound items and reports the outcome counts.
 */
export function createPipeline(deps: PipelineDeps) {
  const log = deps.logger ?? console;

  return {
    /** The embedding client in use (surfaces `isStub` for run labelling). */
    embeddings: deps.embeddings,

    /**
     * Process one batch of inbound intel items through Phases A–D. Idempotent at
     * the item level, batched at the embedding level, and
     * serialized per spatial bucket at the write level.
     */
    async processBatch(items: readonly InboundIntelItem[]): Promise<BatchResult> {
      const result: BatchResult = {
        skippedDuplicateItems: 0,
        skippedDuplicateFactors: 0,
        quarantined: 0,
        inserted: 0,
        escalated: 0,
        processedFactors: 0,
      };

      // --- Item-level idempotency — BEFORE extraction, but ONLY for
      // items that carry a source URL (real articles: a re-ingest is a cheap
      // pre-skip). Live research TOPICS have no URL and MUST be re-run each cycle,
      // so they are never pre-skipped here; their idempotency is per-finding,
      // applied after extraction below. ---
      const freshItems: InboundIntelItem[] = [];
      for (const item of items) {
        if (item.sourceUrl) {
          const seen =
            (await deps.repository.existsByContentHash(contentHash(item))) ||
            (await deps.repository.existsBySourceUrl(item.sourceUrl));
          if (seen) {
            result.skippedDuplicateItems++;
            continue;
          }
        }
        freshItems.push(item);
      }

      // Guards against re-inserting the SAME finding twice within one batch
      // (the DB checks below only see committed rows, not siblings in flight).
      const seenInBatch = new Set<string>();

      // --- Phase A: extraction + value validation. ---
      const prepared: PreparedFactor[] = [];
      for (const item of freshItems) {
        let drafts: ExtractedFactorDraft[];
        try {
          drafts = await deps.extractor.extract(item);
        } catch (err) {
          log.error?.(
            `[ingestion] Phase A extraction failed for ${item.externalId ?? item.sourceUrl ?? '<no id>'}: ${String(err)}`,
          );
          continue;
        }

        for (const rawDraft of drafts) {
          const parsed = ExtractedFactorSchema.safeParse(rawDraft);
          if (!parsed.success) {
            await deps.repository.quarantine({
              reason: `value validation failed: ${parsed.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')}`,
              publisher: item.publisher,
              sourceUrl: item.sourceUrl,
              payload: rawDraft,
            });
            result.quarantined++;
            continue;
          }

          const draft = parsed.data;
          if (deps.allowlist && !deps.allowlist(draft.citation)) {
            await deps.repository.quarantine({
              reason: 'source not on allowlist',
              publisher: draft.citation.publisher,
              sourceUrl: draft.citation.sourceUrl,
              payload: draft,
            });
            result.quarantined++;
            continue;
          }

          // Per-finding idempotency: skip a finding whose source was
          // already ingested (a prior cycle) or already seen earlier this batch.
          const hash = draftContentHash(draft);
          const alreadySeen =
            seenInBatch.has(hash) ||
            (await deps.repository.existsByContentHash(hash)) ||
            (draft.citation.sourceUrl
              ? await deps.repository.existsBySourceUrl(draft.citation.sourceUrl)
              : false);
          if (alreadySeen) {
            result.skippedDuplicateFactors++;
            continue;
          }
          seenInBatch.add(hash);

          prepared.push({
            draft,
            item,
            contentHash: hash,
            embeddingText: `${draft.name}\n${draft.description}`,
          });
        }
      }

      if (prepared.length === 0) return result;

      // --- Phase B: ONE batched embedding call for the whole page. ---
      const vectors = await deps.embeddings.embed(prepared.map((p) => p.embeddingText));
      if (vectors.length !== prepared.length) {
        throw new Error(
          `Phase B returned ${vectors.length} vectors for ${prepared.length} factors`,
        );
      }

      // --- Phases C + D, serialized per spatial bucket. ---
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i]!;
        const embedding = vectors[i]!;
        result.processedFactors++;

        const outcome = await deps.repository.withBucketLock(
          bucketKey(p.draft),
          (tx) => this.reconcileOne(tx, p, embedding, deps.resolver),
        );

        if (outcome.kind === 'insert') result.inserted++;
        else result.escalated++;
      }

      return result;
    },

    /**
     * Phase C + D for a single prepared factor, inside the bucket lock. Fetches
     * candidates, asks the resolver to classify when there are any, then executes
     * exactly one write (insert or escalate).
     */
    async reconcileOne(
      tx: IngestionTx,
      p: PreparedFactor,
      embedding: number[],
      resolver: EntityResolver,
    ): Promise<ResolutionOutcome> {
      // Phase C — candidates, not a decision.
      const raw = await tx.findNearestFactors(embedding, CANDIDATE_TOP_K);
      const candidates = filterCandidates(raw);

      // Phase D — classify (only when there is something to compare against).
      let verdict: ResolverVerdict;
      if (candidates.length === 0) {
        verdict = { kind: 'independent' };
      } else {
        verdict = await resolver.resolve({
          incoming: {
            name: p.draft.name,
            description: p.draft.description,
            effect: p.draft.effect,
            significance: p.draft.significance,
            spatialPath: p.draft.spatialPath,
          },
          candidates: candidates.map((c) => candidateView(c, p)),
        });
      }

      const outcome = resolveOutcome(verdict, candidates, {
        effect: p.draft.effect,
        significance: p.draft.significance,
      });

      const citation: CitationWriteInput = {
        publisher: p.draft.citation.publisher,
        sourceUrl: p.draft.citation.sourceUrl,
        quoteSnippet: p.draft.citation.quoteSnippet,
        contentHash: p.contentHash,
      };

      if (outcome.kind === 'insert') {
        // No Collision — a distinct event. Its verification state comes from the
        // reputability gate: `verified` when a reputable source cleared
        // the threshold, else `pending` ( default for machine-extracted
        // rows, still excluded from the field bake until verified).
        await tx.insertFactor({
          name: p.draft.name,
          description: p.draft.description,
          effect: p.draft.effect,
          significance: p.draft.significance,
          lat: p.draft.lat,
          lon: p.draft.lon,
          spatialPath: p.draft.spatialPath,
          embedding,
          verificationState: p.draft.verificationState ?? 'pending',
          // Carried through when the draft had a dated threshold; else undefined.
          tippingPoint: p.draft.tippingPoint,
          // Reputability audit trail: carry the deciding source's
          // score + reasoning onto the persisted factor. Undefined offline/ungated.
          reputabilityScore: p.draft.reputabilityScore,
          reputabilityReasoning: p.draft.reputabilityReasoning,
          citation,
          revision: {
            effect: p.draft.effect,
            significance: p.draft.significance,
            directionality: null,
            reason: 'insert',
          },
        });
      } else {
        // Collision — escalate exactly one parent with recalculated metrics
        //, appending a citation + revision (finding 29 one-target write).
        await tx.escalateFactor({
          parentId: outcome.parent.id,
          effect: outcome.recalculated.effect,
          significance: outcome.recalculated.significance,
          citation,
          revision: {
            effect: p.draft.effect,
            significance: p.draft.significance,
            directionality: outcome.directionality,
            reason: `escalation:${outcome.directionality}`,
          },
        });
      }

      return outcome;
    },
  };
}

export type Pipeline = ReturnType<typeof createPipeline>;

function candidateView(
  c: FactorCandidate,
  _p: PreparedFactor,
): ResolutionCandidateView {
  // The DB candidate carries metrics + distance; name/description are not on the
  // FactorCandidate shape (kept lean for the pure math), so the resolver sees the
  // identifying metrics and distance. A richer view can be added if a resolver
  // needs the parent's text — it would come from an additional repository read.
  return {
    id: c.id,
    name: '',
    description: '',
    effect: c.effect,
    significance: c.significance,
    distance: c.distance,
  };
}

/* -------------------------------------------------------------------------- */
/* Convenience wiring from env                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build a pipeline choosing the embedding client from the environment
 * ({@link createEmbeddingClient}). The repository, extractor, and resolver are
 * always injected — those are the seams a real deployment fills with Postgres +
 * LLM calls, and tests fill with the offline stubs below.
 */
export function createPipelineFromEnv(
  env: EmbeddingEnv,
  ports: Omit<PipelineDeps, 'embeddings'>,
): Pipeline {
  return createPipeline({
    ...ports,
    embeddings: createEmbeddingClient(env, ports.logger ?? console),
  });
}

/* -------------------------------------------------------------------------- */
/* Live Phase A adapter — web-search research as the extractor        */
/* -------------------------------------------------------------------------- */

/** Phase A research function: a topic in, candidate factors out (websearch.ts). */
export type ResearchFn = (topic: string) => Promise<CandidateFactor[]>;

/** The verified/pending decision + chosen primary citation for one candidate. */
export interface GateResult {
  verificationState: VerificationState;
  citation: { publisher: string; sourceUrl: string | null; quoteSnippet: string };
  /**
   * The reputability audit trail: the DECIDING (max-scoring)
   * source's score `∈ [0, 1]` and its reasoning, threaded onto the draft so the
   * verified/pending decision is persisted and auditable. Absent from the ungated
   * `defaultGate` fallback.
   */
  reputabilityScore?: number | undefined;
  reputabilityReasoning?: string | undefined;
}

/**
 * The reputability gate, injected by the worker. Given a candidate and
 * its sources, it scores them and returns the verification state + the primary
 * citation to persist. Kept as an injected port so `pipeline.ts` stays free of
 * the reputability/LLM code (that wiring lives in `worker.ts`).
 */
export type SourceGate = (candidate: CandidateFactor) => Promise<GateResult>;

/** Ungated fallback: pending, citing the candidate's first source. */
function defaultGate(candidate: CandidateFactor): GateResult {
  const primary = candidate.sources[0];
  if (primary) {
    return {
      verificationState: 'pending',
      citation: {
        publisher: primary.publisher,
        sourceUrl: primary.url,
        quoteSnippet: primary.quoteSnippet,
      },
    };
  }
  return {
    verificationState: 'pending',
    citation: {
      publisher: 'live-research',
      sourceUrl: null,
      quoteSnippet: candidate.description.slice(0, 280) || candidate.name,
    },
  };
}

/**
 * Wire Phase A (extraction) to the live web-search research engine. The
 * inbound item's `rawText` is interpreted as a research TOPIC (trusted config, not
 * untrusted article text); `research` runs the retrieval + typed-extraction stages
 * and returns candidates; the optional `gate` resolves each candidate's
 * verification state and primary citation. The rest of the loop (validate → embed
 * → dedupe → resolve → write) is unchanged, so /-19/-20/-21 all still hold.
 */
export function createResearchExtractor(
  research: ResearchFn,
  gate?: SourceGate,
): FactorExtractor {
  return {
    async extract(item: InboundIntelItem): Promise<ExtractedFactorDraft[]> {
      const candidates = await research(item.rawText);
      const drafts: ExtractedFactorDraft[] = [];
      for (const c of candidates) {
        const g = gate ? await gate(c) : defaultGate(c);
        drafts.push({
          name: c.name,
          description: c.description,
          effect: c.effect,
          significance: c.significance,
          lat: c.lat,
          lon: c.lon,
          spatialPath: c.spatialPath,
          verificationState: g.verificationState,
          // Carry a dated threshold through when Phase A found one; else undefined.
          tippingPoint: c.tippingPoint,
          // Carry the reputability audit trail from the gate.
          reputabilityScore: g.reputabilityScore,
          reputabilityReasoning: g.reputabilityReasoning,
          citation: g.citation,
        });
      }
      return drafts;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Offline stubs (deterministic, for tests + `npm run` smoke checks)          */
/* -------------------------------------------------------------------------- */

/**
 * A trivial deterministic extractor: one factor per item, coordinates and
 * metrics carried on the item via a JSON `rawText` payload when present, else a
 * neutral default. Real Phase A is an LLM with a JSON-schema-constrained,
 * untrusted-text-delimited prompt ( / finding 27); this stub only exists
 * so the loop runs offline.
 */
export function createStubExtractor(): FactorExtractor {
  return {
    async extract(item: InboundIntelItem): Promise<ExtractedFactorDraft[]> {
      let payload: Partial<ExtractedFactorDraft> = {};
      try {
        const parsed: unknown = JSON.parse(item.rawText);
        if (parsed && typeof parsed === 'object') {
          payload = parsed as Partial<ExtractedFactorDraft>;
        }
      } catch {
        // rawText was not JSON — fall through to defaults.
      }
      return [
        {
          name: payload.name ?? 'Unclassified factor',
          description: payload.description ?? item.rawText.slice(0, 500),
          effect: payload.effect ?? -0.5,
          significance: payload.significance ?? 0.5,
          lat: payload.lat ?? 0,
          lon: payload.lon ?? 0,
          spatialPath: payload.spatialPath ?? 'global',
          // Pass a dated threshold through when the JSON payload carried one; else undefined.
          tippingPoint: payload.tippingPoint,
          citation: {
            publisher: item.publisher,
            sourceUrl: item.sourceUrl,
            quoteSnippet: payload.citation?.quoteSnippet ?? item.rawText.slice(0, 280),
          },
        },
      ];
    },
  };
}

/**
 * A deterministic resolver: escalates the nearest candidate when it is within
 * the hard collision threshold and classifies it `corroborating`, otherwise
 * declares the inbound independent. This mirrors the spec's original `< 0.15`
 * rule but as one specific *policy* over the candidate set — real Phase D is an
 * LLM. Useful as a baseline and for offline tests.
 */
export function createStubResolver(threshold = 0.15): EntityResolver {
  return {
    async resolve(request: ResolutionRequest): Promise<ResolverVerdict> {
      const nearest = request.candidates[0];
      if (nearest && nearest.distance <= threshold) {
        return {
          kind: 'escalation',
          parentId: nearest.id,
          directionality: 'corroborating',
        };
      }
      return { kind: 'independent' };
    },
  };
}
