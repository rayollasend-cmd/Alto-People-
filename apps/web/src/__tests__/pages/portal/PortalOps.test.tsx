import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/csv', () => ({ downloadCsv: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { PortalOps } from '@/pages/portal/PortalOps';
import type { StoreOpsDay } from '@/lib/storeOpsApi';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const today = new Date().toISOString().slice(0, 10);

function day(over: Partial<StoreOpsDay> = {}): StoreOpsDay {
  return {
    scope: { client: { id: 'c1', name: 'Walmart' }, location: { id: 'l1', name: 'Front Beach 218' } },
    date: today,
    tz,
    storeToday: today,
    summary: {
      sops: 2,
      submitted: 1,
      running: 1,
      notStarted: 1,
      completionPct: 71,
      onTimePct: 88,
      overdueBlocks: 1,
      tempChecks: 6,
      tempsDue: 0,
      tempAlerts: 1,
      tempOpen: 1,
      needsAttention: 3,
      photos: 2,
    },
    periods: ['MORNING', 'EVENING', 'OVERNIGHT'],
    grid: [
      {
        department: 'Frozen & Dairy',
        cells: [
          { period: 'MORNING', runIds: ['r1'], expected: [] },
          { period: 'EVENING', runIds: [], expected: [] },
          { period: 'OVERNIGHT', runIds: ['r2'], expected: [] },
        ],
      },
      {
        department: 'Meat & Produce',
        cells: [
          {
            period: 'MORNING',
            runIds: [],
            expected: [{ windowLabel: 'Morning', storeName: 'Front Beach 218', startsAt: at(-2), endsAt: at(7), missed: true }],
          },
          { period: 'EVENING', runIds: [], expected: [] },
          { period: 'OVERNIGHT', runIds: [], expected: [] },
        ],
      },
    ],
    runs: [
      {
        id: 'r1',
        department: 'Frozen & Dairy',
        period: 'MORNING',
        windowLabel: 'Morning',
        storeName: 'Front Beach 218',
        templateName: 'Frozen & Dairy — Morning (7 AM–4 PM)',
        status: 'ACTIVE',
        runBy: 'Tori Banks',
        openedAt: at(-3),
        closedAt: null,
        dueAt: at(5),
        done: 12,
        total: 30,
        overdueItems: 2,
        onTimePct: 80,
        closedIncomplete: false,
        incompleteReason: null,
        summary: null,
        current: { section: 'Backroom · 7:30–9:30', dueAt: at(-0.2), open: 2 },
        blocks: [
          { section: 'Start of shift · 7:00–7:30', dueAt: at(-2), total: 4, done: 4, late: 0, state: 'done', finishedAt: at(-2.2) },
          { section: 'Backroom · 7:30–9:30', dueAt: at(-0.2), total: 6, done: 4, late: 0, state: 'overdue', finishedAt: null },
          { section: 'End of shift · 3:00–4:00', dueAt: at(5), total: 4, done: 0, late: 0, state: 'upcoming', finishedAt: null },
        ],
        finalPhotoId: null,
      },
      {
        id: 'r2',
        department: 'Frozen & Dairy',
        period: 'OVERNIGHT',
        windowLabel: 'Overnight',
        storeName: 'Front Beach 218',
        templateName: 'Frozen & Dairy — Overnight (10 PM–7 AM)',
        status: 'CLOSED',
        runBy: 'Sam Ortiz',
        openedAt: at(-12),
        closedAt: at(-4),
        dueAt: at(-4),
        done: 38,
        total: 38,
        overdueItems: 0,
        onTimePct: 97,
        closedIncomplete: false,
        incompleteReason: null,
        summary: 'Truck of 22 pallets worked.',
        current: null,
        blocks: [],
        finalPhotoId: 'p1',
      },
    ],
    attention: [
      {
        kind: 'TEMP',
        severity: 'high',
        shiftId: 'r1',
        department: 'Frozen & Dairy',
        period: 'MORNING',
        storeName: 'Front Beach 218',
        title: 'Dairy cooler °F 44°F — outside 33–41°F',
        detail: 'Not re-checked yet',
        at: at(-1),
      },
      {
        kind: 'NOT_STARTED',
        severity: 'high',
        shiftId: null,
        department: 'Meat & Produce',
        period: 'MORNING',
        storeName: 'Front Beach 218',
        title: 'Morning — SOP not started',
        detail: 'Meat & Produce — Morning (6 AM–3 PM)',
        at: at(-2),
      },
    ],
    temps: [
      {
        taskId: 't1',
        shiftId: 'r1',
        department: 'Frozen & Dairy',
        period: 'MORNING',
        storeName: 'Front Beach 218',
        label: 'Dairy cooler °F',
        title: 'Dairy cooler temperature',
        min: 33,
        max: 41,
        value: 44,
        outOfRange: true,
        at: at(-1),
        dueAt: at(-2),
        recheck: null,
      },
      {
        taskId: 't2',
        shiftId: 'r1',
        department: 'Frozen & Dairy',
        period: 'MORNING',
        storeName: 'Front Beach 218',
        label: 'Freezer °F',
        title: 'Freezer case temperature',
        min: -20,
        max: 10,
        value: 2,
        outOfRange: false,
        at: at(-1.5),
        dueAt: at(-2),
        recheck: null,
      },
    ],
    metrics: [
      { key: 'pallets_received', label: 'Pallets received', unit: 'pallets', total: 22, byDepartment: { 'Frozen & Dairy': 22 } },
    ],
    handoffs: [
      {
        id: 'h1',
        shiftId: 'r2',
        department: 'Frozen & Dairy',
        period: 'OVERNIGHT',
        kind: 'EQUIPMENT',
        body: 'Freezer door 3 seal is torn',
        priority: 'HIGH',
        status: 'PENDING',
        createdAt: at(-4),
        decidedAt: null,
        decidedBy: null,
      },
    ],
    filters: { period: null, department: null },
    departments: ['Frozen & Dairy', 'Meat & Produce'],
    live: [
      {
        id: 'r1',
        department: 'Frozen & Dairy',
        period: 'MORNING',
        storeName: 'Front Beach 218',
        windowLabel: 'Morning',
        runBy: 'Tori Banks',
        openedAt: at(-3),
        dueAt: at(5),
        done: 12,
        total: 30,
        overdueItems: 2,
        current: { section: 'Backroom · 7:30–9:30', dueAt: at(-0.2), open: 2 },
      },
    ],
    photos: [
      {
        id: 'p1',
        at: at(-5),
        title: 'Final zone photo',
        section: 'End of shift',
        shiftId: 'r2',
        department: 'Frozen & Dairy',
        period: 'OVERNIGHT',
        storeName: 'Front Beach 218',
      },
    ],
    ...over,
  };
}

