import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

/**
 * The guided close (finance walks 3 and 18): each step's text follows its
 * own state — a done step never reads "not yet" — and the tax deposit is
 * created and recorded paid on the step itself.
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
const createRunTaxDeposit = vi.fn();
const markTaxDepositPaid = vi.fn();
vi.mock('@/lib/payrollDeskApi', async (orig) => ({ ...(await orig<typeof import('@/lib/payrollDeskApi')>()), createRunTaxDeposit: (...a: unknown[]) => createRunTaxDeposit(...a) }));
vi.mock('@/lib/payrollApi', async (orig) => ({ ...(await orig<typeof import('@/lib/payrollApi')>()), markTaxDepositPaid: (...a: unknown[]) => markTaxDepositPaid(...a) }));

import { apiFetch } from '@/lib/api';
import { PayrollClosePage, type PayrollClose } from '@/pages/payroll/PayrollClosePage';

function renderClose() {
  const caps = ROLE_CAPABILITIES.FINANCE_ACCOUNTANT;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{ isInitializing: false, isOffline: false, user: { id: 'u', email: 'f@x.com', role: 'FINANCE_ACCOUNTANT', status: 'ACTIVE', clientId: null, associateId: null } as never, role: 'FINANCE_ACCOUNTANT', primaryRole: 'FINANCE_ACCOUNTANT', availableRoles: ['FINANCE_ACCOUNTANT'], capabilities: caps, tenant: DEFAULT_TENANT, signIn: vi.fn(), submitMfaChallenge: vi.fn(), signOut: vi.fn(), refreshUser: vi.fn(), switchRole: vi.fn(), can: (c: Capability) => caps.has(c) }}
      >
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/payroll/runs/r1/close']}>
            <Routes>
              <Route path="/payroll/runs/:id/close" element={<PayrollClosePage />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const paid = (deposit: PayrollClose['deposit']): PayrollClose => ({
  run: { id: 'r1', status: 'DISBURSED', kind: 'REGULAR', clientName: null, periodStart: '2026-08-29', periodEnd: '2026-09-11', totalGross: 4054.5, totalNet: 3490.2, totalEmployerTax: 310, finalizedAt: null, approvedAt: null, approvedByEmail: null, disbursedAt: '2026-09-18T12:00:00Z' },
  approvalRequired: true,
  review: { required: true, signedByName: null, signedAt: null, soleReviewer: false, staleSignedByName: null, staleSignedAt: null },
  items: { pending: 0, disbursed: 9, held: 0, failed: 0, voided: 0 },
  heldItems: [],
  paidItems: [],
  rerouted: 0,
  readiness: { missingW4: [], missingPayout: [], unverifiedPayout: [], unsupportedState: [] },
  exceptions: null,
  deposit,
  remittances: [],
  quickbooks: { connected: false, status: null, companyName: null },
  steps: [
    { key: 'approve', label: 'Finalize', state: 'done', blockers: 0, warnings: 0, to: '/payroll?run=r1' },
    { key: 'review', label: 'Review and sign off', state: 'done', blockers: 0, warnings: 0, to: '/payroll/runs/r1/review' },
    { key: 'deposits', label: 'Tax deposit', state: deposit ? 'current' : 'warn', blockers: 0, warnings: 0, to: '/payroll/taxes?tab=deposits' },
  ],
} as unknown as PayrollClose);

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  createRunTaxDeposit.mockReset();
  markTaxDepositPaid.mockReset();
});

describe('the guided close', () => {
  it('a done step reads done; a paid run with no deposit offers "Create the deposit"', async () => {
    vi.mocked(apiFetch).mockResolvedValue(paid(null) as never);
    createRunTaxDeposit.mockResolvedValue({ created: true, deposit: { id: 'd1', status: 'PENDING', dueDate: '2026-10-15', amount: 564.3, confirmationNumber: null } });
    renderClose();
    const steps = await screen.findByRole('list', { name: 'Close steps' });
    expect(within(steps).queryByText('Not finalized yet')).not.toBeInTheDocument();
    expect(within(steps).getByText('Finalized')).toBeInTheDocument();
    expect(within(steps).queryByText(/No sign-off yet/)).not.toBeInTheDocument();
    expect(within(steps).getByText('Paid out with no sign-off on record.')).toBeInTheDocument();
    await userEvent.click(within(steps).getByRole('button', { name: 'Create the deposit' }));
    await waitFor(() => expect(createRunTaxDeposit).toHaveBeenCalledWith('r1'));
  });

  it('a pending deposit shows its due date and records the EFTPS confirmation inline', async () => {
    vi.mocked(apiFetch).mockResolvedValue(paid({ id: 'd1', status: 'PENDING', dueDate: '2026-10-15', amount: 564.3, confirmationNumber: null }) as never);
    markTaxDepositPaid.mockResolvedValue({ ok: true });
    renderClose();
    const steps = await screen.findByRole('list', { name: 'Close steps' });
    expect(within(steps).getByText(/\$564\.30 due Oct 15, 2026/)).toBeInTheDocument();
    await userEvent.type(within(steps).getByLabelText('EFTPS confirmation'), '270012345678901');
    await userEvent.click(within(steps).getByRole('button', { name: 'Record as paid' }));
    await waitFor(() => expect(markTaxDepositPaid).toHaveBeenCalledWith('d1', '270012345678901'));
  });
});
