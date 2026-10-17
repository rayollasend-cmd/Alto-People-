import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdminUser } from '@/lib/usersAdminApi';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/approvalRequestsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/approvalRequestsApi')>()),
  proposePromotion: vi.fn(),
  listPayChanges: vi.fn(),
  listPromotions: vi.fn(),
  listAccessGrants: vi.fn(async () => ({ grants: [] })),
  grantAccess: vi.fn(),
  revertAccessGrant: vi.fn(),
  createDelegation: vi.fn(),
  endDelegation: vi.fn(),
  listMyDelegations: vi.fn(async () => ({ given: [], covering: [] })),
}));
vi.mock('@/lib/orgApi', () => ({ listJobProfiles: vi.fn(async () => ({ jobProfiles: [{ id: '11111111-1111-4111-8111-111111111111', clientId: null, code: 'LEAD', title: 'Shift lead', family: null, level: 'L2', isExempt: false, description: null, wcClassCode: null }] })) }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async () => ({ candidates: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Dana Reyes', email: 'dana@example.com', role: 'OPERATIONS_MANAGER' }] })),
}));

import { createDelegation, grantAccess, isPending, listPayChanges, listPromotions, proposePromotion } from '@/lib/approvalRequestsApi';
import { PromoteDialog } from '@/pages/people/PromoteDialog';
import { PayChangesTab, PromotionsTab } from '@/pages/compensation/PayChangesTab';
import { ElevateAccessDialog } from '@/pages/admin/ElevateAccessDialog';
import { DelegationDialog } from '@/components/approvals/DelegationDialog';
import { changeRows, subjectPath } from '@/components/approvals/ApprovalRequestCard';

/**
 * The approval engine's screens: a promotion goes for approval (never
 * applies on the spot), Finance reads every pay change with its approval,
 * temporary access is a role until a date with a reason, and cover names a
 * person and days.
 */

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'hr@example.com', role: 'HR_ADMINISTRATOR' as const, status: 'ACTIVE' as const, clientId: null, associateId: null },
    role: 'HR_ADMINISTRATOR' as const,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  return render(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth as never}>
        <MemoryRouter>{ui}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('the approval engine screens', () => {
  it('Promote sends the seat, level, pay and date for approval', async () => {
    vi.mocked(proposePromotion).mockResolvedValue({} as never);
    const onOpenChange = vi.fn();
    wrap(<PromoteDialog associate={{ id: '33333333-3333-4333-8333-333333333333', firstName: 'Ana', lastName: 'Lopez' }} currentAmount={20} currentPayType="HOURLY" open onOpenChange={onOpenChange} />);
    expect(screen.getByText(/Today: \$20\.00 per hour/)).toBeInTheDocument();
    const send = screen.getByRole('button', { name: /send for approval/i });
    expect(send).toBeDisabled();
    await screen.findByRole('option', { name: /Shift lead/ });
    await userEvent.selectOptions(screen.getByLabelText(/^Job profile/), '11111111-1111-4111-8111-111111111111');
    await userEvent.type(screen.getByLabelText(/^New pay/), '24');
    await userEvent.click(send);
    await waitFor(() => expect(proposePromotion).toHaveBeenCalled());
    expect(vi.mocked(proposePromotion).mock.calls[0][0]).toMatchObject({ associateId: '33333333-3333-4333-8333-333333333333', jobProfileId: '11111111-1111-4111-8111-111111111111', amount: 24, payType: 'HOURLY' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('Pay changes show who, before → after, and the approval behind each', async () => {
    vi.mocked(listPayChanges).mockResolvedValue({
      changes: [
        { id: '44444444-4444-4444-8444-444444444444', at: new Date().toISOString(), kind: 'pay', actor: { id: 'a', name: 'Dana Reyes' }, associateId: '33333333-3333-4333-8333-333333333333', associateName: 'Ana Lopez', clientId: null, position: null, before: { amount: 20, payType: 'HOURLY' }, after: { amount: 25, payType: 'HOURLY' }, effectiveFrom: '2026-11-01', reason: 'MERIT', approvalRequestId: '55555555-5555-4555-8555-555555555555', note: null },
        { id: '66666666-6666-4666-8666-666666666666', at: new Date().toISOString(), kind: 'bill', actor: { id: 'b', name: 'Hana Ruiz' }, associateId: null, associateName: null, clientId: null, position: 'Stocker', before: null, after: { payRate: 19, billRate: 31 }, effectiveFrom: '2026-11-01', reason: null, approvalRequestId: null, note: 'No second approver was available.' },
      ],
    });
    wrap(<PayChangesTab />);
    expect((await screen.findAllByText('Ana Lopez')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\$20\.00 → \$25\.00/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Second person' })).toHaveAttribute('href', '/approvals?tab=requests&approval=55555555-5555-4555-8555-555555555555');
    expect(screen.getAllByText('No second approver was available.').length).toBeGreaterThan(0);
  });

  it('Promotions list says where each stands', async () => {
    vi.mocked(listPromotions).mockResolvedValue({
      promotions: [{ id: '77777777-7777-4777-8777-777777777777', associateId: '33333333-3333-4333-8333-333333333333', associateName: 'Ana Lopez', jobProfileId: null, jobProfileTitle: 'Shift lead', newTitle: null, level: 'L2', payType: 'HOURLY', amount: '24.00', currentAmount: '20.00', effectiveFrom: '2026-11-01', notes: null, status: 'PENDING', approvalRequestId: '55555555-5555-4555-8555-555555555555', requestedBy: null, letterDocumentId: null, appliedAt: null, createdAt: new Date().toISOString() }],
    });
    wrap(<PromotionsTab />);
    expect((await screen.findAllByText('Ana Lopez')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Waiting').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Shift lead · level L2/).length).toBeGreaterThan(0);
  });

  it('temporary access is a role until a date, with a reason', async () => {
    vi.mocked(grantAccess).mockResolvedValue({} as never);
    const user = { id: '88888888-8888-4888-8888-888888888888', email: 'fin@example.com', role: 'FINANCE_ACCOUNTANT', additionalRoles: [], status: 'ACTIVE', associateName: 'Fin Person' } as unknown as AdminUser;
    wrap(<ElevateAccessDialog user={user} onClose={() => undefined} onChanged={() => undefined} />);
    const grant = screen.getByRole('button', { name: /grant until then/i });
    expect(grant).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText(/^Role/), 'HR_ADMINISTRATOR');
    await userEvent.type(screen.getByLabelText(/^Reason/), 'Year-end close');
    await userEvent.click(grant);
    await waitFor(() => expect(grantAccess).toHaveBeenCalled());
    expect(vi.mocked(grantAccess).mock.calls[0][0]).toMatchObject({ userId: user.id, role: 'HR_ADMINISTRATOR', reason: 'Year-end close' });
  });

  it('cover names a person and the days', async () => {
    vi.mocked(createDelegation).mockResolvedValue({} as never);
    wrap(<DelegationDialog open onOpenChange={() => undefined} />);
    await screen.findByRole('option', { name: /Dana Reyes/ });
    await userEvent.selectOptions(screen.getByLabelText(/^Who covers you/), '22222222-2222-4222-8222-222222222222');
    await userEvent.click(screen.getByRole('button', { name: /set cover/i }));
    await waitFor(() => expect(createDelegation).toHaveBeenCalled());
    expect(vi.mocked(createDelegation).mock.calls[0][0]).toMatchObject({ toUserId: '22222222-2222-4222-8222-222222222222' });
  });

  it('a 202 reads as pending; requests describe their change and link their subject', () => {
    expect(isPending({ pending: true, approvalId: 'x', title: 't' })).toBe(true);
    expect(isPending(undefined)).toBe(false);
    const base = { id: 'r', status: 'PENDING', subjectType: 'Position', subjectId: 'p', title: 't', summary: null, requester: null, approverRule: { capability: null, userId: null, role: null }, clientId: null, associateId: null, decidedBy: null, decidedAt: null, reason: null, appliedAt: null, applyError: null, createdAt: '', mayDecide: true } as const;
    const req = { ...base, kind: 'REQUISITION' as const, proposed: { budgetAmount: 42000, budgetPeriod: 'ANNUAL', fteAuthorized: 1 }, before: { status: 'PLANNED' } };
    expect(changeRows(req)).toEqual([
      { label: 'Status', before: 'planned', after: 'open' },
      { label: 'Budget', before: null, after: '$42,000.00 per year' },
      { label: 'FTE', before: null, after: '1' },
    ]);
    expect(subjectPath(req)).toBe('/org?tab=positions');
  });
});
