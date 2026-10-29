import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { ExecFinancials } from '@alto-people/shared';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { ymdLocal } from '@/lib/format';
import { ExecFinancialsPage } from '@/pages/executive/FinancialsPage';
import { agingSlices, budgetStatus, daysPastDue, pastDue, pct1, weeksTrend } from '@/pages/executive/financials/finMath';
import { COMPARISON, PERIOD, execKpi, location, renderAsChairman, routeApi } from './execPagesHarness';

/**
 * The chairman's Financials: the six money measures, billed down to margin,
 * thirteen weeks of billed against cost, cash and its forecast low point,
 * receivables by age with the open statements, payroll cost and profit
 * against budget, and the footnote that says where each number comes from
 * — plus the states a young company shows (no bank, few weeks, no budget).
 */

const dayFromToday = (n: number) => ymdLocal(new Date(Date.now() + n * 86_400_000));

const week = (i: number, billed: number) => ({
  start: `2026-${i < 6 ? '08' : i < 10 ? '09' : '10'}-${String(1 + (i % 4) * 7).padStart(2, '0')}`,
  billed,
  cost: billed * 0.792,
  margin: billed * 0.208,
  marginPct: 20.8,
  hours: billed / 21.21,
  otHours: 2,
});

function fin(over: Partial<ExecFinancials> = {}): ExecFinancials {
  return {
    period: PERIOD,
    comparison: COMPARISON,
    kpis: [
      execKpi({ id: 'revenue', label: 'Revenue', unit: 'money', value: 82189.46, href: '/executive/financials' }),
      execKpi({ id: 'grossMargin', label: 'Gross margin', unit: 'money', value: 17088.9, href: '/executive/financials' }),
      execKpi({ id: 'marginPct', label: 'Margin rate', unit: 'pct', value: 20.79, href: '/executive/financials' }),
      execKpi({ id: 'overtimePct', label: 'Overtime', unit: 'pct', value: 0.27, href: '/executive/people' }),
      execKpi({ id: 'cash', label: 'Cash', unit: 'money', value: 181091.03, href: '/books/bank' }),
      execKpi({ id: 'dso', label: 'Days to collect', unit: 'days', value: 23.1, betterWhen: 'down', href: '/executive/financials' }),
    ],
    waterfall: [
      { key: 'billed', label: 'Billed', amount: 82189.46 },
      { key: 'basePay', label: 'Base pay', amount: 58046.75 },
      { key: 'overtimePremium', label: 'Overtime premium', amount: 78.75 },
      { key: 'burden', label: 'Employer burden', amount: 6975.06 },
      { key: 'overhead', label: 'Overhead', amount: 0 },
      { key: 'margin', label: 'Margin', amount: 17088.9 },
    ],
    weeks: Array.from({ length: 13 }, (_, i) => week(i, 18000 + i * 400)),
    cash: {
      today: 181091.03,
      accounts: 2,
      minimum: 150000,
      forecast: Array.from({ length: 13 }, (_, i) => ({ weekStart: `2026-1${i < 5 ? '0' : i < 9 ? '1' : '2'}-${String(1 + (i % 4) * 7).padStart(2, '0')}`, balance: 181000 - i * 3000 })),
      lowPoint: { weekStart: '2026-12-22', balance: 145000, belowMinimum: true },
    },
    receivables: {
      total: 23760.63,
      buckets: { current: 14000, days1to30: 5200, days31to60: 0, days61to90: 2100, over90: 2460.63 },
      open: [
        { statementId: 's1', clientName: 'Coastal Resort Holdings', number: 'No. 1093', amount: 18143.85, dueOn: dayFromToday(-12), ageDays: 12 },
        { statementId: 's2', clientName: 'Seaside Hospitality Group', number: 'No. 1094', amount: 5616.78, dueOn: dayFromToday(10), ageDays: -10 },
      ],
      dsoByMonth: [
        { month: '2026-05', days: 31 },
        { month: '2026-06', days: 28 },
        { month: '2026-07', days: null },
        { month: '2026-08', days: 30 },
        { month: '2026-09', days: 26 },
        { month: '2026-10', days: 23 },
      ],
    },
    payrollRuns: Array.from({ length: 5 }, (_, i) => ({
      runId: `r${i}`,
      periodStart: `2026-0${7 + Math.floor(i / 2)}-${i % 2 ? '15' : '01'}`,
      periodEnd: `2026-0${7 + Math.floor(i / 2)}-${i % 2 ? '28' : '14'}`,
      people: 34 + i,
      gross: 32000 + i * 100,
      employerTaxes: 3500,
      cost: 35500 + i * 100,
    })),
    profit: { month: '2026-10', mtdNetIncome: 57083.63, ytd: { actual: 412000, budget: 430000, variance: -18000 }, budgetName: 'FY2026 operating plan' },
    rates: { billRate: 21.21, payRate: 15, burdenPct: 12, overheadPerHour: 0 },
    ...over,
  };
}