function renderPage(payload: StoreOpsDay) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/client-portal/ops?')) return payload;
    throw new Error(`unexpected ${path}`);
  });
  const role = 'CLIENT_PORTAL' as const;
  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'sm@walmart.com', role, status: 'ACTIVE' as const, clientId: 'c1', clientName: 'Walmart', associateId: null },
    role,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/portal/ops']}>
          <PortalOps />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('<PortalOps> — the store manager’s store operations', () => {
  it('leads with what needs them now, worst first', async () => {
    renderPage(day());
    expect(await screen.findByText('2 things need you now')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Needs attention' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Dairy cooler °F 44°F — outside 33–41°F');
    expect(rows[0]).toHaveTextContent('Food safety');
    expect(rows[1]).toHaveTextContent('Morning — SOP not started');
    expect(screen.getByText('1/3')).toBeInTheDocument(); // submitted of expected
    expect(screen.getByText('88%')).toBeInTheDocument();
  });

  it('shows every department by shift, and a shift opens block by block', async () => {
    const user = userEvent.setup();
    renderPage(day());
    const cell = await screen.findByRole('button', { name: /Frozen & Dairy Morning: 2 overdue, 12 of 30 done/ });
    expect(within(cell).getByText(/Now: Backroom · 7:30–9:30/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Frozen & Dairy Overnight: Submitted/ })).toBeInTheDocument();
    expect(screen.getByText(/no SOP open/)).toBeInTheDocument();

    await user.click(cell);
    const blocks = await screen.findByRole('list', { name: 'Blocks' });
    expect(within(blocks).getAllByRole('listitem')).toHaveLength(3);
    expect(within(blocks).getByText(/Overdue · due/)).toBeInTheDocument();
    expect(within(blocks).getByText(/Up next · due/)).toBeInTheDocument();
  });

  it('keeps the temperature log, downloadable for an inspector', async () => {
    const user = userEvent.setup();
    renderPage(day());
    expect(await screen.findByText('Not re-checked')).toBeInTheDocument();
    expect(screen.getByText('2°F')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Temperature log/ }));
    const rows = vi.mocked(downloadCsv).mock.calls[0]![1];
    expect(rows[0]).toContain('Reading °F');
    expect(rows).toHaveLength(3);
  });

  it('counts the freight and lists what each shift handed the next', async () => {
    renderPage(day());
    expect(await screen.findByText('Pallets received')).toBeInTheDocument();
    expect(screen.getByText('22')).toBeInTheDocument();
    expect(screen.getByText('Freezer door 3 seal is torn')).toBeInTheDocument();
    expect(screen.getByText('Waiting for next shift')).toBeInTheDocument();
  });

  it('a clean day says so', async () => {
    renderPage(
      day({
        attention: [],
        summary: { ...day().summary, notStarted: 0, overdueBlocks: 0, tempOpen: 0, tempAlerts: 0, needsAttention: 0 },
      }),
    );
    expect(await screen.findByText('Every department is on track')).toBeInTheDocument();
  });
});

