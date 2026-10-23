import { describe, expect, it, vi, beforeEach, onTestFinished } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/timeApi', () => ({
  addTimeEntryBreak: vi.fn(async () => ({})),
  adminCreateTimeEntry: vi.fn(async () => ({ id: 'entry-1', clientId: 'c1' })),
  adminEditTimeEntry: vi.fn(),
  approveTimeEntry: vi.fn(),
  bulkApplyBreakTimeEntries: vi.fn(),
  bulkApproveTimeEntries: vi.fn(),
  bulkRejectTimeEntries: vi.fn(),
  countAdminTimeEntries: vi.fn(async () => ({ count: 0 })),
  deleteTimeEntryBreak: vi.fn(),
  exportPayrollSheet: vi.fn(),
  exportTimeEntries: vi.fn(),
  exportTimeSummary: vi.fn(),
  getActiveDashboard: vi.fn(async () => ({ entries: [] })),
  getTimeExceptions: vi.fn(async () => ({
    missedPunches: { count: 0, oldestAt: null },
    lateToday: { count: 0, dayFrom: '', dayTo: '' },
    overtimeRisk: { count: 0, thresholdHours: 36, weekStart: '2026-06-27', weekEnd: '2026-07-03', people: [] },
  })),
  listAdminTimeEntries: vi.fn(async () => ({ entries: [] })),
  listPayPeriods: vi.fn(),
  rejectTimeEntry: vi.fn(),
  updateTimeEntryBreak: vi.fn(),
}));

vi.mock('@/lib/directoryApi', () => ({
  listDirectory: vi.fn(async () => ({ associates: [] })),
}));

vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn(async () => ({ clients: [] })),
  listClientLocations: vi.fn(async () => ({ locations: [] })),
}));

vi.mock('@/lib/schedulingApi', () => ({
  listShifts: vi.fn(async () => ({ shifts: [] })),
  // The add-entry associate picker now uses the client-clamped scheduling
  // roster instead of the view:org-gated directory.
  listSchedulingAssociates: vi.fn(async () => ({ associates: [] })),
}));

import {
  addTimeEntryBreak,
  adminCreateTimeEntry,
  adminEditTimeEntry,
  approveTimeEntry,
  exportTimeEntries,
  getActiveDashboard,
  getTimeExceptions,
  listAdminTimeEntries,
  listPayPeriods,
} from '@/lib/timeApi';
import { ymdToIsoEndExclusive, ymdToIsoStart } from '@/lib/format';
import { listDirectory } from '@/lib/directoryApi';
import { listSchedulingAssociates, listShifts } from '@/lib/schedulingApi';
import { AdminTimeView, defaultQueuePeriod } from '@/pages/time/AdminTimeView';
import { AuthContext } from '@/lib/auth';

// Fixed windows from the MOCKED endpoint — the component only displays
// them, so nothing here rots as the calendar moves.
const PERIODS = [
  { start: '2026-06-29', end: '2026-07-05', current: true, hasRun: false },
  { start: '2026-06-22', end: '2026-06-28', current: false, hasRun: true },
];

// The view now reads the caller's client boundary from useAuth (to pin
// SHIFT_SUPERVISOR pickers), so tests must supply an auth context.
const AUTH_VALUE = {
  isInitializing: false,
  isOffline: false,
  user: {
    id: 'u-hr',
    email: 'hr@example.com',
    role: 'HR_ADMINISTRATOR',
    status: 'ACTIVE',
    clientId: null,
    clientName: null,
    associateId: null,
  },
  role: 'HR_ADMINISTRATOR',
  capabilities: new Set(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  can: () => true,
} as never;

function renderAtPath(path: string) {
  // Fresh client per render — the view's dialogs read the shared
  // ['clients','list'] key via useClients(), and a leaked cache would
  // couple tests.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={AUTH_VALUE}>
        <MemoryRouter initialEntries={[path]}>
          <AdminTimeView canManage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

function renderQueueTab() {
  return renderAtPath('/');
}

/** Downloads live in one "Export & payroll" menu (F500 G2: five buttons in the filter row). */
async function exportAs(user: ReturnType<typeof userEvent.setup>, item: RegExp) {
  await user.click(await screen.findByRole('button', { name: /export & payroll/i }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

/** The queue's last read window, as ISO instants. */
const lastWindow = () => {
  const q = vi.mocked(listAdminTimeEntries).mock.calls.at(-1)?.[0] as { from?: string; to?: string } | undefined;
  return { from: q?.from, to: q?.to };
};

beforeEach(() => {
  // The status filter persists; a leaked value would change which chips render.
  localStorage.clear();
  vi.mocked(listPayPeriods).mockResolvedValue({ periods: PERIODS });
  vi.mocked(listAdminTimeEntries).mockClear();
  vi.mocked(exportTimeEntries).mockClear();
  // Reset per test — a live-board fixture from one test must not leak an
  // occupied floor into the next.
  vi.mocked(getActiveDashboard).mockResolvedValue({ entries: [] } as never);
  vi.mocked(listDirectory).mockResolvedValue({ associates: [] } as never);
});

describe('<AdminTimeView> pay-period picker', () => {
  it('lists the server periods with current/paid markers', async () => {
    // "Current" is the reader's own date, not the server's flag.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-01T12:00:00'));
    onTestFinished(() => vi.useRealTimers());
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    // One picker owns the window: the pay periods, the quick ranges, and
    // "Custom range…" (F500 G2: no "· N pending" suffix cut off at 1440).
    const select = await screen.findByLabelText(/pay period/i);
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual([
      'Jun 29 – Jul 5 · current',
      'Jun 22 – Jun 28 · paid',
      'Today',
      'This week',
      'Last week',
      'Last 14 days',
      'Custom range…',
    ]);
  });

  it('choosing a period sets the queue window and refetches (no date fields)', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    const select = await screen.findByLabelText(/pay period/i);
    await user.selectOptions(select, '2026-06-22|2026-06-28');

    await waitFor(() =>
      expect(lastWindow()).toEqual({ from: ymdToIsoStart('2026-06-22'), to: ymdToIsoEndExclusive('2026-06-28') }),
    );
    // The period owns the dates: no From/To fields beside it.
    expect(screen.queryByLabelText(/^from$/i)).not.toBeInTheDocument();
  });

  it('"Custom range…" shows From/To on the current window, and editing a date keeps it custom', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    const select = await screen.findByLabelText<HTMLSelectElement>(/pay period/i);
    await user.selectOptions(select, '2026-06-22|2026-06-28');
    await user.selectOptions(select, 'CUSTOM');
    expect(select.value).toBe('CUSTOM');
    // The chosen dates stay — dropping to custom must not reset the range.
    expect(screen.getByLabelText(/^from$/i)).toHaveValue('2026-06-22');
    expect(screen.getByLabelText(/^to$/i)).toHaveValue('2026-06-28');

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '2026-06-20' } });
    expect(select.value).toBe('CUSTOM');
    await waitFor(() => expect(lastWindow().from).toBe(ymdToIsoStart('2026-06-20')));
  });

  it('offers the quick ranges alone when no periods exist (no schedule, no runs)', async () => {
    vi.mocked(listPayPeriods).mockResolvedValue({ periods: [] });
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    await screen.findByRole('button', { name: /anomalies only/i }); // filter row rendered
    const select = await screen.findByLabelText(/pay period/i);
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Today',
      'This week',
      'Last week',
      'Last 14 days',
      'Custom range…',
    ]);
  });
});

