import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { FixedAssetDetail, FixedAssetListResponse, FixedAssetSummary } from '@alto-people/shared';
import { renderAs } from '../../hrPack/harness';

const api = vi.hoisted(() => ({
  listFixedAssets: vi.fn(),
  getFixedAsset: vi.fn(),
  createFixedAsset: vi.fn(),
  updateFixedAsset: vi.fn(),
  disposeFixedAsset: vi.fn(),
  runDepreciation: vi.fn(),
  listAccountOptions: vi.fn(),
}));
vi.mock('@/lib/books/closeApi', () => api);

import { FixedAssetsPage } from '@/pages/books/assets/FixedAssetsPage';
import { FixedAssetDetailPage } from '@/pages/books/assets/FixedAssetDetailPage';

/** Fixed assets: the register with what's due, a van added from the fleet, the schedule, and disposal. */

const summary = (o: Partial<FixedAssetSummary> = {}): FixedAssetSummary => ({
  id: 'fa1',
  name: 'Ford Transit — Van 7',
  category: 'VEHICLE',
  status: 'ACTIVE',
  method: 'STRAIGHT_LINE',
  acquiredOn: '2026-06-10',
  inServiceOn: '2026-06-10',
  cost: 36000,
  salvageValue: 6000,
  usefulLifeMonths: 60,
  accumulated: 1500,
  netBookValue: 34500,
  monthlyDepreciation: 500,
  lastPostedPeriod: '2026-08',
  duePeriods: 1,
  assetId: null,
  vanId: 'v7',
  linkedLabel: 'Van 7 · ALT 107',
  ...o,
});

const list: FixedAssetListResponse = {
  assets: [summary()],
  totals: { cost: 36000, accumulated: 1500, netBookValue: 34500, monthly: 500 },
  suggestions: [{ kind: 'VAN', id: 'v8', label: 'Van 8 · 2024 · Ford · Transit', cost: null, acquiredOn: null, category: 'VEHICLE' }],
};

const detail = (o: Partial<FixedAssetDetail> = {}): FixedAssetDetail => ({
  ...summary(),
  assetAccountId: 'acc-veh',
  accumulatedAccountId: 'acc-ad',
  expenseAccountId: 'acc-dep',
  accounts: { asset: '1500 Vehicles', accumulated: '1590 Accumulated depreciation', expense: '6900 Depreciation' },
  clientId: null,
  siteId: null,
  departmentId: null,
  notes: null,
  disposedOn: null,
  disposalProceeds: null,
  acquisitionEntryId: 'je1',
  disposalEntryId: null,
  schedule: [
    { periodKey: '2026-06', amount: 500, accumulated: 500, netBookValue: 35500, posted: true, entryId: 'je2', postedLate: false },
    { periodKey: '2026-07', amount: 500, accumulated: 1000, netBookValue: 35000, posted: true, entryId: 'je3', postedLate: true },
    { periodKey: '2026-08', amount: 500, accumulated: 1500, netBookValue: 34500, posted: true, entryId: 'je4', postedLate: false },
  ],
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.listAccountOptions.mockResolvedValue({
    accounts: [
      { id: 'cash', code: '1000', name: 'Operating checking', type: 'ASSET', subtype: 'BANK', systemKey: 'CASH_OPERATING' },
      { id: 'ap', code: '2000', name: 'Accounts payable', type: 'LIABILITY', subtype: 'AP', systemKey: 'AP' },
    ],
  });
});

describe('FixedAssetsPage', () => {
  it('shows the register and what’s due, and adds a van from the fleet with its acquisition', async () => {
    api.listFixedAssets.mockResolvedValue(list);
    api.createFixedAsset.mockResolvedValue({ asset: detail({ id: 'fa2', name: 'Van 8' }) });
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <FixedAssetsPage />, '/books/assets');
    expect(await screen.findByText('Ford Transit — Van 7')).toBeInTheDocument();
    expect(screen.getByText('1 due')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Post depreciation due/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add to fixed assets' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Van 8 · 2024 · Ford · Transit');
    await user.type(within(dialog).getByLabelText('Cost'), '41000');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: '1000 Operating checking' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Paid from'), 'cash');
    await user.click(within(dialog).getByRole('button', { name: 'Add to fixed assets' }));
    await waitFor(() =>
      expect(api.createFixedAsset).toHaveBeenCalledWith(expect.objectContaining({ vanId: 'v8', category: 'VEHICLE', cost: 41000, usefulLifeMonths: 60, acquisition: { creditAccountId: 'cash' } })),
    );
  });

  it('read-only roles see the register without the buttons', async () => {
    api.listFixedAssets.mockResolvedValue(list);
    renderAs('EXECUTIVE_CHAIRMAN', <FixedAssetsPage />, '/books/assets');
    expect(await screen.findByText('Ford Transit — Van 7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add asset/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Owned, not on the register')).not.toBeInTheDocument();
  });
});

describe('FixedAssetDetailPage', () => {
  it('shows the schedule (a late month flagged) and disposes with proceeds', async () => {
    api.getFixedAsset.mockResolvedValue({ asset: detail() });
    api.disposeFixedAsset.mockResolvedValue({ asset: detail({ status: 'DISPOSED', netBookValue: 0, disposedOn: '2026-10-12', disposalProceeds: 35000 }) });
    const user = userEvent.setup();
    renderAs(
      'FINANCE_ACCOUNTANT',
      <Routes>
        <Route path="/books/assets/:id" element={<FixedAssetDetailPage />} />
      </Routes>,
      '/books/assets/fa1',
    );
    await screen.findByRole('heading', { name: 'Ford Transit — Van 7' });
    expect(screen.getByText('Posted late')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Dispose/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Proceeds/), '35000');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: '1000 Operating checking' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Deposited to'), 'cash');
    expect(within(dialog).getByText(/about \$500\.00 gain/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Dispose' }));
    await waitFor(() => expect(api.disposeFixedAsset).toHaveBeenCalledWith('fa1', expect.objectContaining({ proceeds: 35000, proceedsAccountId: 'cash' })));
  });
});
