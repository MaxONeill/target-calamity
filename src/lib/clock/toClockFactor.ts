import type { FieldPin, GlobalFactor } from '../../../shared/types.js';
import type { ClockFactorInput, TippingPoint } from './clockModel.js';

/**
 * Projects a field pin onto the Clock's input shape.
 *
 * The schema's `tippingPoint` is `.optional()` (fields typed `T | undefined`)
 * while the Clock's own type uses `?: T`. Under `exactOptionalPropertyTypes`
 * those are distinct even though they mean the same thing, so the tipping point
 * is rebuilt carrying only the fields actually present — no cast, and no
 * `undefined` leaking into a property that claims to be absent.
 */
export function toClockFactor(pin: FieldPin | GlobalFactor): ClockFactorInput {
  const source = pin.tippingPoint;
  let tippingPoint: TippingPoint | null = null;

  if (source) {
    const built: {
      centralYear: number;
      earliestYear?: number;
      latestYear?: number;
      label?: string;
    } = { centralYear: source.centralYear };

    if (source.earliestYear !== undefined) built.earliestYear = source.earliestYear;
    if (source.latestYear !== undefined) built.latestYear = source.latestYear;
    if (source.label !== undefined) built.label = source.label;
    tippingPoint = built;
  }

  return { effect: pin.effect, significance: pin.significance, tippingPoint };
}
