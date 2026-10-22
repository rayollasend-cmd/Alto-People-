import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, defaultTenantProfile, type Capability, type Shift } from '@alto-people/shared';
import { AuthContext, type TenantSession } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/Tooltip';
import type { SchedulingKpis } from '@/lib/schedulingApi';

/**
 * Renders the schedule page against an in-memory API: `apiFetch` is routed
 * by URL, so every query the page runs gets a plain answer and a test
 * only names the shifts and KPIs it is about. Mock `@/lib/api` in the
 * test file with `apiMock(...)` BEFORE importing the page.
 */

export const CLIENT = '22222222-2222-4222-8222-222222222222';
export const SITE = '11111111-1111-4111-8111-111111111111';
export const ASSOC = '33333333-3333-4333-8333-333333333333';

const HOUR = 3_600_000;

export function makeShift(over: Partial<Shift> & { id: string }): Shift {
  const startsAt = over.startsAt ?? new Date(Date.now() + 2 * 24 * HOUR).toISOString();
  return {
    clientId: CLIENT,
    clientName: 'The Grand Hotel',
    position: 'Housekeeper',
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 8 * HOUR).toISOString(),
    location: null,
    locationId: SITE,
    locationName: 'Front Beach',
    timezone: 'America/Chicago',
    fairWorkweekNoticeDays: null,
    hourlyRate: null,
    payRate: null,
    effectivePayRate: null,
    status: 'OPEN',
    assignedAssociateId: null,
    assignedAssociateName: null,
    notes: null,
    cancellationReason: null,
    publishedAt: new Date().toISOString(),
    lateNoticeReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as Shift;
}

export const defaultKpis: SchedulingKpis = {
  from: '2026-10-19',
  to: '2026-10-25',
  openShifts: 2,
  openUpcoming: 1,
  wentUnfilled: 1,
  assignedShifts: 0,
  draftShifts: 0,
  completedShifts: 0,
  totalShifts: 2,
  fillRatePercent: 0,
  totalScheduledMinutes: 16 * 60,
  projectedLaborCost: 300,
  shiftsWithoutRate: 0,
};

export interface ApiWorld {
  shifts: Shift[];
  kpis?: SchedulingKpis;
  calls: Array<{ url: string; init?: { method?: string; body?: unknown } }>;
  /** Extra URL handlers, matched by prefix before the defaults. */
  routes?: Array<[string, (url: string, init?: { method?: string; body?: unknown }) => unknown]>;
}

/** The `apiFetch` an `vi.mock('@/lib/api')` factory hands back. */
export function apiMock(world: ApiWorld) {
  return async (url: string, init?: { method?: string; body?: unknown }) => {
    world.calls.push({ url, init });
    for (const [prefix, fn] of world.routes ?? []) {
      if (url.startsWith(prefix)) return fn(url, init);
    }
    if (url.startsWith('/scheduling/shifts/close-out-unfilled')) return { closed: 1, shiftIds: [] };
    if (url.startsWith('/scheduling/shifts?') || url === '/scheduling/shifts') return { shifts: world.shifts, truncated: false };
    if (url.startsWith('/scheduling/kpis')) return world.kpis ?? defaultKpis;
    if (url.startsWith('/scheduling/associates')) return { associates: [{ id: ASSOC, firstName: 'Ana', lastName: 'Lopez', email: 'ana@example.com' }], truncated: false };
    if (url.startsWith('/scheduling/drafts/summary')) return { total: 0, weeks: [] };
    if (url.startsWith('/scheduling/staffing-targets')) return { locations: [] };
    if (url.startsWith('/scheduling/teams')) return { teams: [] };
    if (url.startsWith('/scheduling/templates')) return { templates: [] };
    if (url.startsWith('/scheduling/clients')) return { clients: [] };
    if (url.startsWith('/scheduling/availability')) return { associates: [] };
    if (url.startsWith('/scheduling/last-shift')) return { shift: null };
    if (url === '/clients') return { clients: [{ id: CLIENT, name: 'The Grand Hotel', industry: null, status: 'ACTIVE', contactEmail: null, state: 'FL' }] };
    if (url.startsWith('/clients/') && url.endsWith('/locations')) return { locations: [{ id: SITE, clientId: CLIENT, name: 'Front Beach', addressLine1: null, addressLine2: null, city: null, state: 'FL', zip: null, latitude: null, longitude: null, geofenceRadiusMeters: null, isActive: true, timezone: 'America/Chicago' }] };
    if (url.startsWith('/me/inbox')) return { sources: [] };
    return {};
  };
}

export function renderSchedule(ui: React.ReactElement, path = '/scheduling?view=list') {
  const role = 'HR_ADMINISTRATOR' as const;
  const caps = ROLE_CAPABILITIES[role];
  const tenant: TenantSession = { id: 't', ...defaultTenantProfile('WORKFORCE_PROVIDER') };
  return render(
    <I18nProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[path]}>
            <ConfirmProvider>
              <AuthContext.Provider
                value={{
                  isInitializing: false,
                  isOffline: false,
                  user: { id: 'u1', email: 'hr@example.com', role, status: 'ACTIVE', clientId: null, locationId: null, regionId: null, associateId: null, language: 'en', additionalRoles: [], activeRole: null, pinnedModules: [] } as never,
                  role,
                  primaryRole: role,
                  availableRoles: [role],
                  capabilities: caps,
                  tenant,
                  signIn: vi.fn(),
                  submitMfaChallenge: vi.fn(),
                  signOut: vi.fn(),
                  refreshUser: vi.fn(),
                  switchRole: vi.fn(),
                  can: (c: Capability) => caps.has(c),
                }}
              >
                {ui}
              </AuthContext.Provider>
            </ConfirmProvider>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

/** jsdom as a 390px phone: no min-width query matches. */
export function asPhone(): () => void {
  const prev = window.matchMedia;
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: /max-width/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  return () => {
    window.matchMedia = prev;
  };
}
