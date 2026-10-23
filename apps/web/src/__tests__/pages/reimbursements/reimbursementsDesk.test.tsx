import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';
import type { ReimbursementSummary } from '@/lib/reimbursements97Api';

const api = vi.hoisted(() => ({
  listReimbursements: vi.fn(),
  getReimbursementSummary: vi.fn(),
  settleReimbursementsBulk: vi.fn(),
  managerApproveReimbursement: vi.fn(),
  getReimbursement: vi.fn(),
}));
vi.mock('@/lib/reimbursements97Api', async (orig) => ({ ...(await orig<typeof import('@/lib/reimbursements97Api')>()), ...api }));

import { ReimbursementsHome } from '@/pages/reimbursements/ReimbursementsHome';

/**
 * /reimbursements opens on each role's own work (F500 G6): finance on what
 * is ready to settle (and settles several at once), a manager on what to
 * approve, the person submitting on their own open reports.
 */

const row = (o: Partial<ReimbursementSummary>): ReimbursementSummary => ({
  id: 'r1',
  associateId: 'a1',
  associateName: 'Jordan Reyes',
  title: 'Client lunch',
  description: null,
  totalAmount: '47.32',
  currency: 'USD',
  status: 'MANAGER_APPROVED',
  lineCount: 1,
  submittedAt: '2026-10-05T12:00:00.000Z',
  managerApprovedAt: null,
  settledAt: null,
  decidedAt: null,
  paidAt: null,
  rejectionReason: null,
  createdAt: '2026-10-05T12:00:00.000Z',
  ...o,
});

const SUMMARY = { toApprove: { count: 1, amount: 40.25 }, readyToSettle: { count: 2, amount: 120 }, queuedForPayroll: { count: 1, amount: 60 }, paidThisMonth: { count: 3, amount: 312.5 } };

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.getReimbursementSummary.mockResolvedValue(SUMMARY);
  api.listReimbursements.mockImplementation(async (p?: { status?: string }) => ({
    reimbursements:
      p?.status === 'MANAGER_APPROVED'
        ? [row({ id: 'r1', totalAmount: '100.10' }), row({ id: 'r2', title: 'Mileage', totalAmount: '19.90' })]
        : p?.status === 'SUBMITTED'
          ? [row({ id: 'r3', title: 'Hotel', status: 'SUBMITTED', totalAmount: '40.25' })]
          : [row({ id: 'r9', title: 'Gloves', status: 'DRAFT', totalAmount: '12.00' }), row({ id: 'r8', title: 'Boots', status: 'PAID', totalAmount: '80.00' })],
  }));
});

describe('finance', () => {
  it('opens on “Ready to settle” with the desk’s numbers, and no “New report”', async () => {
    renderAs('FINANCE_ACCOUNTANT', <ReimbursementsHome />, '/reimbursements');
    await waitFor(() => expect(api.listReimbursements).toHaveBeenCalledWith({ status: 'MANAGER_APPROVED' }));
    const strip = await screen.findByRole('group', { name: 'Expense reports at a glance' });
    await waitFor(() => expect(within(strip).getByRole('button', { name: /Ready to settle/ })).toHaveTextContent('$120.00'));
    expect(within(strip).getByRole('button', { name: /Ready to settle/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(strip).getByRole('button', { name: /Queued for next payroll/ })).toHaveTextContent('$60.00');
    expect(within(strip).getByRole('button', { name: /Paid this month/ })).toHaveTextContent('$312.50');
    expect(screen.queryByRole('button', { name: /New report/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve selected/ })).toBeNull();
  });

  it('settles the picked reports in one go', async () => {
    api.settleReimbursementsBulk.mockResolvedValue({ settled: [{ id: 'r1', amount: 100.1 }, { id: 'r2', amount: 19.9 }], skipped: [], amount: 120 });
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <ReimbursementsHome />, '/reimbursements');
    await user.click(await screen.findByRole('checkbox', { name: 'Select every report ready to settle' }));
    await user.click(await screen.findByRole('button', { name: 'Settle 2 reports · $120.00' }));
    await waitFor(() => expect(api.settleReimbursementsBulk).toHaveBeenCalledWith(['r1', 'r2']));
  });
});

describe('a manager', () => {
  it('opens on “To approve”', async () => {
    renderAs('MANAGER', <ReimbursementsHome />, '/reimbursements');
    await waitFor(() => expect(api.listReimbursements).toHaveBeenCalledWith({ status: 'SUBMITTED' }));
    expect(await screen.findByText('Hotel')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'To approve' })).toBeChecked();
  });
});

describe('the person submitting', () => {
  it('sees their open reports, “New report” up top, no export, no search under ten, and no $0.00 pending line', async () => {
    renderAs('ASSOCIATE', <ReimbursementsHome />, '/reimbursements', { associateId: 'a1' });
    expect(await screen.findByText('Gloves')).toBeInTheDocument();
    // Open hides the paid one; the three-way control is all the filtering there is.
    expect(screen.queryByText('Boots')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Open' })).toBeChecked();
    expect(screen.getAllByRole('button', { name: /New report/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByText(/Total pending/)).toBeNull();
    expect(api.getReimbursementSummary).not.toHaveBeenCalled();
  });

  it('“Queued for payroll”, not “Settled — queued”', async () => {
    api.listReimbursements.mockResolvedValue({ reimbursements: [row({ id: 'r5', title: 'Parking', status: 'SETTLED' })] });
    renderAs('ASSOCIATE', <ReimbursementsHome />, '/reimbursements', { associateId: 'a1' });
    expect(await screen.findByText('Queued for payroll')).toBeInTheDocument();
    expect(screen.queryByText(/Settled — queued/)).toBeNull();
  });
});