const pad = (n: number) => String(n).padStart(2, '0');
const localDateStr = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Same local-wall-clock composition the drawer uses.
const isoAt = (dateStr: string, time: string, dayOffset = 0) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d + dayOffset, hh, mm).toISOString();
};

async function openCreateDrawerWithAssociate(
  user: ReturnType<typeof userEvent.setup>,
) {
  vi.mocked(listSchedulingAssociates).mockResolvedValue({
    associates: [
      { id: 'a1', firstName: 'Maria', lastName: 'Lopez', email: 'maria@x.com' },
    ],
  } as never);
  await user.click(await screen.findByRole('button', { name: /add entry/i }));
  // The queue's filter bar has its own associate search — scope to the drawer.
  const drawer = within(await screen.findByRole('dialog'));
  await user.type(
    await drawer.findByPlaceholderText(/search associate/i),
    'Mar',
  );
  await user.click(await drawer.findByRole('button', { name: /maria lopez/i }));
  return drawer;
}

describe('<AdminTimeView> add-entry drawer', () => {
  beforeEach(() => {
    vi.mocked(adminCreateTimeEntry).mockClear();
    vi.mocked(adminCreateTimeEntry).mockResolvedValue({
      id: 'entry-1',
      clientId: 'c1',
    } as never);
    vi.mocked(addTimeEntryBreak).mockClear();
    vi.mocked(listShifts).mockResolvedValue({ shifts: [] });
  });

  it('defaults the date to today and needs only two time picks for a shift', async () => {
    const user = renderQueueTab();
    await openCreateDrawerWithAssociate(user);

    const today = localDateStr(new Date());
    const dateInput = screen.getByLabelText<HTMLInputElement>('Shift date');
    expect(dateInput.value).toBe(today);

    fireEvent.change(screen.getByLabelText('Clock-in time'), {
      target: { value: '09:00' },
    });
    fireEvent.change(screen.getByLabelText('Clock-out time'), {
      target: { value: '17:30' },
    });
    // Live summary appears before saving anything.
    expect(screen.getByText(/total 8\.50h/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create entry/i }));
    await waitFor(() => expect(adminCreateTimeEntry).toHaveBeenCalledTimes(1));
    expect(adminCreateTimeEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        associateId: 'a1',
        clockInAt: isoAt(today, '09:00'),
        clockOutAt: isoAt(today, '17:30'),
      }),
    );
  });

  it('quick-adds a 30-minute break centered in the shift and shows paid hours', async () => {
    const user = renderQueueTab();
    await openCreateDrawerWithAssociate(user);

    const today = localDateStr(new Date());
    fireEvent.change(screen.getByLabelText('Clock-in time'), {
      target: { value: '09:00' },
    });
    fireEvent.change(screen.getByLabelText('Clock-out time'), {
      target: { value: '17:30' },
    });
    await user.click(screen.getByRole('button', { name: /30m/i }));

    // Centered: 9:00–17:30 minus 30m → 13:00–13:30.
    expect(screen.getByLabelText<HTMLInputElement>('Break 1 start').value).toBe(
      '13:00',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Break 1 end').value).toBe(
      '13:30',
    );
    expect(screen.getByText(/paid 8\.00h/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create entry/i }));
    await waitFor(() => expect(addTimeEntryBreak).toHaveBeenCalledTimes(1));
    expect(addTimeEntryBreak).toHaveBeenCalledWith('entry-1', {
      startedAt: isoAt(today, '13:00'),
      endedAt: isoAt(today, '13:30'),
    });
  });

  it('treats an end before the start as overnight (+1 day) without a second date', async () => {
    const user = renderQueueTab();
    await openCreateDrawerWithAssociate(user);

    const today = localDateStr(new Date());
    fireEvent.change(screen.getByLabelText('Clock-in time'), {
      target: { value: '22:00' },
    });
    fireEvent.change(screen.getByLabelText('Clock-out time'), {
      target: { value: '06:00' },
    });
    expect(screen.getByText(/ends the next day/i)).toBeInTheDocument();
    expect(screen.getByText(/total 8\.00h/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create entry/i }));
    await waitFor(() => expect(adminCreateTimeEntry).toHaveBeenCalledTimes(1));
    expect(adminCreateTimeEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        clockInAt: isoAt(today, '22:00'),
        clockOutAt: isoAt(today, '06:00', 1),
      }),
    );
  });

  it('offers a one-click prefill from the associate’s scheduled shift', async () => {
    const today = localDateStr(new Date());
    vi.mocked(listShifts).mockResolvedValue({
      shifts: [
        {
          id: 's1',
          assignedAssociateId: 'a1',
          status: 'ASSIGNED',
          startsAt: isoAt(today, '08:00'),
          endsAt: isoAt(today, '16:30'),
        },
      ],
    } as never);
    const user = renderQueueTab();
    await openCreateDrawerWithAssociate(user);

    await user.click(
      await screen.findByRole('button', { name: /use scheduled shift/i }),
    );
    expect(screen.getByLabelText<HTMLInputElement>('Clock-in time').value).toBe(
      '08:00',
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Clock-out time').value,
    ).toBe('16:30');
    expect(screen.getByText(/total 8\.50h/i)).toBeInTheDocument();
  });
});

