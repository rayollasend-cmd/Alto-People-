import type * as React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type ExecKpi, type TenantModule } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';

/**
 * The chairman, signed in, on one executive page — for the Workforce, Risk,
 * Scenarios, Board packs and Operations pulse tests. `modules` turns tenant
 * modules off (a direct employer bills no one); the current URL is read
 * back from `location()`.
 */
let lastLocation = '';
function LocationProbe() {
  const loc = useLocation();
  lastLocation = `${loc.pathname}${loc.search}`;
  return null;
}
export const location = () => lastLocation;

export function renderAsChairman(ui: React.ReactElement, opts: { route?: string; off?: TenantModule[] } = {}) {
  const caps = ROLE_CAPABILITIES.EXECUTIVE_CHAIRMAN;
  const modules = { ...DEFAULT_TENANT.modules };
  for (const m of opts.off ?? []) modules[m] = false;
  const value = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u-exec', email: 'exec@altohr.com', role: 'EXECUTIVE_CHAIRMAN', status: 'ACTIVE', clientId: null, associateId: null },
    role: 'EXECUTIVE_CHAIRMAN',
    primaryRole: 'EXECUTIVE_CHAIRMAN',
    availableRoles: ['EXECUTIVE_CHAIRMAN'],
    capabilities: new Set<Capability>(caps),
    tenant: { ...DEFAULT_TENANT, modules },
    signIn: () => Promise.resolve({}),
    signOut: () => Promise.resolve(),
    can: (c: Capability) => caps.has(c),
  } as unknown as React.ContextType<typeof AuthContext>;
  const route = opts.route ?? '/';
  const path = route.split('?')[0]!;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={value}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path={path} element={ui} />
          </Routes>
          {/* Outside the routes, so a navigation away from the page is still read back. */}
          <LocationProbe />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const trend = (vals: number[]) => vals.map((value, i) => ({ start: `2026-08-${String(i + 1).padStart(2, '0')}`, value }));

export function execKpi(over: Partial<ExecKpi> & Pick<ExecKpi, 'id' | 'label' | 'unit'>): ExecKpi {
  return {
    value: null,
    sub: null,
    compare: null,
    delta: null,
    deltaPct: null,
    betterWhen: 'up',
    target: null,
    targetLabel: null,
    status: 'none',
    statusLabel: 'No plan set',
    trend: trend([1, 2, 3, 4]),
    basis: 'live',
    definition: 'How it is counted.',
    href: '/executive/people',
    ...over,
  };
}

export const PERIOD = { key: 'quarter', label: 'Q4 to date', start: '2026-10-01', end: '2026-10-27', complete: false, elapsedPct: 29, asOf: '2026-10-27T12:44:00.000Z' } as const;
export const COMPARISON = { key: 'prior', label: 'vs Q3, same days', start: '2026-07-01', end: '2026-07-27', available: true, reason: null } as const;

/** Route an apiFetch mock by path prefix; anything unrouted rejects (so a stray call shows up). */
export function routeApi(routes: Record<string, unknown | (() => unknown)>) {
  return (path: string) => {
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => path.startsWith(k));
    if (!key) return Promise.reject(new Error(`unrouted ${path}`));
    const v = routes[key];
    try {
      return Promise.resolve(typeof v === 'function' ? (v as () => unknown)() : v);
    } catch (e) {
      return Promise.reject(e);
    }
  };
}
