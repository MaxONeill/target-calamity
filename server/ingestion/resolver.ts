/**
 * Phase D — LLM entity resolver.
 *
 * On an embedding collision (Phase C surfaced candidates), the resolver decides
 * whether the incoming factor is an INDEPENDENT context or an ONGOING ESCALATION
 * of a colliding existing factor. This is the LIVE implementation of the
 * `EntityResolver` port `pipeline.ts` already consumes; the deterministic
 * `createStubResolver` there remains the OFFLINE fallback (never deleted).
 *
 * Division of labour (finding 28 / ): the LLM only PROPOSES — a relation,
 * and (for an escalation) its own recalculated effect/significance and a
 * rationale. It never writes the stored numbers. This module maps that proposal
 * onto a `ResolverVerdict` (`independent` | `escalation` + directionality), and
 * the DETERMINISTIC layer downstream (`resolveOutcome` → `recalculateOnEscalation`
 * in `dedupe.ts`) does the actual bounded, replayable recalculation from the
 * INCOMING report's Phase-A metrics. So the LLM proposes; the server clamps,
 * bounds, and validates.
 *
 * Parent selection stays deterministic: an escalation attaches to
 * the NEAREST candidate (`request.candidates[0]`, already exact-distance-sorted by
 * `filterCandidates`), never to a hallucinated id — the LLM's job is the RELATION,
 * not which row. Directionality is derived from the LLM's proposed significance
 * relative to that parent (higher → intensifying, lower → de-escalating, ~equal or
 * unstated → corroborating), and every proposed number is clamped to its domain
 * before use.
 *
 * LIVE via one JSON-schema-constrained Fireworks turn, exactly the shape
 * `websearch.ts` / `reputability.ts` use. Any failure (throw, unparseable output)
 * degrades to `independent` — the conservative "do not merge" default, matching
 * `resolveOutcome`'s own fallback — rather than crashing a cycle.
 */
