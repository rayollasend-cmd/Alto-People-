import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PLATFORM_OPERATOR_TENANT_ID, ROLE_CAPABILITIES, type AgentRegistryResponse, type AgentSummary, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';

vi.mock('@/lib/agentsApi', () => ({
  listAgents: vi.fn(),
  getAgentControl: vi.fn(),
  suspendAllAgents: vi.fn(),
  resumeAllAgents: vi.fn(),
  getPlatformControl: vi.fn(),
  suspendPlatformAgents: vi.fn(),
  resumePlatformAgents: vi.fn(),
  listDecisionRecords: vi.fn(),
}));
vi.mock('@/lib/usersAdminApi', () => ({ listAdminUsers: vi.fn().mockResolvedValue({ users: [], total: 0 }) }));
vi.mock('@/lib/hugoApi', () => ({ getHugo: vi.fn().mockResolvedValue({ name: 'Hugo', audience: 'admin', intro: '', can: [] }), askHugo: vi.fn(), listProposals: vi.fn().mockResolvedValue({ proposals: [] }) }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn().mockResolvedValue('Incident 7') }));
// The gates panel and the MCP catalog read through apiFetch.
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/agents/gates') {
      return {
        policies: [
          { id: 'g1', scope: 'TENANT', scopeKey: null, action: '*', requirement: 'REQUIRED', approver: 'OWNER', approverRole: null, approverUserId: null, ttlHours: 72, effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: null, inForce: true },
          { id: 'g2', scope: 'TENANT', scopeKey: null, action: '*', requirement: 'REQUIRED', approver: 'OWNER', approverRole: null, approverUserId: null, ttlHours: 72, effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: '2026-09-30T00:00:00.000Z', inForce: false },
        ],
      };
    }
    if (path === '/agents/mcp-catalog') {
      return { preview: true, tools: [{ name: 'schedule_read', title: 'Read schedules', description: '', effect: 'read', gate: null, family: 'workforce' }] };
    }
    return {};
  }),
}));

import { getPlatformControl, listAgents, listDecisionRecords, suspendPlatformAgents } from '@/lib/agentsApi';
import { AgentGovernance } from '@/pages/admin/AgentGovernance';

const OWNER = { id: '11111111-1111-4111-8111-111111111111', name: 'Jo Park', email: 'jo@alto.example' };

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    type: 'AGENT',
    name: 'Roster Bot',
    associateId: null,
    owner: OWNER,
    status: 'ACTIVE',
    capabilities: [],
    notes: null,
    sites: [],
    upcomingShifts: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    offboardedAt: null,
    profile: { purpose: 'Answers.', vendor: 'Anthropic', model: 'Claude Sonnet', modelVersion: '4.5', environment: 'PRODUCTION', scopes: [], spendCapCents: null, rateLimitPerMinute: 60, allowedHoursStart: null, allowedHoursEnd: null, builtInKey: null, lastActiveAt: null, family: 'workforce', capability: null },
    activeCredentials: 1,
    pendingApprovals: 0,
    spendThisMonthCents: 0,
    certification: { modelVersion: '4.5', certifiedAt: '2026-10-01T00:00:00.000Z', certifiedModelVersion: '4.5', current: true, scenarios: 2, passing: 2, ready: true, runnable: true },
    kill: { suspendedAt: null, suspendedBy: null, suspendReason: null },
    drift: { driftErrorRatePct: null, driftCostPerTaskCents: null, lastDriftAlertAt: null },
    ...over,
  };
}

const registry: AgentRegistryResponse = {
  agents: [agent(), agent({ id: '33333333-3333-4333-8333-333333333333', name: 'Compliance agent', activeCredentials: 0, certification: { modelVersion: '4.6', certifiedAt: '2026-09-01T00:00:00.000Z', certifiedModelVersion: '4.5', current: false, scenarios: 1, passing: 0, ready: false, runnable: true } })],
  counts: { ONBOARDING: 0, ACTIVE: 2, SUSPENDED: 0, OFFBOARDED: 0 },
  pendingApprovals: 0,
  builtInMissing: [],
  control: { allSuspendedAt: null, suspendedBy: null, reason: null },
  platformControl: { allSuspendedAt: null, suspendedBy: null, reason: null },
};

