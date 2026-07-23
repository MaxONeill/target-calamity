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
 * Splits a remaining duration into years-inclusive parts.
 *
 * Years use the same Julian convention as the model's deadline math, so the
 * leading `Yy` segment stays consistent with the projected target year.
 * Remaining days are whatever is left after whole years.
 */
export function splitDuration(ms: number): CountdownParts {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const years = Math.floor(totalSeconds / SECONDS_PER_YEAR);

  let rem = totalSeconds - Math.floor(years * SECONDS_PER_YEAR);
  const days = Math.floor(rem / 86_400);
  rem -= days * 86_400;
  const hours = Math.floor(rem / 3_600);
  rem -= hours * 3_600;
  const minutes = Math.floor(rem / 60);

  return { years, days, hours, minutes, seconds: rem - minutes * 60 };
}

/** Formats a decimal year: whole years as "2050", fractional as "2048.3". */
export function formatYear(year: number): string {
  return Number.isInteger(year) ? String(year) : year.toFixed(1);
}
