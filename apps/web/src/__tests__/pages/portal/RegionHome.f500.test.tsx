import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import type { RegionOverview, StoreSnapshot } from '@/lib/regionsApi';

vi.mock('@/lib/regionsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/regionsApi')>()), regionOverview: vi.fn() }));
vi.mock('@/components/home/HugoSeat', () => ({ HugoSeat: () => null }));
vi.mock('@/components/PushPrompt', () => ({ PushPrompt: () => null }));
const csv = vi.hoisted(() => ({ downloadCsv: vi.fn() }));
vi.mock('@/lib/csv', async (orig) => ({ ...(await orig<typeof import('@/lib/csv')>()), downloadCsv: csv.downloadCsv }));

import { regionOverview } from '@/lib/regionsApi';
import { PortalRequests } from '@/pages/portal/PortalRequests';
import { RegionHome } from '@/pages/region/RegionHome';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));

/**
 * The region command center (F500 G5) and the request rows the store home
 * and /portal/requests share: one meaning of "short" with the right
 * plural, the ring as % of contract, below-contract first, the working
 * table for a big region (with CSV), and request subjects that never
 * collapse to one letter beside their badges.
 */

function store(i: number, over: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return {
    id: `l${i}`,
    name: `Store ${i}`,
    clientId: 'c1',
    clientName: 'Coastal',
    timezone: 'America/Chicago',
    now: { onFloor: 3, target: 6, targetLabel: 'Swing', short: 3, shortBasis: 'contract', shortOfContract: 3, missingFromSchedule: 0 },
    today: { expected: 6, present: 3, open: 0, missedSoFar: 0 },
    tomorrow: { expected: 6, open: 0, unconfirmed: 0 },
    reliability: { grade: 'B', score: 80, basis: 'contract' },
    requests: { open: 1, overdue: 1 },
    leads: { onFloor: 1, total: 1 },
    alert: null,
    hours: [],
    weeks: [],
    ...over,
  };
}

function overview(stores: StoreSnapshot[]): RegionOverview {
  return {
    region: { id: 'rg1', name: 'Florida Panhandle' },
    generatedAt: new Date().toISOString(),
    preview: false,
    totals: {
      stores: stores.length,
      onFloor: 3 * stores.length,
      target: 6 * stores.length,
      shortNow: stores.length,
      belowContract: stores.length,
      missingFromSchedule: 0,
      alerts: 0,
      openToday: 0,
      openTomorrow: 0,
      unconfirmedTomorrow: 0,
      openRequests: stores.length,
      overdueRequests: stores.length,
      score: 80,
      gradeCounts: { A: 0, B: stores.length, C: 0, D: 0, F: 0, none: 0 },
    },
    hours: [],
    weeks: [],
    requests: [
      { id: 'r1', storeName: 'Store 1', clientId: 'c1', kind: 'STAFFING', subject: 'Two more overnight stockers for Friday', status: 'RECEIVED', createdAt: new Date().toISOString(), dueAt: new Date(Date.now() - 32 * 86_400_000).toISOString(), overdue: true, owner: null, about: null },
    ],
    stores,
  } as RegionOverview;
}

function renderRegion(stores: StoreSnapshot[]) {
  vi.mocked(regionOverview).mockResolvedValue(overview(stores));
  const caps = ROLE_CAPABILITIES.CLIENT_PORTAL;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'region@x.example', role: 'CLIENT_PORTAL', status: 'ACTIVE', clientId: null, regionId: 'rg1', associateId: null } as never,
          role: 'CLIENT_PORTAL',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter>
            <RegionHome />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(regionOverview).mockReset();
  csv.downloadCsv.mockReset();
});

