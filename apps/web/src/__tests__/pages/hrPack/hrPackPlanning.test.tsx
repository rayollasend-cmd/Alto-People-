import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './harness';

vi.mock('@/lib/positionsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/positionsApi')>()), getHeadcountPlan: vi.fn(), getHeadcount: vi.fn() }));
vi.mock('@/lib/massUpdateApi', () => ({ previewMassUpdate: vi.fn(), applyMassUpdate: vi.fn(), listMassUpdateBatches: vi.fn(), undoMassUpdate: vi.fn() }));
vi.mock('@/lib/orgApi', async (orig) => ({ ...(await orig<typeof import('@/lib/orgApi')>()), listDepartments: vi.fn() }));
vi.mock('@/lib/payrollApi', async (orig) => ({ ...(await orig<typeof import('@/lib/payrollApi')>()), listPayrollSchedules: vi.fn() }));
vi.mock('@/lib/useOrgSites', () => ({ useOrgSites: () => [] }));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [], isError: false, refetch: vi.fn() }) }));
vi.mock('@/lib/compApi', async (orig) => ({ ...(await orig<typeof import('@/lib/compApi')>()), listCycles: vi.fn(), getWorksheet: vi.fn(), getCalibration: vi.fn(), updateProposal: vi.fn() }));
vi.mock('@/lib/inboxApi', () => ({ useInbox: () => ({ data: { total: 5, sources: [{ key: 'expirations', count: 3 }, { key: 'onboarding-review', count: 2 }] }, isLoading: false }) }));
vi.mock('@/lib/hrCases123Api', async (orig) => ({ ...(await orig<typeof import('@/lib/hrCases123Api')>()), getCaseSummary: vi.fn() }));
vi.mock('@/lib/policyCampaignsApi', () => ({ listPolicyCampaigns: vi.fn() }));

