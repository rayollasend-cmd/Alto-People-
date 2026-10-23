import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability, type WorkerSummary, type WorkersResponse } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/workersApi', () => ({
  listWorkers: vi.fn(),
  getWorker: vi.fn(),
  createWorker: vi.fn(),
  updateWorker: vi.fn(),
  assignWorkerSite: vi.fn(),
  ensurePersonWorkers: vi.fn(),
}));
vi.mock('@/lib/usersAdminApi', () => ({ listAdminUsers: vi.fn() }));
vi.mock('@/lib/clientsApi', () => ({ listClients: vi.fn(), listClientLocations: vi.fn() }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));

import { createWorker, listWorkers } from '@/lib/workersApi';
import { listAdminUsers } from '@/lib/usersAdminApi';
import { listClientLocations, listClients } from '@/lib/clientsApi';
import { WorkerTypesAdmin } from '@/pages/admin/WorkerTypesAdmin';

const OWNER = { id: '11111111-1111-4111-8111-111111111111', name: 'Jo Park', email: 'jo@alto.example', associateId: 'assoc-jo' };

function worker(over: Partial<WorkerSummary>): WorkerSummary {
  return {
    id: 'w1',
    type: 'PERSON',
    name: 'Maria Lopez',
    associateId: 'a1',
    owner: OWNER,
    status: 'ACTIVE',
    capabilities: ['stocking'],
    notes: null,
    sites: [
      { locationId: 'l1', siteName: 'Destin', clientId: 'c1', clientName: 'Coastal Resort', startedAt: '2026-06-01', endedAt: null, source: 'associate' },
    ],
    upcomingShifts: 3,
    createdAt: '2026-06-01T00:00:00.000Z',
    offboardedAt: null,
    ...over,
  };
}

const response: WorkersResponse = {
  workers: [
    worker({}),
    worker({ id: 'w2', type: 'AGENT', name: 'Roster Bot', associateId: null, status: 'ONBOARDING', capabilities: ['schedule-read'], sites: [], upcomingShifts: 0 }),
    worker({ id: 'w3', type: 'ROBOT', name: 'Scrubber 7', associateId: null, status: 'ACTIVE', capabilities: ['floor-care'], sites: [], upcomingShifts: 1 }),
  ],
  counts: {
    PERSON: { ONBOARDING: 0, ACTIVE: 1, SUSPENDED: 0, OFFBOARDED: 0 },
    AGENT: { ONBOARDING: 1, ACTIVE: 0, SUSPENDED: 0, OFFBOARDED: 0 },
    ROBOT: { ONBOARDING: 0, ACTIVE: 1, SUSPENDED: 0, OFFBOARDED: 0 },
  },
  withoutOwner: [],
  associatesWithoutWorker: 0,
};

function renderPage(role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' = 'HR_ADMINISTRATOR', url = '/workers?type=ALL') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'x@example.com', role, status: 'ACTIVE' },
          loading: false,
          can: (c: Capability) => caps.has(c),
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[url]}>
          <WorkerTypesAdmin />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listWorkers).mockResolvedValue(response);
  vi.mocked(listAdminUsers).mockResolvedValue({
    users: [
      { id: OWNER.id, email: OWNER.email, role: 'HR_ADMINISTRATOR', status: 'ACTIVE', associateName: OWNER.name } as never,
      { id: '22222222-2222-4222-8222-222222222222', email: 'store@client.example', role: 'CLIENT_PORTAL', status: 'ACTIVE', associateName: null } as never,
    ],
    total: 2,
  });
  vi.mocked(listClients).mockResolvedValue({ clients: [{ id: 'c1', name: 'Coastal Resort' } as never] });
  vi.mocked(listClientLocations).mockResolvedValue({ locations: [{ id: 'l1', clientId: 'c1', name: 'Destin', isActive: true } as never] });
  vi.mocked(createWorker).mockResolvedValue(worker({ id: 'w9', type: 'ROBOT', name: 'Scrubber 8' }));
});

