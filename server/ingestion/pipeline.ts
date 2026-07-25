/**
 * The reconciliation loop — Phase A to D orchestration.
 *
 * This module owns the impure concerns: idempotency, batching, value
 * validation, quarantine and the transactional critical section. The decision
 * math is pure and lives in dedupe.ts; vectorization lives in embeddings.ts.
 *
 *   A. Extraction    one untrusted item becomes structured drafts, then every
 *                    VALUE is re-validated and anything out of domain is
 *                    quarantined rather than inserted.
 *   B. Vectorization one batched embedding call for the whole surviving page.
 *   C. Similarity    top-k nearest as CANDIDATES, never a distance predicate.
 *   D. Resolution    the resolver classifies; the server computes the metrics
 *                    and writes exactly one target.
 *
 * Everything outside the loop is an injected port (see ports.ts), so this file
 * depends on no database code directly.
 */

import {
  CANDIDATE_TOP_K,
  type FactorCandidate,
  type ResolutionOutcome,
  type ResolverVerdict,
  filterCandidates,
  resolveOutcome,
} from './dedupe.js';
import { contentHash, draftContentHash, bucketKey } from './contentHash.js';
import { ExtractedFactorSchema } from './types.js';
import type { ExtractedFactorDraft, InboundIntelItem } from './types.js';
import type {
  BatchResult,
  CitationWriteInput,
  EntityResolver,
  IngestionTx,
  PipelineDeps,
  ResolutionCandidateView,
} from './ports.js';

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
        // Collision — escalate exactly one parent with recalculated metrics,
        // appending a citation + revision (one-target write) and merging in any
        // new data the parent lacked (tipping point, reputable promotion).
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
          tippingPoint: p.draft.tippingPoint,
          verificationState: p.draft.verificationState,
          reputabilityScore: p.draft.reputabilityScore,
          reputabilityReasoning: p.draft.reputabilityReasoning,
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
/* Re-exports                                                                 */
/* -------------------------------------------------------------------------- */
/*
 * The loop's types, ports, hashing and offline stubs live in their own modules
 * now. They are re-exported here so existing importers keep working and callers
 * still have one obvious entry point for the pipeline.
 */
export * from './types.js';
export * from './ports.js';
export * from './contentHash.js';
export * from './researchExtractor.js';
export * from './stubs.js';
