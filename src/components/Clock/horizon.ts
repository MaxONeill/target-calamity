import {
  DEFAULT_CLOCK_HORIZON,
  type ClockHorizonConfig,
} from '../../lib/clock/clockModel.js';

/**
 * Reads the operator-configured shift bound from the Vite env at build time.
 *
 * `VITE_CLOCK_MAX_SHIFT_YEARS` bounds how far net polarity may move the
 * tipping-point baseline. It is an operator estimate, never a figure taken from
 * the seed sources, so it is configured rather than hardcoded here. Anything
 * non-numeric or negative falls back to {@link DEFAULT_CLOCK_HORIZON}.
 */
export function resolveHorizon(): ClockHorizonConfig {
  const raw = import.meta.env?.VITE_CLOCK_MAX_SHIFT_YEARS;
  const parsed = raw === undefined ? NaN : Number(raw);

  return Number.isFinite(parsed) && parsed >= 0
    ? { maxShiftYears: parsed }
    : DEFAULT_CLOCK_HORIZON;
}