describe('WorkerTypesAdmin', () => {
  it('renders the counts by type and the zero-without-owner state', async () => {
    renderPage();
    expect(await screen.findByText('Roster Bot')).toBeInTheDocument();
    expect(screen.getByText('Without an owner')).toBeInTheDocument();
    expect(screen.getByText('Every worker is owned')).toBeInTheDocument();
    // Agents: none active, one onboarding — the hint carries the other statuses.
    expect(screen.getByText('1 onboarding')).toBeInTheDocument();
    expect(screen.getByText('Scrubber 7')).toBeInTheDocument();
    expect(screen.getByText('Maria Lopez')).toBeInTheDocument();
    // The person-sweep line stays hidden when nobody is missing a record.
    expect(screen.queryByText(/People without a worker record/)).not.toBeInTheDocument();
  });

  it('groups the roster by where people work — store by default, client or type on request', async () => {
    renderPage();
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    // Store headings carry the client; agents and robots sit under "not placed".
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && /^Destin · Coastal Resort · 1 worker$/.test(el.textContent ?? ''))).toBeInTheDocument();
    expect(screen.getByText(/^No store assignment · 2 workers$/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Group by'), 'type');
    expect(await screen.findByText(/^Robots · 1 worker$/)).toBeInTheDocument();
  });

  it('flags workers without an owner and offers the sweep when people are missing', async () => {
    vi.mocked(listWorkers).mockResolvedValue({ ...response, withoutOwner: [response.workers[1]], associatesWithoutWorker: 4 });
    renderPage();
    expect(await screen.findByText(/Must be zero/)).toBeInTheDocument();
    expect(screen.getByText(/People without a worker record/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create them now' })).toBeInTheDocument();
  });

  it('creates a robot with an owner and capabilities; Create stays disabled without an owner; agents go to the Agents page', async () => {
    const user = userEvent.setup();
    // One create path for agents: the Agents page's Register form (its profile has no place in the roster's schema).
    const agents = renderPage('HR_ADMINISTRATOR', '/workers?type=AGENT');
    await screen.findByText('Roster Bot');
    expect(screen.getByRole('link', { name: /Register agent/ })).toHaveAttribute('href', '/agents?register=1');
    agents.unmount();
    renderPage('HR_ADMINISTRATOR', '/workers?type=ROBOT');
    await screen.findByText('Scrubber 7');
    await user.click(screen.getByRole('button', { name: /Add robot/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Add robot')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Type/)).not.toBeInTheDocument();
    const create = within(dialog).getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Name/), 'Scrubber 8');
    expect(create).toBeDisabled();

    // Portal accounts are not offered as owners.
    const ownerSelect = within(dialog).getByLabelText(/Owner/) as HTMLSelectElement;
    await waitFor(() => expect(within(ownerSelect).getByRole('option', { name: /Jo Park/ })).toBeInTheDocument());
    expect(within(ownerSelect).queryByRole('option', { name: /store@client\.example/ })).not.toBeInTheDocument();
    await user.selectOptions(ownerSelect, OWNER.id);
    expect(create).toBeEnabled();

    // Robot capabilities only: floor-care applies, schedule-read does not.
    expect(within(dialog).queryByLabelText('Read schedules')).not.toBeInTheDocument();
    await user.click(within(dialog).getByLabelText('Floor care'));

    await user.click(create);
    await waitFor(() => expect(createWorker).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createWorker).mock.calls[0][0]).toMatchObject({
      type: 'ROBOT',
      name: 'Scrubber 8',
      ownerUserId: OWNER.id,
      status: 'ONBOARDING',
      capabilities: ['floor-care'],
    });
  });

  it('a person answers to their manager, an agent or robot to its owner, and each name opens its own record', async () => {
    vi.mocked(listWorkers).mockResolvedValue({
      ...response,
      workers: [worker({ manager: { associateId: 'm1', name: 'Dana Reyes' } }), response.workers[1], response.workers[2]],
    });
    renderPage();
    expect(await screen.findByText('Roster Bot')).toBeInTheDocument();
    // The column says both while every type shows (the default tenant's word for manager is "Supervisor").
    expect(screen.getByRole('columnheader', { name: /Supervisor or owner/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dana Reyes/ })).toHaveAttribute('href', '/people/m1');
    expect(screen.getAllByRole('link', { name: /Jo Park/ })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Maria Lopez' })).toHaveAttribute('href', '/people/a1');
    expect(screen.getByRole('link', { name: 'Roster Bot' })).toHaveAttribute('href', '/agents/w2');
    expect(screen.getByRole('link', { name: 'Scrubber 7' })).toHaveAttribute('href', '/robots/w3');
  });

  it('hides the manage actions from a read-only role', async () => {
    const robots = renderPage('EXECUTIVE_CHAIRMAN', '/workers?type=ROBOT');
    expect(await screen.findByText('Scrubber 7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add robot/ })).not.toBeInTheDocument();
    robots.unmount();
    renderPage('EXECUTIVE_CHAIRMAN', '/workers?type=AGENT');
    expect(await screen.findByText('Roster Bot')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Register agent/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Invite/ })).not.toBeInTheDocument();
  });
});

/**
 * F500 G1 /workers: People › Workforce roster opens on people, in the People
 * directory's words and numbers; agents and robots are one tap away, with
 * their own create action; nothing clips at 1440.
 */
describe('the roster opens on people (F500)', () => {
  const people = {
    ACTIVE: 1,
    PLACED_NOT_ACTIVE: 12,
    NOT_PLACED: 0,
    ONBOARDING: 1,
    DEACTIVATED: 8,
    SEPARATED: 0,
    onTheBooks: 21,
    total: 22,
    windowDays: 14,
  };
  const roster: WorkersResponse = {
    ...response,
    people,
    workers: [
      worker({ workStatus: 'PLACED_NOT_ACTIVE' }),
      worker({ id: 'w4', name: 'Dana Reyes', associateId: 'a4', status: 'ACTIVE', workStatus: 'ACTIVE' }),
      worker({ id: 'w5', name: 'Kim Nguyen', associateId: 'a5', status: 'SUSPENDED', workStatus: 'DEACTIVATED' }),
      ...response.workers.slice(1),
    ],
  };

  it('defaults to people: Invite is the one action, the status is the People page’s word, and the tile is on the books', async () => {
    vi.mocked(listWorkers).mockResolvedValue(roster);
    renderPage('HR_ADMINISTRATOR', '/workers');
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    // Agents and robots are not in the people list.
    expect(screen.queryByText('Roster Bot')).not.toBeInTheDocument();
    expect(screen.queryByText('Scrubber 7')).not.toBeInTheDocument();
    // The one create action that fits a list of people.
    expect(screen.getAllByRole('link', { name: /Invite associates/ })[0]).toHaveAttribute('href', '/onboarding?new=invite');
    expect(screen.queryByRole('button', { name: /Add robot/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Register agent/ })).not.toBeInTheDocument();
    // Where each person stands, in the People directory's words (not the worker account's "Active").
    expect(screen.getByRole('columnheader', { name: /^Status/ })).toBeInTheDocument();
    const maria = screen.getByRole('link', { name: 'Maria Lopez' }).closest('tr')!;
    expect(within(maria).getByText('No recent shifts').closest('[data-work-status]')).toHaveAttribute('data-work-status', 'PLACED_NOT_ACTIVE');
    expect(within(screen.getByRole('link', { name: 'Kim Nguyen' }).closest('tr')!).getByText('Paused')).toBeInTheDocument();
    // People on the books: the same 21 the People page and Headcount show, with the breakdown.
    const tile = screen.getByRole('button', { name: /on the books/ });
    expect(within(tile).getByText('1 working · 8 paused')).toBeInTheDocument();
    await waitFor(() => expect(within(tile).getByText('21')).toBeInTheDocument());
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    // An agent-only column has no place here, and one fetch serves the page.
    expect(screen.queryByRole('columnheader', { name: /Scorecard/ })).not.toBeInTheDocument();
    expect(listWorkers).toHaveBeenCalledTimes(1);
  });

  it('the type tiles are the filter; each type brings its own create action', async () => {
    const user = userEvent.setup();
    vi.mocked(listWorkers).mockResolvedValue(roster);
    renderPage('HR_ADMINISTRATOR', '/workers');
    await screen.findByText('Maria Lopez');
    await user.click(screen.getByRole('button', { name: /^Agents/ }));
    expect(await screen.findByText('Roster Bot')).toBeInTheDocument();
    expect(screen.queryByText('Maria Lopez')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Account/ })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Register agent/ })[0]).toHaveAttribute('href', '/agents?register=1');
    expect(screen.queryByRole('link', { name: /Invite associates/ })).not.toBeInTheDocument();
  });

  it('filters people by where they stand, and says so when nobody matches', async () => {
    const user = userEvent.setup();
    vi.mocked(listWorkers).mockResolvedValue(roster);
    renderPage('HR_ADMINISTRATOR', '/workers?group=none');
    await screen.findByText('Maria Lopez');
    // The People view's status filter speaks the people vocabulary.
    const status = screen.getAllByLabelText('Status')[0] as HTMLSelectElement;
    expect(within(status).getByRole('option', { name: 'No recent shifts' })).toBeInTheDocument();
    expect(within(status).queryByRole('option', { name: 'Suspended' })).not.toBeInTheDocument();
    await user.selectOptions(status, 'DEACTIVATED');
    expect(await screen.findByRole('link', { name: 'Kim Nguyen' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Maria Lopez' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getAllByLabelText('Status')[0] as HTMLSelectElement, 'SEPARATED');
    expect(await screen.findByText('Nothing matches these filters')).toBeInTheDocument();
  });

  it('grouped by store, the store heading replaces the store column; by client, the column comes back', async () => {
    const user = userEvent.setup();
    vi.mocked(listWorkers).mockResolvedValue(roster);
    renderPage('HR_ADMINISTRATOR', '/workers');
    await screen.findByText('Maria Lopez');
    expect(screen.queryByRole('columnheader', { name: /Current stores/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Capabilities/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Created/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getAllByLabelText('Group by')[0] as HTMLSelectElement, 'client');
    expect(await screen.findByRole('columnheader', { name: /Current stores/ })).toBeInTheDocument();
  });

  it('a type with none at all says so instead of a 0', async () => {
    vi.mocked(listWorkers).mockResolvedValue({
      ...roster,
      workers: roster.workers.filter((w) => w.type === 'PERSON'),
      counts: { ...roster.counts, AGENT: { ONBOARDING: 0, ACTIVE: 0, SUSPENDED: 0, OFFBOARDED: 0 }, ROBOT: { ONBOARDING: 0, ACTIVE: 0, SUSPENDED: 0, OFFBOARDED: 0 } },
    });
    renderPage('HR_ADMINISTRATOR', '/workers');
    await screen.findByText('Maria Lopez');
    expect(within(screen.getByRole('button', { name: /^Robots/ })).getByText('No robots yet')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^Agents/ })).getByText('No agents registered')).toBeInTheDocument();
  });

  it('faces come from the API: no photo on file means initials, not a request that 404s', async () => {
    vi.mocked(listWorkers).mockResolvedValue({
      ...roster,
      workers: [
        worker({ manager: { associateId: 'm1', name: 'Dana Reyes', photoUrl: null }, workStatus: 'ACTIVE' }),
        worker({ id: 'w4', name: 'Kim Nguyen', associateId: 'a4', manager: { associateId: 'm2', name: 'Lee Park', photoUrl: '/api/associates/m2/photo?v=7' }, workStatus: 'ACTIVE' }),
      ],
    });
    const { container } = renderPage('HR_ADMINISTRATOR', '/workers?group=none');
    await screen.findByRole('link', { name: /Dana Reyes/ });
    const srcs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toContain('/api/associates/m2/photo?v=7');
    expect(srcs.some((src) => src?.includes('/api/associates/m1/photo'))).toBe(false);
  });

  it('an empty type shows its own empty state and the way to add one', async () => {
    vi.mocked(listWorkers).mockResolvedValue({ ...roster, workers: roster.workers.filter((w) => w.type !== 'AGENT') });
    renderPage('HR_ADMINISTRATOR', '/workers?type=AGENT');
    expect(await screen.findByText('No agents registered')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Register agent/ }).length).toBeGreaterThan(0);
  });
});
