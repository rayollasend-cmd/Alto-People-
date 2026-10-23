import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClientSummary } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/geoApi', () => ({ suggestAddresses: vi.fn() }));
vi.mock('@/lib/clientsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/clientsApi')>()), updateClient: vi.fn() }));

import { suggestAddresses } from '@/lib/geoApi';
import { updateClient } from '@/lib/clientsApi';
import { ClientBasicsCard } from '@/pages/clients/ClientBasicsCard';

/**
 * A client's billing address, picked: street, suite, city and ZIP fill;
 * the client's state is not the billing form's to change (it sets the tax
 * and labor rules, in Settings), so a pick in another state says so.
 */

const client = {
  id: 'c1', name: 'Coastal Resorts', legalName: null, industry: null, status: 'ACTIVE', contactEmail: null,
  addressLine1: null, addressLine2: null, city: null, state: 'FL', zip: null, poNumber: null, paymentTermsDays: 30,
} as unknown as ClientSummary;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updateClient).mockImplementation(async (_id, body) => ({ ...client, ...body }) as ClientSummary);
  vi.mocked(suggestAddresses).mockResolvedValue({
    available: true,
    provider: 'mapbox',
    outage: false,
    results: [
      { label: '400 Peachtree Street NE Suite 900', address: '400 Peachtree Street NE Suite 900, Atlanta, Georgia 30308', line1: '400 Peachtree Street NE', line2: 'Suite 900', city: 'Atlanta', state: 'GA', zip: '30308', county: 'Fulton County', lat: 33.76, lng: -84.38, precision: 'exact' },
    ],
  });
});

describe('the billing address, picked', () => {
  it('fills street, suite, city and ZIP, says the state on file stays, and saves them', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <ClientBasicsCard client={client} canManage editing onEditingChange={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText('Address line 1'), '400 Peachtree Suite 900');
    await user.click(await screen.findByRole('option', { name: /400 Peachtree Street NE/ }));
    expect(screen.getByLabelText('Address line 2')).toHaveValue('Suite 900');
    expect(screen.getByLabelText('City')).toHaveValue('Atlanta');
    expect(screen.getByLabelText('ZIP')).toHaveValue('30308');
    expect(screen.getByText('This address is in GA. The client’s state on file, FL, changes in Settings.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateClient).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateClient).mock.calls[0]![1]).toMatchObject({ addressLine1: '400 Peachtree Street NE', addressLine2: 'Suite 900', city: 'Atlanta', zip: '30308' });
    expect(vi.mocked(updateClient).mock.calls[0]![1]).not.toHaveProperty('state');
  });
});
