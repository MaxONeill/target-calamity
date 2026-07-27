/**
 * Adapts the live research engine to the loop's extractor port, and applies the
 * source-reputability gate that decides verified vs pending.
 */
import type { VerificationState } from '../../shared/types.js';
import type { CandidateFactor } from './websearch.js';
import type { FactorExtractor } from './ports.js';
import type { ExtractedFactorDraft, InboundIntelItem } from './types.js';
import type { EmbeddingEnv } from './embeddings.js';
import { createEmbeddingClient } from './embeddings.js';
import type { PipelineDeps } from './ports.js';
import { createPipeline, type Pipeline } from './pipeline.js';

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
   * Every OTHER source the gate scored, in the order the extraction gave them.
   *
   * The gate has always seen all of them — it scores each and keeps the best —
   * but only the winner was persisted, so a claim backed by three publishers
   * displayed one citation and the corroboration vanished silently. Carried
   * through here so the write path can keep them.
   */
  corroborating?: readonly { publisher: string; sourceUrl: string | null; quoteSnippet: string }[];
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
          // LLM-assigned causal domains.
          domains: c.domains,
          // Carry the reputability audit trail from the gate.
          reputabilityScore: g.reputabilityScore,
          reputabilityReasoning: g.reputabilityReasoning,
          citation: g.citation,
          // The sources that did not win. Kept so the write path can persist
          // them alongside the deciding one.
          corroborating: g.corroborating,
        });
      }
      return drafts;
    },
  };
}
