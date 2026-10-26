import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { AgentScorecard, WorkerSummary, WorkersResponse } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

/**
 * The workforce roster (/workers) as wave 1 left it (audit: "/people and
 * /agents become views of one roster; scorecard column"): each live agent
 * row carries its last-seven-days scorecard and opens the agent's
 * Scorecard tab; People and Agents each link to the roster already
 * filtered to their own type, and the roster honours that filter.
 */

type Call = { path: string; method: string };
const calls: Call[] = [];
let routes: Record<string, unknown> = {};
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (path: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method });
      const key = `${method} ${path.split('?')[0]}`;
      if (key in routes) {
        const v = routes[key];
        return typeof v === 'function' ? (v as (p: string) => unknown)(path) : v;
      }
      // Anything else answers an object whose every field is an empty list.
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});

import { WorkerTypesAdmin } from '@/pages/admin/WorkerTypesAdmin';
import { PeopleDirectory } from '@/pages/people/PeopleDirectory';
import { AgentRegistryAdmin } from '@/pages/admin/AgentRegistryAdmin';

const OWNER = { id: '11111111-1111-4111-8111-111111111111', name: 'Jo Park', email: 'jo@alto.example', associateId: 'assoc-jo' };

function worker(over: Partial<WorkerSummary>): WorkerSummary {
  return {
    id: 'w1',
    type: 'PERSON',
    name: 'Maria Lopez',
    associateId: 'a1',
    owner: OWNER,
    status: 'ACTIVE',
    capabilities: [],
    notes: null,
    sites: [],
    upcomingShifts: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    offboardedAt: null,
    ...over,
  };
}

const scorecard = (over: Partial<AgentScorecard>): AgentScorecard => ({
  days: 7,
  tasksCompleted: 0,
  errors: 0,
  errorRatePct: null,
  exceptionsEscalated: 0,
  approvalsRequested: 0,
  approvalsRejected: 0,
  spendCents: 0,
  costPerTaskCents: null,
  ...over,
});

const roster: WorkersResponse = {
  workers: [
    worker({}),
    worker({ id: 'w2', type: 'AGENT', name: 'Roster Bot', associateId: null }),
    worker({ id: 'w3', type: 'AGENT', name: 'Noisy Bot', associateId: null }),
    worker({ id: 'w4', type: 'AGENT', name: 'New Bot', associateId: null, status: 'ONBOARDING' }),
    worker({ id: 'w5', type: 'AGENT', name: 'Old Bot', associateId: null, status: 'OFFBOARDED' }),
  ],
  counts: {
    PERSON: { ONBOARDING: 0, ACTIVE: 1, SUSPENDED: 0, OFFBOARDED: 0 },
    AGENT: { ONBOARDING: 1, ACTIVE: 2, SUSPENDED: 0, OFFBOARDED: 1 },
    ROBOT: { ONBOARDING: 0, ACTIVE: 0, SUSPENDED: 0, OFFBOARDED: 0 },
  },
  withoutOwner: [],
  associatesWithoutWorker: 0,
};

const SCORECARDS: Record<string, AgentScorecard> = {
  w2: scorecard({ tasksCompleted: 42, errors: 1, errorRatePct: 2, exceptionsEscalated: 3 }),
  w3: scorecard({ tasksCompleted: 11, errors: 2, errorRatePct: 15 }),
  w4: scorecard({}),
};

beforeEach(() => {
  calls.length = 0;
  routes = {
    'GET /workers': roster,
    'GET /agents/w2/scorecard': SCORECARDS.w2,
    'GET /agents/w3/scorecard': SCORECARDS.w3,
    'GET /agents/w4/scorecard': SCORECARDS.w4,
  };
});

