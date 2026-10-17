import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ROLE_CAPABILITIES, type AgentDetail, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';

vi.mock('@/lib/agentsApi', () => ({
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
  listAgentCapabilities: vi.fn(),
  getCapabilityScorecard: vi.fn(),
  suspendAgentCapability: vi.fn(),
  resumeAgentCapability: vi.fn(),
  issueAgentCredential: vi.fn(),
  revokeAgentCredential: vi.fn(),
  recordAgentSpend: vi.fn(),
  suspendAgent: vi.fn(),
  resumeAgent: vi.fn(),
  listAgentScenarios: vi.fn(),
  addAgentScenario: vi.fn(),
  removeAgentScenario: vi.fn(),
  runAgentScenarios: vi.fn(),
  certifyAgent: vi.fn(),
  getAgentScorecard: vi.fn(),
  updateAgentDrift: vi.fn(),
  listAgents: vi.fn(),
  listAgentApprovals: vi.fn(),
  decideAgentApproval: vi.fn(),
  getAgentControl: vi.fn(),
  suspendAllAgents: vi.fn(),
  resumeAllAgents: vi.fn(),
  ensureBuiltInAgents: vi.fn(),
  createAgent: vi.fn(),
}));
vi.mock('@/lib/usersAdminApi', () => ({ listAdminUsers: vi.fn().mockResolvedValue({ users: [], total: 0 }) }));
vi.mock('@/lib/hugoApi', () => ({ getHugo: vi.fn().mockResolvedValue({ name: 'Hugo', audience: 'admin', intro: '', can: [] }), askHugo: vi.fn(), listProposals: vi.fn().mockResolvedValue({ proposals: [] }) }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn().mockResolvedValue('') }));
// The decision record is read straight through apiFetch; one decision on file.
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  apiFetch: vi.fn(async (path: string) => {
    if (path.endsWith('/decision-record')) {
      return {
        profiles: [],
        audits: [],
        decisions: [
          { id: 'd1', at: '2026-10-12T09:00:00.000Z', capabilityKey: 'shift.fill', decisionType: 'SCHEDULING', subject: 'Maria Lopez', outcome: 'FAVORABLE', summary: 'Placed on Friday', jurisdictionTags: [], humanDecidedAt: null, noticeGivenAt: null, explanationSentAt: null, reviewRequestedAt: null },
        ],
      };
    }
    return {};
  }),
}));

import { getAgent, listAgentCapabilities, getAgentScorecard, listAgentScenarios } from '@/lib/agentsApi';
import { AgentRecordPage } from '@/pages/admin/AgentRecordPage';

const OWNER = { id: '11111111-1111-4111-8111-111111111111', name: 'Jo Park', email: 'jo@alto.example', associateId: 'assoc-jo' };
const AGENT_ID = '22222222-2222-4222-8222-222222222222';

const detail: AgentDetail = {
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
    model: 'Claude Sonnet',
    modelVersion: '4.5',
    environment: 'PRODUCTION',
    scopes: ['view:scheduling'],
    spendCapCents: 50_000,
    rateLimitPerMinute: 60,
    allowedHoursStart: null,
    allowedHoursEnd: null,
    builtInKey: 'whatsapp-assistant',
    lastActiveAt: '2026-10-12T10:00:00.000Z',
    family: 'associate-self-service',
    capability: 'Answers questions',
  },
  activeCredentials: 1,
  pendingApprovals: 0,
  spendThisMonthCents: 1234,
  certification: { modelVersion: '4.5', certifiedAt: '2026-10-01T00:00:00.000Z', certifiedModelVersion: '4.5', current: true, scenarios: 0, passing: 0, ready: false, runnable: true },
  scorecard: { days: 7, tasksCompleted: 42, errors: 2, errorRatePct: 5, exceptionsEscalated: 1, approvalsRequested: 3, approvalsRejected: 1, spendCents: 1234, costPerTaskCents: 29 },
  kill: { suspendedAt: null, suspendedBy: null, suspendReason: null },
  drift: { driftErrorRatePct: null, driftCostPerTaskCents: null, lastDriftAlertAt: null },
  credentials: [
    { id: 'c1', last4: 'ab12', state: 'ACTIVE', issuedAt: '2026-10-10T00:00:00.000Z', expiresAt: '2026-10-17T00:00:00.000Z', lastUsedAt: null, revokedAt: null, revokedReason: null, issuedBy: { id: OWNER.id, name: OWNER.name }, rotatedFromId: null },
  ],
  approvals: [
    { id: 'ap1', workerId: AGENT_ID, agentName: 'Roster Bot', action: 'CLIENT_MESSAGE', summary: 'Tell Coastal Resort the Friday crew is confirmed.', payload: {}, status: 'APPROVED', requestedAt: '2026-10-13T08:00:00.000Z', expiresAt: '2026-10-14T08:00:00.000Z', decidedBy: { id: OWNER.id, name: OWNER.name }, decidedAt: '2026-10-13T09:00:00.000Z', decisionNote: null, consumedAt: null },
  ],
  spend: [],
  trail: [
    { id: 't1', action: 'agent.credential.issued', entityType: 'AgentCredential', entityId: 'c1', metadata: { last4: 'ab12' }, createdAt: '2026-10-10T00:00:00.000Z' },
    { id: 't2', action: 'agent.approval.requested', entityType: 'AgentApprovalRequest', entityId: 'ap1', metadata: null, createdAt: '2026-10-13T08:00:00.000Z' },
  ],
};

