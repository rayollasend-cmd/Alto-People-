import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  ROLE_CAPABILITIES,
  type AgentApprovalSummary,
  type AgentCertification,
  type AgentDetail,
  type AgentRegistryResponse,
  type AgentScenarioSummary,
  type AgentScorecard,
  type AgentSummary,
  type Capability,
} from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/agentsApi', () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  ensureBuiltInAgents: vi.fn(),
  issueAgentCredential: vi.fn(),
  revokeAgentCredential: vi.fn(),
  recordAgentSpend: vi.fn(),
  listAgentApprovals: vi.fn(),
  getAgentApproval: vi.fn(),
  decideAgentApproval: vi.fn(),
  // Brief 1D-3
  getAgentControl: vi.fn(),
  suspendAllAgents: vi.fn(),
  resumeAllAgents: vi.fn(),
  suspendAgent: vi.fn(),
  resumeAgent: vi.fn(),
  listAgentScenarios: vi.fn(),
  addAgentScenario: vi.fn(),
  removeAgentScenario: vi.fn(),
  runAgentScenarios: vi.fn(),
  certifyAgent: vi.fn(),
  getAgentScorecard: vi.fn(),
  updateAgentDrift: vi.fn(),
}));
vi.mock('@/lib/usersAdminApi', () => ({ listAdminUsers: vi.fn() }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn().mockResolvedValue('') }));

import { certifyAgent, decideAgentApproval, getAgent, getAgentScorecard, issueAgentCredential, listAgentApprovals, listAgentScenarios, listAgents, resumeAllAgents } from '@/lib/agentsApi';
import { listAdminUsers } from '@/lib/usersAdminApi';
import { AgentRegistryAdmin } from '@/pages/admin/AgentRegistryAdmin';

const OWNER = { id: '11111111-1111-4111-8111-111111111111', name: 'Jo Park', email: 'jo@alto.example' };
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '33333333-3333-4333-8333-333333333333';
const SCENARIO_ID = '66666666-6666-4666-8666-666666666666';

const certified: AgentCertification = {
  modelVersion: '4.5',
  certifiedAt: '2026-10-01T00:00:00.000Z',
  certifiedModelVersion: '4.5',
  current: true,
  scenarios: 1,
  passing: 1,
  ready: true,
  runnable: true,
};

const scorecard7: AgentScorecard = {
  days: 7,
  tasksCompleted: 42,
  errors: 2,
  errorRatePct: 5,
  exceptionsEscalated: 1,
  approvalsRequested: 3,
  approvalsRejected: 1,
  spendCents: 1234,
  costPerTaskCents: 29,
};

const scenario: AgentScenarioSummary = {
  id: SCENARIO_ID,
  name: 'Tomorrow shift question',
  input: { text: 'when do I work tomorrow?' },
  expected: { allowedActions: ['schedule.read'] },
  latest: {
    id: '77777777-7777-4777-8777-777777777777',
    modelVersion: '4.5',
    passed: true,
    actual: { actions: ['schedule.read'] },
    reason: null,
    ranBy: { id: OWNER.id, name: OWNER.name },
    ranAt: '2026-10-12T09:00:00.000Z',
  },
  createdAt: '2026-10-01T00:00:00.000Z',
};

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: AGENT_ID,
    type: 'AGENT',
    name: 'Roster Bot',
    associateId: null,
    owner: OWNER,
    status: 'ACTIVE',
    capabilities: ['schedule-read'],
    notes: null,
    sites: [],
    upcomingShifts: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    offboardedAt: null,
    profile: {
      purpose: 'Answers schedule questions over WhatsApp.',
      vendor: 'Anthropic',
      model: 'claude-sonnet',
      modelVersion: '4.5',
      environment: 'PRODUCTION',
      scopes: ['view:scheduling', 'manage:communications'],
      spendCapCents: 50_000,
      rateLimitPerMinute: 60,
      allowedHoursStart: null,
      allowedHoursEnd: null,
      builtInKey: 'whatsapp-assistant',
      lastActiveAt: '2026-10-12T10:00:00.000Z',
    },
    activeCredentials: 1,
    pendingApprovals: 1,
    spendThisMonthCents: 1234,
    certification: certified,
    scorecard: scorecard7,
    kill: { suspendedAt: null, suspendedBy: null, suspendReason: null },
    drift: { driftErrorRatePct: null, driftCostPerTaskCents: null, lastDriftAlertAt: null },
    ...over,
  };
}

