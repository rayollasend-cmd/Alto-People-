import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderAs } from './hrPack/harness';

/**
 * Payroll banking when payouts are stuck (F500 G3, P1): the payroll home's
 * "Payouts failing → Fix in Payroll banking" used to land on a raw "HTTP 401:
 * Invalid token" with no action. Now it says what happened in plain words
 * and how to fix it; it opens on a tab with something in it when payroll
 * pays through the platform's provider; and the page says one thing about
 * how pay goes out.
 */

let routes: Record<string, unknown> = {};
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) => {
    const hit = Object.keys(routes).find((k) => path.startsWith(k));
    return hit ? routes[hit] : {};
  }),
}));

import { PayrollBankingPage, railName } from '@/pages/payrollBanking/PayrollBankingPage';
import { isSignInFailure } from '@/pages/payroll/WebhookHealthTile';

const PLATFORM_PROFILE = { id: 'p1', bankRail: 'PLATFORM', settlement: 'PREFUND', requirePrenote: true, gaps: [], kybStatus: 'APPROVED', immediateDestinationName: null, fundingAccountId: null, achSpeed: 'NEXT_DAY', submitCutoffEt: '16:00' };
const SUMMARY = { profile: PLATFORM_PROFILE, connection: null, accounts: [], runs: [], openReturns: 0, sameDayWindows: [] };
const WISE_401 = {
  provider: 'WISE',
  health: 'erroring',
  detail: 'Payments go out from your own Wise balance, but the connection is failing: Wise refused the token (HTTP 401): Invalid token.',
  lastEventAt: '2026-10-15T01:48:34.398Z',
  minutesSinceLastEvent: 11175,
  eventsLast24h: 0,
  errorsLast7d: 1,
  pendingFinalizedItems: 3,
  latestError: { at: '2026-10-17T18:48:34.398Z', eventType: 'connection', notes: 'Wise refused the token (HTTP 401): Invalid token' },
};
const DEPOSITS = { counts: { cleared: 0, sent: 0, returned: 0, due: 0, unverified: 0, split: 0 }, accounts: [] };

beforeEach(() => {
  routes = {
    '/payroll-banking/summary': SUMMARY,
    '/payroll-banking/deposits': DEPOSITS,
    '/payroll/disbursement/webhook-status': WISE_401,
  };
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
});

describe('payouts stuck', () => {
  it('an admin reads what happened in plain words and gets a Reconnect action — no raw HTTP error', async () => {
    renderAs('HR_ADMINISTRATOR', <PayrollBankingPage />, '/payroll/banking');
    const card = await screen.findByTestId('payouts-down');
    expect(card).toHaveTextContent('Payouts can’t go out');
    expect(card).toHaveTextContent('Wise rejected our sign-in on Oct 17, 2026. Payouts can’t go out until someone reconnects it.');
    expect(card).toHaveTextContent('3 paychecks are waiting to pay out.');
    expect(within(card).getByRole('link', { name: 'Reconnect Wise' })).toHaveAttribute('href', '/integrations');
    expect(screen.queryByText(/HTTP 401/)).toBeNull();
    expect(screen.queryByText(/event\(s\)|error\(s\)|item\(s\)/)).toBeNull();
  });

  it('finance, who can’t manage integrations, is told who can — never a link that 403s', async () => {
    renderAs('FINANCE_ACCOUNTANT', <PayrollBankingPage />, '/payroll/banking');
    const card = await screen.findByTestId('payouts-down');
    expect(card).toHaveTextContent('Ask an administrator to reconnect Wise in Settings & trust › Integrations.');
    expect(within(card).queryByRole('link')).toBeNull();
  });

  it('tells a sign-in failure from an outage', () => {
    expect(isSignInFailure('Wise refused the token (HTTP 401): Invalid token')).toBe(true);
    expect(isSignInFailure('Upstream timed out after 30s')).toBe(false);
    expect(isSignInFailure(null)).toBe(false);
  });
});

describe('on the platform’s payout provider', () => {
  it('opens on Direct deposit, not an empty Funding tab; ?tab= still wins', async () => {
    renderAs('FINANCE_ACCOUNTANT', <PayrollBankingPage />, '/payroll/banking');
    expect(await screen.findByRole('tab', { name: 'Direct deposit', selected: true })).toBeInTheDocument();
    expect(screen.queryByText('Nothing to fund here')).toBeNull();
  });

  it('a ?tab=funding link still opens Funding', async () => {
    renderAs('FINANCE_ACCOUNTANT', <PayrollBankingPage />, '/payroll/banking?tab=funding');
    expect(await screen.findByRole('tab', { name: 'Funding', selected: true })).toBeInTheDocument();
  });

  it('names the provider once, and the note moves into Setup once read', async () => {
    renderAs('FINANCE_ACCOUNTANT', <PayrollBankingPage />, '/payroll/banking');
    expect(await screen.findByText('Bank-account pay goes out through Wise')).toBeInTheDocument();
    // The provider's own sentence ("your own Wise balance") isn't a second, different story on this page.
    expect(screen.queryByText(/your own Wise balance/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText('Bank-account pay goes out through Wise')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Setup' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    expect(await screen.findByText('Bank-account pay goes out through Wise')).toBeInTheDocument();
  });

  it('railName says which way pay goes out', () => {
    expect(railName('PLATFORM', 'WISE')).toBe('Wise');
    expect(railName('PLATFORM', 'STUB')).toBe('the platform’s payout provider');
    expect(railName('ACH', null)).toBe('your own ACH');
  });
});
