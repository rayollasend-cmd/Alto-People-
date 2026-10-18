import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'vitest-axe';
import { ConfirmProvider } from '@/lib/confirm';
import { etDeadline, fundingSentence, shortDay, type Funding } from '@/lib/bankingApi';
import { routingLooksValid } from '@/pages/payrollBanking/AccountsTab';

/**
 * Payroll banking: the funding sentence names the amount, the Eastern
 * deadline and the pay day; the page shows what's left to set up, the runs
 * to fund and the account payroll pulls from. Axe-clean.
 */

const profile = {
  id: 'p1',
  bankRail: 'ACH',
  achSpeed: 'NEXT_DAY',
  submitCutoffEt: '16:00',
  companyName: 'ALTO HR',
  companyId: '1234567890',
  companyEntryDescription: 'PAYROLL',
  immediateDestination: '091000019',
  immediateDestinationName: 'WELLS FARGO',
  immediateOrigin: '1234567890',
  immediateOriginName: 'ALTO HR',
  originatingDfi: '09100001',
  kybStatus: 'APPROVED',
  kybCheckedAt: null,
  kybNote: null,
  perRunLimitCents: null,
  perDayLimitCents: null,
  requirePrenote: true,
  collectTaxes: false,
  collectGarnishments: false,
  fundingAccountId: 'acct1',
  gaps: [] as string[],
};

const funding: Funding = {
  id: null,
  payrollRunId: 'run1',
  status: 'NOT_STARTED',
  amountCents: 4_821_055,
  breakdown: { netPayCents: 4_821_055, achPeople: 61, otherRailNetCents: 0, taxesCents: 0, garnishmentsCents: 0, feesCents: 0 },
  payDate: '2026-10-16',
  debitEffectiveDate: '2026-10-14',
  fundingDeadline: '2099-10-13T20:00:00.000Z',
  achSpeed: 'NEXT_DAY',
  bankAccountId: 'acct1',
  approvalRequestId: null,
  submittedAt: null,
  settledAt: null,
  returnCode: null,
  returnReason: null,
  returnedAt: null,
  note: null,
};

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith('/payroll-banking/summary'))
      return {
        profile,
        connection: null,
        accounts: [{ id: 'acct1', label: 'Operating', bankName: 'Chase', routingNumber: '011000015', accountLast4: '6789', accountType: 'CHECKING', status: 'VERIFIED', microDepositSentAt: null, attemptsLeft: 5, verifiedAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-30T00:00:00Z' }],
        runs: [{ runId: 'run1', periodStart: '2026-10-03', periodEnd: '2026-10-09', clientName: null, funding }],
        openReturns: 0,
        sameDayWindows: [],
      };
    return {};
  }),
}));

import { PayrollBankingPage } from '@/pages/payrollBanking/PayrollBankingPage';

describe('payroll banking copy', () => {
  it('names the amount, the Eastern deadline and the pay day', () => {
    const f = { ...funding, fundingDeadline: '2026-10-13T20:00:00.000Z' };
    expect(etDeadline(f.fundingDeadline)).toBe('4:00 PM ET Tue, Oct 13');
    expect(shortDay('2026-10-16')).toBe('Fri, Oct 16');
    expect(fundingSentence(f, new Date('2026-10-12T12:00:00Z'))).toBe('Fund $48,210.55 by 4:00 PM ET Tue, Oct 13 for Fri, Oct 16 pay.');
    expect(fundingSentence({ ...f, status: 'RETURNED', returnCode: 'R01', returnReason: 'Insufficient funds' })).toMatch(/returned the \$48,210.55 debit \(R01\): Insufficient funds/);
  });
  it('checks the routing number’s check digit', () => {
    expect(routingLooksValid('011000015')).toBe(true);
    expect(routingLooksValid('011000016')).toBe(false);
  });
});

describe('PayrollBankingPage', () => {
  it('shows the in-house mode, the run to fund and the account it pulls from', async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/payroll/banking']}>
            <PayrollBankingPage />
          </MemoryRouter>
        </ConfirmProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Files for your own bank')).toBeTruthy();
    expect(screen.getByText(/Fund \$48,210.55 by 4:00 PM ET .* for Fri, Oct 16 pay\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pull \$48,210.55 for pay on Fri, Oct 16/ })).toBeTruthy();
    expect(screen.getByText('····6789')).toBeTruthy();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations).toHaveLength(0);
  });
});
