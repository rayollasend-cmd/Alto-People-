import { describe, expect, it, vi, beforeEach } from 'vitest';
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
  exportTimeEntries,
  getActiveDashboard,
  listAdminTimeEntries,
  listPayPeriods,
} from '@/lib/timeApi';
import { listDirectory } from '@/lib/directoryApi';
import { listSchedulingAssociates, listShifts } from '@/lib/schedulingApi';
import { AdminTimeView, __resetPayPeriodsCacheForTests } from '@/pages/time/AdminTimeView';
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

function renderQueueTab() {
  // Fresh client per render — the view's dialogs read the shared
  // ['clients','list'] key via useClients(), and a leaked cache would
  // couple tests.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={AUTH_VALUE}>
        <MemoryRouter>
          <AdminTimeView canManage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  // The status filter persists; a leaked value would change which chips render.
  localStorage.clear();
  // Pay periods are module-cached in the component; reset so each test's
  // mock actually takes effect.
  __resetPayPeriodsCacheForTests();
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
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    const select = await screen.findByLabelText(/pay period/i);
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual([
      'Custom range',
      'Jun 29 – Jul 5 · current',
      'Jun 22 – Jun 28 · paid',
    ]);
  });

  it('choosing a period drives the From/To dates and refetches', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    const select = await screen.findByLabelText(/pay period/i);
    const callsBefore = vi.mocked(listAdminTimeEntries).mock.calls.length;
    await user.selectOptions(select, '2026-06-22|2026-06-28');

    expect(screen.getByDisplayValue('2026-06-22')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-06-28')).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(listAdminTimeEntries).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it('hand-editing a date drops back to Custom range', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    const select = await screen.findByLabelText<HTMLSelectElement>(/pay period/i);
    await user.selectOptions(select, '2026-06-22|2026-06-28');
    expect(select.value).toBe('2026-06-22|2026-06-28');

    fireEvent.change(screen.getByDisplayValue('2026-06-22'), {
      target: { value: '2026-06-20' },
    });
    expect(select.value).toBe('');
    expect(screen.getByDisplayValue('2026-06-20')).toBeInTheDocument();
    // The chosen dates stay — dropping to custom must not reset the range.
    expect(screen.getByDisplayValue('2026-06-28')).toBeInTheDocument();
  });

  it('hides the picker when no periods exist (no schedule, no runs)', async () => {
    vi.mocked(listPayPeriods).mockResolvedValue({ periods: [] });
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    await screen.findByRole('button', { name: /anomalies only/i }); // filter row rendered
    expect(screen.queryByLabelText(/pay period/i)).not.toBeInTheDocument();
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
  async function pickMaria(user: ReturnType<typeof renderQueueTab>) {
    vi.mocked(listDirectory).mockResolvedValue({
      associates: [{ id: 'a-maria', firstName: 'Maria', lastName: 'Lopez' }],
    } as never);
    await user.type(
      await screen.findByPlaceholderText(/all associates/i),
      'mar',
    );
    await user.click(await screen.findByRole('button', { name: 'Maria Lopez' }));
  }

  it('scopes the CSV to the picked associate', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));
    await pickMaria(user);

    await user.click(screen.getByRole('button', { name: /^csv$/i }));

    await waitFor(() => expect(exportTimeEntries).toHaveBeenCalled());
    const [format, body] = vi.mocked(exportTimeEntries).mock.calls.at(-1)!;
    expect(format).toBe('csv');
    expect(body.associateId).toBe('a-maria');
  });

  it('carries the free-text search into the download', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    await user.type(screen.getByPlaceholderText(/associate name/i), 'lopez');
    // The queue debounces the term at 300ms; the export must send the same
    // applied value, not the raw keystrokes.
    await waitFor(() =>
      expect(
        vi.mocked(listAdminTimeEntries).mock.calls.at(-1)?.[0],
      ).toMatchObject({ search: 'lopez' }),
    );

    await user.click(screen.getByRole('button', { name: /^csv$/i }));

    await waitFor(() => expect(exportTimeEntries).toHaveBeenCalled());
    expect(vi.mocked(exportTimeEntries).mock.calls.at(-1)![1].search).toBe('lopez');
  });

  it('carries the anomalies-only toggle into the download', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    await user.click(screen.getByRole('button', { name: /anomalies only/i }));
    await user.click(screen.getByRole('button', { name: /^csv$/i }));

    await waitFor(() => expect(exportTimeEntries).toHaveBeenCalled());
    expect(
      vi.mocked(exportTimeEntries).mock.calls.at(-1)![1].anomaliesOnly,
    ).toBe(true);
  });

  it('sends no person filter when nothing is narrowed', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    await user.click(screen.getByRole('button', { name: /^csv$/i }));

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
    await user.click(screen.getByRole('button', { name: /^csv$/i }));

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
