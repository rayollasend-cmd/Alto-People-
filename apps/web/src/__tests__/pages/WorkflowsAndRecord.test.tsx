import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type ApprovalRequestSummary, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

vi.mock('@/lib/workflowsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/workflowsApi')>()),
  listWorkflows: vi.fn(async () => ({ definitions: [] })),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getRun: vi.fn(),
  createWorkflow: vi.fn(async () => ({ id: 'w', name: 'x', trigger: 'ASSOCIATE_HIRED', isActive: true })),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  testWorkflow: vi.fn(),
}));
vi.mock('@/lib/approvalRequestsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/approvalRequestsApi')>()),
  listWorkflowTasks: vi.fn(async () => ({ tasks: [] })),
  finishWorkflowTask: vi.fn(),
  listApprovalRequests: vi.fn(async () => ({ requests: [] })),
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) =>
    path.startsWith('/approvals/requests/people')
      ? { requesters: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Hana Ruiz' }], approvers: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Dana Reyes' }] }
      : { candidates: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Dana Reyes', email: 'dana@example.com', role: 'OPERATIONS_MANAGER' }] },
  ),
}));

import { createWorkflow, listRuns } from '@/lib/workflowsApi';
import { finishWorkflowTask, listApprovalRequests, listWorkflowTasks } from '@/lib/approvalRequestsApi';
import { WorkflowsHome } from '@/pages/workflows/WorkflowsHome';
import { ApprovalRecord } from '@/pages/audit/ApprovalRecord';
import { withDecider, deciderOf } from '@/pages/workflows/ApprovalGateEditor';

/**
 * The approval engine's last two screens: the workflow builder authors a
 * "Require approval" step (who decides, in the engine's terms) and shows a
 * WAITING run with the approval it waits on; the approval record filters the
 * tenant's requests and opens each to its before and after.
 */

