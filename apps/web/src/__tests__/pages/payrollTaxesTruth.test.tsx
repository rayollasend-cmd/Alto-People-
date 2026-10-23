import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '@/lib/confirm';

/**
 * Payroll taxes (F500 G3, P1): the overview said "You're paid up" and
 * "Every return is filed" while a paid payroll had never posted its taxes.
 * Now that payroll is named at the top with the fix, the empty states say
 * "nothing due yet" instead of "all done", and the tiles link to the list
 * behind them.
 */

const overview = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) => (path.startsWith('/payroll-taxes/overview') ? overview.value : {})),
}));

import { PayrollTaxesDesk, quarterShort } from '@/pages/payrollTaxes/PayrollTaxesDesk';

const BASE = {
  today: '2026-10-22',
  filing: { mode: 'IN_HOUSE', providerLabel: null, penaltyGuarantee: false, environment: null },
  totals: { owedOpen: 0, overdue: 0, dueSoon: 0, failedPayments: 0, openNotices: 0 },
  overdue: [],
  dueSoon: [],
  upcoming: [],
  returns: { previous: { periodLabel: '2026-Q3', items: [] }, current: { periodLabel: '2026-Q4', items: [] } },
  registrations: [],
  noticesDue: [],
  quarter: { periodLabel: '2026-Q4', posted: 0, deposited: 0 },
  hasLiabilities: false,
};

function renderDesk(url = '/payroll/taxes') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[url]}>
          <PayrollTaxesDesk />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* none */
  }
});

describe('payroll taxes overview', () => {
  it('names the paid payroll that never posted its taxes, with the fix — never "paid up"', async () => {
    overview.value = { ...BASE, unposted: { count: 1, amount: 932, runs: [{ id: 'r1', periodStart: '2026-10-03', periodEnd: '2026-10-16', paidOn: '2026-10-16', amount: 932, paychecksMissing: false }] } };
    renderDesk();
    const alert = await screen.findByTestId('unposted-taxes');
    expect(alert).toHaveTextContent('1 paid payroll hasn’t posted its taxes ($932.00)');
    expect(within(alert).getByRole('button', { name: /Post past payrolls/ })).toBeInTheDocument();
    expect(screen.queryByText('You’re paid up')).toBeNull();
    expect(screen.queryByText('Every return is filed')).toBeNull();
    expect(screen.getByText('No deposits due yet')).toBeInTheDocument();
    expect(screen.getByText('No returns due yet')).toBeInTheDocument();
  });

  it('a run with no paid paychecks to post from links to the run instead', async () => {
    overview.value = { ...BASE, unposted: { count: 1, amount: 564.3, runs: [{ id: 'r9', periodStart: '2026-08-29', periodEnd: '2026-09-11', paidOn: '2026-09-18', amount: 564.3, paychecksMissing: true }] } };
    renderDesk();
    const alert = await screen.findByTestId('unposted-taxes');
    expect(within(alert).getByRole('link', { name: 'Open the run' })).toHaveAttribute('href', '/payroll/runs/r9');
    expect(within(alert).queryByRole('button', { name: /Post past payrolls/ })).toBeNull();
  });

  it('with no taxes ever posted and nothing unposted, nothing claims "all filed"', async () => {
    overview.value = { ...BASE, unposted: { count: 0, amount: 0, runs: [] } };
    renderDesk();
    expect(await screen.findByText('No returns due yet')).toBeInTheDocument();
    expect(screen.getByText('No deposits due yet')).toBeInTheDocument();
    expect(screen.queryByTestId('unposted-taxes')).toBeNull();
  });

  it('once taxes are posted and all paid, it is paid up; tiles link to the deposits', async () => {
    overview.value = {
      ...BASE,
      hasLiabilities: true,
      quarter: { periodLabel: '2026-Q4', posted: 932, deposited: 932 },
      upcoming: [{ kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', agency: 'Internal Revenue Service', dueDate: '2026-11-16', amount: 759, liabilities: 1, scheduled: 0, accountId: 'a1' }],
      unposted: { count: 0, amount: 0, runs: [] },
    };
    renderDesk();
    expect(await screen.findByText('You’re paid up')).toBeInTheDocument();
    expect(screen.getByText('Nothing late')).toBeInTheDocument();
    expect(screen.getByText('$932.00 deposited · withheld and employer share')).toBeInTheDocument();
    expect(screen.getByText('$759.00 · Internal Revenue Service')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Late/ })).toHaveAttribute('href', '/payroll/taxes?tab=deposits');
  });

  it('the in-house note folds to one line once read; sibling desks are links, not buttons', async () => {
    overview.value = { ...BASE, unposted: { count: 0, amount: 0, runs: [] } };
    renderDesk();
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));
    expect(screen.getByTestId('in-house-line')).toHaveTextContent('You file and pay these yourself.');
    expect(screen.getByRole('button', { name: 'How this works' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Garnishments' })).toHaveAttribute('href', '/payroll/garnishments');
    expect(screen.queryByRole('button', { name: 'Garnishments' })).toBeNull();
  });

  it('quarterShort', () => {
    expect(quarterShort('2026-Q4')).toBe('Q4 2026');
  });
});