import * as z from 'zod/v4';
import {
  type LlmClient,
  getLlmClient,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';
import type { EntityResolver, ResolutionRequest } from './pipeline.js';
import type { EscalationDirectionality, ResolverVerdict } from './dedupe.js';

/** The proposed significance change under which a report is treated as corroborating. */
const DIRECTIONALITY_EPSILON = 0.02;

/* -------------------------------------------------------------------------- */
/* Output contract (zod v4 — grammar source AND response validator)           */
/* -------------------------------------------------------------------------- */

/**
 * What the resolver prompt returns. `relation` is the decision; for an
 * `escalation` the model MAY propose recalculated metrics (clamped here, then
 * used only to derive directionality — the deterministic layer re-computes the
 * stored numbers). `rationale` is retained for logging/audit.
 */
export const ResolutionSchema = z.object({
  relation: z.enum(['independent', 'escalation']),
  updatedEffect: z.number().optional(),
  updatedSignificance: z.number().optional(),
  rationale: z.string(),
});

export type ResolutionProposal = z.infer<typeof ResolutionSchema>;

/* -------------------------------------------------------------------------- */
/* Domain clamps                                                    */
/* -------------------------------------------------------------------------- */

/** Clamp to `[lo, hi]`; a non-finite input collapses to `lo` (defensive). */
export function clampTo(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/* -------------------------------------------------------------------------- */
/* Proposal → verdict (pure, testable)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Derive escalation directionality from the LLM's proposed significance relative
 * to the parent's current significance. Higher (beyond ε) → `intensifying`;
 * lower → `de-escalating`; within ε or unstated → `corroborating`. The proposed
 * value is clamped to `[0, 1]` first.
 */
export function deriveDirectionality(
  proposedSignificance: number | undefined,
  parentSignificance: number,
): EscalationDirectionality {
  if (proposedSignificance === undefined) return 'corroborating';
  const proposed = clampTo(proposedSignificance, 0, 1);
  const parent = clampTo(parentSignificance, 0, 1);
  if (proposed > parent + DIRECTIONALITY_EPSILON) return 'intensifying';
  if (proposed < parent - DIRECTIONALITY_EPSILON) return 'de-escalating';
  return 'corroborating';
}

/**
 * Map a validated proposal + the candidate set onto a {@link ResolverVerdict}.
 * Pure and deterministic given its inputs, so the clamping/validation logic is
 * unit-testable without any network call. An `escalation` with no candidates
 * degrades to `independent` (nothing to attach to); otherwise it attaches to the
 * NEAREST candidate with LLM-derived directionality. Proposed
 * effect/significance are clamped even though the deterministic recalc
 * downstream re-derives the stored numbers — the clamp keeps a poisoned proposal
 * from ever influencing directionality out of domain.
 */
export function verdictFromProposal(
  proposal: ResolutionProposal,
  request: ResolutionRequest,
): ResolverVerdict {
  const nearest = request.candidates[0];
  if (proposal.relation === 'independent' || !nearest) {
    return { kind: 'independent' };
  }
  return {
    kind: 'escalation',
    parentId: nearest.id,
    directionality: deriveDirectionality(
      proposal.updatedSignificance,
      nearest.significance,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

const RESOLVER_SYSTEM =
  'You are an entity-resolution analyst for a live reality tracker. You are given ' +
  'an INCOMING factor and one or more EXISTING candidate factors it collided with ' +
  'by embedding similarity. Decide the RELATION: "independent" if the incoming ' +
  'factor is a genuinely distinct development (even if same-domain), or ' +
  '"escalation" if it is a new report of the SAME ongoing situation as the nearest ' +
  'candidate (corroboration, intensification, or easing). If "escalation", also ' +
  'propose updatedEffect in [-1,1] (signed: negative=Calamity, positive=Humanity) ' +
  'and updatedSignificance in [0,1] reflecting the situation AFTER this report — ' +
  'raise significance if it intensified, lower it if it eased, keep it if merely ' +
  'corroborated. Always give a brief rationale. When unsure, prefer "independent" ' +
  '(merging distinct events is worse than a near-duplicate). Judge only from the ' +
  'text provided; do not invent facts.';

function resolverUserPrompt(request: ResolutionRequest): string {
  const inc = request.incoming;
  const candidates = request.candidates
    .map(
      (c, i) =>
        `Candidate ${i + 1}${i === 0 ? ' (nearest)' : ''}: ` +
        `effect=${c.effect.toFixed(3)}, significance=${c.significance.toFixed(3)}, ` +
        `distance=${c.distance.toFixed(4)}` +
        (c.name ? `, name="${c.name}"` : '') +
        (c.description ? `, description="${c.description}"` : ''),
    )
    .join('\n');
  return (
    `INCOMING factor:\n` +
    `  name: ${inc.name}\n` +
    `  description: ${inc.description}\n` +
    `  effect: ${inc.effect.toFixed(3)}\n` +
    `  significance: ${inc.significance.toFixed(3)}\n` +
    `  spatialPath: ${inc.spatialPath}\n\n` +
    `EXISTING candidate factor(s), nearest first:\n${candidates}\n\n` +
    'Is the incoming factor independent, or an escalation of the nearest candidate?'
  );
}

/* -------------------------------------------------------------------------- */
/* Live resolver                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the LIVE Phase D resolver. Callers wire this in when
 * `hasLiveCredentials()` and keep `createStubResolver` otherwise (see
 * `worker.ts`). `client` is injectable for tests; it defaults to the shared
 * singleton (constructed only when actually called on a collision).
 */
export function createLlmResolver(client?: LlmClient): EntityResolver {
  return {
    async resolve(request: ResolutionRequest): Promise<ResolverVerdict> {
      // No candidates → nothing to escalate against; skip the call entirely.
      if (request.candidates.length === 0) return { kind: 'independent' };

      const llm = client ?? getLlmClient();
      const model = ingestModel();
      try {
        const out = await structuredCompletion({
          client: llm,
          model,
          system: RESOLVER_SYSTEM,
          user: resolverUserPrompt(request),
          schema: ResolutionSchema,
          schemaName: 'EntityResolution',
        });
        if (out === null) {
          // No parseable proposal → conservative default (do not merge).
          return { kind: 'independent' };
        }
        return verdictFromProposal(out, request);
      } catch {
        // A single resolution failure must not crash the cycle: default to
        // independent (an insert), the same fallback `resolveOutcome` applies.
        return { kind: 'independent' };
      }
    },
  };
}
