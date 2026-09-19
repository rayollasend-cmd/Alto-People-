import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import type { ActivityNote, Lane, LaneStage, RelayBoardData } from '@/pages/relay/relayTypes';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { RelayBoard } from '@/pages/relay/RelayBoard';

/**
 * The relay as the room the desks work in: it opens on your desk, names
 * who holds each baton and lane (claim one, hand it on), the pipeline
 * filters by stage, a lane opens to its timeline, next move and thread,
 * and a ruling owed to your desk is answered right on the board.
 */

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

function stages(current: LaneStage['key'], overdue: boolean): LaneStage[] {
  const order: Array<[LaneStage['key'], LaneStage['desk']]> = [
    ['approved', 'HR'],
    ['scheduled', 'WORKFORCE'],
    ['fieldglass', 'FINANCE'],
    ['firstShift', 'WORKFORCE'],
    ['hoursApproved', 'WORKFORCE'],
    ['paycheck', 'FINANCE'],
  ];
  const at = order.findIndex(([k]) => k === current);
  return order.map(([key, desk], i) => ({
    key,
    desk,
    done: i < at,
    at: i < at ? iso(-10 + i) : null,
    dueAt: i === at ? iso(overdue ? -1 : 2) : null,
    overdue: i === at && overdue,
  }));
}

const lane = (associateId: string, name: string, current: LaneStage['key'], overdue: boolean): Lane => ({
  associateId,
  name,
  clientName: 'Coastal Resort',
  approvedAt: iso(-12),
  stages: stages(current, overdue),
  currentStage: current,
  stalled: overdue,
  completed: false,
  cohortId: null,
  notes: associateId === 'jay' ? 3 : 0,
});

const BOARD: RelayBoardData = {
  generatedAt: new Date().toISOString(),
  promise: { keptPct: 92, completed: 12, medianDays: 14, windowDays: 45 },
  lanes: [lane('jay', 'Jay Patel', 'fieldglass', true), lane('leo', 'Leo Ramos', 'scheduled', true), lane('nia', 'Nia Carter', 'fieldglass', false)],
  cohorts: [],
  recentKept: [],
  batons: [
    { key: 'fieldglass-add', label: 'Fieldglass adds', desk: 'FINANCE', count: 5, oldestAt: null, dueOn: null, status: 'overdue', link: '/fieldglass' },
    { key: 'timesheets', label: 'Timesheets awaiting approval', desk: 'WORKFORCE', count: 6, oldestAt: iso(-1), dueOn: null, status: 'overdue', link: '/time-attendance' },
    { key: 'settlements', label: 'Reimbursements to settle', desk: 'FINANCE', count: 0, oldestAt: null, dueOn: null, status: 'quiet', link: '/reimbursements' },
  ],
  agenda: [{ severity: 'red', desk: 'WORKFORCE', text: 'Timesheets awaiting approval: 6 overdue.', link: '/time-attendance' }],
  desks: {
    HR: [{ userId: 'u-hr', name: 'Hana Reed', photoUrl: null }],
    WORKFORCE: [{ userId: 'u-wf', name: 'Wes Ford', photoUrl: null }],
    FINANCE: [{ userId: 'u-fin', name: 'Fay Inman', photoUrl: null }],
  },
  claims: { 'LANE:jay': { userId: 'u-wf', name: 'Wes Ford', photoUrl: null, claimedAt: iso(-1), claimedByName: 'Hana Reed' } },
  me: { userId: 'u-fin', desk: 'FINANCE' },
};

const note = (id: string, body: string, over: Partial<ActivityNote> = {}): ActivityNote => ({
  id,
  body,
  mentions: [],
  createdAt: iso(-0.2),
  author: { name: 'Wes Ford', photoUrl: null },
  subject: { associateId: 'jay', name: 'Jay Patel' },
  decisionDesk: null,
  decisionStatus: null,
  decisionNote: null,
  decidedAt: null,
  decidedByName: null,
  ...over,
});