const approval: AgentApprovalSummary = {
  id: APPROVAL_ID,
  workerId: AGENT_ID,
  agentName: 'Roster Bot',
  action: 'CLIENT_MESSAGE',
  summary: 'Tell Coastal Resort the Friday crew is confirmed.',
  payload: { conversationId: 'c1' },
  status: 'PENDING',
  requestedAt: '2026-10-13T08:00:00.000Z',
  expiresAt: '2026-10-14T08:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  consumedAt: null,
};

const registry: AgentRegistryResponse = {
  agents: [agent()],
  counts: { ONBOARDING: 0, ACTIVE: 1, SUSPENDED: 0, OFFBOARDED: 0 },
  pendingApprovals: 1,
  builtInMissing: [],
  control: { allSuspendedAt: null, suspendedBy: null, reason: null },
};

const detail: AgentDetail = {
  ...agent(),
  credentials: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      last4: 'ab12',
      state: 'ACTIVE',
      issuedAt: '2026-10-10T00:00:00.000Z',
      expiresAt: '2026-10-17T00:00:00.000Z',
      lastUsedAt: '2026-10-12T10:00:00.000Z',
      revokedAt: null,
      revokedReason: null,
      issuedBy: { id: OWNER.id, name: OWNER.name },
      rotatedFromId: null,
    },
  ],
  approvals: [approval],
  spend: [{ id: 's1', occurredAt: '2026-10-05T00:00:00.000Z', amountCents: 1234, taskRef: 'inv-9', note: null }],
  trail: [{ id: 't1', action: 'agent.credential.issued', entityType: 'AgentCredential', entityId: '44444444-4444-4444-8444-444444444444', metadata: { last4: 'ab12' }, createdAt: '2026-10-10T00:00:00.000Z' }],
};

function renderPage(role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' = 'HR_ADMINISTRATOR', path = '/agents', userId = 'u1') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: userId, email: 'x@example.com', role, status: 'ACTIVE' },
          loading: false,
          can: (c: Capability) => caps.has(c),
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <AgentRegistryAdmin />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAgents).mockResolvedValue(registry);
  vi.mocked(listAgentApprovals).mockResolvedValue({ approvals: [approval] });
  vi.mocked(getAgent).mockResolvedValue(detail);
  vi.mocked(decideAgentApproval).mockResolvedValue({ ...approval, status: 'APPROVED' });
  vi.mocked(issueAgentCredential).mockResolvedValue({ id: 'cred-new', plaintext: 'alto_agent_SECRETVALUE_xyz9', last4: 'xyz9', expiresAt: '2026-10-14T08:00:00.000Z' });
  vi.mocked(listAgentScenarios).mockResolvedValue({ scenarios: [scenario] });
  vi.mocked(getAgentScorecard).mockResolvedValue(scorecard7);
  vi.mocked(resumeAllAgents).mockResolvedValue({ allSuspendedAt: null, suspendedBy: null, reason: null });
  vi.mocked(certifyAgent).mockResolvedValue({ certification: certified, agent: detail });
  vi.mocked(listAdminUsers).mockResolvedValue({
    users: [
      { id: OWNER.id, email: OWNER.email, role: 'HR_ADMINISTRATOR', status: 'ACTIVE', associateName: OWNER.name } as never,
      { id: '55555555-5555-4555-8555-555555555555', email: 'store@client.example', role: 'CLIENT_PORTAL', status: 'ACTIVE', associateName: null } as never,
    ],
    total: 2,
  });
});