describe('the roster’s agent scorecard column', () => {
  it('shows each live agent’s last seven days and opens its Scorecard tab', async () => {
    renderAs('HR_ADMINISTRATOR', <WorkerTypesAdmin />, '/workers?type=AGENT&group=none');
    expect(await screen.findByRole('columnheader', { name: /Scorecard \(7 days\)/ })).toBeInTheDocument();
    const good = await screen.findByRole('link', { name: /42 tasks/ });
    expect(good).toHaveAttribute('href', '/agents/w2?tab=scorecard');
    expect(good).toHaveAttribute('title', '42 tasks, 1 errors, 3 escalated');
    expect(within(good).getByText('2% errors')).toBeInTheDocument();
    // Over ten percent reads as a problem; nothing measured says so.
    const noisy = await screen.findByRole('link', { name: /11 tasks/ });
    expect(within(noisy).getByText('15% errors').closest('[class*="negative"]')).not.toBeNull();
    expect(within(await screen.findByRole('link', { name: /0 tasks/ })).getByText('no errors measured')).toBeInTheDocument();
    // One read per live agent, for seven days — none for the person, none for the offboarded agent.
    const reads = calls.filter((c) => c.path.includes('/scorecard')).map((c) => c.path);
    expect(reads.sort()).toEqual(['/agents/w2/scorecard?days=7', '/agents/w3/scorecard?days=7', '/agents/w4/scorecard?days=7']);
  });

  it('a person’s row has no scorecard', async () => {
    routes['GET /workers'] = { ...roster, workers: [worker({})] };
    renderAs('HR_ADMINISTRATOR', <WorkerTypesAdmin />, '/workers?group=none');
    const row = (await screen.findByRole('link', { name: 'Maria Lopez' })).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).queryByText(/tasks/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('/scorecard'))).toBe(false);
  });
});

describe('People and Agents open the roster on their own type', () => {
  it('People links to the roster filtered to people', async () => {
    renderAs('HR_ADMINISTRATOR', <PeopleDirectory />, '/people');
    expect(await screen.findByRole('link', { name: 'Workforce roster' })).toHaveAttribute('href', '/workers?type=PERSON');
  });

  it('Agents links to the roster filtered to agents', async () => {
    renderAs('HR_ADMINISTRATOR', <AgentRegistryAdmin />, '/agents');
    expect(await screen.findByRole('link', { name: /Workforce roster/ })).toHaveAttribute('href', '/workers?type=AGENT');
  });

  it('the roster honours ?type= — the chip is set and the list shows only that type', async () => {
    renderAs('HR_ADMINISTRATOR', <WorkerTypesAdmin />, '/workers?type=AGENT');
    await screen.findByText('Roster Bot');
    const chips = screen.getByRole('radiogroup', { name: 'Worker type' });
    expect(within(chips).getByRole('radio', { name: 'Agents' })).toHaveAttribute('aria-checked', 'true');
    // One read of the roster; the type is a view of it (the page used to read it twice).
    await waitFor(() => expect(calls.filter((c) => c.path.split('?')[0] === '/workers').length).toBe(1));
    expect(screen.queryByText('Maria Lopez')).not.toBeInTheDocument();
  });
});

describe('the roster counts people the way its tile does (F500 audit 2026-10-26)', () => {
  it('lists people on the books by default — onboarding and separated people only when asked for', async () => {
    routes['GET /workers'] = {
      ...roster,
      workers: [
        worker({ workStatus: 'ACTIVE' }),
        worker({ id: 'p2', name: 'Paused Pat', associateId: 'a2', workStatus: 'DEACTIVATED' }),
        worker({ id: 'p3', name: 'New Nia', associateId: 'a3', workStatus: 'ONBOARDING' }),
        worker({ id: 'p4', name: 'Gone Gus', associateId: 'a4', workStatus: 'SEPARATED' }),
      ],
    };
    renderAs('HR_ADMINISTRATOR', <WorkerTypesAdmin />, '/workers?group=none');
    expect(await screen.findByText('Paused Pat')).toBeInTheDocument();
    expect(screen.getByText('Maria Lopez')).toBeInTheDocument();
    expect(screen.queryByText('New Nia')).not.toBeInTheDocument();
    expect(screen.queryByText('Gone Gus')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveDisplayValue('On the books');
  });

  it('?status=ANY shows everyone', async () => {
    routes['GET /workers'] = {
      ...roster,
      workers: [worker({ workStatus: 'ACTIVE' }), worker({ id: 'p4', name: 'Gone Gus', associateId: 'a4', workStatus: 'SEPARATED' })],
    };
    renderAs('HR_ADMINISTRATOR', <WorkerTypesAdmin />, '/workers?group=none&status=ANY');
    expect(await screen.findByText('Gone Gus')).toBeInTheDocument();
  });
});
