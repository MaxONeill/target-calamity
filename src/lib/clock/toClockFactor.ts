import type {
  FieldPin,
  GlobalFactor,
  Projection as WireProjection,
} from '../../../shared/types.js';
import type {
  ClockFactorInput,
  Projection,
  QuantityThreshold,
  TippingPoint,
} from './clockModel.js';

/**
 * Projects a wire projection onto the Clock's input shape.
 *
 * Same `exactOptionalPropertyTypes` boundary as {@link toClockFactor}: the
 * schema's `.optional()` yields `T | undefined`, the model uses `?: T`, and
 * those are distinct types even though they mean the same thing. Rebuilt field
 * by field rather than cast — and every optional MUST be listed, because one
 * omitted here is dropped silently while everything still compiles.
 *
 * `assumesFutureAction` is the dangerous one to lose: absent means "assumes
 * action", so dropping a `false` would withhold forces from a curve that should
 * have received them.
 */
export function toClockProjection(p: WireProjection): Projection {
  const built: {
    id?: string;
    quantity: string;
    unit: string;
    baseline?: string;
    assumesFutureAction?: boolean;
    points: readonly { readonly year: number; readonly value: number }[];
  } = { id: p.id, quantity: p.quantity, unit: p.unit, points: p.points };

  if (p.baseline !== undefined) built.baseline = p.baseline;
  if (p.assumesFutureAction !== undefined) {
    built.assumesFutureAction = p.assumesFutureAction;
  }
  return built;
}

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
    // Every optional field must be copied explicitly. A field omitted here is
    // dropped SILENTLY — the result stays structurally assignable, so nothing
    // fails to compile and unit tests that build ClockFactorInput directly still
    // pass, while the running app quietly loses the value. `closesWindow`
    // decides whether a threshold anchors the countdown at all, so losing it
    // would suppress the Clock outright.
    const built: {
      centralYear?: number;
      earliestYear?: number;
      latestYear?: number;
      label?: string;
      closesWindow?: boolean;
      quantityThreshold?: QuantityThreshold;
    } = {};

    if (source.centralYear !== undefined) built.centralYear = source.centralYear;
    if (source.earliestYear !== undefined) built.earliestYear = source.earliestYear;
    if (source.latestYear !== undefined) built.latestYear = source.latestYear;
    if (source.label !== undefined) built.label = source.label;
    if (source.closesWindow !== undefined) built.closesWindow = source.closesWindow;
    if (source.quantityThreshold !== undefined) {
      const q = source.quantityThreshold;
      const qt: {
        quantity: string;
        value: number;
        unit: string;
        baseline?: string;
        lowValue?: number;
        highValue?: number;
      } = { quantity: q.quantity, value: q.value, unit: q.unit };
      if (q.baseline !== undefined) qt.baseline = q.baseline;
      if (q.lowValue !== undefined) qt.lowValue = q.lowValue;
      if (q.highValue !== undefined) qt.highValue = q.highValue;
      built.quantityThreshold = qt;
    }
    tippingPoint = built;
  }

  return {
    // Carried so a threshold can be joined to rows keyed on the factor —
    // contingency chains in particular. Without it every ThresholdContribution
    // reports factorId: null and the chains have nothing to attach to.
    id: pin.id,
    effect: pin.effect,
    significance: pin.significance,
    domains: pin.domains,
    tippingPoint,
  };
}
