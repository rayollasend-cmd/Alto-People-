import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role, type TimesheetRow, type TimesheetWeekResponse } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { TimesheetsView } from '@/pages/time/TimesheetsView';
import { FinanceDashboard } from '@/pages/FinanceDashboard';

/**
 * The Fieldglass desk: the week's deadline, entry progress and money;
 * each worker's Fieldglass status with an "entered" tick; enter mode, one
 * worker at a time with every value one tap to copy; the buyer's list
 * imported back; and the registration packet with the Worker ID.
 */

function renderAs(role: Role, ui: React.ReactElement) {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'fin@altohr.com', role, status: 'ACTIVE' as const, clientId: null, associateId: null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const fg = (over: Partial<NonNullable<TimesheetRow['fieldglass']>> = {}): NonNullable<TimesheetRow['fieldglass']> => ({
  registered: true,
  workerId: null,
  enteredAt: null,
  enteredBy: null,
  enteredHours: null,
  status: null,
  timesheetId: null,
  revision: null,
  hours: null,
  syncedAt: null,
  ...over,
});

const row = (associateId: string, worker: string, total: number, fieldglass: TimesheetRow['fieldglass']): TimesheetRow => ({
  associateId,
  clientId: 'c1',
  worker,
  site: '1 - Onsite - FL - Destin',
  st: 0,
  ot: 0,
  dt: 0,
  others: total,
  nb: 0,
  total,
  status: 'READY',
  fieldglass,
});

function week(rows: TimesheetRow[]): TimesheetWeekResponse {
  return {
    weekStart: '2026-09-12',
    weekEndIso: '2026-09-18',
    weekEnding: '09/18/2026',
    rows,
    totalHours: rows.reduce((n, r) => n + r.total, 0),
    pendingCount: 0,
    issues: [],
    scheduleComparison: [],
    filing: null,
    fieldglass: {
      dueAt: new Date(Date.now() + 26 * 3_600_000).toISOString(),
      workers: rows.length,
      entered: rows.filter((r) => r.fieldglass?.enteredAt).length,
      notRegistered: rows.filter((r) => !r.fieldglass?.registered).length,
      submitted: 0,
      approved: rows.filter((r) => r.fieldglass?.status === 'APPROVED').length,
      rejected: 0,
      variances: 1,
      syncedAt: null,
      money: { billRate: 20, approved: 160, awaiting: 0, atRisk: 240 },
    },
    timeZone: 'America/New_York',
    generatedAt: new Date().toISOString(),
  };
}

const detail = {
  associateId: 'a1',
  worker: 'Lee, Ann',
  site: '1 - Onsite - FL - Destin',
  weekStart: '2026-09-12',
  weekEndIso: '2026-09-18',
  weekEnding: '09/18/2026',
  periodLabel: '09/12/2026 to 09/18/2026',
  days: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((weekday, i) => ({
    date: `2026-09-${12 + i}`,
    weekday,
    monthDay: `9/${12 + i}`,
    timeIn: i === 2 ? '10:00 PM' : null,
    timeOut: i === 2 ? '7:00 AM' : null,
    breaks: i === 2 ? ['3:00 AM – 4:00 AM (1h)'] : [],
    netHours: i === 2 ? 8 : 0,
  })),
  totalHours: 8,
  status: 'READY',
  pendingCount: 0,
  rateLabel: 'Standard Hourly Rate /Hr',
  payRate: 15,
  billRate: 20,
  amount: 160,
  timeZone: 'America/New_York',
  generatedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Fieldglass desk on Timesheets', () => {
  it('the week’s deadline, progress and money; each worker’s status; the entered tick', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, body: init?.body });
      if (path === '/time/admin/timesheets') {
        return week([
          row('a1', 'Lee, Ann', 8, fg({ workerId: 'WKR1' })),
          row('a2', 'Ray, Bo', 6, fg({ status: 'APPROVED', timesheetId: 'WALTTS9', hours: 5.5 })),
          row('a3', 'Vega, Cy', 12, fg({ registered: false })),
        ]) as never;
      }
      if (path === '/time/admin/timesheets/entered') return { ok: true } as never;
      if (path === '/clients' || path.startsWith('/clients?')) return { clients: [] } as never;
      throw new Error(`unexpected ${path}`);
    });
    renderAs('FINANCE_ACCOUNTANT', <TimesheetsView />);
    const strip = await screen.findByRole('region', { name: 'Fieldglass' });
    expect(within(strip).getByText(/Due in Fieldglass/)).toBeInTheDocument();
    expect(within(strip).getByText('0 of 2 entered')).toBeInTheDocument();
    expect(within(strip).getByText('1 not in Fieldglass')).toBeInTheDocument();
    expect(within(strip).getByText('$240.00')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('Not in Fieldglass')).toBeInTheDocument();
    expect(within(table).getByText('Approved')).toBeInTheDocument();
    expect(within(table).getByText('Fieldglass 5.50h')).toBeInTheDocument();
    expect(within(table).getByText('WALTTS9')).toBeInTheDocument();
    expect(within(table).getByText('WKR1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Lee, Ann entered in Fieldglass' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/time/admin/timesheets/entered')?.body).toMatchObject({
        associateId: 'a1',
        clientId: 'c1',
        entered: true,
      }),
    );
  });

  it('enter mode: one worker at a time, every value one tap to copy, “Entered — next”', async () => {
    let entered = false;
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/time/admin/timesheets') return week([row('a1', 'Lee, Ann', 8, fg({ workerId: 'WKR1', enteredAt: entered ? new Date().toISOString() : null }))]) as never;
      if (path === '/time/admin/timesheets/associate') return detail as never;
      if (path === '/time/admin/timesheets/entered') {
        entered = true;
        return { ok: true } as never;
      }
      if (path === '/clients' || path.startsWith('/clients?')) return { clients: [] } as never;
      throw new Error(`unexpected ${path}`);
    });
    renderAs('FINANCE_ACCOUNTANT', <TimesheetsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Enter in Fieldglass (1)' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('1 of 1 · week ending 09/18/2026')).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Copy Worker ID: WKR1' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('WKR1');
    expect(await within(drawer).findByRole('button', { name: 'Copy Time in: 10:00 PM' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Copy Meal break: 3:00 AM – 4:00 AM (1h)' })).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Entered — next' }));
    expect(await within(drawer).findByText('All 1 entered.')).toBeInTheDocument();
  });

  it('a rejected week: the buyer’s reason, “Mark resubmitted” — and it’s in enter mode to fix', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, body: init?.body });
      if (path === '/time/admin/timesheets') {
        return week([
          row('a1', 'Lee, Ann', 8, fg({ enteredAt: '2026-09-20T15:00:00Z', status: 'REJECTED', timesheetId: 'WALTTS4', comment: 'Missing Sunday', note: 'Called the buyer' })),
        ]) as never;
      }
      if (path === '/time/admin/timesheets/associate') return detail as never;
      if (path === '/time/admin/timesheets/entered') return { ok: true } as never;
      if (path === '/clients' || path.startsWith('/clients?')) return { clients: [] } as never;
      throw new Error(`unexpected ${path}`);
    });
    renderAs('FINANCE_ACCOUNTANT', <TimesheetsView />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Rejected')).toBeInTheDocument();
    expect(within(table).getByText('“Missing Sunday”')).toBeInTheDocument();
    expect(within(table).getByLabelText('Note: Called the buyer')).toBeInTheDocument();
    // Every timesheet they've had, a tap away.
    expect(within(table).getByRole('link', { name: 'Lee, Ann — every timesheet, across pay periods' })).toHaveAttribute(
      'href',
      '/time-attendance/timesheets/history/a1',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Enter in Fieldglass (1)' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/Rejected by the buyer/)).toHaveTextContent('Missing Sunday');
    expect(within(drawer).getByRole('button', { name: 'Resubmitted — next' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(table).getByRole('button', { name: 'Mark resubmitted' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/time/admin/timesheets/entered')?.body).toMatchObject({ associateId: 'a1', entered: true }),
    );
  });

  it('imports the buyer’s Fieldglass list — the hours that differ, the rows Alto can’t place', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/time/admin/timesheets') return week([row('a1', 'Lee, Ann', 8, fg())]) as never;
      if (path === '/clients' || path.startsWith('/clients?')) return { clients: [] } as never;
      throw new Error(`unexpected ${path}`);
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        weeks: ['2026-09-12'],
        rows: 3,
        matched: 2,
        statuses: { APPROVED: 1, REJECTED: 1 },
        unmatched: [{ worker: 'Nobody, Here', site: null, weekEnd: '2026-09-18', hours: 4, status: 'Submitted' }],
        variances: [{ associateId: 'a2', worker: 'Ray, Bo', weekEnd: '2026-09-18', alto: 6, fieldglass: 5.5 }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAs('FINANCE_ACCOUNTANT', <TimesheetsView />);
    await screen.findByRole('region', { name: 'Fieldglass' });
    const file = new File(['Status,Worker,End,Total'], 'Timesheets.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText('Fieldglass Timesheets list'), file);
    const dialog = await screen.findByRole('dialog', { name: 'Fieldglass list imported' });
    expect(within(dialog).getByText('Matched 2 of 3 timesheets.')).toBeInTheDocument();
    expect(within(dialog).getByText('Alto 6.00h · Fieldglass 5.50h')).toBeInTheDocument();
    expect(within(dialog).getByText('Nobody, Here')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/time/admin/timesheets/fieldglass-import', expect.objectContaining({ method: 'POST' }));
  });
});

describe('registering in Fieldglass, from the finance worklist', () => {
  it('the packet in Fieldglass’s terms, what’s missing first — and “Mark added” keeps the Worker ID', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, body: init?.body });
      if (path === '/finance/overview') {
        return {
          generatedAt: new Date().toISOString(),
          payday: { next: null, inFlight: null, lastDisbursed: null },
          close: { pendingEntries: 0, pendingHours: 0, oldestDay: null, byClient: [] },
          payrollCases: { open: 0, assignedToMe: 0 },
          settlements: { count: 0, total: 0 },
          receivables: { outstandingTotal: 0, outstandingCount: 0, oldestDays: null, avgDaysToPay: null, draftStatements: 0 },
          fieldglassQueue: [
            {
              kind: 'add',
              associateId: 'a1',
              name: 'Ann Lee',
              clientName: 'Walmart Destin',
              fromClientName: null,
              position: 'Overnight Stocker',
              firstShiftAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
              approvedAt: new Date().toISOString(),
              email: 'ann@example.com',
              phone: null,
              hireDate: null,
            },
          ],
          billedVsPaid: null,
        } as never;
      }
      if (path === '/finance/fieldglass/a1/packet') {
        return {
          packet: {
            associateId: 'a1',
            worker: {
              firstName: 'Ann',
              middleInitial: null,
              lastName: 'Lee',
              listName: 'Lee, Ann',
              email: 'ann@example.com',
              phone: '850-555-0100',
              dob: '1994-03-02',
              ssnLast4: '4321',
              travelDocLast4: null,
              securityId: { value: '0302LE321', source: 'ssn', needs: [] },
              address: { line1: '9 Harbor Rd', line2: null, city: 'Destin', state: 'FL', zip: '32541' },
            },
            engagement: {
              clientId: 'c1',
              clientName: 'Walmart Destin',
              site: '1 - Onsite - FL - Destin',
              billRate: 20,
              position: 'Overnight Stocker',
              shift: { label: 'Overnight', start: '10:00 PM', end: '6:30 AM' },
              firstShiftAt: null,
              startDate: '2026-09-22',
              firstClockIn: { at: '2026-09-23T02:04:00Z', date: '2026-09-22', time: '10:04 PM' },
              store: { name: 'Store 1234', address: null },
              siteManager: null,
            },
            screening: { backgroundCheck: { status: 'PASSED', completedAt: '2026-09-01T12:00:00Z' }, drugTest: null, i9: null, eVerify: null },
            registration: null,
            separatedAt: null,
            missing: ['I-9 Section 2'],
          },
        } as never;
      }
      if (path === '/finance/fieldglass/a1/done') return { ok: true } as never;
      return {} as never;
    });
    renderAs('FINANCE_ACCOUNTANT', <FinanceDashboard />);
    await userEvent.click(await screen.findByRole('button', { name: /Ann Lee/ }));
    expect(await screen.findByRole('button', { name: 'Copy Date of birth: 03/02/1994' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Site: 1 - Onsite - FL - Destin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Start date: 09/22/2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Position: Overnight Stocker' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Shift: Overnight · 10:00 PM – 6:30 AM' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy First clock-in: 09/22/2026 10:04 PM' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Security ID: 0302LE321' })).toBeInTheDocument();
    expect(screen.getByText(/Birth MMDD \+ LE \+ last 3 of/)).toHaveTextContent('the SSN');
    // They have an SSN — no travel document to ask for.
    expect(screen.queryByLabelText('Passport / travel doc (last 4)')).not.toBeInTheDocument();
    expect(screen.getByText(/Fieldglass will ask for something not on file yet/)).toHaveTextContent('I-9 Section 2');

    await userEvent.click(screen.getByRole('button', { name: 'Mark added' }));
    const dialog = await screen.findByRole('dialog', { name: 'Added Ann Lee to Fieldglass?' });
    await userEvent.type(within(dialog).getByLabelText('Fieldglass Worker ID'), 'WKR00012345');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark added' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/finance/fieldglass/a1/done')?.body).toEqual({ workerId: 'WKR00012345' }),
    );
  });

  it('no SSN: the last 4 of a passport / travel document, and the Security ID says what it still needs', async () => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (path === '/finance/overview') {
        return {
          generatedAt: new Date().toISOString(),
          payday: { next: null, inFlight: null, lastDisbursed: null },
          close: { pendingEntries: 0, pendingHours: 0, oldestDay: null, byClient: [] },
          payrollCases: { open: 0, assignedToMe: 0 },
          settlements: { count: 0, total: 0 },
          receivables: { outstandingTotal: 0, outstandingCount: 0, oldestDays: null, avgDaysToPay: null, draftStatements: 0 },
          fieldglassQueue: [
            { kind: 'add', associateId: 'a2', name: 'Jo Ng', clientName: 'Walmart Destin', fromClientName: null, position: null, firstShiftAt: null, approvedAt: null, email: 'jo@example.com', phone: null, hireDate: null },
          ],
          billedVsPaid: null,
        } as never;
      }
      if (path === '/finance/fieldglass/a2/packet') {
        return {
          packet: {
            associateId: 'a2',
            worker: {
              firstName: 'Jo', middleInitial: null, lastName: 'Ng', listName: 'Ng, Jo', email: 'jo@example.com', phone: null,
              dob: '1999-07-04', ssnLast4: null, travelDocLast4: null,
              securityId: { value: null, source: null, needs: ['Last 4 of SSN — or of a passport / travel document'] },
              address: null,
            },
            engagement: { clientId: 'c1', clientName: 'Walmart Destin', site: null, billRate: null, position: null, shift: null, firstShiftAt: null, startDate: null, firstClockIn: null, store: null, siteManager: null },
            screening: { backgroundCheck: null, drugTest: null, i9: null, eVerify: null },
            registration: null,
            separatedAt: null,
            missing: ['Last 4 of SSN — or of a passport / travel document'],
          },
        } as never;
      }
      if (path === '/finance/fieldglass/a2/travel-doc') return { ok: true } as never;
      return {} as never;
    });
    renderAs('FINANCE_ACCOUNTANT', <FinanceDashboard />);
    await userEvent.click(await screen.findByRole('button', { name: /Jo Ng/ }));
    expect(await screen.findByText(/Needs last 4 of ssn/i)).toBeInTheDocument();
    const field = screen.getByLabelText('Passport / travel doc (last 4)');
    await userEvent.type(field, 'ab');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(field);
    await userEvent.type(field, 'x987');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/finance/fieldglass/a2/travel-doc')).toMatchObject({ method: 'PATCH', body: { last4: 'X987' } }),
    );
  });
});
