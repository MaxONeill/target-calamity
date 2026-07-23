/**
 * Phase C (Similarity) + the Phase D (Resolution) decision math.
 *
 * This module owns the *pure, testable* half of deduplication: the collision
 * query contract, the candidate-selection ordering, and the escalation
 * recalculation formula. It performs no I/O — the pipeline hands it candidates
 * already fetched from the database and an entity-resolution verdict already
 * obtained from the LLM, and this module turns those into a deterministic
 * `ResolutionOutcome`.
 *
 * Three ADRs govern here:
 *
 *    — the `0.15` cosine distance is a CANDIDATE FILTER, not the decision
 *            boundary. We retrieve the top-k within a looser ceiling and let the
 *            entity-resolution prompt make the actual escalate/independent call.
 *
 *    — the "dynamically recalculated" effect/significance ( Phase D,
 *            never defined) is pinned to an explicit, bounded, convex blend here.
 *
 *   /finding-29 — parent selection among multiple collisions is a total
 *            order (exact distance, then age, then id), never HNSW visit order.
 */

/* -------------------------------------------------------------------------- */
/* Query contract                                           */
/* -------------------------------------------------------------------------- */

/**
 * The similarity query MUST be written as a k-NN order-by-limit, not a distance
 * predicate:
 *
 *   SELECT id, effect, significance, created_at, citation_count,
 *          embedding <=> :query AS distance
 *   FROM factors
 *   WHERE embedding IS NOT NULL
 *   ORDER BY embedding <=> :query
 *   LIMIT :k;
 *
 * the spec's
 * "queried for cosine distance collisions (< 0.15)" reads as a
 * `WHERE embedding <=> :q < 0.15` predicate. pgvector only uses the HNSW index
 * for the `ORDER BY ... LIMIT` shape; a bare predicate falls back to a
 * sequential scan computing 1536/512-dim distance on every row. The `ORDER BY`
 * form both uses the index and returns rows in EXACT distance order (the `<=>`
 * operator computes exact distance; HNSW only affects which rows are visited),
 * so `candidates[0]` is the true nearest and the `distance` field is exact.
 *
 * The repository is also expected to set a per-session recall floor
 * (`SET LOCAL hnsw.ef_search = ...`) well above the default 40 for this dedup
 * workload, where a missed neighbour means a false "no collision" and a
 * duplicate insert. That is a DB-layer concern; documented here so it is not
 * forgotten.
 */
export const SIMILARITY_QUERY_SHAPE =
  'SELECT id, effect, significance, created_at, citation_count, embedding <=> :query AS distance ' +
  'FROM factors WHERE embedding IS NOT NULL ORDER BY embedding <=> :query LIMIT :k';

/**
 * How many nearest rows Phase C retrieves as *candidates*. The entity-resolution
 * prompt sees all of them and picks at most one parent; a handful is plenty and
 * keeps the prompt cheap.
 */
export const CANDIDATE_TOP_K = 20;

/**
 * The spec's original number, retained as the CANDIDATE ceiling. A row
 * further than this in cosine distance is not even offered to the resolver.
 *
 * Failure modes of treating this as a hard decision boundary (why  demotes
 * it to a filter):
 *   - Too tight: two genuinely-different-wording reports of the SAME event sit
 *     just above 0.15 → missed escalation → duplicate factors for one event,
 *     double-counting its charge in the field.
 *   - Too loose: two DIFFERENT events in the same domain ("Arctic sea-ice") sit
 *     just below 0.15 → false escalation → distinct events silently merged, their
 *     citations collapsed onto one pin.
 * Neither is decidable by a fixed scalar on 512-dim cosine distance, which is
 * exactly why the LLM makes the final call over the candidate set.
 */
export const COLLISION_DISTANCE_THRESHOLD = 0.15;

/**
 * The looser retrieval ceiling. We surface candidates the hard threshold would
 * exclude so the resolver can catch near-misses in the too-tight direction
 * above. Cosine distance is in `[0, 2]`; `0.30` roughly doubles the capture
 * radius of the spec's `0.15` without dragging in unrelated domains.
 */