import { getHeadcountPlan } from '@/lib/positionsApi';
import { applyMassUpdate, listMassUpdateBatches, previewMassUpdate } from '@/lib/massUpdateApi';
import { listDepartments } from '@/lib/orgApi';
import { listPayrollSchedules } from '@/lib/payrollApi';
import { getWorksheet, listCycles, updateProposal } from '@/lib/compApi';
import { getCaseSummary } from '@/lib/hrCases123Api';
import { listPolicyCampaigns } from '@/lib/policyCampaignsApi';
import { HeadcountPlan } from '@/pages/headcount/HeadcountPlan';
import { MassUpdate } from '@/pages/people/MassUpdate';
import { CompPlanningTab } from '@/pages/compensation/CompPlanningTab';
import { RoleFocusRow } from '@/components/home/RoleFocusRow';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('headcount plan', () => {
  it('budget, projected and variance, with an over-plan seat in red words', async () => {
    vi.mocked(getHeadcountPlan).mockResolvedValue({
      year: 2026,
      positions: [{ id: 'p1', code: 'HK-1', title: 'Room attendant', status: 'FILLED', departmentId: 'd1', departmentName: 'Housekeeping', fteAuthorized: '1.00', filledByAssociateId: 'a1', filledByName: 'Ana Lopez', budgetAmount: '40000', budgetPeriod: 'ANNUAL', annualBudget: 40000, projectedAnnualCost: 41600, paidYearToDate: 30000, variance: -1600 }],
      departments: [{ departmentId: 'd1', departmentName: 'Housekeeping', positions: 1, filled: 1, budget: 40000, projected: 41600, paidYearToDate: 30000, unbudgeted: 0, variance: -1600 }],
      totals: { positions: 1, filled: 1, budget: 40000, projected: 41600, paidYearToDate: 30000, unbudgeted: 0, variance: -1600 },
    });
    renderAs('HR_ADMINISTRATOR', <HeadcountPlan />);
    expect((await screen.findAllByText('Room attendant')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('−$1,600.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Housekeeping').length).toBeGreaterThan(0);
  });
});

describe('mass update', () => {
  it('needs a filter, previews who changes, then applies', async () => {
    vi.mocked(listDepartments).mockResolvedValue({ departments: [{ id: 'd1', clientId: 'c1', parentId: null, name: 'Front desk', code: null, description: null, associateCount: 2 }, { id: 'd2', clientId: 'c1', parentId: null, name: 'Back office', code: null, description: null, associateCount: 0 }] } as never);
    vi.mocked(listPayrollSchedules).mockResolvedValue({ schedules: [] });
    vi.mocked(listMassUpdateBatches).mockResolvedValue({ batches: [] });
    vi.mocked(previewMassUpdate).mockResolvedValue({ matched: 2, willChange: 2, rows: [{ associateId: 'a1', name: 'Ana Lopez', changes: [{ field: 'department', from: 'Front desk', to: 'Back office' }] }] });
    vi.mocked(applyMassUpdate).mockResolvedValue({ batchId: 'b1', affected: 2, undoUntil: '2026-10-18T12:00:00.000Z' });
    renderAs('HR_ADMINISTRATOR', <MassUpdate />);
    const preview = await screen.findByRole('button', { name: 'Preview' });
    expect(preview).toBeDisabled();
    const [whoDept, whatDept] = screen.getAllByLabelText('Department');
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Front desk' }).length).toBeGreaterThan(0));
    await userEvent.selectOptions(whoDept!, 'd1');
    await userEvent.selectOptions(whatDept!, 'd2');
    await userEvent.click(preview);
    expect(await screen.findByText(/will change/)).toHaveTextContent('2 of 2 matched people will change.');
    expect(screen.getAllByText('Ana Lopez').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Apply to 2' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(applyMassUpdate).toHaveBeenCalledWith({ departmentIds: ['d1'] }, { departmentId: 'd2' }));
  });
});

describe('compensation planning', () => {
  it("a manager's worksheet shows their share of the budget and saves a proposal on blur", async () => {
    vi.mocked(listCycles).mockResolvedValue({ cycles: [{ id: 'cy1', clientId: 'c1', name: 'FY27', status: 'OPEN', reviewPeriodStart: '2026-01-01', reviewPeriodEnd: '2026-12-31', effectiveDate: '2027-01-01', budget: '10000.00', appliedAt: null }] } as never);
    vi.mocked(getWorksheet).mockResolvedValue({
      cycle: { id: 'cy1', name: 'FY27', status: 'OPEN', effectiveDate: '2027-01-01', budget: '10000.00' },
      budget: { share: '5000.00', spent: 2080, remaining: 2920 },
      editable: true,
      rows: [{ id: 'mp1', associateId: 'a1', associateName: 'Ana Lopez', jobTitle: 'Cashier', managerId: 'm1', managerName: 'Mia Grant', payType: 'HOURLY', currentAmount: '20.00', proposedAmount: '21.00', increasePct: 5, status: 'DRAFT', proposedNotes: null, decisionNote: null, band: { name: 'Hourly', min: '15.00', mid: '20.00', max: '25.00' }, bandPositionNow: 50, bandPositionProposed: 60, lastRating: 4, lastReviewEnd: '2026-06-30' }],
    });
    vi.mocked(updateProposal).mockResolvedValue({ ok: true });
    renderAs('MANAGER', <CompPlanningTab clientId="c1" />, '/', { associateId: 'm1' });
    expect(await screen.findByText('$5,000.00')).toBeInTheDocument();
    // A line manager works their sheet; calibration is HR's.
    expect(screen.queryByRole('radio', { name: 'Calibration' })).not.toBeInTheDocument();
    const input = (await screen.findAllByLabelText('Proposed pay for Ana Lopez'))[0]!;
    await userEvent.clear(input);
    await userEvent.type(input, '22');
    input.blur();
    await waitFor(() => expect(updateProposal).toHaveBeenCalledWith('cy1', 'mp1', { proposedAmount: 22, status: 'SUBMITTED' }));
  });
});

describe('the role-differentiated first row', () => {
  it('the HR administrator sees the people desk', async () => {
    vi.mocked(getCaseSummary).mockResolvedValue({ openTotal: 7, byStatus: {}, byPriority: {}, byCategory: {}, sla: { breached: 2, atRisk: 1 } });
    vi.mocked(listPolicyCampaigns).mockResolvedValue({ campaigns: [] });
    renderAs('HR_ADMINISTRATOR', <RoleFocusRow />);
    expect(await screen.findByRole('region', { name: 'Your people desk' })).toBeInTheDocument();
    expect(await screen.findByText('2 past SLA · 1 due within 4h')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /HR cases open/ })).toHaveAttribute('href', '/hr-cases?sla=breached');
    expect(screen.getByRole('link', { name: /Credentials expiring/ })).toHaveTextContent('3');
  });

  it('a Manager has its own home, so no row here', () => {
    const { container } = renderAs('MANAGER', <RoleFocusRow />);
    expect(container).toBeEmptyDOMElement();
  });
});
