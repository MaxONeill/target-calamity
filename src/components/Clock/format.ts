/** Seconds in a Julian year, matching the clock model's 365.25-day convention. */
const SECONDS_PER_YEAR = 365.25 * 86_400;

export interface CountdownParts {
  years: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Zero-pads to two digits for clock segments. */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Splits a duration into years-inclusive parts, by MAGNITUDE.
 *
 * Years use the same Julian convention as the model's deadline math, so the
 * leading `Yy` segment stays consistent with the projected target year.
 * Remaining days are whatever is left after whole years.
 *
 * A negative input yields the size of the overshoot rather than clamping to
 * zero, so the Clock can keep counting once the target is behind us. The sign
 * is the caller's to render: the parts describe how far, not which way.
 */
export function splitDuration(ms: number): CountdownParts {
  const totalSeconds = Math.floor(Math.abs(ms) / 1000);
  const years = Math.floor(totalSeconds / SECONDS_PER_YEAR);

  let rem = totalSeconds - Math.floor(years * SECONDS_PER_YEAR);
  const days = Math.floor(rem / 86_400);
  rem -= days * 86_400;
  const hours = Math.floor(rem / 3_600);
  rem -= hours * 3_600;
  const minutes = Math.floor(rem / 60);

  return { years, days, hours, minutes, seconds: rem - minutes * 60 };
}

/**
 * Formats a decimal year to the nearest whole year: 2048.3 → "2048".
 *
 * The model works in fractional years because it interpolates between published
 * bounds, but a tenth of a year is far below the precision any source actually
 * carries, so rendering it implied accuracy that is not there.
 */
export function formatYear(year: number): string {
  return String(Math.round(year));
}

/**
 * What the reversal area says when a crossed threshold has no published
 * `recovery` assessment.
 *
 * A pure function, and exported, because the bug it encodes was a coupling that
 * lived only in JSX and so could not be tested: the fallback line was chosen
 * from `recovery` alone, ignoring the contingency chain rendered directly
 * beneath it. A threshold with a full requirement tree therefore announced
 * "Reversal not yet assessed." and then immediately set out what reversal would
 * require — the panel contradicting itself inside two adjacent blocks.
 *
 * Taking the chain's size as input is the fix: `recovery` and the requirements
 * are the only two sources of reversal knowledge, so the sentence cannot be
 * chosen honestly from one of them alone.
 *
 * @param stepCount number of root requirements in the contingency chain
 */
export function reversalFallback(stepCount: number): string {
  // Requirements ARE an assessment of reversal — a cited chain of what would
  // have to happen. What is absent in that case is the timescale and effort
  // estimate, so that is what gets said. Claiming nothing is known would be
  // false, and the reader can see it is false in the very next block.
  return stepCount > 0
    ? 'No published reversal timescale or effort estimate — what it would require is set out below.'
    : 'Reversal not yet assessed.';
}