describe('<AdminTimeView> export scope', () => {
  // The download used to send only {from, to, status}. Narrowing the queue to
  // one person and hitting CSV handed back every associate in the range — a
  // file that looked like the filtered list but wasn't.
  it('scopes the CSV to the person in focus', async () => {
    const user = renderAtPath('/?associate=a-maria&name=Maria%20Lopez');
    expect(await screen.findByText(/maria lopez — timesheet/i)).toBeInTheDocument();

    await exportAs(user, /^csv$/i);

    await waitFor(() => expect(exportTimeEntries).toHaveBeenCalled());
    const [format, body] = vi.mocked(exportTimeEntries).mock.calls.at(-1)!;
    expect(format).toBe('csv');
    expect(body.associateId).toBe('a-maria');
  });

  it('carries the free-text search into the download', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    await user.type(screen.getByPlaceholderText(/search associates/i), 'lopez');
    // The queue debounces the term at 300ms; the export must send the same
    // applied value, not the raw keystrokes.
    await waitFor(() =>
      expect(
        vi.mocked(listAdminTimeEntries).mock.calls.at(-1)?.[0],
      ).toMatchObject({ search: 'lopez' }),
    );

    await exportAs(user, /^csv$/i);

    await waitFor(() => expect(exportTimeEntries).toHaveBeenCalled());
    expect(vi.mocked(exportTimeEntries).mock.calls.at(-1)![1].search).toBe('lopez');
  });

  it('carries the anomalies-only toggle into the download', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    await user.click(screen.getByRole('button', { name: /anomalies only/i }));
    await exportAs(user, /^csv$/i);

    await waitFor(() => expect(exportTimeEntries).toHaveBeenCalled());
    expect(
      vi.mocked(exportTimeEntries).mock.calls.at(-1)![1].anomaliesOnly,
    ).toBe(true);
  });

  it('sends no person filter when nothing is narrowed', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    await exportAs(user, /^csv$/i);

    await waitFor(() => expect(exportTimeEntries).toHaveBeenCalled());
    const body = vi.mocked(exportTimeEntries).mock.calls.at(-1)![1];
    expect(body.associateId).toBeUndefined();
    expect(body.search).toBeUndefined();
    expect(body.anomaliesOnly).toBeUndefined();
    expect(body.from).toBeTruthy();
    expect(body.to).toBeTruthy();
  });
});