export const CANDIDATE_DISTANCE_CEILING = 0.3;

/* -------------------------------------------------------------------------- */
/* Candidate model + selection                                                */
/* -------------------------------------------------------------------------- */

/**
 * One row returned by the Phase C query. `distance` is exact cosine distance to
 * the inbound embedding; `citationCount` feeds the escalation blend weight.
 */
export interface FactorCandidate {
  id: string;
  effect: number;
  significance: number;
  /** Row birth time; the age tiebreak for deterministic parent selection. */
  createdAt: Date;
  /** Number of citations already attached (drives the  blend weight λ). */
  citationCount: number;
  /** Exact cosine distance to the inbound embedding, from `embedding <=> :query`. */
  distance: number;
}

/**
 * Keep only candidates within the retrieval ceiling, in the query's exact
 * distance order. A no-op ordering-wise when the DB already ordered them, but it
 * makes the ordering an explicit invariant of this module rather than a trusted
 * side effect.
 */
export function filterCandidates(
  candidates: readonly FactorCandidate[],
  ceiling = CANDIDATE_DISTANCE_CEILING,
): FactorCandidate[] {
  return candidates
    .filter((c) => c.distance <= ceiling)
    .sort(compareCandidates);
}

/**
 * Total order for parent selection: nearest exact distance wins;
 * ties broken by oldest `createdAt` (event identity anchors to the first report);
 * final tiebreak by ascending `id` so the order is total and stable across
 * processes — Postgres gives no stable order for exact ties, so without the id
 * tiebreak two workers could disagree on the parent.
 */
export function compareCandidates(a: FactorCandidate, b: FactorCandidate): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The deterministic default parent: the single best candidate by
 * {@link compareCandidates}. `null` when the candidate set is empty. The
 * resolver may name a specific parent, but it must be one of the candidates;
 * otherwise the pipeline falls back to this (see `resolveOutcome`).
 */
export function selectParent(
  candidates: readonly FactorCandidate[],
): FactorCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareCandidates)[0]!;
}

/* -------------------------------------------------------------------------- */
/* Escalation recalculation                                          */
/* -------------------------------------------------------------------------- */

/**
 * The resolver's classification of how an inbound report relates to its parent.
 * Only these three are permitted; the arithmetic branches on them.
 */
export type EscalationDirectionality =
  | 'corroborating' // same intensity, more evidence — significance may only rise
  | 'intensifying' // the situation worsened/strengthened — significance may rise
  | 'de-escalating'; // the situation eased — the only case significance may fall

/** The signed/bounded inputs the resolver (or Phase A) supplies for the blend. */
export interface EscalationInputMetrics {
  /** Incoming report's own effect estimate, clamped to [-1, 1]. */
  effect: number;
  /** Incoming report's own significance estimate, clamped to [0, 1]. */
  significance: number;
}

/** Current stored metrics of the parent factor. */
export interface ParentMetrics {
  effect: number;
  significance: number;
  /** Citations already attached — the blend weight decays as this grows. */
  citationCount: number;
}