describe('the region command center', () => {
  it('one store: the plural is right, the ring is % of contract, below contract leads the tile, the report is the primary action', async () => {
    renderRegion([store(1)]);
    expect(await screen.findByText('3 short of contract at 1 store right now.')).toBeInTheDocument();
    expect(screen.getByText('1 store below contract')).toBeInTheDocument();
    // The ring says the share of the contract; the count is said once, beside it.
    expect(screen.getByText('50%')).toBeInTheDocument();
    // Below contract outranks the overdue request.
    expect(screen.getByText('3 below contract on the floor now')).toBeInTheDocument();
    expect(screen.queryByText('1 request past its reply-by')).toBeNull();
    expect(screen.getByRole('button', { name: /Service report/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Messages/ })).toHaveAttribute('href', '/messages');
    // Cards by default for a handful of stores.
    expect(screen.queryByTestId('region-table')).toBeNull();
    // The request row: its status, and the late reply said as Alto's lateness.
    expect(screen.getByText('Reply overdue · 32 days')).toBeInTheDocument();
    expect(screen.getByText('Received')).toBeInTheDocument();
    expect(screen.getByText('Open with Alto HR')).toBeInTheDocument();
  });

  it('seven stores: the table is the working view, with CSV', async () => {
    renderRegion(Array.from({ length: 7 }, (_, i) => store(i + 1)));
    const table = await screen.findByTestId('region-table');
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(csv.downloadCsv).toHaveBeenCalledTimes(1);
    const rows = csv.downloadCsv.mock.calls[0]![1] as unknown[][];
    expect(rows).toHaveLength(8);
    expect(rows[1]!.slice(0, 5)).toEqual(['Store 1', 'B', 80, 3, 6]);
    // And back to cards.
    await userEvent.click(screen.getByRole('radio', { name: 'Cards' }));
    expect(screen.queryByTestId('region-table')).toBeNull();
  });
});

describe('a request row (the store home and /portal/requests)', () => {
  it('puts the subject on its own line, always shows the status, and says a late reply as such', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      requests: [
        { id: 'r1', kind: 'STAFFING', subject: 'Two more overnight stockers for Friday', body: 'Truck day', status: 'RECEIVED', resolution: null, createdAt: '2026-09-18T12:00:00.000Z', resolvedAt: null, dueAt: new Date(Date.now() - 32 * 86_400_000 - 3_600_000).toISOString(), desk: 'Workforce desk', owner: null, associateId: null, associateName: null, overdue: true },
        { id: 'r2', kind: 'ISSUE', subject: 'Late van', body: 'x', status: 'RESOLVED', resolution: 'Fixed', createdAt: '2026-10-01T12:00:00.000Z', resolvedAt: '2026-10-02T12:00:00.000Z', dueAt: null, desk: 'HR desk', owner: 'Dana', associateId: null, associateName: null, overdue: false },
      ],
    } as never);
    const caps = ROLE_CAPABILITIES.CLIENT_PORTAL;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider value={{ isInitializing: false, isOffline: false, user: { id: 'u', email: 'p@x', role: 'CLIENT_PORTAL', status: 'ACTIVE', clientId: 'c1', associateId: null } as never, role: 'CLIENT_PORTAL', capabilities: new Set<Capability>(caps), signIn: vi.fn(), signOut: vi.fn(), can: (c: Capability) => caps.has(c) }}>
          <MemoryRouter initialEntries={['/portal/requests?id=r2']}>
            <PortalRequests />
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
    const rows = await screen.findAllByTestId('portal-request');
    const subject = within(rows[0]!).getByText('Two more overnight stockers for Friday');
    expect(subject.tagName).toBe('P');
    expect(subject).toHaveClass('line-clamp-2');
    expect(subject).not.toHaveClass('truncate');
    expect(within(rows[0]!).getByText('Received')).toBeInTheDocument();
    expect(within(rows[0]!).getByTestId('request-reply-overdue')).toHaveTextContent('Reply overdue · 32 days');
    expect(within(rows[0]!).queryByText('Past due')).toBeNull();
    // ?id= marks the request it names.
    expect(rows[1]).toHaveClass('ring-1');
    expect(rows[0]).not.toHaveClass('ring-1');
  });
});
