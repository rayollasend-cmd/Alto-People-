/**
 * The time zone a US state lives in, for defaulting a new site's clock
 * from its address (ease-of-use sweep, 2026-10-22: the site form defaulted
 * to the browser's zone, which is the HR desk's, not the store's). States
 * that straddle two zones get the zone most of their people are in; the
 * form keeps the zone editable for the rest.
 *
 * Only zones the app offers (SUPPORTED_TIMEZONES): Michigan and Indiana
 * keep New York's clock, Idaho keeps Denver's — the same offsets and the
 * same daylight saving — and Puerto Rico, on Atlantic time with no daylight
 * saving, has no zone here, so the form keeps what it had. (The rule used
 * to answer America/Detroit and friends, which the zone picker doesn't
 * list and the location form's server check refuses.)
 */
const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Denver', IL: 'America/Chicago', IN: 'America/New_York', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/New_York', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
};

export function timezoneForState(state: string | null | undefined): string | null {
  if (!state) return null;
  return STATE_TZ[state.trim().toUpperCase()] ?? null;
}

const CHICAGO = 'America/Chicago';
const NEW_YORK = 'America/New_York';
const DENVER = 'America/Denver';

/**
 * Whole counties on the other side of their state's line — only where it
 * runs along county lines and only where we're sure. Florida's western
 * Panhandle (Pensacola to Panama City, Destin and Santa Rosa Beach among
 * them) is Central; Gulf County splits down the middle, so it stays with
 * the state. A picked address names its county, so a Destin store opens on
 * Central rather than Florida's Eastern.
 */
const COUNTY_TZ: Record<string, Record<string, string>> = {
  FL: Object.fromEntries(['escambia', 'santarosa', 'okaloosa', 'walton', 'holmes', 'washington', 'bay', 'jackson', 'calhoun'].map((c) => [c, CHICAGO])),
  TX: { elpaso: DENVER, hudspeth: DENVER },
  MI: Object.fromEntries(['gogebic', 'iron', 'dickinson', 'menominee'].map((c) => [c, CHICAGO])),
  IN: Object.fromEntries(
    ['lake', 'porter', 'laporte', 'newton', 'jasper', 'starke', 'gibson', 'posey', 'vanderburgh', 'warrick', 'spencer', 'perry'].map((c) => [c, CHICAGO]),
  ),
  TN: Object.fromEntries(
    [
      'anderson', 'blount', 'bradley', 'campbell', 'carter', 'claiborne', 'cocke', 'grainger', 'greene', 'hamblen',
      'hamilton', 'hancock', 'hawkins', 'jefferson', 'johnson', 'knox', 'loudon', 'mcminn', 'meigs', 'monroe',
      'morgan', 'polk', 'rhea', 'roane', 'scott', 'sevier', 'sullivan', 'unicoi', 'union', 'washington',
    ].map((c) => [c, NEW_YORK]),
  ),
};

/** "Okaloosa County", "St. Joseph County", "La Porte" → the table's key. */
const countyKey = (county: string) => county.toLowerCase().replace(/\b(county|parish)\b/g, '').replace(/[^a-z]/g, '');

/** The zone a county settles, where its state has two; null when the state's own rule stands. */
export function timezoneForCounty(state: string | null | undefined, county: string | null | undefined): string | null {
  if (!state || !county) return null;
  return COUNTY_TZ[state.trim().toUpperCase()]?.[countyKey(county)] ?? null;
}

/**
 * The zone a site takes when its address is picked from a suggestion.
 *
 * The zone follows the place when the place says something new: a county
 * that settles a two-zone state, or a different state than the form had.
 * Picking an address in the same state leaves alone a zone someone may
 * have set by hand.
 */
export function zoneForPickedPlace(
  pick: { state: string | null; county: string | null },
  current: { state: string | null | undefined; timezone: string },
): string {
  const byCounty = timezoneForCounty(pick.state, pick.county);
  if (byCounty) return byCounty;
  const st = pick.state?.trim().toUpperCase() ?? '';
  if (st && st !== (current.state ?? '').trim().toUpperCase()) return timezoneForState(st) ?? current.timezone;
  return current.timezone;
}