describe('<AdminTimeView> shift-window filter', () => {
  const base = {
    associateId: 'a1',
    clientId: null,
    clientName: 'Walmart',
    status: 'COMPLETED' as const,
    notes: null,
    rejectionReason: null,
    approvedById: null,
    approverEmail: null,
    approvedAt: null,
    minutesElapsed: 480,
    netMinutes: 480,
  };
  // No locationTimezone → the window key falls back to UTC, so these are
  // deterministic in any test-runner timezone. Two mornings (6–2), one
  // afternoon (2–10), one punch with no matched shift.
  const ENTRIES = [
    {
      ...base,
      id: 's1',
      associateName: 'Ana Morning',
      clockInAt: '2026-06-24T06:02:00.000Z',
      clockOutAt: '2026-06-24T14:00:00.000Z',
      shiftStartsAt: '2026-06-24T06:00:00.000Z',
      shiftEndsAt: '2026-06-24T14:00:00.000Z',
    },
    {
      ...base,
      id: 's2',
      associateName: 'Amy Morning',
      clockInAt: '2026-06-25T05:58:00.000Z',
      clockOutAt: '2026-06-25T14:05:00.000Z',
      shiftStartsAt: '2026-06-25T06:00:00.000Z',
      shiftEndsAt: '2026-06-25T14:00:00.000Z',
    },
    {
      ...base,
      id: 's3',
      associateName: 'Ben Afternoon',
      clockInAt: '2026-06-24T14:00:00.000Z',
      clockOutAt: '2026-06-24T22:00:00.000Z',
      shiftStartsAt: '2026-06-24T14:00:00.000Z',
      shiftEndsAt: '2026-06-24T22:00:00.000Z',
    },
    {
      ...base,
      id: 's4',
      associateName: 'Cara Walkin',
      clockInAt: '2026-06-24T09:00:00.000Z',
      clockOutAt: '2026-06-24T13:00:00.000Z',
      shiftStartsAt: null,
      shiftEndsAt: null,
    },
  ];

  it('offers the page’s real windows and narrows the queue to one shift', async () => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: ENTRIES } as never);
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));
    await screen.findAllByText('Ben Afternoon');

    const select = screen.getByLabelText(/^shift$/i);
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual([
      'All shifts',
      '6:00 AM – 2:00 PM (2)',
      '2:00 PM – 10:00 PM (1)',
      'No matched shift (1)',
    ]);

    await user.selectOptions(select, '360-840');
    expect(screen.getAllByText('Ana Morning').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Amy Morning').length).toBeGreaterThan(0);
    expect(screen.queryByText('Ben Afternoon')).not.toBeInTheDocument();
    expect(screen.queryByText('Cara Walkin')).not.toBeInTheDocument();

    // 'none' = the punches with no matched shift.
    await user.selectOptions(select, 'none');
    expect(screen.getAllByText('Cara Walkin').length).toBeGreaterThan(0);
    expect(screen.queryByText('Ana Morning')).not.toBeInTheDocument();
  });

  it('carries the picked window into the download', async () => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: ENTRIES } as never);
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));
    await screen.findAllByText('Ben Afternoon');

    await user.selectOptions(screen.getByLabelText(/^shift$/i), '360-840');
    await exportAs(user, /^csv$/i);

    await waitFor(() => expect(exportTimeEntries).toHaveBeenCalled());
    expect(
      vi.mocked(exportTimeEntries).mock.calls.at(-1)![1].shiftWindow,
    ).toBe('360-840');
  });
});

describe('<AdminTimeView> live board shift filter', () => {
  const liveBase = {
    clientId: null,
    clientName: 'Walmart',
    jobId: null,
    jobName: null,
    onBreak: false,
    geofenceOk: null,
    clockInLat: null,
    clockInLng: null,
    minutesElapsed: 60,
  };
  // No locationTimezone → UTC-keyed windows, deterministic in any runner tz.
  const ACTIVE = [
    {
      ...liveBase,
      id: 'l1',
      associateId: 'a1',
      associateName: 'Ana Morning',
      clockInAt: '2026-06-24T06:00:00.000Z',
      shiftStartsAt: '2026-06-24T06:00:00.000Z',
      shiftEndsAt: '2026-06-24T14:00:00.000Z',
    },
    {
      ...liveBase,
      id: 'l2',
      associateId: 'a2',
      associateName: 'Ben Afternoon',
      clockInAt: '2026-06-24T14:00:00.000Z',
      shiftStartsAt: '2026-06-24T14:00:00.000Z',
      shiftEndsAt: '2026-06-24T22:00:00.000Z',
    },
    {
      ...liveBase,
      id: 'l3',
      associateId: 'a3',
      associateName: 'Cara Walkin',
      clockInAt: '2026-06-24T09:00:00.000Z',
      shiftStartsAt: null,
      shiftEndsAt: null,
    },
  ];

  it('narrows who is on the board to one shift window', async () => {
    vi.mocked(getActiveDashboard).mockResolvedValue({ entries: ACTIVE } as never);
    const user = renderQueueTab();
    await screen.findAllByText('Ana Morning');

    const select = screen.getByLabelText(/^shift$/i);
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual([
      'All shifts',
      '6:00 AM – 2:00 PM (1)',
      '2:00 PM – 10:00 PM (1)',
      'No matched shift (1)',
    ]);

    await user.selectOptions(select, '360-840');
    expect(screen.getAllByText('Ana Morning').length).toBeGreaterThan(0);
    expect(screen.queryByText('Ben Afternoon')).not.toBeInTheDocument();
    expect(screen.queryByText('Cara Walkin')).not.toBeInTheDocument();

    await user.selectOptions(select, 'none');
    expect(screen.getAllByText('Cara Walkin').length).toBeGreaterThan(0);
    expect(screen.queryByText('Ana Morning')).not.toBeInTheDocument();
  });
});

