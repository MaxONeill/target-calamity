import { useEffect, useMemo, useState } from 'react';
import type { ClockModel } from '../../lib/clock/clockModel.js';
import { targetDeadlineMs } from '../../lib/clock/clockModel.js';
import { splitDuration, type CountdownParts } from './format.js';

export interface Countdown {
  /**
   * Distance to the target instant, as a magnitude. Past the target this is how
   * far past — the clock keeps running rather than stopping at a label.
   */
  remaining: CountdownParts;
  /** True once the modeled target instant has passed; the count is then negative. */
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
  // Keyed on targetYear, NOT on `model`. `deriveClock` returns a fresh object
  // every render, so depending on the whole model would recompute the deadline
  // and retrigger the effect below on every tick — tearing down and rearming the
  // interval once a second. The deadline is a function of targetYear alone.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
