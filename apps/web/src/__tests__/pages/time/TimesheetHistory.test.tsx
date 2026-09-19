import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TimesheetDay, TimesheetHistoryResponse, TimesheetHistoryWeek } from '@alto-people/shared';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { TimesheetHistory } from '@/pages/time/TimesheetHistory';

/**
 * An associate's whole timesheet: who they are to Fieldglass, the totals,
 * a bar per week, each pay period with its weeks as day grids — and a
 * week opened to its times, the buyer's reason, the note, the next step.
 */

function days(weekStart: string, hours: Record<number, number>): TimesheetDay[] {
  return ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((weekday, i) => {
    const d = new Date(`${weekStart}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const h = hours[i] ?? 0;
    return {
      date: d.toISOString().slice(0, 10),
      weekday,
      monthDay: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      timeIn: h ? '10:00 PM' : null,
      timeOut: h ? '6:30 AM' : null,
      breaks: h ? ['2:00 AM – 2:30 AM (30m)'] : [],
      netHours: h,
      shifts: h ? ['Overnight Stocker'] : [],
      overnight: !!h,
    };
  });
}

function wk(weekStart: string, weekEnd: string, total: number, fieldglass: Partial<NonNullable<TimesheetHistoryWeek['fieldglass']>>, over: Partial<TimesheetHistoryWeek> = {}): TimesheetHistoryWeek {
  return {
    weekStart,
    weekEnd,
    weekEnding: `${weekEnd.slice(5, 7)}/${weekEnd.slice(8, 10)}/${weekEnd.slice(0, 4)}`,
    clientId: 'c1',
    clientName: 'Walmart Destin',
    site: '1 - Onsite - FL - Destin',
    days: days(weekStart, { 2: total }),
    total,
    pendingHours: 0,
    inProgress: false,
    dueAt: '2026-09-21T21:00:00.000Z',
    overdue: false,
    fieldglass: {
      registered: true,
      workerId: 'WKR1',
      enteredAt: '2026-09-20T15:00:00Z',
      enteredBy: 'Fin Ance',
      enteredHours: total,
      status: null,
      timesheetId: null,
      revision: null,
      hours: null,
      syncedAt: null,
      comment: null,
      resubmittedAt: null,
      note: null,
      ...fieldglass,
    },
    amount: total * 20,
    ...over,
  };
}

const HISTORY: TimesheetHistoryResponse = {
  associate: {
    id: 'a1',
    name: 'Ann Lee',
    worker: 'Lee, Ann',
    photoUrl: null,
    clientName: 'Walmart Destin',
    position: 'Overnight Stocker',
    workerId: 'WKR1',
    registeredAt: '2026-08-20T15:00:00Z',
    firstClockIn: { date: '2026-08-24', time: '10:04 PM' },
    lastWorked: '2026-09-14',
    securityId: '0302LE321',
  },
  schedule: { name: 'Alto biweekly', frequency: 'BIWEEKLY' },
  periods: [
    {
      periodStart: '2026-09-12',
      periodEnd: '2026-09-25',
      payDate: '2026-10-02',
      weeks: [wk('2026-09-12', '2026-09-18', 8, { status: null, enteredAt: null }, { overdue: true })],
      total: 8,
      pendingHours: 0,
      amount: 160,
    },
    {
      periodStart: '2026-08-29',
      periodEnd: '2026-09-11',
      payDate: '2026-09-18',
      weeks: [
        wk('2026-09-05', '2026-09-11', 6, { status: 'REJECTED', timesheetId: 'WALTTS2', revision: 1, hours: 6, comment: 'Missing Sunday' }),
        wk('2026-08-29', '2026-09-04', 8, { status: 'APPROVED', timesheetId: 'WALTTS1', revision: 0, hours: 8, note: 'Buyer approved late' }),
      ],
      total: 14,
      pendingHours: 0,
      amount: 280,
    },
  ],
  totals: {
    hours: 22,
    weeks: 3,
    avgWeekHours: 7.33,
    year: 2026,
    yearHours: 22,
    pendingHours: 0,
    fieldglass: { approved: 1, awaiting: 0, rejected: 1, toEnter: 1, overdue: 1, notRegistered: 0, variances: 0 },
    money: { approved: 160, awaiting: 0, atRisk: 280 },
  },
  years: [2026],
  truncated: false,
  from: '2023-09-19',
  generatedAt: '2026-09-19T12:00:00Z',
};

function renderPage(history: TimesheetHistoryResponse = HISTORY) {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, method: init?.method, body: init?.body });
    if (path === '/time/admin/timesheets/history/a1') return history as never;
    if (path === '/time/admin/timesheets/note') return { ok: true, note: 'x' } as never;
    if (path === '/time/admin/timesheets/entered') return { ok: true } as never;
    throw new Error(`unexpected ${path}`);
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/time-attendance/timesheets/history/a1']}>
        <Routes>
          <Route path="/time-attendance/timesheets/history/:associateId" element={<TimesheetHistory />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('an associate’s timesheet history', () => {
  it('who they are to Fieldglass, the totals, and every pay period with its weeks', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Ann Lee' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Worker ID: WKR1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Security ID: 0302LE321' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy First clock-in: 08/24/2026 10:04 PM' })).toBeInTheDocument();
    expect(screen.getAllByText('22.00', { selector: 'div' })).toHaveLength(2); // this year, and all time
    expect(screen.getByText('$280.00', { selector: 'div' })).toBeInTheDocument();

    const periods = screen.getAllByRole('heading', { level: 2, name: /Pay period/ });
    expect(periods.map((h) => h.textContent)).toEqual(['Pay period · Sep 12 – Sep 25, 2026', 'Pay period · Aug 29 – Sep 11, 2026']);
    expect(screen.getByText('Pays Fri, Oct 2, 2026')).toBeInTheDocument();
    const [current, previous] = screen.getAllByRole('table');
    expect(within(current!).getByText('Past due')).toBeInTheDocument();
    expect(within(previous!).getByText('Rejected')).toBeInTheDocument();
    expect(within(previous!).getByText('Approved')).toBeInTheDocument();
    expect(within(previous!).getByText('WALTTS2 · rev 1')).toBeInTheDocument();
    expect(within(previous!).getByLabelText('Has a note')).toBeInTheDocument();
    // A bar per week, labeled for the screen reader too.
    expect(screen.getByRole('button', { name: /Week ending 09\/11\/2026 · 6\.00h · Rejected/ })).toBeInTheDocument();
  });

  it('“Needs a look” keeps only the weeks with something to fix', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Ann Lee' });
    await userEvent.click(screen.getByRole('radio', { name: 'Needs a look (2)' }));
    await waitFor(() => expect(screen.queryByText('WALTTS1')).not.toBeInTheDocument());
    expect(screen.getByText('WALTTS2 · rev 1')).toBeInTheDocument();
  });

  it('a week opened: its days, the buyer’s reason, “Mark resubmitted”, and a note that saves', async () => {
    const calls = renderPage();
    await screen.findByRole('heading', { name: 'Ann Lee' });
    await userEvent.click(screen.getByRole('button', { name: 'Week ending 09/11/2026 at Walmart Destin' }));
    expect(await screen.findByText(/The buyer rejected it/)).toHaveTextContent('“Missing Sunday”');
    expect(screen.getByText('10:00 PM → 6:30 AM')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the week/ })).toHaveAttribute('href', '/time-attendance/timesheets?week=2026-09-05&client=c1');

    await userEvent.click(screen.getByRole('button', { name: 'Mark resubmitted' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/time/admin/timesheets/entered')?.body).toEqual({
        weekStart: '2026-09-05T12:00:00.000Z',
        associateId: 'a1',
        clientId: 'c1',
        entered: true,
      }),
    );

    await userEvent.type(screen.getByLabelText('Note'), 'Fixed Sunday, resent');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/time/admin/timesheets/note')).toMatchObject({
        method: 'PUT',
        body: { weekStart: '2026-09-05T12:00:00.000Z', associateId: 'a1', clientId: 'c1', note: 'Fixed Sunday, resent' },
      }),
    );
  });

  it('a store-bound viewer: no money and no Security ID on the page', async () => {
    renderPage({
      ...HISTORY,
      associate: { ...HISTORY.associate, securityId: null },
      totals: { ...HISTORY.totals, money: null },
      periods: HISTORY.periods.map((p) => ({ ...p, amount: null, weeks: p.weeks.map((w) => ({ ...w, amount: null })) })),
    });
    await screen.findByRole('heading', { name: 'Ann Lee' });
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Security ID')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Amount' })).not.toBeInTheDocument();
  });
});
