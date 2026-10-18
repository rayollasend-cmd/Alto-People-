import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import type { ReactNode } from 'react';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { PayBillPage } from '@/pages/finance/PayBillPage';
import type { ReconReport } from '@/lib/payBillApi';

/** BEYOND — the pay and bill desk on screen: the gap in money, its reason, and the adjustments waiting on review. */

function renderAs(role: Role, ui: ReactNode, path: string) {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'x@altohr.com', role, status: 'ACTIVE' as const, clientId: null, associateId: null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/finance/pay-bill" element={ui} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const report: ReconReport = {
  periodStart: '2026-09-05',
  periodEnd: '2026-09-18',
  runs: [{ id: 'r1', periodStart: '2026-09-05', periodEnd: '2026-09-18', status: 'FINALIZED', clientName: null, checks: 1 }],
  hours: { paid: 20, billed: 10, onDraft: 0, unbilled: 10 },
  premiums: { paid: 60, billed: 45, queued: 0, awaitingReview: 0, notBillable: 15, unbilled: 0 },
  retro: { paid: 20, rebilled: 0, queued: 0, awaitingReview: 20, notRebilled: 0 },
  totals: { wages: 400, cost: 448, billed: 300, pending: 0, margin: -148, marginPct: -49.33, gapPay: 1240 },
  paychecks: [],
  unbilled: [
    { associateId: 'a1', associateName: 'Rosa Diaz', payrollItemId: 'i1', clientId: 'c1', clientName: 'Coastal', kind: 'HOURS', label: 'Hours worked', hours: 10, payAmount: 1240, reason: 'NO_STATEMENT', reasonText: 'No statement for Coastal covers these days.', workFrom: '2026-09-13', workTo: '2026-09-13' },
  ],
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.startsWith('/pay-bill/periods')) return { periods: [{ periodStart: '2026-09-05', periodEnd: '2026-09-18', runs: 1 }] } as never;
    if (url.startsWith('/pay-bill/reconciliation')) return report as never;
    if (url.startsWith('/pay-bill/adjustments')) {
      return {
        adjustments: [
          { id: 'b1', clientId: 'c1', clientName: 'Coastal', kind: 'RETRO', status: 'PENDING_REVIEW', ruleKey: null, label: 'Retroactive pay — Rosa Diaz, 2026-09-08 to 2026-09-12', basis: '$20.00 back pay × 1.500 bill-rate markup', hours: 10, payAmount: 20, amount: 30, workFrom: null, workTo: null, associateId: 'a1', payrollRunId: 'r1', approvalId: 'ap1', reason: null, originalStatements: [{ id: 's1', number: 1042 }], billedStatement: null, createdAt: '2026-09-20T00:00:00Z' },
        ],
        truncated: false,
      } as never;
    }
    throw new Error(`unexpected ${url}`);
  });
});

describe('pay and bill desk', () => {
  it('reconciliation: the gap in money and why', async () => {
    renderAs('FINANCE_ACCOUNTANT', <PayBillPage />, '/finance/pay-bill');
    expect(await screen.findByText('Billable pay on no statement')).toBeInTheDocument();
    expect((await screen.findAllByText('$1,240.00')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('No statement for Coastal covers these days.').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Pay and bill' })).toBeInTheDocument();
  });

  it('adjustments: a rebill waiting on review shows what it corrects, with the decision for Finance only', async () => {
    renderAs('FINANCE_ACCOUNTANT', <PayBillPage />, '/finance/pay-bill?tab=adjustments');
    expect((await screen.findAllByText(/Corrects #1042/)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Rebill' }).length).toBeGreaterThan(0);
  });

  it('an executive reads the adjustments without the decision buttons', async () => {
    renderAs('EXECUTIVE_CHAIRMAN', <PayBillPage />, '/finance/pay-bill?tab=adjustments');
    expect((await screen.findAllByText(/Corrects #1042/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Rebill' })).toBeNull();
  });
});