describe('<PortalOps> — what is happening in the store', () => {
  it('names what is on the floor right now, not only how the day finished', async () => {
    renderPage(day());
    const now = await screen.findByRole('heading', { name: /On the floor now/i });
    const card = now.closest('div')!.parentElement!;
    expect(within(card).getByText(/Tori Banks/)).toBeInTheDocument();
    expect(within(card).getByText(/2 items past due/)).toBeInTheDocument();
    // The section is absent on a past day — "now" has no meaning there.
    expect(screen.getByText(/1 shift running/)).toBeInTheDocument();
  });

  it('shows the photographs, rather than counting them', async () => {
    renderPage(day());
    expect(await screen.findByRole('heading', { name: /From the floor/i })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open the full photo: Final zone photo/i }),
    ).toBeInTheDocument();
    expect(screen.getByAltText('Final zone photo')).toBeInTheDocument();
  });

  it('stays on the page when the floor photographed nothing', async () => {
    renderPage(day({ photos: [] }));
    expect(await screen.findByRole('heading', { name: /From the floor/i })).toBeInTheDocument();
    expect(screen.getByText(/no photos yet/i)).toBeInTheDocument();
  });

  it('turns "what happened overnight" into one button', async () => {
    const user = userEvent.setup();
    renderPage(day());
    const btn = await screen.findByRole('button', { name: /Last night/i });
    await user.click(btn);
    // Yesterday AND the overnight shift, in one act — the manager should
    // not have to pick a date and then remember to filter.
    const calls = vi.mocked(apiFetch).mock.calls.map((c) => String(c[0]));
    const last = calls.at(-1)!;
    expect(last).toContain('period=OVERNIGHT');
    expect(last).toMatch(/date=\d{4}-\d{2}-\d{2}/);
    expect(last).not.toContain(`date=${today}`);
  });

  it('offers the shift and department filters, and a way back out', async () => {
    const user = userEvent.setup();
    renderPage(day());
    const shift = await screen.findByLabelText('Filter by shift');
    await user.selectOptions(shift, 'OVERNIGHT');
    expect(String(vi.mocked(apiFetch).mock.calls.at(-1)![0])).toContain('period=OVERNIGHT');

    const dept = screen.getByLabelText('Filter by department');
    await user.selectOptions(dept, 'Meat & Produce');
    expect(String(vi.mocked(apiFetch).mock.calls.at(-1)![0])).toContain(
      'department=Meat+%26+Produce',
    );

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    const after = String(vi.mocked(apiFetch).mock.calls.at(-1)![0]);
    expect(after).not.toContain('period=');
    expect(after).not.toContain('department=');
  });
});