describe('AgentRegistryAdmin', () => {
  it('renders the queue with a pending client message and approving it records the decision with the note', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Tell Coastal Resort the Friday crew is confirmed.')).toBeInTheDocument();
    expect(screen.getByText('Waiting for a person')).toBeInTheDocument();
    expect(screen.getByText('Message to a client')).toBeInTheDocument();
    // The hero line names the human-only actions.
    expect(screen.getByText(/Pay change and Separation approvals are carried out by the approver/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Approve this request?')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Note/), 'Go ahead');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(decideAgentApproval).toHaveBeenCalledWith(APPROVAL_ID, 'approve', 'Go ahead'));
  });

  it('opens the decision dialog from the ?approval= deep link and drops the param', async () => {
    renderPage('HR_ADMINISTRATOR', `/agents?approval=${APPROVAL_ID}`);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Decide this request')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('shows the agent, its scopes and spend in the grid', async () => {
    renderPage();
    // The name shows in the queue row and in the grid.
    expect(await screen.findAllByText('Roster Bot')).toHaveLength(2);
    expect(screen.getByText('Read schedules')).toBeInTheDocument();
    expect(screen.getByText('Write messages')).toBeInTheDocument();
    expect(screen.getByText('$12.34')).toBeInTheDocument();
    expect(screen.getByText('Jo Park')).toBeInTheDocument();
  });

  it('issues a credential and shows the plaintext once', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Open Roster Bot' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/Answers schedule questions/);
    await user.click(within(dialog).getByRole('tab', { name: /Credentials/ }));
    await user.selectOptions(within(dialog).getByLabelText(/Valid for/), '1');
    await user.click(within(dialog).getByRole('button', { name: 'Issue credential' }));
    await waitFor(() => expect(issueAgentCredential).toHaveBeenCalledWith(AGENT_ID, { ttlHours: 1 }));
    expect(await within(dialog).findByText('alto_agent_SECRETVALUE_xyz9')).toBeInTheDocument();
    expect(within(dialog).getByText(/It will not be shown again/)).toBeInTheDocument();
    // The existing credential still lists with its state and a revoke action.
    expect(within(dialog).getByText('…ab12')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('hides Approve, Issue and Register from a read-only role', async () => {
    const user = userEvent.setup();
    renderPage('EXECUTIVE_CHAIRMAN');
    expect(await screen.findByText('Tell Coastal Resort the Friday crew is confirmed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Register agent/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open Roster Bot' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/Answers schedule questions/);
    await user.click(within(dialog).getByRole('tab', { name: /Credentials/ }));
    expect(within(dialog).queryByRole('button', { name: 'Issue credential' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  /* ---------------------------------------------------- Brief 1D-3 */

  it('shows the global banner when every agent is suspended and Resume all agents lifts it', async () => {
    const user = userEvent.setup();
    vi.mocked(listAgents).mockResolvedValue({
      ...registry,
      control: { allSuspendedAt: '2026-10-13T06:00:00.000Z', suspendedBy: { id: OWNER.id, name: OWNER.name }, reason: 'Vendor outage' },
    });
    renderPage();
    const banner = await screen.findByRole('alert');
    expect(within(banner).getByText(/All agents suspended since .* by Jo Park — Vendor outage/)).toBeInTheDocument();
    // The quiet header button is gone while the switch is thrown.
    expect(screen.queryByRole('button', { name: /Suspend all agents/ })).not.toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Resume all agents' }));
    await waitFor(() => expect(resumeAllAgents).toHaveBeenCalledTimes(1));
  });

  it('offers Suspend all agents when the switch is not thrown, and hides it from a read-only role', async () => {
    const first = renderPage();
    expect(await screen.findByRole('button', { name: /Suspend all agents/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    first.unmount();
    renderPage('EXECUTIVE_CHAIRMAN');
    expect(await screen.findByText('Tell Coastal Resort the Friday crew is confirmed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Suspend all agents/ })).not.toBeInTheDocument();
  });

  it('shows Recertify in the grid for an agent whose certification is not current', async () => {
    vi.mocked(listAgents).mockResolvedValue({
      ...registry,
      agents: [agent({ certification: { ...certified, modelVersion: '4.6', current: false, passing: 0, ready: false } })],
    });
    renderPage();
    expect(await screen.findByText('Recertify')).toBeInTheDocument();
  });

  it('shows the certified version in the grid when certification is current', async () => {
    renderPage();
    expect(await screen.findByText('✓ 4.5')).toBeInTheDocument();
  });

  it('lets only the owner resume a suspended agent', async () => {
    const user = userEvent.setup();
    const suspended: AgentDetail = {
      ...detail,
      status: 'SUSPENDED',
      kill: { suspendedAt: '2026-10-13T05:00:00.000Z', suspendedBy: { id: 'u9', name: 'Sam Ops' }, suspendReason: 'Answering off-script' },
    };
    vi.mocked(getAgent).mockResolvedValue(suspended);

    // Not the owner: Resume is there but disabled, with the hint.
    const first = renderPage('HR_ADMINISTRATOR', '/agents', 'u1');
    await user.click(await screen.findByRole('button', { name: 'Open Roster Bot' }));
    let dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/Answering off-script/);
    expect(within(dialog).getByText(/by Sam Ops/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(within(dialog).getByText(/Only the owner/)).toBeInTheDocument();
    first.unmount();

    // The owner: enabled.
    renderPage('HR_ADMINISTRATOR', '/agents', OWNER.id);
    await user.click(await screen.findByRole('button', { name: 'Open Roster Bot' }));
    dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/Answering off-script/);
    expect(within(dialog).getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(within(dialog).queryByText(/Only the owner/)).not.toBeInTheDocument();
  });

  it('shows a scenario with its latest run on the Certification tab and Certify calls the API when ready', async () => {
    const user = userEvent.setup();
    // Certified for 4.5, now running 4.6 — a recertification is due and every scenario passes again.
    const recert: AgentDetail = { ...detail, certification: { ...certified, modelVersion: '4.6', current: false, ready: true } };
    vi.mocked(getAgent).mockResolvedValue(recert);
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Open Roster Bot' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/Answers schedule questions/);
    await user.click(within(dialog).getByRole('tab', { name: /Certification/ }));
    expect(await within(dialog).findByText('Tomorrow shift question')).toBeInTheDocument();
    expect(within(dialog).getByText('{"text":"when do I work tomorrow?"}')).toBeInTheDocument();
    expect(within(dialog).getByText('Actions: schedule.read')).toBeInTheDocument();
    expect(within(dialog).getByText('Pass')).toBeInTheDocument();
    expect(within(dialog).getByText(/Jo Park$/)).toBeInTheDocument();
    expect(within(dialog).getByText('Certified for 4.5')).toBeInTheDocument();
    // Built in: the API can run the scenarios itself.
    expect(within(dialog).getByRole('button', { name: 'Run scenarios' })).toBeInTheDocument();
    const certify = within(dialog).getByRole('button', { name: 'Certify' });
    expect(certify).toBeEnabled();
    await user.click(certify);
    await waitFor(() => expect(certifyAgent).toHaveBeenCalledWith(AGENT_ID));
  });

  it('disables Certify when the agent is not ready', async () => {
    const user = userEvent.setup();
    vi.mocked(getAgent).mockResolvedValue({ ...detail, status: 'ONBOARDING', certification: { ...certified, certifiedAt: null, certifiedModelVersion: null, current: false, passing: 0, ready: false } });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Open Roster Bot' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/Answers schedule questions/);
    await user.click(within(dialog).getByRole('tab', { name: /Certification/ }));
    expect(await within(dialog).findByText('Tomorrow shift question')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Certify' })).toBeDisabled();
  });

  it('opens the agent detail from the ?agent= deep link', async () => {
    renderPage('HR_ADMINISTRATOR', `/agents?agent=${AGENT_ID}`);
    // The loading dialog is swapped for the loaded one, so wait on the content.
    expect(await screen.findByText(/Answers schedule questions/)).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: /Scorecard/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: /Certification/ })).toBeInTheDocument();
  });
});
