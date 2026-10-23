import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/credentialRequirementsApi', () => ({
  listCredentialRequirements: vi.fn().mockResolvedValue({
    requirements: [
      { id: 'r1', kind: 'VACCINATION', label: 'TB test', locationId: 's1', clientId: null, place: 'The Grand Hotel', vaccinationKind: 'TB_TEST', complianceTag: null, qualificationId: null, latest: { weekOf: '2026-10-10', population: 12, missing: 3 } },
    ],
  }),
  createCredentialRequirement: vi.fn().mockResolvedValue({ id: 'r2' }),
  removeCredentialRequirement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/orgApi', () => ({
  listSites: vi.fn().mockResolvedValue({ sites: [{ id: 's1', name: 'The Grand Hotel', type: 'PROPERTY', timezone: 'America/Chicago', state: 'FL', isActive: true, clientId: null, clientName: null }] }),
}));
vi.mock('@/lib/qualApi', () => ({ listQualifications: vi.fn().mockResolvedValue({ qualifications: [] }) }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

import { createCredentialRequirement } from '@/lib/credentialRequirementsApi';
import { RequirementsTab } from '@/pages/compliance/RequirementsTab';

function renderTab(canManage: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RequirementsTab canManage={canManage} />
    </QueryClientProvider>,
  );
}

/** Agent families step 5: what a site requires; the Compliance agent measures it weekly. */
describe('<RequirementsTab>', () => {
  it('shows each requirement with its latest week, and a manager adds one with the label prefilled', async () => {
    renderTab(true);
    // The week reads as a date, not "2026-10-10".
    expect(await screen.findByText('3 of 12 without it, week of Oct 10, 2026')).toBeInTheDocument();
    // One word for the place: the card says what the tab says.
    expect(screen.getByText(/^(Site|Store) requirements$/)).toBeInTheDocument();
    // The form lives in a dialog, not inline under the list.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add requirement' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'The Grand Hotel' });
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: /Site|Store/ }), 's1');
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: /Kind/ }), 'TRAINING');
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: /^Required/ }), 'FOOD_HANDLER');
    expect(within(dialog).getByRole('textbox', { name: /What people read/ })).toHaveValue('Food handler');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add requirement' }));
    await waitFor(() =>
      expect(createCredentialRequirement).toHaveBeenCalledWith({ locationId: 's1', kind: 'TRAINING', label: 'Food handler', vaccinationKind: null, complianceTag: 'FOOD_HANDLER', qualificationId: null }),
    );
  });

  it('a read-only desk sees the list and no form', async () => {
    renderTab(false);
    expect(await screen.findByText('TB test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add requirement' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop requiring' })).not.toBeInTheDocument();
  });
});