function renderRelay(initial = '/relay') {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, method: init?.method, body: init?.body });
    if (path === '/relay/board') return BOARD as never;
    if (path === '/relay/activity') {
      return {
        decisions: [note('n2', 'Approve a retro-dated start so last week bills?', { decisionDesk: 'FINANCE', decisionStatus: 'PENDING' })],
        notes: [note('n1', 'Can Finance register him today?', { mentions: ['FINANCE'] })],
      } as never;
    }
    if (path === '/client-requests') return { requests: [] } as never;
    if (path.startsWith('/work-notes?')) return { notes: [] } as never;
    if (path === '/relay/claims') return { claim: { userId: 'u-fin', name: 'Fay Inman', photoUrl: null, claimedAt: iso(0), claimedByName: 'Fay Inman' } } as never;
    if (path === '/work-notes/n2/decide') return { ok: true } as never;
    throw new Error(`unexpected ${path}`);
  });
  const caps = ROLE_CAPABILITIES.FINANCE_ACCOUNTANT;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u-fin', email: 'fin@altohr.com', role: 'FINANCE_ACCOUNTANT', status: 'ACTIVE' as const, clientId: null, associateId: null },
          role: 'FINANCE_ACCOUNTANT',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter initialEntries={[initial]}>
          <RelayBoard />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return calls;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the relay', () => {
  it('opens on your desk — its batons, its lanes — and every desk is a tap away', async () => {
    renderRelay();
    const finance = await screen.findByRole('button', { name: /Finance\s*your desk/ });
    expect(finance).toHaveAttribute('aria-pressed', 'true');
    const batons = screen.getByRole('region', { name: /Batons/ });
    expect(within(batons).getByText('Fieldglass adds')).toBeInTheDocument();
    expect(within(batons).queryByText('Timesheets awaiting approval')).not.toBeInTheDocument();
    // Lanes waiting on Finance only: Jay and Nia, not Leo (Workforce's).
    expect(screen.getByRole('button', { name: 'Open Jay Patel’s lane' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Leo Ramos’s lane' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All desks' }));
    expect(within(batons).getByText('Timesheets awaiting approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Leo Ramos’s lane' })).toBeInTheDocument();
  });

  it('names on the work: who holds a lane, and claiming a baton', async () => {
    const calls = renderRelay();
    expect(await screen.findByRole('button', { name: /Jay Patel’s lane: held by Wes Ford/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Claim “Fieldglass adds”' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/relay/claims')).toMatchObject({ method: 'POST', body: { subjectType: 'BATON', subjectKey: 'fieldglass-add' } }),
    );
  });

  it('the pipeline filters by stage', async () => {
    renderRelay('/relay?desk=ALL');
    const fieldglass = await screen.findByRole('button', { name: /3\. Fieldglass/ });
    await userEvent.click(fieldglass);
    expect(fieldglass).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Open Nia Carter’s lane' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Leo Ramos’s lane' })).not.toBeInTheDocument();
  });

  it('a lane opens to its road, the move that unsticks it, and the conversation', async () => {
    renderRelay();
    await userEvent.click(await screen.findByRole('button', { name: 'Open Jay Patel’s lane' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('heading', { name: 'Jay Patel' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: /Register them in Fieldglass/ })).toHaveAttribute('href', '/fieldglass');
    expect(within(drawer).getByText('1d late')).toBeInTheDocument();
    expect(within(drawer).getByRole('region', { name: 'The conversation' })).toBeInTheDocument();
  });

  it('a ruling owed to your desk is answered on the board — always with a reason', async () => {
    const calls = renderRelay();
    const decisions = await screen.findByRole('region', { name: /Decisions/ });
    await userEvent.click(await within(decisions).findByRole('button', { name: 'Approve' }));
    const approve = within(decisions).getByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    await userEvent.type(within(decisions).getByLabelText('The reason — it stays on the record'), 'Start confirmed with the buyer.');
    await userEvent.click(approve);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/work-notes/n2/decide')).toMatchObject({ method: 'POST', body: { approve: true, note: 'Start confirmed with the buyer.' } }),
    );
  });
});
