import { ELASTICITY_DEFAULT } from '../../lib/clock/clockModel.js';

/**
 * Reads the operator-configured elasticity from the Vite env at build time.
 *
 * `VITE_CLOCK_ELASTICITY` is the one modeling knob — the dimensionless fraction
 * of a threshold's runway that collective force can bend it. It is a reasoned
 * assumption, not a figure from any source, so it is configured rather than
 * hardcoded. Anything non-numeric or negative falls back to
 * {@link ELASTICITY_DEFAULT}.
 */
export function resolveElasticity(): number {
  const raw = import.meta.env?.VITE_CLOCK_ELASTICITY;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : ELASTICITY_DEFAULT;
}

/** The current instant as a decimal calendar year (the model's reference frame). */
export function currentYearFraction(now: Date = new Date()): number {
  const year = now.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (now.getTime() - start) / (end - start);
}
