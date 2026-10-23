import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

const api = vi.hoisted(() => ({
  payRulesSummary: vi.fn(),
  listProjects: vi.fn(),
  listPremiumPayRules: vi.fn(),
  listTipPools: vi.fn(),
}));
vi.mock('@/lib/payRulesApi', async (orig) => ({ ...(await orig<typeof import('@/lib/payRulesApi')>()), ...api }));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [{ id: 'c1', name: 'Coastal Resort' }, { id: 'c2', name: 'Harbor Grill' }] }) }));

import { PayRulesHome } from '@/pages/payrules/PayRulesHome';

/**
 * Pay rules (F500 G6): with "All clients" it opens on every client's rules
 * instead of whichever client sorted first; the client and tab are in the
 * URL; Premium pay leads, and the billing side links to Contract terms.
 */

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.payRulesSummary.mockResolvedValue({ clients: [{ clientId: 'c1', clientName: 'Coastal Resort', projects: 2, premiumRules: 1, openTipPools: 1 }, { clientId: 'c2', clientName: 'Harbor Grill', projects: 1, premiumRules: 0, openTipPools: 0 }] });
  api.listProjects.mockResolvedValue({ projects: [] });
  api.listPremiumPayRules.mockResolvedValue({ rules: [] });
  api.listTipPools.mockResolvedValue({ pools: [] });
});

describe('<PayRulesHome>', () => {
  it('“All clients” is a table of every client’s rules; a row opens that client on Premium pay', async () => {
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <PayRulesHome />, '/payrules');
    const table = await screen.findByRole('table', { name: /Pay rules by client/i });
    const coastal = within(table).getByText('Coastal Resort').closest('tr')!;
    expect(coastal).toHaveTextContent('1');
    expect(api.listPremiumPayRules).not.toHaveBeenCalled();
    await user.click(coastal);
    await waitFor(() => expect(api.listPremiumPayRules).toHaveBeenCalledWith('c1'));
    expect(screen.getByRole('tab', { name: 'Premium pay' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('link', { name: 'Contract terms (billing)' })).toHaveAttribute('href', '/finance/pay-bill?tab=terms&client=c1');
  });

  it('opens a linked client and tab from the URL', async () => {
    renderAs('FINANCE_ACCOUNTANT', <PayRulesHome />, '/payrules?client=c2&tab=tips');
    await waitFor(() => expect(api.listTipPools).toHaveBeenCalledWith('c2'));
    expect(screen.getByRole('tab', { name: 'Tip pools' })).toHaveAttribute('aria-selected', 'true');
    expect((screen.getByLabelText(/client/i) as HTMLSelectElement).value).toBe('c2');
  });
});
