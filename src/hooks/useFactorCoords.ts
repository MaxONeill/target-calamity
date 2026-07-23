import { useEffect, useRef, type RefObject } from 'react';
import type { Factor, FieldPin } from '../../shared/types.js';

export interface Coords {
  lat: number;
  lon: number;
}

/**
 * Maintains an id → lat/lon lookup for camera alignment.
 *
 * Built from both data paths so a pin picked off the globe can be aligned to
 * even before its card has paged into the feed. Held in a ref because the
 * scene's pick handler reads it outside React's render cycle.
 */
export function useFactorCoords(
  fieldPins: readonly FieldPin[],
  feedFactors: readonly Factor[],
): RefObject<Map<string, Coords>> {
  const coordsRef = useRef<Map<string, Coords>>(new Map());

  useEffect(() => {
    const map = new Map<string, Coords>();
    for (const pin of fieldPins) map.set(pin.id, { lat: pin.lat, lon: pin.lon });
    // Placeless factors are deliberately absent: there is nowhere to fly to, so
    // selecting one leaves the camera where it is rather than inventing a target.
    for (const factor of feedFactors) {
      if (factor.lat === null || factor.lon === null) continue;
      map.set(factor.id, { lat: factor.lat, lon: factor.lon });
    }
    coordsRef.current = map;
  }, [fieldPins, feedFactors]);

  return coordsRef;
}
