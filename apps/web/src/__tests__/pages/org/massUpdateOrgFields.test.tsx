import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * F500 G1 /org: the People tab of Departments & job profiles — and its bulk
 * "assign org fields" — is gone; Mass update takes cost center and job
 * profile with the rest, so a start class still gets its fields in one step.
 */

vi.mock('@/lib/massUpdateApi', () => ({ previewMassUpdate: vi.fn(), applyMassUpdate: vi.fn(), listMassUpdateBatches: vi.fn(), undoMassUpdate: vi.fn() }));
vi.mock('@/lib/directoryApi', async (orig) => ({ ...(await orig<typeof import('@/lib/directoryApi')>()), getDirectoryEntry: vi.fn(async (id: string) => ({ id, firstName: 'Ana', lastName: id })) }));
vi.mock('@/lib/orgApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/orgApi')>()),
  listDepartments: vi.fn(async () => ({ departments: [] })),
  listCostCenters: vi.fn(async () => ({ costCenters: [{ id: 'cc2', code: '200', name: 'Back of house' }] })),
  listJobProfiles: vi.fn(async () => ({ jobProfiles: [{ id: 'jp2', code: 'HSK2', title: 'Housekeeping lead' }] })),
}));
vi.mock('@/lib/payrollApi', async (orig) => ({ ...(await orig<typeof import('@/lib/payrollApi')>()), listPayrollSchedules: vi.fn(async () => ({ schedules: [] })) }));
vi.mock('@/lib/useOrgSites', () => ({ useOrgSites: () => [] }));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [], isError: false, refetch: vi.fn() }) }));

import { listMassUpdateBatches, previewMassUpdate } from '@/lib/massUpdateApi';
import { MassUpdate } from '@/pages/people/MassUpdate';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMassUpdateBatches).mockResolvedValue({ batches: [] });
  vi.mocked(previewMassUpdate).mockResolvedValue({ matched: 2, willChange: 2, rows: [] });
});

describe('Mass update: cost center and job profile', () => {
  it('sets both for the people picked on the list', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <MassUpdate />, '/people/mass-update?ids=a,b');
    await screen.findByText('2 people chosen');
    await waitFor(() => expect(screen.getByRole('option', { name: '200 · Back of house' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Cost center'), 'cc2');
    await waitFor(() => expect(screen.getByRole('option', { name: 'HSK2 · Housekeeping lead' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText(/Job profile/), 'jp2');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(previewMassUpdate).toHaveBeenCalledWith({ associateIds: ['a', 'b'] }, { costCenterId: 'cc2', jobProfileId: 'jp2' }));
  });

  it('a batch that changed them reads as such in Recent batches', async () => {
    vi.mocked(listMassUpdateBatches).mockResolvedValue({
      batches: [{ id: 'b1', actorEmail: 'hr@example.com', changes: { costCenterId: 'cc2', costCenterName: '200 · Back of house', jobProfileId: null, jobProfileName: null }, affectedCount: 2, appliedAt: '2026-10-21T15:00:00.000Z', undoneAt: null, canUndo: true }],
    } as never);
    renderAs('HR_ADMINISTRATOR', <MassUpdate />, '/people/mass-update');
    expect(await screen.findByText('Cost center → 200 · Back of house · Job profile → none')).toBeInTheDocument();
  });
});
