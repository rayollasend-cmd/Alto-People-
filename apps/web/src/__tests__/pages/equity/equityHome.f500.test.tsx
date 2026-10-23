import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

const api = vi.hoisted(() => ({
  listMyEquity: vi.fn(),
  listEquityGrants: vi.fn(),
  getEquitySummary: vi.fn(),
}));
vi.mock('@/lib/equity129Api', async (orig) => ({ ...(await orig<typeof import('@/lib/equity129Api')>()), ...api }));

import { EquityHome } from '@/pages/equity/EquityHome';

/**
 * Equity (F500 G6): whoever issues grants opens on all of them, every
 * status (proposed ones included); "New grant" is the header's action; a
 * one-option switch isn't shown.
 */

const grant = (o: Record<string, unknown> = {}) => ({
  id: 'g1', associateId: 'a1', associateName: 'Maria Lopez', associateEmail: 'maria@example.com', grantType: 'RSU', totalShares: 1000,
  strikePrice: null, currency: 'USD', grantDate: '2026-10-01', vestingStartDate: '2026-10-01', cliffMonths: 12, vestingMonths: 48, status: 'PROPOSED', ...o,
});

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.listMyEquity.mockResolvedValue({ grants: [] });
  api.listEquityGrants.mockResolvedValue({ grants: [grant()] });
  api.getEquitySummary.mockResolvedValue({ proposedCount: 1, activeRecipients: 0, sharesGranted: 0, sharesVested: 0 });
});

describe('<EquityHome>', () => {
  it('an HR admin opens on all grants, every status — the proposed one shows', async () => {
    renderAs('HR_ADMINISTRATOR', <EquityHome />, '/equity');
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    expect(api.listEquityGrants).toHaveBeenCalledWith(undefined);
    expect(api.listMyEquity).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /All grants/ })).toBeChecked();
    expect(screen.getAllByRole('button', { name: /New grant/ }).length).toBeGreaterThan(0);
    // One export: the grid's own.
    expect(screen.queryByRole('button', { name: /Export CSV/ })).toBeNull();
  });

  it('the Proposed tile filters the list, in the URL', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <EquityHome />, '/equity');
    const strip = await screen.findByRole('group', { name: 'Equity at a glance' });
    await user.click(within(strip).getByRole('button', { name: /Proposed/ }));
    await waitFor(() => expect(api.listEquityGrants).toHaveBeenLastCalledWith('PROPOSED'));
  });

  it('finance has only its own grants: no one-option switch, no New grant', async () => {
    renderAs('FINANCE_ACCOUNTANT', <EquityHome />, '/equity');
    expect(await screen.findByText('No equity grants')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Grant view' })).toBeNull();
    expect(screen.queryByRole('button', { name: /New grant/ })).toBeNull();
  });
});
