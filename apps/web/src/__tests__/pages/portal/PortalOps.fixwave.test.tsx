import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { PortalOps, windowSuffix } from '@/pages/portal/PortalOps';
import type { StoreOpsDay, StoreOpsRun } from '@/lib/storeOpsApi';

/**
 * Store operations, as the deep audit (2026-10-29) found it:
 *   LEAD-2   an SOP the expiry sweep closed read "Dana Reyes · submitted 1:54 AM"
 *   LEAD-27  "MORNING · MORNING", and "On track — 1 to review" over it
 *   LEAD-19  a photo whose file is gone drew a broken-image box
 *   LEAD-17  the page opened on the browser's day, not the store's
 */

const tz = 'America/Chicago';
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const STORE_DAY = '2026-10-29';

const expiredRun: StoreOpsRun = {
  id: 'r1',
  department: 'Grocery',
  period: 'MORNING',
  windowLabel: 'Morning',
  storeName: 'Front Beach 218',
  templateName: 'Grocery — Morning',
  status: 'CLOSED',
  runBy: 'Dana Reyes',
  openedAt: at(-20),
  closedAt: at(-1),
  expired: true,
  day: STORE_DAY,
  carried: false,
  dueAt: at(-13),
  done: 3,
  total: 10,
  overdueItems: 0,
  onTimePct: null,
  closedIncomplete: true,
  incompleteReason: 'Expired — not submitted. Closed automatically 12 hours after the shift ended.',
  summary: null,
  current: null,
  blocks: [],
  finalPhotoId: null,
};

function day(over: Partial<StoreOpsDay> = {}): StoreOpsDay {
  return {
    scope: { client: { id: 'c1', name: 'Coastal' }, location: { id: 'l1', name: 'Front Beach 218' } },
    date: STORE_DAY,
    tz,
    storeToday: STORE_DAY,
    summary: { sops: 1, submitted: 0, expired: 1, running: 0, notStarted: 0, completionPct: 30, onTimePct: null, overdueBlocks: 0, tempChecks: 0, tempsDue: 0, tempAlerts: 0, tempOpen: 0, needsAttention: 1, photos: 1 },
    periods: ['MORNING'],
    grid: [{ department: 'Grocery', cells: [{ period: 'MORNING', runIds: ['r1'], expected: [] }] }],
    runs: [expiredRun],
    attention: [
      { kind: 'NOT_SUBMITTED', severity: 'high', shiftId: 'r1', department: 'Grocery', period: 'MORNING', storeName: 'Front Beach 218', title: 'Never submitted — expired with 3 of 10 done', detail: 'Dana Reyes', at: at(-13) },
    ],
    temps: [],
    metrics: [],
    handoffs: [],
    filters: { period: null, department: null },
    departments: ['Grocery'],
    live: [],
    photos: [{ id: 'p1', at: at(-5), title: 'Final zone photo', section: 'End of shift', shiftId: 'r1', department: 'Grocery', period: 'MORNING', storeName: 'Front Beach 218' }],
    ...over,
  };
}

function renderPage(payload: StoreOpsDay, path = '/portal/ops') {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (p: string) => {
    if (p.startsWith('/client-portal/ops?')) return payload;
    throw new Error(`unexpected ${p}`);
  });
  const role = 'CLIENT_PORTAL' as const;
  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'sm@coastal.example', role, status: 'ACTIVE' as const, clientId: 'c1', clientName: 'Coastal', associateId: null },
    role,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[path]}>
          <PortalOps />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('<PortalOps> after the deep audit', () => {
  it('an expired checklist reads "never submitted" — never "submitted 1:54 AM", never "On track"', async () => {
    renderPage(day());
    expect(await screen.findAllByText('Never submitted')).not.toHaveLength(0);
    expect(screen.getByText('Dana Reyes · never submitted')).toBeInTheDocument();
    expect(screen.queryByText(/submitted \d/)).toBeNull();
    // The KPI says 0 of 1 submitted, and why.
    expect(screen.getByText('0/1')).toBeInTheDocument();
    expect(screen.getByText('1 never submitted')).toBeInTheDocument();
    expect(screen.queryByText(/On track/)).toBeNull();
  });

  it('"1 to review" over a checklist submitted short — not "On track — 1 to review"', async () => {
    const short: StoreOpsRun = { ...expiredRun, expired: false, incompleteReason: 'Two call-outs' };
    renderPage(
      day({
        runs: [short],
        summary: { ...day().summary, submitted: 1, expired: 0, needsAttention: 0 },
        attention: [{ kind: 'INCOMPLETE', severity: 'medium', shiftId: 'r1', department: 'Grocery', period: 'MORNING', storeName: 'Front Beach 218', title: 'Submitted incomplete — 3 of 10 done', detail: 'Two call-outs', at: at(-1) }],
      }),
    );
    expect(await screen.findByText('1 to review')).toBeInTheDocument();
    expect(screen.queryByText(/On track/)).toBeNull();
  });

  it('says the store window only when it differs from the period', () => {
    const t = ((k: string) => ({ 'portalOps.period.MORNING': 'Morning', 'portalOps.period.OVERNIGHT': 'Overnight' })[k] ?? k) as never;
    expect(windowSuffix(t, 'MORNING', 'Morning')).toBe('');
    expect(windowSuffix(t, 'MORNING', 'MORNING')).toBe('');
    expect(windowSuffix(t, 'OVERNIGHT', 'Swing')).toBe(' · Swing');
    expect(windowSuffix(t, 'MORNING', null)).toBe('');
  });

  it('a photo whose file is gone shows "Photo unavailable", not a broken image', async () => {
    renderPage(day());
    const img = await screen.findByAltText('Final zone photo');
    fireEvent.error(img);
    expect(await screen.findByTestId('ops-photo-unavailable')).toHaveTextContent('Photo unavailable');
    expect(screen.queryByAltText('Final zone photo')).toBeNull();
  });

  it('opens on the store\'s day: no ?date= is sent, the server answers with the store\'s today', async () => {
    renderPage(day());
    await screen.findAllByText('Never submitted');
    const calls = vi.mocked(apiFetch).mock.calls.map((c) => String(c[0]));
    expect(calls.every((c) => !c.includes('date='))).toBe(true);
    // The day shown is the store's (Oct 29), whatever the test machine's clock says.
    expect(screen.getAllByText(/Oct 29, 2026/).length).toBeGreaterThan(0);
  });
});
