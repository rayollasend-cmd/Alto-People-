import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClientPerformanceResponse } from '@alto-people/shared';

const auth = vi.hoisted(() => ({ caps: new Set<string>() }));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ user: { id: 'u1' }, can: (c: string) => auth.caps.has(c) }),
  useTerm: () => (k: string) => (k === 'label.store' ? 'Store' : k === 'label.client' ? 'Client' : k),
}));
vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  storeTrends: vi.fn(async () => ({
    bestMarginPerHour: 6,
    stores: [
      { clientId: 'c1', locationId: 'l1', locationName: 'Front Beach', clientName: 'Coastal', hours4w: 300, avgMarginPerHour: 5, weeks: [{ start: '2026-09-21', hours: 100, marginPerHour: 4 }, { start: '2026-09-28', hours: 200, marginPerHour: 5.5 }] },
      { clientId: 'c1', locationId: 'l2', locationName: 'Bay Side', clientName: 'Coastal', hours4w: 100, avgMarginPerHour: 2, weeks: [{ start: '2026-09-21', hours: 50, marginPerHour: 2 }, { start: '2026-09-28', hours: 50, marginPerHour: null }] },
    ],
  })),
}));
const api = vi.hoisted(() => ({ getClientPerformance: vi.fn() }));
vi.mock('@/lib/clientsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/clientsApi')>()), ...api }));

import { ClientPerformance, rollUpWeeks } from '@/pages/clients/ClientPerformance';

const week = (start: string, hours: number, overtimeHours: number, shifts: number, filled: number) => ({
  start,
  hours,
  overtimeHours,
  overtimePct: hours > 0 ? Math.round((overtimeHours / hours) * 1000) / 10 : null,
  shifts,
  filled,
  fillRatePct: shifts > 0 ? Math.round((filled / shifts) * 1000) / 10 : null,
});
const WEEKS = [
  ...['2026-07-25', '2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29', '2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26'].map((d) => week(d, 0, 0, 0, 0)),
  week('2026-10-03', 120, 0, 20, 19),
  week('2026-10-10', 210, 12.5, 30, 24),
];
const PERF: ClientPerformanceResponse = {
  clientId: 'c1',
  asOf: '2026-10-22T18:00:00.000Z',
  weekStartsOn: 6,
  timezone: 'America/New_York',
  weeks: WEEKS,
  canSeeMoney: true,
  statements: [
    { id: 's1', number: 7, periodStart: '2026-09-27', periodEnd: '2026-10-03', amount: 3000, hours: 120, open: 0, state: 'paid', dueOn: '2026-10-10', daysPastDue: null },
    { id: 's2', number: 8, periodStart: '2026-10-04', periodEnd: '2026-10-10', amount: 5000, hours: 210, open: 5000, state: 'waiting', dueOn: '2026-10-17', daysPastDue: 5 },
    { id: 's3', number: null, periodStart: '2026-10-11', periodEnd: '2026-10-17', amount: 640, hours: 16, open: 0, state: 'draft', dueOn: null, daysPastDue: null },
  ],
  nps: [
    { quarter: '2026-Q2', nps: 20, responses: 3 },
    { quarter: '2026-Q3', nps: 40, responses: 4 },
  ],
};

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  auth.caps = new Set(['view:clients', 'process:payroll', 'view:executive', 'manage:scheduling']);
  api.getClientPerformance.mockResolvedValue(PERF);
});

describe('a client’s Performance tab', () => {
  it('rolls locations up by week, weighting margin by hours', () => {
    expect(
      rollUpWeeks([
        { clientId: 'c', locationId: 'a', locationName: 'A', clientName: 'C', hours4w: 0, avgMarginPerHour: null, weeks: [{ start: '2026-09-21', hours: 30, marginPerHour: 4 }] },
        { clientId: 'c', locationId: 'b', locationName: 'B', clientName: 'C', hours4w: 0, avgMarginPerHour: null, weeks: [{ start: '2026-09-21', hours: 10, marginPerHour: 8 }] },
      ]),
    ).toEqual([{ start: '2026-09-21', hours: 40, marginPerHour: 5 }]);
  });

  it('draws 12 weeks of hours with their overtime, fill rate and overtime % by week, each with its dated table', async () => {
    wrap(<ClientPerformance clientId="c1" />);
    const hours = await screen.findByRole('table', { name: 'Hours, week by week' });
    const rows = within(hours).getAllByRole('row');
    expect(rows).toHaveLength(13);
    expect(rows[12]).toHaveTextContent('Oct 10, 2026');
    expect(rows[12]).toHaveTextContent('210');
    expect(rows[12]).toHaveTextContent('12.5');
    expect(rows[12]).toHaveTextContent('6%');
    expect(screen.getByRole('img', { name: /330 hours over 12 weeks, 13 of them overtime/ })).toBeInTheDocument();
    const fill = screen.getByRole('table', { name: 'Fill rate, week by week' });
    expect(within(fill).getByRole('row', { name: /Oct 10, 2026/ })).toHaveTextContent('80%');
    expect(within(fill).getByRole('row', { name: /Aug 1, 2026/ })).toHaveTextContent('—');
    expect(screen.getByRole('img', { name: /43 of 50 shifts filled over 12 weeks \(86%\)/ })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Overtime, week by week' })).toBeInTheDocument();
  });

  it('puts each statement on the day its period ends, paid, past due or draft', async () => {
    wrap(<ClientPerformance clientId="c1" />);
    const billed = await screen.findByRole('table', { name: 'Billed by statement' });
    expect(within(billed).getByRole('row', { name: /#7/ })).toHaveTextContent('Oct 3, 2026');
    expect(within(billed).getByRole('row', { name: /#7/ })).toHaveTextContent('Paid');
    expect(within(billed).getByRole('row', { name: /#8/ })).toHaveTextContent('Waiting · 5 days late');
    expect(within(billed).getByRole('row', { name: /Draft/ })).toHaveTextContent('$640.00');
    expect(screen.getByRole('img', { name: /3 statements, \$8,640.00 billed in all; \$5,000.00 still waiting on payment/ })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'NPS by quarter' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Margin per hour, week by week' })).toBeInTheDocument();
    expect(screen.getByText('Bay Side')).toBeInTheDocument();
  });

  it('shows no money and no NPS to someone the API gave none, and says plainly when there are no hours or shifts', async () => {
    auth.caps = new Set(['view:clients']);
    api.getClientPerformance.mockResolvedValue({ ...PERF, canSeeMoney: false, statements: undefined, nps: undefined, weeks: WEEKS.map((w) => ({ ...w, hours: 0, overtimeHours: 0, overtimePct: null, shifts: 0, filled: 0, fillRatePct: null })) });
    wrap(<ClientPerformance clientId="c1" />);
    expect(await screen.findByText('Nobody has clocked hours here in the last 12 weeks.')).toBeInTheDocument();
    expect(screen.getAllByText('No hours yet')).toHaveLength(2);
    expect(screen.getByText('No shifts to fill')).toBeInTheDocument();
    expect(screen.queryByText('Billed by statement')).toBeNull();
    expect(screen.queryByText('NPS by quarter')).toBeNull();
    expect(screen.queryByText(/Margin per hour/)).toBeNull();
  });
});