describe('<AdminTimeView> individual timesheet (focus mode)', () => {
  const baseEntry = {
    associateId: 'a1',
    associateName: 'Primavera Vasquez Blanco',
    clientId: null,
    clientName: 'Walmart',
    status: 'COMPLETED' as const,
    notes: null,
    rejectionReason: null,
    approvedById: null,
    approverEmail: null,
    approvedAt: null,
  };

  // Wed Jun 24 2026, browser-local: a split day (two entries, 40m apart)
  // plus a normal day after it.
  const ENTRIES = [
    {
      ...baseEntry,
      id: 'e1',
      clockInAt: isoAt('2026-06-24', '08:00'),
      clockOutAt: isoAt('2026-06-24', '12:00'),
      minutesElapsed: 240,
      netMinutes: 240,
    },
    {
      ...baseEntry,
      id: 'e2',
      clockInAt: isoAt('2026-06-24', '12:40'),
      clockOutAt: isoAt('2026-06-24', '17:00'),
      minutesElapsed: 260,
      netMinutes: 260,
    },
    {
      ...baseEntry,
      id: 'e3',
      clockInAt: isoAt('2026-06-25', '08:00'),
      clockOutAt: isoAt('2026-06-25', '16:30'),
      minutesElapsed: 510,
      netMinutes: 480,
    },
  ];

  async function focusOnAssociate(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));
    // The clickable ROW is also role="button" (whole-row accessible name),
    // so target the name button by its title.
    const nameButtons = await screen.findAllByTitle('View individual timesheet');
    await user.click(nameButtons[0]);
    await screen.findByText(/individual timesheet/i);
  }

  it('groups a double clock-in day under one header with the gap spelled out', async () => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: ENTRIES } as never);
    const user = renderQueueTab();
    await focusOnAssociate(user);

    expect(await screen.findByText('2 shifts')).toBeInTheDocument();
    expect(screen.getByText(/back in 40m later/i)).toBeInTheDocument();
    // Week section with the summed net total: 240 + 260 + 480 = 980m = 16.33h.
    expect(screen.getByText(/week of/i)).toBeInTheDocument();
    expect(screen.getByText('16.33h')).toBeInTheDocument();
  });

  it('flags a second entry that starts before the first ended as an overlap', async () => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({
      entries: [
        ENTRIES[0],
        {
          ...ENTRIES[1],
          clockInAt: isoAt('2026-06-24', '11:30'), // 30m before e1 clocked out
        },
      ],
    } as never);
    const user = renderQueueTab();
    await focusOnAssociate(user);

    expect(
      await screen.findByText(/overlaps previous entry by 30m/i),
    ).toBeInTheDocument();
  });

  it('the focus banner’s OT is the server’s split (daily rules included), not the week minus 40', async () => {
    // 16.33 h in the week — under 40 — but the server split 30 min of e3 as overtime (a live daily rule).
    const split = (reg: number, ot: number) => ({ regularMinutes: reg, overtimeMinutes: ot, doubleTimeMinutes: 0, overtimeMultiplier: 1.5, doubleMultiplier: 2 });
    vi.mocked(listAdminTimeEntries).mockResolvedValue({
      entries: [{ ...ENTRIES[0], hours: split(240, 0) }, { ...ENTRIES[1], hours: split(260, 0) }, { ...ENTRIES[2], hours: split(450, 30) }],
    } as never);
    const user = renderQueueTab();
    await focusOnAssociate(user);
    expect(await screen.findByText('0.5h OT')).toBeInTheDocument();
    // …and the week section carries the same figure.
    expect(screen.getByText('0.50h OT')).toBeInTheDocument();
  });

  it('leaving focus returns to the flat queue table', async () => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: ENTRIES } as never);
    const user = renderQueueTab();
    await focusOnAssociate(user);

    await user.click(screen.getByRole('button', { name: /back to all associates/i }));
    await waitFor(() =>
      expect(screen.queryByText(/week of/i)).not.toBeInTheDocument(),
    );
    // The sortable triage table is back.
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('<AdminTimeView> quick ranges', () => {
  /** Local Saturday that starts the org Sat→Fri week containing `d`. */
  const satWeekStart = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() + 1) % 7));
    return x;
  };

  it('"Last week" reads the previous Sat→Fri window; "Custom range…" shows it as dates', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    const select = await screen.findByLabelText<HTMLSelectElement>(/pay period/i);
    await user.selectOptions(select, 'LAST_WEEK');

    const lastSat = satWeekStart(new Date());
    lastSat.setDate(lastSat.getDate() - 7);
    const lastFri = new Date(lastSat);
    lastFri.setDate(lastFri.getDate() + 6);
    await waitFor(() =>
      expect(lastWindow()).toEqual({ from: ymdToIsoStart(localDateStr(lastSat)), to: ymdToIsoEndExclusive(localDateStr(lastFri)) }),
    );
    expect(select.value).toBe('LAST_WEEK');

    await user.selectOptions(select, 'CUSTOM');
    expect(screen.getByLabelText(/^from$/i)).toHaveValue(localDateStr(lastSat));
    expect(screen.getByLabelText(/^to$/i)).toHaveValue(localDateStr(lastFri));
  });

  it('"Today" is one day: from and to are both today', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));
    await user.selectOptions(await screen.findByLabelText(/pay period/i), 'TODAY');
    const today = localDateStr(new Date());
    await waitFor(() => expect(lastWindow()).toEqual({ from: ymdToIsoStart(today), to: ymdToIsoEndExclusive(today) }));
  });
});

