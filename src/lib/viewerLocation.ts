/**
 * Where to point the globe when someone opens it.
 *
 * WHY NOT IP GEOLOCATION, which is the obvious way to do this. Every practical
 * route to an IP-derived location either ships the visitor's address to a third
 * party (a geo-IP API, called from the browser, on page load) or adds a ~70MB
 * MaxMind database to the deployment. This app hashes IPs with a secret salt so
 * a database dump cannot recover them; quietly handing the raw address to
 * someone else's API for a camera angle would give away more than the whole
 * submission pipeline is built to protect, and for a cosmetic default.
 *
 * The timezone is already in the browser, costs no request, reaches no third
 * party, and answers the actual question — which part of the world should face
 * the viewer.
 *
 * IT IS DELIBERATELY COARSE. Longitude comes from the UTC offset, which is a
 * political boundary rather than a meridian: America/Chicago resolves to about
 * -75° where the city is at -87.6°, and China spans five geographic hours in one
 * zone. That error is invisible here — it moves the opening camera by a few
 * degrees of a globe the viewer is about to drag anyway. Nothing but the
 * initial framing reads this, and nothing may: it is a guess about a viewer,
 * not a fact about the world, and the moment it decided anything the data shows
 * it would be asserting something no source said.
 */

/** Fallback framing: the Atlantic, so land is visible on both sides. */
export const DEFAULT_VIEW = { lat: 25, lon: -30 } as const;

/**
 * Representative latitude per IANA region prefix. The offset gives longitude
 * for free; latitude has no equivalent trick, and a table of every zone would
 * be a large amount of data pretending to a precision this does not have. The
 * region is enough to pick a hemisphere and a rough band.
 */
const REGION_LATITUDE: Readonly<Record<string, number>> = {
  America: 40,
  Europe: 50,
  Africa: 5,
  Asia: 35,
  Australia: -27,
  Pacific: -15,
  Atlantic: 40,
  Indian: -10,
  Antarctica: -75,
};

export interface ViewerLocation {
  lat: number;
  lon: number;
}

/**
 * Longitude implied by a UTC offset in minutes, as the browser reports it.
 *
 * `getTimezoneOffset` returns minutes to ADD to local time to reach UTC, so it
 * is positive west of Greenwich — the opposite sign to longitude. Getting that
 * backwards mirrors the globe, which is exactly the class of error
 * `src/lib/geo.ts` exists to keep in one place, so the reasoning is written
 * down rather than left in a minus sign.
 */
export function longitudeFromOffsetMinutes(offsetMinutes: number): number {
  const hoursEastOfUtc = -offsetMinutes / 60;
  const lon = hoursEastOfUtc * 15;
  // Offsets run to UTC+14 (Kiritimati), which is 210° — past the meridian and
  // back into negative longitude.
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Latitude band for an IANA zone id such as `America/Chicago`. */
export function latitudeFromTimeZone(timeZone: string | undefined): number {
  const region = timeZone?.split('/')[0] ?? '';
  return REGION_LATITUDE[region] ?? DEFAULT_VIEW.lat;
}

/**
 * The viewer's approximate location, or {@link DEFAULT_VIEW} when the
 * environment does not say. Never throws: this decides a camera angle, and an
 * exotic locale should not be able to stop the globe from rendering.
 */
export function viewerLocation(): ViewerLocation {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      lat: latitudeFromTimeZone(timeZone),
      lon: longitudeFromOffsetMinutes(new Date().getTimezoneOffset()),
    };
  } catch {
    return { ...DEFAULT_VIEW };
  }
}