function renderPage(role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' = 'HR_ADMINISTRATOR', tenantId = '') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'x@example.com', role, status: 'ACTIVE' },
          tenant: { ...DEFAULT_TENANT, id: tenantId },
          loading: false,
          can: (c: Capability) => caps.has(c),
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/admin/agents']}>
          <AgentGovernance />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAgents).mockResolvedValue(registry);
  vi.mocked(getPlatformControl).mockResolvedValue({ allSuspendedAt: null, suspendedBy: null, reason: null });
  vi.mocked(suspendPlatformAgents).mockResolvedValue({ revoked: 3, agents: 2 });
  vi.mocked(listDecisionRecords).mockResolvedValue({
    total: 1,
    decisions: [
      { id: 'd1', at: '2026-10-12T09:00:00.000Z', agentId: registry.agents[0].id, agentName: 'Roster Bot', capabilityKey: 'shift.fill', decisionType: 'SCHEDULING', subject: 'Maria Lopez', subjectAssociateId: 'a1', outcome: 'FAVORABLE', summary: 'Placed on Friday', humanDecidedAt: '2026-10-12T10:00:00.000Z', noticeGivenAt: null, explanationSentAt: null, reviewRequestedAt: null },
    ],
  });
});

describe('AgentGovernance', () => {
  it('is one Settings page of open sections: gates, certification, credentials, MCP tools, the decision record, the switch', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Agents & gates' })).toBeInTheDocument();
    // Gates: open, with the count of policies in force.
    expect(await screen.findByText('1 policy in force')).toBeInTheDocument();
    expect(screen.getByTestId('agent-gates')).toBeInTheDocument();
    // Certification reads as the record does: current for the version it runs.
    expect(await screen.findByText('1 of 2 certified for the version they run')).toBeInTheDocument();
    expect(screen.getByText('Recertify')).toBeInTheDocument();
    expect(screen.getByText('✓ 4.5')).toBeInTheDocument();
    // Credentials across agents.
    expect(screen.getByText('1 live credential')).toBeInTheDocument();
    const creds = screen.getByRole('list', { name: 'Credentials by agent' });
    expect(within(creds).getByRole('link', { name: 'Roster Bot' })).toHaveAttribute('href', `/agents/${registry.agents[0].id}?tab=credentials`);
    expect(within(creds).queryByText('Compliance agent')).not.toBeInTheDocument();
    // MCP tools, open.
    expect(await screen.findByText('schedule_read')).toBeInTheDocument();
    // The decision record across agents.
    expect(await screen.findByText('1 decision')).toBeInTheDocument();
    expect(screen.getByText('Scheduling')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Maria Lopez' })).toHaveAttribute('href', '/people/a1');
    expect(screen.getByText('Fill open shifts · Placed on Friday')).toBeInTheDocument();
    // The organization's switch, off, with its action; no platform switch for an ordinary tenant.
    expect(screen.getByRole('heading', { name: 'Stop every agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Suspend all agents/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Platform switch' })).not.toBeInTheDocument();
  });

  it('shows the platform switch to the operator alone, and throws it with a reason', async () => {
    const user = userEvent.setup();
    renderPage('HR_ADMINISTRATOR', PLATFORM_OPERATOR_TENANT_ID);
    expect(await screen.findByRole('heading', { name: 'Platform switch' })).toBeInTheDocument();
    const stop = await screen.findByRole('button', { name: /Stop every organization’s agents/ });
    expect(screen.getByTestId('platform-switch')).toHaveTextContent(/^Off/);
    await user.click(stop);
    await waitFor(() => expect(suspendPlatformAgents).toHaveBeenCalledWith('Incident 7'));
  });

  it('hides every switch and policy action from a read-only role', async () => {
    renderPage('EXECUTIVE_CHAIRMAN');
    expect(await screen.findByRole('heading', { name: 'Agents & gates' })).toBeInTheDocument();
    await screen.findByText('1 of 2 certified for the version they run');
    expect(screen.queryByRole('button', { name: /Suspend all agents/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add policy' })).not.toBeInTheDocument();
  });
});