function renderPage(role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' = 'HR_ADMINISTRATOR') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'x@example.com', role, status: 'ACTIVE' },
          tenant: DEFAULT_TENANT,
          loading: false,
          can: (c: Capability) => caps.has(c),
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[`/agents/${AGENT_ID}`]}>
          <Routes>
            <Route path="/agents/:id" element={<AgentRecordPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAgent).mockResolvedValue(detail);
  vi.mocked(listAgentCapabilities).mockResolvedValue({
    capabilities: [
      { key: 'shift.fill', label: 'Fill open shifts', family: 'workforce', gate: 'SHIFT_ASSIGN', requiresModule: ['scheduling'], offered: true, enabled: true, suspendedAt: null, suspendedBy: null, suspendReason: null, driftErrorRatePct: null },
      { key: 'attendance.confirm', label: 'Confirm tomorrow’s attendance', family: 'workforce', gate: 'SHIFT_ASSIGN', requiresModule: ['scheduling'], offered: true, enabled: true, suspendedAt: null, suspendedBy: null, suspendReason: null, driftErrorRatePct: null },
    ],
  });
  vi.mocked(getAgentScorecard).mockResolvedValue(detail.scorecard!);
  vi.mocked(listAgentScenarios).mockResolvedValue({ scenarios: [] });
});

describe('AgentRecordPage', () => {
  it('opens read-only, as a record: owner as a person, model in words, and Edit turns the profile into the form', async () => {
    const user = userEvent.setup();
    renderPage();
    const profile = await screen.findByTestId('agent-profile');
    // The owner is a person with a record.
    const owner = within(profile).getByRole('link', { name: /Jo Park/ });
    expect(owner).toHaveAttribute('href', '/people/assoc-jo');
    expect(within(profile).getByText('Answers schedule questions over WhatsApp.')).toBeInTheDocument();
    expect(within(profile).getByText('Anthropic · Claude Sonnet 4.5')).toBeInTheDocument();
    expect(within(profile).getByText(/ships with the product/)).toBeInTheDocument();
    // No form yet.
    expect(screen.queryByLabelText(/Purpose/)).not.toBeInTheDocument();
    // The subtitle says family, owner and status in words only.
    expect(screen.getByText('Associate Self-Service · owned by Jo Park · active')).toBeInTheDocument();
    // Breadcrumb: People › Agents › the agent.
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/agents');

    await user.click(screen.getByRole('button', { name: /Edit/ }));
    expect(await screen.findByLabelText(/Purpose/)).toHaveValue('Answers schedule questions over WhatsApp.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('agent-profile')).toBeInTheDocument();
  });

  it('puts Suspend in the actions, and counts proposals, capabilities and decisions on their tabs', async () => {
    renderPage();
    await screen.findByTestId('agent-profile');
    expect(screen.getByRole('button', { name: /Suspend/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Proposals/ })).toHaveTextContent('(1)');
    expect(await screen.findByRole('tab', { name: /Capabilities & gates/ })).toHaveTextContent('(2)');
    expect(await screen.findByRole('tab', { name: /Decision record/ })).toHaveTextContent('(1)');
    expect(screen.queryByRole('tab', { name: /Requests/ })).not.toBeInTheDocument();
  });

  it('reads the trail in words, with the entity named and no raw code or id on screen', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('agent-profile');
    await user.click(screen.getByRole('tab', { name: /Trail/ }));
    expect(await screen.findByText('Credential issued')).toBeInTheDocument();
    expect(screen.getByText('Credential …ab12')).toBeInTheDocument();
    expect(screen.getByText('Asked for approval')).toBeInTheDocument();
    expect(screen.getByText('Proposal: Tell Coastal Resort the Friday crew is confirmed.')).toBeInTheDocument();
    expect(screen.queryByText('agent.credential.issued')).not.toBeInTheDocument();
    expect(screen.queryByText('AgentCredential')).not.toBeInTheDocument();
  });

  it('says an agent attested at registration is certified with no scenario yet', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('agent-profile');
    await user.click(screen.getByRole('tab', { name: /^Certification$/ }));
    expect(await screen.findByText(/Attested at registration/)).toBeInTheDocument();
    expect(screen.queryByText(/GET \/agent\/v1/)).not.toBeInTheDocument();
  });

  it('hides Edit and Suspend from a read-only role', async () => {
    renderPage('EXECUTIVE_CHAIRMAN');
    await screen.findByTestId('agent-profile');
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Suspend/ })).not.toBeInTheDocument();
  });
});