function renderAt(ui: React.ReactElement, path: string) {
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
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('the workflow builder', () => {
  it('authors a "Require approval" step with a role, saved as the engine reads it', async () => {
    renderAt(<WorkflowsHome />, '/workflows');
    await userEvent.click(await screen.findByRole('button', { name: /new workflow/i }));
    await userEvent.type(screen.getByLabelText(/^Name/), 'Confirm hires');
    await userEvent.click(screen.getByRole('button', { name: /add action/i }));
    const kind = screen.getAllByRole('combobox').find((el) => within(el).queryByRole('option', { name: 'Require approval' }));
    expect(kind).toBeTruthy();
    await userEvent.selectOptions(kind!, 'REQUIRE_APPROVAL');
    const editor = await screen.findByTestId('approval-gate-editor');
    // Saving before naming who decides is refused on the page.
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(createWorkflow).not.toHaveBeenCalled();
    await userEvent.selectOptions(within(editor).getByLabelText(/^Role/), 'HR_ADMINISTRATOR');
    await userEvent.type(within(editor).getByLabelText(/^What they see/), 'Confirm the hire');
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
    const input = vi.mocked(createWorkflow).mock.calls[0][0];
    expect(input.actions[0]).toEqual({ kind: 'REQUIRE_APPROVAL', params: { role: 'HR_ADMINISTRATOR', title: 'Confirm the hire' } });
  });

  it('switching who decides keeps one decider only', () => {
    const p = withDecider({ role: 'HR_ADMINISTRATOR', title: 't' }, 'person', 'abc');
    expect(p).toEqual({ title: 't', userId: 'abc' });
    expect(deciderOf(p)).toBe('person');
    expect(withDecider(p, 'capability', '')).toEqual({ title: 't' });
  });

  it('a WAITING run names and links the approval it waits on', async () => {
    vi.mocked(listRuns).mockResolvedValue({
      runs: [{ id: 'run-1', definitionId: 'd', definitionName: 'Confirm hires', trigger: 'ASSOCIATE_HIRED', entityType: 'Associate', entityId: 'a', status: 'WAITING', waitingOn: { approvalId: '33333333-3333-4333-8333-333333333333', title: 'Confirm Ana', status: 'PENDING' }, startedAt: new Date().toISOString(), completedAt: null, failureReason: null, stepCount: 2, stepsCompleted: 0, stepsFailed: 0 }],
    });
    renderAt(<WorkflowsHome />, '/workflows?tab=runs');
    const link = (await screen.findAllByRole('link', { name: 'Confirm Ana' }))[0];
    expect(link).toHaveAttribute('href', '/approvals?tab=requests&approval=33333333-3333-4333-8333-333333333333');
    expect(screen.getAllByText('Waiting on approval').length).toBeGreaterThan(0);
  });

  it('the Tasks tab finishes what a workflow handed over', async () => {
    vi.mocked(listWorkflowTasks).mockResolvedValue({ tasks: [{ id: 't1', title: 'Welcome Ana on day one', details: null, assigneeUserId: null, assigneeRole: 'HR_ADMINISTRATOR', entityType: null, entityId: null, linkUrl: null, dueAt: null, status: 'OPEN', doneAt: null, createdAt: new Date().toISOString() }] });
    vi.mocked(finishWorkflowTask).mockResolvedValue({} as never);
    renderAt(<WorkflowsHome />, '/workflows?tab=tasks');
    expect((await screen.findAllByText('Welcome Ana on day one')).length).toBeGreaterThan(0);
    await userEvent.click(screen.getAllByRole('button', { name: /^done$/i })[0]);
    await waitFor(() => expect(finishWorkflowTask).toHaveBeenCalledWith('t1'));
  });
});

const recordRow: ApprovalRequestSummary = {
  id: '44444444-4444-4444-8444-444444444444',
  kind: 'BILL_RATE_CHANGE',
  status: 'APPROVED',
  subjectType: 'ShiftRateDefault',
  subjectId: '55555555-5555-4555-8555-555555555555',
  title: 'Picker: bill $27.00 → $29.00',
  summary: null,
  proposed: { clientId: 'c', position: 'Picker', payRate: 18, billRate: 29 },
  before: { payRate: 18, billRate: 27 },
  requester: { id: '11111111-1111-4111-8111-111111111111', name: 'Hana Ruiz' },
  approverRule: { capability: 'process:payroll', userId: null, role: null },
  clientId: null,
  associateId: null,
  decidedBy: { id: '22222222-2222-4222-8222-222222222222', name: 'Dana Reyes' },
  decidedAt: new Date().toISOString(),
  reason: null,
  appliedAt: new Date().toISOString(),
  applyError: null,
  createdAt: new Date().toISOString(),
  mayDecide: false,
};

describe('the approval record', () => {
  it('filters reach the server, and a row opens to its before and after', async () => {
    vi.mocked(listApprovalRequests).mockResolvedValue({ requests: [recordRow] });
    renderAt(<ApprovalRecord />, '/audit/approvals?status=APPROVED');
    expect((await screen.findAllByText('Picker: bill $27.00 → $29.00')).length).toBeGreaterThan(0);
    expect(listApprovalRequests).toHaveBeenCalledWith('all', expect.objectContaining({ status: 'APPROVED' }));

    await screen.findByRole('option', { name: 'Dana Reyes' });
    await userEvent.selectOptions(screen.getByLabelText('Filter by kind'), 'BILL_RATE_CHANGE');
    await userEvent.selectOptions(screen.getByLabelText('Filter by who decided'), '22222222-2222-4222-8222-222222222222');
    await waitFor(() =>
      expect(listApprovalRequests).toHaveBeenLastCalledWith('all', expect.objectContaining({ status: 'APPROVED', kind: 'BILL_RATE_CHANGE', approverUserId: '22222222-2222-4222-8222-222222222222' })),
    );

    await userEvent.click(screen.getAllByRole('button', { name: /before and after/i })[0]);
    const card = await screen.findByTestId('approval-request-card');
    expect(card).toHaveTextContent('$27.00/h');
    expect(card).toHaveTextContent('$29.00/h');
    expect(card).toHaveTextContent('Approved and applied');
    expect(card).toHaveTextContent('Dana Reyes');
  });
});
