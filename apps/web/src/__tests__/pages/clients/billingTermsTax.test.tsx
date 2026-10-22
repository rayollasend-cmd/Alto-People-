import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

const clients = vi.hoisted(() => ({
  listClientStatements: vi.fn(),
  getClientDunning: vi.fn(),
  updateClientBillingTerms: vi.fn(),
}));
vi.mock('@/lib/clientsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/clientsApi')>()), ...clients }));

import { StatementsSection } from '@/pages/clients/StatementsSection';

/**
 * Audit 2026-10-21 #17 — sales tax was always $0.00 because no client could
 * be taxable. Finance sets it on the client's billing terms: taxable, and
 * the rate; the bar says what is in force.
 */

const C1 = '00000000-0000-4000-8000-0000000000c1';

beforeEach(() => {
  vi.clearAllMocks();
  clients.listClientStatements.mockResolvedValue({ statements: [] });
  clients.getClientDunning.mockResolvedValue({ poNumber: 'PO-5000', paymentTermsDays: 30, salesTaxable: false, salesTaxRatePct: null, paused: null, reminders: [] });
  clients.updateClientBillingTerms.mockResolvedValue({ poNumber: 'PO-5000', paymentTermsDays: 30, salesTaxable: true, salesTaxRatePct: 7 });
});

describe('sales tax on the client’s billing terms', () => {
  it('shows none, then sets the client taxable at a rate', async () => {
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <StatementsSection clientId={C1} />, `/clients/${C1}`);
    expect(await screen.findByText(/Sales tax/)).toHaveTextContent('Sales tax none');
    await user.click(screen.getByRole('button', { name: 'Edit terms' }));
    await user.click(screen.getByRole('checkbox', { name: 'Charge sales tax' }));
    await user.type(screen.getByLabelText(/Rate %/), '7');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(clients.updateClientBillingTerms).toHaveBeenCalledWith(C1, { poNumber: 'PO-5000', paymentTermsDays: 30, salesTaxable: true, salesTaxRatePct: 7 }));
  });
});
