import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW,
  latitudeFromTimeZone,
  longitudeFromOffsetMinutes,
} from './viewerLocation.js';

describe('longitudeFromOffsetMinutes', () => {
  it('puts the Americas in the western hemisphere', () => {
    // The sign trap. getTimezoneOffset is POSITIVE west of Greenwich, so a
    // missing negation mirrors the globe and opens on Asia for a Chicago
    // viewer — visibly wrong, but only if you happen to test from the west.
    expect(longitudeFromOffsetMinutes(300)).toBeLessThan(0); // UTC-5, Chicago (CDT)
    expect(longitudeFromOffsetMinutes(480)).toBeLessThan(0); // UTC-8, Pacific
  });

  it('puts Europe and Asia in the eastern hemisphere', () => {
    expect(longitudeFromOffsetMinutes(-60)).toBeGreaterThan(0); // UTC+1
    expect(longitudeFromOffsetMinutes(-540)).toBeGreaterThan(0); // UTC+9, Tokyo
  });

  it('maps an offset to roughly the right meridian', () => {
    expect(longitudeFromOffsetMinutes(300)).toBeCloseTo(-75, 5); // UTC-5
    expect(longitudeFromOffsetMinutes(0)).toBeCloseTo(0, 5);
  });

  it('wraps past-the-antimeridian offsets back into range', () => {
    // UTC+14 is 210°, which is not a longitude. Left unwrapped it would place
    // the camera off the far side of the sphere.
    const lon = longitudeFromOffsetMinutes(-840);
    expect(lon).toBeGreaterThanOrEqual(-180);
    expect(lon).toBeLessThanOrEqual(180);
    expect(lon).toBeCloseTo(-150, 5);
  });

  it('stays in range for every whole-hour offset', () => {
    for (let h = -12; h <= 14; h++) {
      const lon = longitudeFromOffsetMinutes(-h * 60);
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThanOrEqual(180);
    }
  });
});

describe('latitudeFromTimeZone', () => {
  it('reads the region, not the city', () => {
    expect(latitudeFromTimeZone('America/Chicago')).toBeGreaterThan(0);
    expect(latitudeFromTimeZone('Australia/Sydney')).toBeLessThan(0);
  });

  it('falls back rather than failing on an unknown or absent zone', () => {
    expect(latitudeFromTimeZone(undefined)).toBe(DEFAULT_VIEW.lat);
    expect(latitudeFromTimeZone('Mars/Olympus')).toBe(DEFAULT_VIEW.lat);
    expect(latitudeFromTimeZone('UTC')).toBe(DEFAULT_VIEW.lat);
  });
});

describe('a Chicago viewer', () => {
  it('opens facing North America', () => {
    // The reported case, end to end: CDT is UTC-5, so offset 300.
    const lat = latitudeFromTimeZone('America/Chicago');
    const lon = longitudeFromOffsetMinutes(300);
    expect(lat).toBeGreaterThan(20); // northern hemisphere
    expect(lon).toBeGreaterThan(-130); // not out in the Pacific
    expect(lon).toBeLessThan(-40); // not out in the Atlantic
  });
});