/** Result of the recalculation: the new stored values for the parent factor. */
export interface RecalculatedMetrics {
  effect: number;
  significance: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * The blend weight λ for a parent with `n` existing citations: `1 / (n + 1)`.
 * A well-corroborated factor (large n) moves little per new report; a fresh one
 * (n = 0) weights the newcomer at 1/2. λ ∈ (0, 1], so the blend below is convex.
 */
export function escalationLambda(citationCount: number): number {
  const n = Math.max(0, citationCount);
  return 1 / (n + 1);
}

/**
 *  — the escalation recalculation, defined once as a pure function.
 *
 * the spec says effect and
 * significance are "dynamically recalculated" and gives no formula. We use a
 * citation-count-weighted convex blend:
 *
 *   λ            = 1 / (parent.citationCount + 1)
 *   effect'      = clamp((1-λ)·effect_parent + λ·effect_new, -1, 1)
 *   significance = clamp((1-λ)·sig_parent    + λ·sig_new,     0,  1)
 *
 * Because inputs are clamped and the blend is convex, outputs stay in domain and
 * repeated escalation SATURATES rather than growing without bound (no runaway
 * counter needed). Monotonicity is explicit: `significance` may only fall under a
 * `de-escalating` verdict; `corroborating`/`intensifying` are non-decreasing
 * (we take `max(parent, blend)`), so more evidence never quietly lowers a
 * factor's weight. `effect` may move either direction — its sign IS the finding.
 *
 * Replayability: the entire current state of a factor is a pure left-fold of
 * this function over its ordered citation history, so persisting each report's
 * (directionality, effect_new, significance_new) lets the value be audited or
 * recomputed if the formula changes (see the `factor_revisions` write in the
 * pipeline).
 */
export function recalculateOnEscalation(
  parent: ParentMetrics,
  incoming: EscalationInputMetrics,
  directionality: EscalationDirectionality,
): RecalculatedMetrics {
  const lambda = escalationLambda(parent.citationCount);

  const eNew = clamp(incoming.effect, -1, 1);
  const sNew = clamp(incoming.significance, 0, 1);
  const eParent = clamp(parent.effect, -1, 1);
  const sParent = clamp(parent.significance, 0, 1);

  const effect = clamp((1 - lambda) * eParent + lambda * eNew, -1, 1);
  const blendedSig = clamp((1 - lambda) * sParent + lambda * sNew, 0, 1);

  const significance =
    directionality === 'de-escalating'
      ? blendedSig // the one case weight is allowed to drop
      : Math.max(sParent, blendedSig); // corroborating/intensifying never lower it

  return { effect, significance };
}

/* -------------------------------------------------------------------------- */
/* Resolution outcome                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The entity-resolution prompt's verdict. Deliberately narrow: the LLM
 * classifies, it does NOT compute the stored numbers (finding 28 — arithmetic is
 * the server's job, above). `parentId`, when present, must reference one of the
 * candidates offered to the prompt.
 */
export type ResolverVerdict =
  | { kind: 'independent' }
  | {
      kind: 'escalation';
      parentId: string;
      directionality: EscalationDirectionality;
    };

/**
 * The final, executable decision for one inbound item. `insert` → new factor +
 * first citation; `escalate` → append citation + revision to exactly one parent
 * with the recalculated metrics (finding 29: one-target write contract).
 */
export type ResolutionOutcome =
  | { kind: 'insert' }
  | {
      kind: 'escalate';
      parent: FactorCandidate;
      directionality: EscalationDirectionality;
      recalculated: RecalculatedMetrics;
    };

/**
 * Turn a resolver verdict + the candidate set + the inbound metrics into an
 * executable {@link ResolutionOutcome}, applying the deterministic guards:
 *
 *   - No candidates, or verdict `independent`  → `insert`.
 *   - Verdict `escalation` naming a candidate   → escalate that one.
 *   - Verdict `escalation` naming an unknown id  → escalate the deterministic
 *     nearest ({@link selectParent}) instead of trusting a hallucinated id; if
 *     somehow no candidate exists, fall back to `insert`.
 *
 * This keeps the write single-target and the parent choice reproducible even
 * when the model is vague or wrong about which row it meant.
 */
export function resolveOutcome(
  verdict: ResolverVerdict,
  candidates: readonly FactorCandidate[],
  incoming: EscalationInputMetrics,
): ResolutionOutcome {
  if (verdict.kind === 'independent' || candidates.length === 0) {
    return { kind: 'insert' };
  }

  const named = candidates.find((c) => c.id === verdict.parentId);
  const parent = named ?? selectParent(candidates);
  if (!parent) return { kind: 'insert' };

  return {
    kind: 'escalate',
    parent,
    directionality: verdict.directionality,
    recalculated: recalculateOnEscalation(
      {
        effect: parent.effect,
        significance: parent.significance,
        citationCount: parent.citationCount,
      },
      incoming,
      verdict.directionality,
    ),
  };
}
