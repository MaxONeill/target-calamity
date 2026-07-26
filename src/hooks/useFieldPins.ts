import { useCallback, useEffect, useState } from 'react';
import { FieldResponseSchema } from '../../shared/schema.js';
import type { FieldPin, GlobalFactor, Projection } from '../../shared/types.js';

export interface FieldPinsState {
  fieldPins: FieldPin[];
  /** Factors with no location. Off the bake, but still part of the aggregate. */
  globalFactors: GlobalFactor[];
  /**
   * Published trajectories. Nothing on the GPU uses these — they date the
   * quantity-stated thresholds the Clock anchors on, and they arrive with the
   * field so both are refetched by the same invalidation and can never drift
   * apart into a threshold dated by a stale curve.
   */
  projections: Projection[];
  /** Refetches the field set. Called on mount and on a stream invalidation. */
  reloadField: () => Promise<void>;
}

/**
 * The shader's data path: `GET /api/field`, fetched once and again only when
 * the live stream signals a factor changed.
 *
 * It takes no camera, cursor or sort parameter by design — the field is a
 * function of the data alone, so two clients on the same epoch render the same
 * planet. A failed fetch leaves the globe showing plain geography, which is the
 * honest "no data" state, rather than tearing down the instrument.
 */
export function useFieldPins(): FieldPinsState {
  const [fieldPins, setFieldPins] = useState<FieldPin[]>([]);
  const [globalFactors, setGlobalFactors] = useState<GlobalFactor[]>([]);
  const [projections, setProjections] = useState<Projection[]>([]);

  const reloadField = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/field');
      if (!res.ok) throw new Error(`field ${res.status}`);
      const parsed = FieldResponseSchema.parse(await res.json());
      setFieldPins(parsed.pins);
      setGlobalFactors(parsed.globalFactors);
      setProjections(parsed.projections);
    } catch (err) {
      console.error('[field] fetch failed:', err);
    }
  }, []);

  useEffect(() => {
    void reloadField();
  }, [reloadField]);

  return { fieldPins, globalFactors, projections, reloadField };
}
