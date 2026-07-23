import { useCallback, useEffect, useState } from 'react';
import { FieldResponseSchema } from '../../shared/schema.js';
import type { FieldPin } from '../../shared/types.js';

export interface FieldPinsState {
  fieldPins: FieldPin[];
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

  const reloadField = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/field');
      if (!res.ok) throw new Error(`field ${res.status}`);
      const parsed = FieldResponseSchema.parse(await res.json());
      setFieldPins(parsed.pins);
    } catch (err) {
      console.error('[field] fetch failed:', err);
    }
  }, []);

  useEffect(() => {
    void reloadField();
  }, [reloadField]);

  return { fieldPins, reloadField };
}
