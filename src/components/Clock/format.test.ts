import { describe, expect, it } from 'vitest';
import { formatYear, pad2, splitDuration } from './format.js';

const YEAR_MS = 365.25 * 86_400 * 1000;
const DAY_MS = 86_400 * 1000;

describe('splitDuration', () => {
  it('splits a positive duration into years-inclusive parts', () => {
    const p = splitDuration(2 * YEAR_MS + 3 * DAY_MS + 4 * 3_600_000 + 5 * 60_000 + 6_000);
    expect(p).toEqual({ years: 2, days: 3, hours: 4, minutes: 5, seconds: 6 });
  });

  it('reports the magnitude of an overshoot rather than clamping to zero', () => {
    // The behaviour the negative countdown rests on. Clamping here is what
    // forced the Clock to swap in a "target passed" label, which reads as a
    // terminal state when the model treats a crossed threshold as a debt.
    const p = splitDuration(-(3 * DAY_MS + 2 * 3_600_000));
    expect(p).toEqual({ years: 0, days: 3, hours: 2, minutes: 0, seconds: 0 });
  });

  it('is symmetric about zero, so the sign is purely the caller display', () => {
    const ms = 5 * YEAR_MS + 40 * DAY_MS + 7 * 60_000;
    expect(splitDuration(-ms)).toEqual(splitDuration(ms));
  });

  it('carries years into the overshoot too', () => {
    expect(splitDuration(-(4 * YEAR_MS + DAY_MS)).years).toBe(4);
  });

  it('is all zeroes exactly at the target', () => {
    expect(splitDuration(0)).toEqual({ years: 0, days: 0, hours: 0, minutes: 0, seconds: 0 });
  });
});

describe('pad2', () => {
  it('zero-pads below ten and leaves wider values alone', () => {
    expect(pad2(0)).toBe('00');
    expect(pad2(9)).toBe('09');
    expect(pad2(59)).toBe('59');
  });
});

describe('formatYear', () => {
  it('rounds to a whole year, since sources carry no finer precision', () => {
    expect(formatYear(2048.3)).toBe('2048');
    expect(formatYear(2048.7)).toBe('2049');
    expect(formatYear(2020.93)).toBe('2021');
  });
});