describe('<AdminTimeView> ?from/?to deep link', () => {
  it('consumes valid params into the queue date window', async () => {
    renderAtPath('/?tab=queue&from=2026-06-01&to=2026-06-10');
    expect(await screen.findByDisplayValue('2026-06-01')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-06-10')).toBeInTheDocument();
  });

  it('ignores an inverted pair (consumed, defaults kept)', async () => {
    renderAtPath('/?tab=queue&from=2026-06-10&to=2026-06-01');
    await screen.findByRole('button', { name: /anomalies only/i });
    expect(screen.queryByDisplayValue('2026-06-10')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('2026-06-01')).not.toBeInTheDocument();
  });

  it('composes with an ?associate deep link', async () => {
    renderAtPath(
      '/?associate=a-maria&name=Maria%20Lopez&from=2026-06-01&to=2026-06-10',
    );
    expect(
      await screen.findByText(/maria lopez — timesheet/i),
    ).toBeInTheDocument();
    expect(await screen.findByDisplayValue('2026-06-01')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-06-10')).toBeInTheDocument();
  });
});

describe('<AdminTimeView> anomaly triage', () => {
  const base = {
    associateId: 'a1',
    clientId: null,
    clientName: 'Walmart',
    status: 'COMPLETED' as const,
    notes: null,
    rejectionReason: null,
    approvedById: null,
    approverEmail: null,
    approvedAt: null,
    minutesElapsed: 480,
    netMinutes: 480,
  };
  const FLAGGED = [
    {
      ...base,
      id: 'n1',
      associateName: 'Nora NoBreak',
      clockInAt: '2026-06-24T06:00:00.000Z',
      clockOutAt: '2026-06-24T14:00:00.000Z',
      anomalies: ['NO_BREAK'],
    },
    {
      ...base,
      id: 'f1',
      associateName: 'Frank Forgot',
      clockInAt: '2026-06-24T14:00:00.000Z',
      clockOutAt: '2026-06-25T02:00:00.000Z',
      anomalies: ['FORGOT_CLOCKOUT'],
      shiftStartsAt: '2026-06-24T14:00:00.000Z',
      shiftEndsAt: '2026-06-24T22:00:00.000Z',
    },
    {
      ...base,
      id: 'c1',
      associateName: 'Carl Clean',
      clockInAt: '2026-06-24T09:00:00.000Z',
      clockOutAt: '2026-06-24T17:00:00.000Z',
      anomalies: [],
    },
  ];

  it('anomaly-type chips list the present types with counts and OR together', async () => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: FLAGGED } as never);
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));
    await screen.findAllByText('Carl Clean');

    await user.click(screen.getByRole('button', { name: /anomalies only/i }));
    // Lens on: clean rows gone, one chip per type present.
    expect(screen.queryByText('Carl Clean')).not.toBeInTheDocument();
    const noBreakChip = await screen.findByRole('button', {
      name: /no break taken \(1\)/i,
    });
    const forgotChip = screen.getByRole('button', {
      name: /forgot clock-out \(1\)/i,
    });

    await user.click(noBreakChip);
    expect(screen.getAllByText('Nora NoBreak').length).toBeGreaterThan(0);
    expect(screen.queryByText('Frank Forgot')).not.toBeInTheDocument();

    // Second chip ORs in the other type.
    await user.click(forgotChip);
    expect(screen.getAllByText('Nora NoBreak').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Frank Forgot').length).toBeGreaterThan(0);
  });

  it('offers "Approve at sched. end" on FORGOT_CLOCKOUT rows and sends the override', async () => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: FLAGGED } as never);
    vi.mocked(approveTimeEntry).mockResolvedValue({} as never);
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));
    await screen.findAllByText('Frank Forgot');

    // Only the FORGOT_CLOCKOUT row with a scheduled end offers it. (The
    // clickable row itself is also role=button, so anchor to the start.)
    const buttons = screen.getAllByRole('button', {
      name: /^approve at sched\. end/i,
    });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]);
    await waitFor(() =>
      expect(approveTimeEntry).toHaveBeenCalledWith('f1', {
        clockOutAt: '2026-06-24T22:00:00.000Z',
      }),
    );
  });

  it('reject presets fill the reason box (still editable)', async () => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: FLAGGED } as never);
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));
    await screen.findAllByText('Carl Clean');

    await user.click(screen.getAllByRole('button', { name: /^reject$/i })[0]);
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: /duplicate punch/i }));
    expect(dialog.getByRole('textbox')).toHaveValue('Duplicate punch');
  });
});

describe('<AdminTimeView> live board one-click clock out', () => {
  const ACTIVE_ROW = {
    id: 'l1',
    associateId: 'a1',
    associateName: 'Ana Morning',
    clientId: null,
    clientName: 'Walmart',
    jobId: null,
    jobName: null,
    clockInAt: '2026-06-24T06:00:00.000Z',
    minutesElapsed: 125,
    onBreak: false,
    geofenceOk: null,
    clockInLat: null,
    clockInLng: null,
    shiftStartsAt: null,
    shiftEndsAt: null,
  };

  it('clocks the row out at "now" without opening the drawer', async () => {
    vi.mocked(getActiveDashboard).mockResolvedValue({
      entries: [ACTIVE_ROW],
    } as never);
    vi.mocked(adminEditTimeEntry).mockResolvedValue({} as never);
    const user = renderQueueTab();
    await screen.findAllByText('Ana Morning');

    await user.click(screen.getByRole('button', { name: /clock out now/i }));
    await waitFor(() => expect(adminEditTimeEntry).toHaveBeenCalled());
    const [id, body] = vi.mocked(adminEditTimeEntry).mock.calls.at(-1)!;
    expect(id).toBe('l1');
    expect(typeof body.clockOutAt).toBe('string');
    // No drawer opened — this is the one-click path.
    expect(screen.queryByText(/edit time entry/i)).not.toBeInTheDocument();
  });
});

