import { useEffect, useMemo, useState } from 'react';
import type { ClockModel } from '../../lib/clock/clockModel.js';
import { targetDeadlineMs } from '../../lib/clock/clockModel.js';
import { splitDuration, type CountdownParts } from './format.js';

export interface Countdown {
  remaining: CountdownParts;
  /** True once the modeled target instant has passed. */
  overdue: boolean;
}

/**
 * Ticks once a second toward the model's target instant.
 *
 * When the model has no tipping-point baseline the deadline is null and no
 * interval is armed — the Clock shows `INDETERMINATE` rather than counting
 * toward an invented instant.
 */
export function useCountdown(model: ClockModel): Countdown {
  const deadlineMs = useMemo(() => targetDeadlineMs(model), [model.targetYear]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineMs === null) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [deadlineMs]);

  const remainingMs = deadlineMs === null ? 0 : deadlineMs - nowMs;

  return {
    remaining: splitDuration(remainingMs),
    overdue: deadlineMs !== null && remainingMs <= 0,
  };
}
