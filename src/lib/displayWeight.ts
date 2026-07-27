/**
 * Stretch significance across the served set's own range — FOR RENDERING ONLY.
 *
 * Scoring produces defensible per-item judgements but a compressed spread: the
 * model's tiers cluster, so a globe tinted straight from `significance` shows
 * far less variation than the underlying judgements actually contain. Stretching
 * the range makes real differences visible.
 *
 * WHY THIS IS RENDER-ONLY, and must stay that way:
 *
 *   - `significance` is `p` in the Clock's first-crossing model, read as "the
 *     probability this threshold is real". Normalising would push the top-ranked
 *     item to ~1.0 BECAUSE it is the maximum, asserting a certainty no source
 *     gave — the one thing that model refuses to do.
 *   - It would make a factor's weight a property of the CORPUS rather than of
 *     the factor. Ingest twenty unrelated findings and every anchor's weight
 *     shifts, moving the countdown for reasons having nothing to do with any
 *     threshold.
 *
 * Determinism holds for the globe: the field payload is fixed for a given
 * `fieldEpoch`, so two clients on the same epoch compute the same stretch from
 * the same inputs and render the same planet.
 *
 * p5/p95 rather than min/max on purpose. True min/max lets a single outlier
 * rescale everything — the same fragility as the weighted median the Clock
 * moved away from. Quantiles ignore the tails; the clamp keeps them in range.
 *
 * LIMITATION: that robustness is a function of sample size. At n = 89 (the
 * current field) p5 sits past four items and an outlier is genuinely absorbed.
 * Below roughly n = 20 the 5th percentile is close to the minimum and a single
 * extreme value still moves the scale. This is display only, so the failure is
 * a mis-tinted globe rather than a wrong number — but it is why nothing in the
 * model may depend on it.
 */

/** Below this the corpus has no spread worth stretching; pass it through. */
const MIN_SPREAD = 0.02;

/**
 * Floor for the stretched value. Nothing renders at exactly zero — a real
 * factor with the lowest significance in view should still be faintly visible
 * rather than indistinguishable from no data, which the globe reserves for
 * genuinely untinted geography.
 */
const DISPLAY_FLOOR = 0.08;

/** Linear-interpolated quantile over a sorted, non-empty array. */
function quantileOf(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
}

/**
 * Map each significance onto [DISPLAY_FLOOR, 1] by its position between the
 * set's 5th and 95th percentiles.
 *
 * Returns a function rather than mutated values so callers decide what to apply
 * it to — and so it is obvious at the call site that this is a display
 * transform, not a new score.
 */
export function displayWeightScaler(
  significances: readonly number[],
): (significance: number) => number {
  const finite = significances.filter((s) => Number.isFinite(s));
  if (finite.length === 0) return (s) => s;

  const sorted = [...finite].sort((a, b) => a - b);
  const p5 = quantileOf(sorted, 0.05);
  const p95 = quantileOf(sorted, 0.95);
  const spread = p95 - p5;

  // A corpus with no spread (one factor, or all identical) has nothing to
  // stretch. Returning the input unchanged beats amplifying rounding noise into
  // apparent structure.
  if (!(spread > MIN_SPREAD)) return (s) => s;

  return (significance: number) => {
    if (!Number.isFinite(significance)) return DISPLAY_FLOOR;
    const t = (significance - p5) / spread;
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    return DISPLAY_FLOOR + clamped * (1 - DISPLAY_FLOOR);
  };
}

/**
 * Re-weight a set for display, leaving every other field alone.
 *
 * The returned objects keep their shape, so the scene layer needs no changes —
 * it receives the same structure with `significance` restretched. The ORIGINAL
 * array must keep being used for the Clock.
 */
export function withDisplayWeight<T extends { significance: number }>(items: readonly T[]): T[] {
  const scale = displayWeightScaler(items.map((i) => i.significance));
  return items.map((item) => ({ ...item, significance: scale(item.significance) }));
}
