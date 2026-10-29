import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LocationSummary } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { boundedClientOf } from '@/lib/roles';
import { listClientLocations } from '@/lib/clientsApi';
import { useOrgSites } from '@/lib/useOrgSites';
import { displayTimeZone, fmtTimeTz, tzAbbrev, zonedDayKey, zonedMinutesOfDay } from '@/lib/format';

/**
 * The sites the viewer works, each with its zone — for pages that show a
 * store's times on the store's clock (the tasks board, the store's SOP).
 *
 * A client-bound viewer (a shift supervisor, a floor supervisor) holds no
 * view:org, so the org's site list came back empty and every time fell back
 * to the company's Eastern clock (FLOOR-19: a Chicago task at 11 PM read
 * "12:00 AM EDT" the next day). Their own client's stores — a read their
 * role is admitted to — carry the zones instead. Everyone else: the org's
 * sites (useOrgSites). null while loading.
 */
export function useViewerSites(): LocationSummary[] | null {
  const auth = useContext(AuthContext);
  const client = boundedClientOf(auth?.user ?? null);
  const orgSites = useOrgSites(!client);
  const clientSites = useQuery({
    queryKey: ['viewer-sites', client?.id],
    queryFn: () => listClientLocations(client!.id),
    enabled: !!client,
    staleTime: 10 * 60_000,
  });
  if (!client) return orgSites;
  if (clientSites.data) return clientSites.data.locations.filter((l) => l.isActive);
  return clientSites.isError ? [] : null;
}

/**
 * A time on a store's clock: "6:00 AM" — with the zone named ("6:00 AM CDT")
 * only when the viewer's own clock reads it differently (FLOOR-20: a 6 AM
 * Central shift read "4:00 AM" for a viewer out west, under the store's day).
 */
export function storeTime(iso: string | Date, timeZone: string | null | undefined): string {
  if (!timeZone) return fmtTimeTz(iso);
  const viewer = displayTimeZone();
  const same = zonedMinutesOfDay(iso, timeZone) === zonedMinutesOfDay(iso, viewer) && zonedDayKey(iso, timeZone) === zonedDayKey(iso, viewer);
  const time = fmtTimeTz(iso, timeZone);
  return same ? time : `${time} ${tzAbbrev(timeZone, iso)}`;
}

/** The one zone every site shares, or null (none, or more than one). */
export function sharedZoneOf(sites: ReadonlyArray<{ timezone: string | null }> | null | undefined): string | null {
  if (!sites || sites.length === 0) return null;
  const first = sites[0]!.timezone;
  return first && sites.every((x) => x.timezone === first) ? first : null;
}