describe('<AdminTimeView> clickable KPI tiles', () => {
  it('"Pending review" jumps to the approval queue', async () => {
    const user = renderQueueTab();
    // Tile becomes a button once its count resolves (mock: 0).
    const tile = await screen.findByRole('button', { name: /pending review/i });
    await user.click(tile);
    expect(
      await screen.findByRole('button', { name: /anomalies only/i }),
    ).toBeInTheDocument();
  });
});

describe('<AdminTimeView> queue opens on the pay period', () => {
  const P = (start: string, end: string, current: boolean, hasRun: boolean) => ({ start, end, current, hasRun });

  it('picks the current period — or the just-closed one until its payday, while it has no run', () => {
    const periods = [P('2026-10-17', '2026-10-30', true, false), P('2026-10-03', '2026-10-16', false, false)];
    // Four days after the close, unpaid: that period's time is what needs approving.
    expect(defaultQueuePeriod(periods, '2026-10-20')).toMatchObject({ which: 'LAST', period: { start: '2026-10-03' } });
    // Payday itself still counts; the day after, the current period.
    expect(defaultQueuePeriod(periods, '2026-10-23')?.which).toBe('LAST');
    expect(defaultQueuePeriod([{ ...periods[0]!, current: true }, periods[1]!], '2026-10-24')?.which).toBe('CURRENT');
    // Already run: nothing left to approve there.
    expect(defaultQueuePeriod([periods[0]!, { ...periods[1]!, hasRun: true }], '2026-10-20')).toMatchObject({ which: 'CURRENT', period: { start: '2026-10-17' } });
    expect(defaultQueuePeriod([], '2026-10-20')).toBeNull();
  });

  it('decides "current" on the reader\'s date, not the server\'s UTC flag', () => {
    // Friday Oct 30, 6 PM Pacific: the server (UTC) already calls the next
    // period current. The reader is still on the last day of theirs.
    const periods = [P('2026-10-31', '2026-11-13', true, false), P('2026-10-17', '2026-10-30', false, false), P('2026-10-03', '2026-10-16', false, true)];
    expect(defaultQueuePeriod(periods, '2026-10-30')).toMatchObject({ which: 'CURRENT', period: { start: '2026-10-17' } });
  });

  it('opens on the current period instead of the last 14 days', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));
    const select = await screen.findByLabelText<HTMLSelectElement>(/pay period/i);
    await waitFor(() => expect(select.value).toBe('2026-06-29|2026-07-05'));
    await waitFor(() => expect(lastWindow()).toEqual({ from: ymdToIsoStart('2026-06-29'), to: ymdToIsoEndExclusive('2026-07-05') }));
    // The first read already asks for that window — no 14-day read first.
    const froms = vi.mocked(listAdminTimeEntries).mock.calls.map((c) => (c[0] as { from?: string }).from);
    expect(froms.length).toBeGreaterThan(0);
    expect(froms.every((f) => f?.startsWith('2026-06-2') || f?.startsWith('2026-06-29'))).toBe(true);
  });

  it('remembers the window picked last time ("Last week") on the next visit', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));
    const select = await screen.findByLabelText(/pay period/i);
    await user.selectOptions(select, 'LAST_WEEK');
    expect(localStorage.getItem('alto:list.time.range.v1')).toContain('LAST_WEEK');
  });
});

describe('<AdminTimeView> queue keyboard', () => {
  it('j moves the cursor onto a row and a approves it', async () => {
    const row = {
      id: 'k1',
      associateId: 'a1',
      associateName: 'Kim Keys',
      clientId: null,
      clientName: 'Walmart',
      status: 'COMPLETED' as const,
      notes: null,
      rejectionReason: null,
      approvedById: null,
      approverEmail: null,
      approvedAt: null,
      minutesElapsed: 480,
      netMinutes: 480,
      clockInAt: new Date(2026, 5, 30, 8, 0).toISOString(),
      clockOutAt: new Date(2026, 5, 30, 16, 0).toISOString(),
      anomalies: [],
      breaks: [],
    };
    vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: [row], truncated: false } as never);
    vi.mocked(approveTimeEntry).mockResolvedValue({} as never);
    const user = renderAtPath('/?tab=queue');
    await screen.findByText('Kim Keys');
    await user.keyboard('j');
    await waitFor(() => expect(document.querySelector('#time-row-k1')?.className).toMatch(/inset_3px/));
    await user.keyboard('a');
    await waitFor(() => expect(approveTimeEntry).toHaveBeenCalledWith('k1'));
  });
});

