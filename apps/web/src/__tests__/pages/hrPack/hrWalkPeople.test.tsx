import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './harness';

/**
 * HR walk 7 (mass update for people picked on the list), 12 (the final-pay
 * deadline defaulted before the separation exists) and 13 (HR opens a case
 * for someone who called).
 */

vi.mock('@/components/ui/AssociatePicker', () => ({
  AssociatePicker: ({ value, onChange }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void }) => (
    <div>
      <span data-testid="picked">{value?.name ?? 'nobody'}</span>
      <button type="button" onClick={() => onChange({ id: 'a9', name: 'Bo Diaz' })}>
        Pick Bo
      </button>
    </div>
  ),
}));
vi.mock('@/lib/massUpdateApi', () => ({ previewMassUpdate: vi.fn(), applyMassUpdate: vi.fn(), listMassUpdateBatches: vi.fn(), undoMassUpdate: vi.fn() }));
vi.mock('@/lib/directoryApi', async (orig) => ({ ...(await orig<typeof import('@/lib/directoryApi')>()), getDirectoryEntry: vi.fn(), listDirectory: vi.fn() }));
vi.mock('@/lib/orgApi', async (orig) => ({ ...(await orig<typeof import('@/lib/orgApi')>()), listDepartments: vi.fn(async () => ({ departments: [{ id: 'd2', name: 'Back office' }] })) }));
vi.mock('@/lib/payrollApi', async (orig) => ({ ...(await orig<typeof import('@/lib/payrollApi')>()), listPayrollSchedules: vi.fn(async () => ({ schedules: [] })) }));
vi.mock('@/lib/useOrgSites', () => ({ useOrgSites: () => [] }));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [], isError: false, refetch: vi.fn() }) }));
vi.mock('@/lib/separation119Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/separation119Api')>()),
  listSeparations: vi.fn(async () => ({ separations: [] })),
  getSeparationSummary: vi.fn(async () => ({ total: 0, byReason: {}, byStatus: {}, exitInterviewRate: null, avgRating: null })),
  getFinalPayDeadline: vi.fn(),
}));
vi.mock('@/lib/hrCases123Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/hrCases123Api')>()),
  listCaseQueue: vi.fn(async () => ({ cases: [], total: 0, page: 0, hasMore: false })),
  listMyCases: vi.fn(async () => ({ cases: [] })),
  getCaseSummary: vi.fn(async () => ({ openTotal: 0, byStatus: {}, byPriority: {}, byCategory: {}, sla: { breached: 0, atRisk: 0 } })),
  listCaseStaff: vi.fn(async () => ({ staff: [] })),
  getCase: vi.fn(() => new Promise(() => undefined)),
  fileCaseOnBehalf: vi.fn(async () => ({ id: 'case-1' })),
}));

import { previewMassUpdate, listMassUpdateBatches } from '@/lib/massUpdateApi';
import { getDirectoryEntry, listDirectory } from '@/lib/directoryApi';
import { getFinalPayDeadline } from '@/lib/separation119Api';
import { fileCaseOnBehalf } from '@/lib/hrCases123Api';
import { MassUpdate } from '@/pages/people/MassUpdate';
import { SeparationHome } from '@/pages/separation/SeparationHome';
import { HrCasesHome } from '@/pages/hrCases/HrCasesHome';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mass update for the people picked on the list (HR walk 7)', () => {
  it('shows who was chosen in place of the filters and previews exactly them', async () => {
    vi.mocked(listMassUpdateBatches).mockResolvedValue({ batches: [] });
    vi.mocked(getDirectoryEntry).mockImplementation(async (id: string) => ({ id, firstName: id === 'a' ? 'Ana' : 'Ben', lastName: 'Lopez' }) as never);
    vi.mocked(previewMassUpdate).mockResolvedValue({ matched: 2, willChange: 2, rows: [] });
    renderAs('HR_ADMINISTRATOR', <MassUpdate />, '/people/mass-update?ids=a,b');
    expect(await screen.findByText('2 people chosen')).toBeInTheDocument();
    expect(await screen.findByText('Ana Lopez')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change who' })).toHaveAttribute('href', '/people');
    // No Who filters while a list is chosen.
    expect(screen.queryByText('Leave a filter blank to not narrow by it. Separated people are never included.')).toBeNull();
    const dept = screen.getAllByRole('combobox').find((el) => within(el).queryByRole('option', { name: 'Back office' }));
    await userEvent.selectOptions(dept!, 'd2');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(previewMassUpdate).toHaveBeenCalledWith({ associateIds: ['a', 'b'] }, { departmentId: 'd2' }));
  });
});

describe('separation defaults the final paycheck to the state deadline (HR walk 12)', () => {
  it('fills the deadline in and says why', async () => {
    vi.mocked(listDirectory).mockResolvedValue({ associates: [{ id: 'a1', firstName: 'Cara', lastName: 'Nunez' }] } as never);
    vi.mocked(getFinalPayDeadline).mockImplementation(async (q) => ({
      deadline: q.lastDayWorked,
      basis: '0 days after the last day worked',
      note: 'California: immediately on discharge; within 72 hours of a resignation without notice.',
      state: 'CA',
    }));
    renderAs('HR_ADMINISTRATOR', <SeparationHome />, '/separations?associateId=a1');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(getFinalPayDeadline).toHaveBeenCalled());
    const q = vi.mocked(getFinalPayDeadline).mock.calls[0]![0];
    expect(q.associateId).toBe('a1');
    expect(await within(dialog).findByText(/Why: California: immediately on discharge/)).toBeInTheDocument();
    const dates = dialog.querySelectorAll('input[type="date"]');
    expect((dates[2] as HTMLInputElement).value).toBe(q.lastDayWorked);
  });
});

describe('HR opens a case for someone (HR walk 13)', () => {
  it('desk staff without an associate record file by phone for the person picked', async () => {
    renderAs('HR_ADMINISTRATOR', <HrCasesHome />, '/hr-cases');
    await userEvent.click(await screen.findByRole('button', { name: /New case/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Open a case for someone')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pick Bo' }));
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Phone' }));
    await userEvent.type(within(dialog).getByPlaceholderText('One-line summary'), 'Shorted on overtime');
    await userEvent.type(within(dialog).getByPlaceholderText(/What they told you/), 'Called the desk about last week.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open case' }));
    await waitFor(() =>
      expect(fileCaseOnBehalf).toHaveBeenCalledWith({
        associateId: 'a9',
        channel: 'PHONE',
        category: 'WORKPLACE_CONCERN',
        subject: 'Shorted on overtime',
        description: 'Called the desk about last week.',
        priority: 'MEDIUM',
      }),
    );
  });
});
