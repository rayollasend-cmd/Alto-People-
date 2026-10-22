import { companyWorkweek } from './timeAnomalies.js';

/**
 * The clock a shift (or a punch) is read on: its site's zone, else the
 * company's. A shift belongs to its building, not to whoever is looking at
 * it — every API row that carries a shift or punch time carries this next
 * to it, and the web formats through fmtShiftTz with it (one shift, one
 * time, wherever it is shown).
 */
export function shiftTimezone(site: { timezone: string | null } | null | undefined): string {
  return site?.timezone || companyWorkweek().timezone;
}
