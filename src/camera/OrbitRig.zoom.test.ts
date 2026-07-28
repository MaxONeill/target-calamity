/**
 * `distanceAfterWheelNotches` — expressing a camera distance in wheel clicks.
 *
 * Zoom is multiplicative (`radius * exp(deltaY * speed)`), so "three clicks
 * further out" is a factor, not an offset. The opening framing is written in
 * notches because that is the unit the requirement arrived in; these pin that
 * the conversion agrees with what the wheel handler actually does, and that the
 * resulting distance is a distance the rig will accept rather than one it
 * silently clamps.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_ZOOM,
  MAX_ZOOM,
  WHEEL_NOTCH_DELTA,
  WHEEL_ZOOM_SPEED,
  distanceAfterWheelNotches,
} from './OrbitRig';

/** The framing the globe opens from, before the pull-back. */
const BASE_FRAMING = MIN_ZOOM * 2.4;

describe('distanceAfterWheelNotches', () => {
  it('matches the wheel handler formula exactly', () => {
    // The handler computes `radius * Math.exp(deltaY * speed)` per event. If
    // these ever disagree, "three clicks out" stops meaning three clicks.
    const oneNotch = BASE_FRAMING * Math.exp(WHEEL_NOTCH_DELTA * WHEEL_ZOOM_SPEED);
    expect(distanceAfterWheelNotches(BASE_FRAMING, 1)).toBeCloseTo(oneNotch, 10);
  });

  it('composes: three notches equals one notch three times', () => {
    let stepped = BASE_FRAMING;
    for (let i = 0; i < 3; i++) stepped = distanceAfterWheelNotches(stepped, 1);
    expect(distanceAfterWheelNotches(BASE_FRAMING, 3)).toBeCloseTo(stepped, 10);
  });

  it('zooms OUT for positive notches and in for negative', () => {
    expect(distanceAfterWheelNotches(BASE_FRAMING, 3)).toBeGreaterThan(BASE_FRAMING);
    expect(distanceAfterWheelNotches(BASE_FRAMING, -3)).toBeLessThan(BASE_FRAMING);
  });

  it('round-trips, because the transform is multiplicative', () => {
    const out = distanceAfterWheelNotches(BASE_FRAMING, 3);
    expect(distanceAfterWheelNotches(out, -3)).toBeCloseTo(BASE_FRAMING, 10);
  });

  it('leaves the opening distance inside the rig range, so it is not clamped', () => {
    // A framing past MAX_ZOOM would be silently pulled back in, and the globe
    // would open at a distance nobody chose.
    const opening = distanceAfterWheelNotches(BASE_FRAMING, 3);
    expect(opening).toBeGreaterThan(MIN_ZOOM);
    expect(opening).toBeLessThan(MAX_ZOOM);
  });
});
