import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAsAdmin } from './orgAdminHarness';

vi.mock('@/lib/orgApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/orgApi')>()),
  listEmployers: vi.fn(),
  createEmployer: vi.fn(),
  updateEmployer: vi.fn(),
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));
vi.mock('@/lib/geoApi', () => ({ suggestAddresses: vi.fn() }));

import { createEmployer, listEmployers, type EmployerRow } from '@/lib/orgApi';
import { suggestAddresses } from '@/lib/geoApi';
import { EmployersAdmin } from '@/pages/admin/EmployersAdmin';

const rows: EmployerRow[] = [
  {
    id: 'e1',
    kind: 'TENANT',
    legalName: 'Harbor House Hospitality LLC',
    ein: '12-3456789',
    address: { line1: '1 Ocean Dr', line2: null, city: 'Miami', state: 'FL', zip: '33139' },
    sutaRateOverride: null,
    sutaWageBaseOverride: null,
    clientId: null,
    clientName: null,
    isDefault: true,
    employments: 42,
  },
  {
    id: 'e2',
    kind: 'THIRD_PARTY',
    legalName: 'Coastal Payroll Services Inc',
    ein: null,
    address: { line1: null, line2: null, city: null, state: null, zip: null },
    sutaRateOverride: null,
    sutaWageBaseOverride: null,
    clientId: null,
    clientName: null,
    isDefault: false,
    employments: 0,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listEmployers).mockResolvedValue({ employers: rows });
  vi.mocked(createEmployer).mockResolvedValue({ employer: { ...rows[1]!, id: 'e3', legalName: 'New Co' } });
});

describe('Employers of record', () => {
  it('lists the employers with a masked EIN and the default marked', async () => {
    renderAsAdmin(<EmployersAdmin />, '/admin/employers');
    expect(await screen.findByText('Harbor House Hospitality LLC')).toBeInTheDocument();
    expect(screen.getByText('Coastal Payroll Services Inc')).toBeInTheDocument();
    expect(screen.getByText('••-•••6789')).toBeInTheDocument();
    expect(screen.queryByText('12-3456789')).not.toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('This organization')).toBeInTheDocument();
    expect(screen.getByText('Third party')).toBeInTheDocument();
  });

  it('adds a third-party employer with its legal name and EIN', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<EmployersAdmin />, '/admin/employers');
    await screen.findByText('Harbor House Hospitality LLC');
    await user.click(screen.getByRole('button', { name: 'Add employer of record' }));
    await user.type(screen.getByLabelText('Legal name'), 'New Co');
    await user.type(screen.getByLabelText('EIN'), '98-7654321');
    await user.type(screen.getByLabelText('State'), 'fl');
    await user.click(screen.getByRole('button', { name: 'Add employer' }));
    await waitFor(() => expect(createEmployer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createEmployer).mock.calls[0]![0]).toEqual({
      legalName: 'New Co',
      ein: '98-7654321',
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: 'FL',
      zip: null,
      phone: null,
      wcCarrierName: null,
      wcCarrierAddress: null,
      wcCarrierPhone: null,
      wcPolicyNumber: null,
    });
  });

  it('fills the employer’s address from a picked suggestion', async () => {
    vi.mocked(suggestAddresses).mockResolvedValue({
      available: true,
      provider: 'mapbox',
      outage: false,
      results: [
        { label: '1 Ocean Drive', address: '1 Ocean Drive, Miami Beach, Florida 33139', line1: '1 Ocean Drive', line2: null, city: 'Miami Beach', state: 'FL', zip: '33139', county: 'Miami-Dade County', lat: 25.77, lng: -80.13, precision: 'exact' },
      ],
    });
    const user = userEvent.setup();
    renderAsAdmin(<EmployersAdmin />, '/admin/employers');
    await screen.findByText('Harbor House Hospitality LLC');
    await user.click(screen.getByRole('button', { name: 'Add employer of record' }));
    await user.type(screen.getByLabelText('Legal name'), 'New Co');
    await user.type(screen.getByLabelText('Address line 1'), '1 Ocean');
    await user.click(await screen.findByRole('option', { name: /1 Ocean Drive/ }));
    // The carrier's address is one line on the pay notice: a pick fills it whole.
    await user.type(screen.getByLabelText('Carrier address'), '1 Ocean');
    await user.click(await screen.findByRole('option', { name: /1 Ocean Drive/ }));
    expect(screen.getByLabelText('Carrier address')).toHaveValue('1 Ocean Drive, Miami Beach, Florida 33139');
    await user.click(screen.getByRole('button', { name: 'Add employer' }));
    await waitFor(() => expect(createEmployer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createEmployer).mock.calls[0]![0]).toMatchObject({
      addressLine1: '1 Ocean Drive',
      city: 'Miami Beach',
      state: 'FL',
      zip: '33139',
      wcCarrierAddress: '1 Ocean Drive, Miami Beach, Florida 33139',
    });
  });

  it('refuses a malformed EIN before it reaches the API', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<EmployersAdmin />, '/admin/employers');
    await screen.findByText('Harbor House Hospitality LLC');
    await user.click(screen.getByRole('button', { name: 'Add employer of record' }));
    await user.type(screen.getByLabelText('Legal name'), 'New Co');
    await user.type(screen.getByLabelText('EIN'), '12345');
    expect(screen.getByRole('button', { name: 'Add employer' })).toBeDisabled();
    expect(createEmployer).not.toHaveBeenCalled();
  });

  // F500 G4: what the tax forms can't print without, said on the row, with the fix one click away.
  it('warns on a row with no EIN or address and opens the editor from "Add EIN"', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<EmployersAdmin />, '/admin/employers');
    expect(await screen.findByText('Missing EIN: W-2s can’t be filed')).toBeInTheDocument();
    expect(screen.getByText('No address')).toBeInTheDocument();
    // The complete row carries neither warning: one of each, both on Coastal.
    expect(screen.getAllByText('Missing EIN: W-2s can’t be filed')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Add EIN' }));
    expect(await screen.findByRole('heading', { name: 'Edit Coastal Payroll Services Inc' })).toBeInTheDocument();
  });
});
