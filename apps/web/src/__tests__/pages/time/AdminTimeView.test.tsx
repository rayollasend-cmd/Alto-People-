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
    expect(screen.getByText(/total 8h 30m/i)).toBeInTheDocument();

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
    expect(screen.getByText(/paid 8h 00m/i)).toBeInTheDocument();

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
    expect(screen.getByText(/total 8h 00m/i)).toBeInTheDocument();

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
    expect(screen.getByText(/total 8h 30m/i)).toBeInTheDocument();
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