function show(data: ExecFinancials | Error, route = '/executive/financials') {
  vi.mocked(apiFetch).mockImplementation(
    routeApi({
      '/executive/financials': () => {
        if (data instanceof Error) throw data;
        return data;
      },
    }) as typeof apiFetch,
  );
  return renderAsChairman(<ExecFinancialsPage />, { route });
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the Financials page', () => {
  it('asks for the frame in the URL and shows every section from one response', async () => {
    show(fin(), '/executive/financials?period=month&compare=plan');
    expect(await screen.findByTestId('exec-fin-kpis')).toBeInTheDocument();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/executive/financials?period=month&compare=plan');
    for (const id of ['revenue', 'grossMargin', 'marginPct', 'overtimePct', 'cash', 'dso']) expect(screen.getByTestId(`exec-kpi-${id}`)).toBeInTheDocument();
    // A drill-down on the executive pages keeps the frame; anything else opens as it is.
    expect(screen.getByTestId('exec-kpi-revenue')).toHaveAttribute('href', '/executive/financials?period=month&compare=plan');
    expect(screen.getByTestId('exec-kpi-cash')).toHaveAttribute('href', '/books/bank');
    expect(screen.getByTestId('exec-board-pack-link')).toHaveAttribute('href', '/executive/board-packs?period=month&compare=plan');

    for (const name of ['Where the money goes', 'Cash', 'Receivables', 'Payroll cost and profit']) expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    // The waterfall says itself, rounded; the table behind it is exact.
    expect(screen.getAllByText('Of $82.2k billed, the work cost $65.1k, leaving $17.1k margin — 20.8% of billed. The biggest cost is Base pay: $58.0k, 70.6% of billed.').length).toBeGreaterThan(0);
    const wfTable = screen.getByRole('table', { name: 'Billed to margin' });
    expect(within(wfTable).getByText('−$58,046.75')).toBeInTheDocument();
    expect(within(wfTable).getByText('$82,189.46')).toBeInTheDocument();
    // Thirteen weeks in words.
    expect(screen.getAllByText(/Billed averaged \$22\.2k a week over the last 4 weeks, up 7\.8% on the 4 before\. The margin rate held at 20\.8%\./).length).toBeGreaterThan(0);
  });

  it('shows cash today, the minimum and the low point — in a sentence, with its status in words', async () => {
    show(fin());
    expect(await screen.findByTestId('exec-fin-cash-today')).toHaveTextContent('$181k');
    expect(screen.getByTestId('exec-fin-cash-today')).toHaveTextContent('in 2 bank accounts');
    expect(screen.getByTestId('exec-fin-cash-low')).toHaveTextContent('$145kweek of Dec 22Below the minimum');
    expect(screen.getAllByText('The forecast runs lowest in the week of Dec 22, at $145k — $5.00k below the minimum.').length).toBeGreaterThan(0);
  });

  it('splits receivables by age without colouring an empty bucket, and says how late each statement is', async () => {
    show(fin());
    const bar = await screen.findByTestId('exec-fin-aging-bar');
    expect([...bar.querySelectorAll('[data-bucket]')].map((e) => (e as HTMLElement).dataset.bucket)).toEqual(['current', 'days1to30', 'days61to90', 'over90']);
    const aging = screen.getByTestId('exec-fin-aging');
    expect(aging).toHaveTextContent('$9.76k past due — 41.1% of it');
    expect(aging).toHaveTextContent('31–60 days late$0');
    const grid = screen.getByRole('table', { name: 'Open statements' });
    expect(within(grid).getByText('12 days overdue')).toBeInTheDocument();
    expect(within(grid).getByText('Not yet due')).toBeInTheDocument();
    expect(within(grid).getByText('$18,143.85')).toBeInTheDocument();
  });

  it('shows profit against the budget, and the footnote with the rates', async () => {
    show(fin());
    const profit = await screen.findByTestId('exec-fin-profit');
    expect(profit).toHaveTextContent('October 2026 to date$57.1k');
    expect(profit).toHaveTextContent('$412kbudget $430k');
    expect(profit).toHaveTextContent('$18.0k behind budget');
    expect(profit).toHaveTextContent('From FY2026 operating plan');
    expect(screen.getByTestId('exec-fin-footnote')).toHaveTextContent('$21.21 an hour billed, $15.00 an hour paid and 12% employer burden; no overhead is set.');
  });

  it('a young company: no bank, two weeks, two runs, one month paid, no budget — each said honestly', async () => {
    show(
      fin({
        cash: null,
        weeks: [week(0, 0), week(11, 21000), week(12, 22600)],
        payrollRuns: fin().payrollRuns.slice(0, 2),
        receivables: { ...fin().receivables, dsoByMonth: [{ month: '2026-09', days: null }, { month: '2026-10', days: 23 }] },
        profit: { month: '2026-10', mtdNetIncome: 1200, ytd: null, budgetName: null },
      }),
    );
    expect(await screen.findByText('Connect the bank in Books to see cash')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open bank accounts' })).toHaveAttribute('href', '/books/bank');
    const sparse = screen.getAllByTestId('trend-sparse');
    // Thirteen weeks, days to collect and payroll cost: each a number and a sentence.
    expect(sparse).toHaveLength(3);
    expect(sparse.map((s) => s.textContent).join(' | ')).toMatch(/the latest of 2 complete weeks on record/);
    // Days to collect is DSO (open AR over 90 days' billing), so the months it can read are the
    // months with finalized statements — not "payments", which is Books' Average days to pay (MONEY-8).
    expect(screen.getByText('October 2026 is the first month with statements on record.')).toBeInTheDocument();
    expect(screen.getByText(/the latest of 2 runs on record — the chart draws from four\./)).toBeInTheDocument();
    expect(screen.getByText('No budget for this year')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open budgets' })).toHaveAttribute('href', '/books/budgets');
  });

  it('nothing billed and nothing open: the waterfall and receivables say so', async () => {
    show(fin({ waterfall: fin().waterfall.map((s) => ({ ...s, amount: 0 })), receivables: { total: 0, buckets: { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 }, open: [], dsoByMonth: [] }, profit: null }));
    expect((await screen.findAllByText('No billed hours in this period yet.')).length).toBeGreaterThan(0);
    expect(screen.getByText('Nothing open — every finalized statement is paid.')).toBeInTheDocument();
    expect(screen.getByText('No open statements')).toBeInTheDocument();
    expect(screen.getByText('No books posted yet')).toBeInTheDocument();
  });

  it('a company that bills no one sees no receivables and no client words', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/financials': fin() }) as typeof apiFetch);
    renderAsChairman(<ExecFinancialsPage />, { route: '/executive/financials', off: ['clientPortal', 'billRates'] });
    expect(await screen.findByTestId('exec-fin-kpis')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Receivables' })).toBeNull();
    expect(screen.getByTestId('exec-fin-footnote')).toHaveTextContent('Cash and profit come from the books; payroll cost from completed runs.');
  });

  it('shows a skeleton while loading and a retry when it fails', async () => {
    vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderAsChairman(<ExecFinancialsPage />, { route: '/executive/financials' });
    expect(screen.getByTestId('exec-financials-loading')).toBeInTheDocument();
    unmount();
    show(new Error('boom'));
    expect(await screen.findByText(/Couldn’t load the financials\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
    expect(location()).toBe('/executive/financials');
  });
});

describe('the financials arithmetic', () => {
  it('writes percentages with a real minus sign and never −0.0%', () => {
    expect(pct1(20.79)).toBe('20.8%');
    expect(pct1(-1)).toBe('−1.0%');
    expect(pct1(-0.01)).toBe('0.0%');
    expect(pct1(null)).toBe('—');
  });

  it('counts days past due from the calendar, not the clock', () => {
    expect(daysPastDue('2026-10-15', '2026-10-27')).toBe(12);
    expect(daysPastDue('2026-11-06', '2026-10-27')).toBe(-10);
    expect(daysPastDue('2026-03-08', '2026-03-09')).toBe(1);
  });

  it('splits the aging buckets and totals what is late', () => {
    const b = { current: 50, days1to30: 25, days31to60: 0, days61to90: 25, over90: 0 };
    expect(agingSlices(b).map((s) => [s.key, s.pct])).toEqual([
      ['current', 50],
      ['days1to30', 25],
      ['days31to60', 0],
      ['days61to90', 25],
      ['over90', 0],
    ]);
    expect(pastDue(b)).toBe(50);
  });

  it('compares the last four weeks with the four before, or halves a shorter record', () => {
    const w = (billed: number, marginPct: number) => ({ start: '2026-10-01', billed, cost: 1, margin: 1, marginPct, hours: 1, otHours: 0 });
    const t = weeksTrend([w(10, 18), w(10, 19), w(10, 19), w(10, 19), w(12, 20), w(12, 20), w(12, 20), w(12, 21)])!;
    expect(t.n).toBe(4);
    expect(t.change).toBeCloseTo(0.2);
    expect([t.marginFrom, t.marginTo]).toEqual([18, 21]);
    expect(weeksTrend([w(10, 18), w(0, 0), w(15, 19)])!.n).toBe(1);
    expect(weeksTrend([w(10, 18)])).toBeNull();
  });

  it('judges profit against budget like any measure', () => {
    expect(budgetStatus(430, 430)).toBe('good');
    expect(budgetStatus(412, 430)).toBe('watch');
    expect(budgetStatus(300, 430)).toBe('bad');
    expect(budgetStatus(10, 0)).toBe('none');
  });
});
