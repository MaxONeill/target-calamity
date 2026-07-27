import { useEffect, useState } from 'react';
import { FactorSchema } from '../../shared/schema.js';
import type { Factor } from '../../shared/types.js';

export type StreamStatus = 'connecting' | 'live' | 'seed' | 'closed';

export const STREAM_LABEL: Record<StreamStatus, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  seed: 'SEED',
  closed: 'RECONNECTING',
};

/** Window over which a burst of deltas collapses into one field refetch. */
const FIELD_REFETCH_DEBOUNCE_MS = 250;

export interface FactorStreamOptions {
  /** Patches a changed factor into the cached feed. */
  onFactorChanged: (factor: Factor) => void;
  /** Invalidates the shader field. Debounced across a burst. */
  onFieldInvalidated: () => void;
}

/**
 * Subscribes to live deltas over server-sent events.
 *
 * A delta patches the cached card in place and invalidates the field. It never
 * splices into the feed's backfill pagination, whose keyset assumes an immutable
 * ordering. Unparseable payloads still count as "something changed" and fall
 * through to the field refetch, which reconciles from the source.
 */
export function useFactorStream({
  onFactorChanged,
  onFieldInvalidated,
}: FactorStreamOptions): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    const source = new EventSource('/api/stream');
    let refetchTimer: number | null = null;

    const scheduleFieldRefetch = (): void => {
      if (refetchTimer !== null) return;
      refetchTimer = window.setTimeout(() => {
        refetchTimer = null;
        onFieldInvalidated();
      }, FIELD_REFETCH_DEBOUNCE_MS);
    };

    source.addEventListener('ready', (event) => {
      try {
        const data = JSON.parse(event.data) as { mode?: string };
        setStatus(data.mode === 'db' ? 'live' : 'seed');
      } catch {
        setStatus('live');
      }
    });

    source.addEventListener('factor', (event) => {
      try {
        const parsed = FactorSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) onFactorChanged(parsed.data);
      } catch {
        // Fall through: the field refetch reconciles regardless.
      }
      scheduleFieldRefetch();
    });

    source.onerror = () => {
      // EventSource reconnects on its own; reflect the transient drop only.
      setStatus((current) => (current === 'live' || current === 'seed' ? current : 'closed'));
    };

    return () => {
      if (refetchTimer !== null) window.clearTimeout(refetchTimer);
      source.close();
    };
  }, [onFactorChanged, onFieldInvalidated]);

  return status;
}
