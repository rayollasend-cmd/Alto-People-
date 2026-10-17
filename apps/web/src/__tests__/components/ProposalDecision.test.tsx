import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentApprovalSummary } from '@alto-people/shared';

/**
 * A proposal as a decision: the card shows what the agent proposes, the
 * evidence behind it (why, alternatives, impact, policy, who it touches),
 * the agent with its owner and the time left; Approve sends one decision;
 * Reject asks for a reason and will not send without one.
 */

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useTerm: () => (key: string) => (key === 'worker' ? 'Associate' : key === 'site' ? 'Property' : key),
  useAuth: () => ({ user: { id: 'me', email: 'pm@grandhotel.example', role: 'SHIFT_SUPERVISOR' }, can: () => true }),
}));

import { apiFetch } from '@/lib/api';
import { ProposalCard, ProposalList, timeLeft } from '@/components/agents/ProposalDecision';

const APPROVAL = '33333333-3333-4333-8333-333333333333';
const TESS = '44444444-4444-4444-8444-444444444444';
const HOTEL = '11111111-1111-4111-8111-111111111111';

const approval: AgentApprovalSummary = {
  id: APPROVAL,
  workerId: '22222222-2222-4222-8222-222222222222',
  agentName: 'Workforce agent',
  agentFamily: 'workforce',
  agentOwner: { id: 'u-hr', name: 'Dana Ortiz' },
  action: 'SHIFT_ASSIGN',
  summary: 'Assign Tess Free to Housekeeper at The Grand Hotel, Oct 14 7:00 AM–3:00 PM. The open-shift broadcast went unanswered.',
  payload: { associateId: TESS, subjectId: 'shift-1' },
  status: 'PENDING',
  requestedAt: new Date(Date.now() - 3_600_000).toISOString(),
  expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  consumedAt: null,
  proposalId: 'p-1',
  capabilityKey: 'shift.fill',
  evidence: {
    why: 'Tess Free is placed at The Grand Hotel, is free for Oct 14 7:00 AM–3:00 PM and has 16h scheduled this week — the fewest of anyone free on the bench.',
    alternatives: [
      { label: 'Omar Busy', note: 'already on a Housekeeper shift that overlaps' },
      { label: 'Leave it open', note: 'The shift starts in about 10 hours.' },
    ],
    impact: [
      { label: 'Overtime', value: 'None expected' },
      { label: "Tess's week", value: '16h → 24h scheduled' },
    ],
    policy: "Shift assignment always needs a person's approval (platform rule).",
    affects: [
      { kind: 'person', id: TESS, name: 'Tess Free' },
      { kind: 'site', id: HOTEL, name: 'The Grand Hotel' },
    ],
  },
  mayDecide: true,
};

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue({ ...approval, status: 'REJECTED', decisionNote: 'Tess asked for a lighter week', decidedBy: { id: 'me', name: 'Me' }, decidedAt: new Date().toISOString() } as never);
});

describe('<ProposalCard>', () => {
  it('renders the proposal, the evidence, the agent with its owner and the time left', () => {
    wrap(<ProposalCard approval={approval} />);
    expect(screen.getByRole('heading', { name: /Assign Tess Free to Housekeeper/ })).toBeInTheDocument();
    expect(screen.getByText('Workforce agent')).toBeInTheDocument();
    expect(screen.getByText(/owned by Dana Ortiz/)).toBeInTheDocument();
    expect(screen.getByText(/2 days left/)).toBeInTheDocument();
    // The evidence sections.
    expect(screen.getByText(/the fewest of anyone free on the bench/)).toBeInTheDocument();
    expect(screen.getByText('Omar Busy')).toBeInTheDocument();
    expect(screen.getByText(/already on a Housekeeper shift that overlaps/)).toBeInTheDocument();
    expect(screen.getByText('None expected')).toBeInTheDocument();
    expect(screen.getByText(/platform rule/)).toBeInTheDocument();
    // Who it touches, in the tenant's words.
    expect(screen.getByRole('link', { name: 'Tess Free' })).toBeInTheDocument();
    expect(screen.getByText('Associate')).toBeInTheDocument();
    expect(screen.getByText('Property')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'The Grand Hotel' })).toHaveAttribute('href', `/control-room?locationId=${HOTEL}`);
    // No raw enum anywhere.
    expect(screen.queryByText('SHIFT_ASSIGN')).not.toBeInTheDocument();
    expect(screen.getByText('Shift assignment')).toBeInTheDocument();
  });

  it('Approve sends one decision', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ ...approval, status: 'APPROVED', decidedBy: { id: 'me', name: 'Me' }, decidedAt: new Date().toISOString() } as never);
    const onDecided = vi.fn();
    wrap(<ProposalCard approval={approval} onDecided={onDecided} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/agents/approvals/${APPROVAL}/decide`, { method: 'POST', body: { decision: 'APPROVE' } }));
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
    expect(await screen.findByText(/^Approved$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('Reject asks for a reason and will not send without one', async () => {
    const user = userEvent.setup();
    wrap(<ProposalCard approval={approval} />);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const reason = screen.getByTestId('reject-reason');
    const confirm = screen.getByRole('button', { name: 'Confirm rejection' });
    expect(confirm).toBeDisabled();
    expect(apiFetch).not.toHaveBeenCalled();
    await user.type(reason, 'Tess asked for a lighter week');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`/agents/approvals/${APPROVAL}/decide`, {
        method: 'POST',
        body: { decision: 'REJECT', reason: 'Tess asked for a lighter week' },
      }),
    );
    // The card shows the decision and the reason.
    expect(await screen.findByText(/^Rejected$/)).toBeInTheDocument();
    expect(screen.getByText(/“Tess asked for a lighter week”/)).toBeInTheDocument();
  });

  it('shows no buttons to someone the rule does not name', () => {
    wrap(<ProposalCard approval={{ ...approval, mayDecide: false }} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getByText(/not yours to decide|the person your organization's rule names/)).toBeInTheDocument();
  });
});

describe('<ProposalList>', () => {
  it('lists proposals oldest-expiring first and says when the deep-linked one is gone', async () => {
    const onFocusMissing = vi.fn();
    const later = { ...approval, id: 'later', summary: 'Later one', expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() };
    wrap(<ProposalList approvals={[later, approval]} focusId="gone" onFocusMissing={onFocusMissing} />);
    const cards = screen.getAllByTestId('proposal-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent(/Assign Tess Free/);
    await waitFor(() => expect(onFocusMissing).toHaveBeenCalledTimes(1));
  });

  it('shows the empty state when nothing waits', () => {
    wrap(<ProposalList approvals={[]} emptyTitle="No agent proposals waiting" />);
    expect(screen.getByText('No agent proposals waiting')).toBeInTheDocument();
  });
});

describe('timeLeft', () => {
  it('reads as minutes, hours, days or expired', () => {
    const now = Date.now();
    expect(timeLeft(new Date(now + 30 * 60_000).toISOString(), now)).toBe('30 min left');
    expect(timeLeft(new Date(now + 5 * 3_600_000).toISOString(), now)).toBe('5h left');
    expect(timeLeft(new Date(now + 3 * 86_400_000).toISOString(), now)).toBe('3 days left');
    expect(timeLeft(new Date(now - 1).toISOString(), now)).toBe('Expired');
  });
});
