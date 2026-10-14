import { useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LocationSummary } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { browserTimeZone } from '@/lib/format';
import { listSites } from '@/lib/orgApi';

const NO_SITES: LocationSummary[] = [];

/**
 * Brief 2-1b: the sites a tenant without clients works at. An org-wide
 * account (view:org) reads the tenant's sites; a site-bound account has
 * only its own. null while loading; empty when there are none (or the
 * read failed). `enabled` false → null, and nothing is fetched.
 * Shared by scheduling and onboarding.
 */
export function useOrgSites(enabled: boolean): LocationSummary[] | null {
  // Read the context directly: a dialog that only needs sites when the client
  // portal is off must still render where no session is provided (tests, previews).
  const auth = useContext(AuthContext);
  const user = auth?.user ?? null;
  const orgWide = auth ? auth.can('view:org') : false;
  const sites = useQuery({
    queryKey: ['org', 'sites'],
    queryFn: listSites,
    enabled: enabled && orgWide,
  });
  return useMemo(() => {
    if (!enabled) return null;
    const summary = (s: { id: string; name: string; state: string | null; timezone: string | null; isActive: boolean }): LocationSummary => ({
      id: s.id,
      clientId: null,
      name: s.name,
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: s.state,
      zip: null,
      latitude: null,
      longitude: null,
      geofenceRadiusMeters: null,
      isActive: s.isActive,
      timezone: s.timezone ?? browserTimeZone(),
    });
    if (!orgWide) {
      return user?.locationId
        ? [summary({ id: user.locationId, name: user.locationName ?? 'My site', state: null, timezone: null, isActive: true })]
        : NO_SITES;
    }
    if (sites.isError) return NO_SITES;
    return sites.data ? sites.data.sites.filter((s) => s.isActive).map(summary) : null;
  }, [enabled, orgWide, user?.locationId, user?.locationName, sites.data, sites.isError]);
}