describe('<AdminTimeView> exception tiles are the filter (F500 G2)', () => {
  const today = localDateStr(new Date());
  const at = (h: number, m = 0) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const base = {
    clientId: null,
    clientName: 'Walmart',
    notes: null,
    rejectionReason: null,
    approvedById: null,
    approverEmail: null,
    approvedAt: null,
    minutesElapsed: 240,
    netMinutes: 240,
    anomalies: [] as string[],
  };
  const ROWS = [
    { ...base, id: 'late', associateId: 'a1', associateName: 'Lena Late', status: 'COMPLETED' as const, clockInAt: at(6, 12), clockOutAt: at(10), shiftStartsAt: at(6), shiftEndsAt: at(10) },
    { ...base, id: 'grace', associateId: 'a2', associateName: 'Gail Grace', status: 'COMPLETED' as const, clockInAt: at(6, 4), clockOutAt: at(10), shiftStartsAt: at(6), shiftEndsAt: at(10) },
    { ...base, id: 'rej', associateId: 'a3', associateName: 'Rex Rejected', status: 'REJECTED' as const, clockInAt: at(6, 30), clockOutAt: at(10), shiftStartsAt: at(6), shiftEndsAt: at(10) },
    { ...base, id: 'forgot', associateId: 'a4', associateName: 'Fran Forgot', status: 'COMPLETED' as const, clockInAt: at(1), clockOutAt: at(5), anomalies: ['FORGOT_CLOCKOUT'] },
    { ...base, id: 'nobreak', associateId: 'a5', associateName: 'Nell NoBreak', status: 'COMPLETED' as const, clockInAt: at(1), clockOutAt: at(5), anomalies: ['NO_BREAK'] },
  ];
  const EXC = {
    missedPunches: { count: 1, oldestAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
    lateToday: { count: 1, dayFrom: '', dayTo: '' },
    overtimeRisk: {
      count: 1,
      thresholdHours: 36,
      weekStart: '2026-06-27',
      weekEnd: '2026-07-03',
      people: [{ associateId: 'a-ot', name: 'Olga Over', photoUrl: null, workedMinutes: 32 * 60, scheduledMinutes: 7 * 60, projectedMinutes: 39 * 60 }],
    },
  };

  beforeEach(() => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: ROWS } as never);
    vi.mocked(getTimeExceptions).mockClear();
    vi.mocked(getTimeExceptions).mockResolvedValue(EXC as never);
  });

  const tile = (name: RegExp) => screen.findByRole('button', { name });

  it('shows the counts the server sent, read for the reader’s today', async () => {
    renderAtPath('/?tab=queue');
    expect(await tile(/missed punches\s*1/i)).toBeInTheDocument();
    expect(await tile(/late today\s*1/i)).toBeInTheDocument();
    expect(await tile(/overtime risk\s*1/i)).toBeInTheDocument();
    const args = vi.mocked(getTimeExceptions).mock.calls.at(-1)![0];
    expect(args.dayFrom).toBe(ymdToIsoStart(today));
    expect(args.dayTo).toBe(ymdToIsoEndExclusive(today));
  });

  it('Missed punches lists the forgotten clock-outs waiting for review, from the oldest', async () => {
    const user = renderAtPath('/?tab=queue');
    await screen.findAllByText('Nell NoBreak');
    const missed = await tile(/missed punches/i);
    await user.click(missed);
    expect(missed).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      const q = vi.mocked(listAdminTimeEntries).mock.calls.at(-1)![0] as { status?: string; from?: string };
      expect(q.status).toBe('COMPLETED');
      expect(q.from).toBe(ymdToIsoStart(localDateStr(new Date(EXC.missedPunches.oldestAt))));
    });
    await waitFor(() => expect(screen.queryByText('Nell NoBreak')).not.toBeInTheDocument());
    expect(screen.getAllByText('Fran Forgot').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /forgot clock-out \(1\)/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Late today lists today’s late punches — past the 5-minute grace, rejected ones aside', async () => {
    const user = renderAtPath('/?tab=queue');
    await screen.findAllByText('Gail Grace');
    await user.click(await tile(/late today/i));
    await waitFor(() => {
      const q = vi.mocked(listAdminTimeEntries).mock.calls.at(-1)![0] as { status?: string; from?: string; to?: string };
      expect(q.status).toBeUndefined();
      expect(q.from).toBe(ymdToIsoStart(today));
      expect(q.to).toBe(ymdToIsoEndExclusive(today));
    });
    await waitFor(() => expect(screen.queryByText('Gail Grace')).not.toBeInTheDocument());
    expect(screen.getAllByText('Lena Late').length).toBeGreaterThan(0);
    expect(screen.queryByText('Rex Rejected')).not.toBeInTheDocument();
    expect(screen.queryByText('Fran Forgot')).not.toBeInTheDocument();

    // The lens says so, and clearing it puts the status back.
    await user.click(screen.getByRole('button', { name: /late arrivals only/i }));
    await waitFor(() => expect((vi.mocked(listAdminTimeEntries).mock.calls.at(-1)![0] as { status?: string }).status).toBe('COMPLETED'));
  });

  it('Overtime risk opens the list of people, and a name opens their week', async () => {
    const user = renderAtPath('/?tab=queue');
    await screen.findAllByText('Gail Grace');
    await user.click(await tile(/overtime risk/i));
    const panel = await screen.findByTestId('ot-risk-panel');
    expect(within(panel).getByText('Olga Over')).toBeInTheDocument();
    expect(within(panel).getByText(/32h worked · 7h still scheduled/)).toBeInTheDocument();
    expect(within(panel).getByText('39h')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: /olga over/i }));
    expect(await screen.findByText(/olga over — timesheet/i)).toBeInTheDocument();
    await waitFor(() => expect((vi.mocked(listAdminTimeEntries).mock.calls.at(-1)![0] as { associateId?: string }).associateId).toBe('a-ot'));
  });

  it('the bulk bar shows only once something is selected', async () => {
    const user = renderAtPath('/?tab=queue');
    await screen.findAllByText('Gail Grace');
    expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /select clean \(2\)/i }));
    const bar = await screen.findByTestId('bulk-bar');
    expect(bar.textContent).toMatch(/^2 selected/);
    expect(within(bar).getByRole('button', { name: /approve 2/i })).toBeInTheDocument();
  });
});
