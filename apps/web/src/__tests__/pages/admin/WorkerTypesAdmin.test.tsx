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

const OWNER = { id: '11111111-1111-4111-8111-111111111111', name: 'Jo Park', email: 'jo@alto.example' };

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

function renderPage(role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' = 'HR_ADMINISTRATOR') {
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
        <MemoryRouter initialEntries={['/workers']}>
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

  it('flags workers without an owner and offers the sweep when people are missing', async () => {
    vi.mocked(listWorkers).mockResolvedValue({ ...response, withoutOwner: [response.workers[1]], associatesWithoutWorker: 4 });
    renderPage();
    expect(await screen.findByText(/Must be zero/)).toBeInTheDocument();
    expect(screen.getByText(/People without a worker record/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create them now' })).toBeInTheDocument();
  });

  it('creates an agent with an owner and capabilities; Create stays disabled without an owner', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Roster Bot');
    await user.click(screen.getByRole('button', { name: /Add agent or robot/ }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Name/), 'Roster Bot 2');
    expect(create).toBeDisabled();

    // Portal accounts are not offered as owners.
    const ownerSelect = within(dialog).getByLabelText(/Owner/) as HTMLSelectElement;
    await waitFor(() => expect(within(ownerSelect).getByRole('option', { name: /Jo Park/ })).toBeInTheDocument());
    expect(within(ownerSelect).queryByRole('option', { name: /store@client\.example/ })).not.toBeInTheDocument();
    await user.selectOptions(ownerSelect, OWNER.id);
    expect(create).toBeEnabled();

    // Agent capabilities only: schedule-read applies, floor-care does not.
    expect(within(dialog).queryByLabelText('Floor care')).not.toBeInTheDocument();
    await user.click(within(dialog).getByLabelText('Read schedules'));
    await user.click(within(dialog).getByLabelText('Send messages to associates'));

    await user.click(create);
    await waitFor(() => expect(createWorker).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createWorker).mock.calls[0][0]).toMatchObject({
      type: 'AGENT',
      name: 'Roster Bot 2',
      ownerUserId: OWNER.id,
      status: 'ONBOARDING',
      capabilities: ['schedule-read', 'messaging'],
    });
  });

  it('hides the manage actions from a read-only role', async () => {
    renderPage('EXECUTIVE_CHAIRMAN');
    expect(await screen.findByText('Roster Bot')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add agent or robot/ })).not.toBeInTheDocument();
  });
});
