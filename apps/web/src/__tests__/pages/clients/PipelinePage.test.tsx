import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProspectListResponse, ProspectRow } from '@alto-people/shared';
import { prospectAnnualValue, prospectWeightedValue } from '@alto-people/shared';
import { TooltipProvider } from '@/components/ui/Tooltip';

/**
 * Clients → Pipeline. The board's columns, the header's numbers (and the
 * per-column weighted sums the page adds up itself), the add dialog, the
 * Won → create the client flow, Lost asking why, money hidden for a caller
 * without it, the views behind the tiles, and the list on a phone.
 */

const prompt = vi.fn();
const confirm = vi.fn();
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'me', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true }),
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => confirm, usePrompt: () => prompt }));
vi.mock('@/lib/prospectsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/prospectsApi')>()),
  listProspects: vi.fn(),
  listProspectOwners: vi.fn(),
  createProspect: vi.fn(),
  updateProspect: vi.fn(),
  deleteProspect: vi.fn(),
}));
vi.mock('@/lib/clientsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/clientsApi')>()),
  createClient: vi.fn(),
  listClients: vi.fn(),
}));

import { createProspect, deleteProspect, listProspectOwners, listProspects, updateProspect } from '@/lib/prospectsApi';
import { createClient, listClients } from '@/lib/clientsApi';
import { PipelinePage } from '@/pages/clients/PipelinePage';

const TODAY = '2026-10-22';
const WEIGHTS = { LEAD: 0.1, CONTACTED: 0.25, PROPOSAL: 0.5, VERBAL: 0.8 } as const;

function row(over: Partial<ProspectRow> & Pick<ProspectRow, 'id' | 'name' | 'stage'>): ProspectRow {
  const hours = over.estWeeklyHours ?? null;
  const rate = over.estBillRate ?? null;
  const annual = prospectAnnualValue(hours, rate);
  return {
    ownerUserId: null,
    ownerName: null,
    contactName: null,
    contactEmail: null,
    estWeeklyHours: hours,
    estBillRate: rate,
    annualValue: annual,
    weightedValue: prospectWeightedValue(over.stage, annual),
    expectedStartDate: null,
    stageChangedAt: `${TODAY}T12:00:00.000Z`,
    daysInStage: 0,
    lostReason: null,
    wonClientId: null,
    wonClientName: null,
    notes: null,
    createdAt: `${TODAY}T12:00:00.000Z`,
    updatedAt: `${TODAY}T12:00:00.000Z`,
    ...over,
  };
}

const ROWS: ProspectRow[] = [
  row({ id: 'p1', name: 'Harbor Hotel', stage: 'LEAD', estWeeklyHours: 200, estBillRate: 22, ownerUserId: 'me', ownerName: 'Rosa Ortiz', expectedStartDate: '2026-11-01' }),
  row({ id: 'p2', name: 'Gulf Logistics', stage: 'LEAD', estWeeklyHours: 160, estBillRate: 19, daysInStage: 41 }),
  row({ id: 'p3', name: 'Pine Resort', stage: 'CONTACTED', estWeeklyHours: 80 }),
  row({ id: 'p4', name: 'Bay Foods', stage: 'PROPOSAL', estWeeklyHours: 100, estBillRate: 30, expectedStartDate: '2026-10-15' }),
  row({ id: 'p5', name: 'Destin Marina', stage: 'VERBAL', estWeeklyHours: 40, estBillRate: 25, contactEmail: 'gm@destin.example', ownerUserId: 'u2', ownerName: 'Sam Lee' }),
  row({ id: 'p6', name: 'Sandpiper Inn', stage: 'WON', wonClientId: 'c9', wonClientName: 'Sandpiper Inn' }),
  row({ id: 'p7', name: 'Old Mill', stage: 'LOST', lostReason: 'Went with the incumbent.' }),
];

function response(over: Partial<ProspectListResponse> = {}): ProspectListResponse {
  return {
    today: TODAY,
    prospects: ROWS,
    totals: { open: 5, unpriced: 1, weightedValue: 142_480, unweightedValue: 436_800, startsNext90: 2, startsNext90Won: 0 },
    weights: { ...WEIGHTS },
    money: true,
    canWrite: true,
    ...over,
  };
}

function renderPage(path = '/clients/pipeline') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <PipelinePage />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  vi.mocked(listProspects).mockResolvedValue(response());
  vi.mocked(listProspectOwners).mockResolvedValue({ owners: [{ id: 'me', name: 'Rosa Ortiz' }, { id: 'u2', name: 'Sam Lee' }] });
  vi.mocked(updateProspect).mockImplementation(async (id) => ({ ...ROWS.find((r) => r.id === id)! }));
  vi.mocked(createProspect).mockResolvedValue({ id: 'new' });
  vi.mocked(listClients).mockResolvedValue({
    clients: [
      { id: 'c1', name: 'Coastal Resort Holdings', industry: null, status: 'ACTIVE', contactEmail: null, state: null },
      { id: 'c2', name: 'bay foods', industry: null, status: 'PROSPECT', contactEmail: null, state: null },
    ],
  } as never);
  prompt.mockReset();
  confirm.mockReset();
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.clearAllMocks();
});

describe('PipelinePage', () => {
  it('draws the four working stages as columns with the outcomes folded at the end', async () => {
    renderPage();
    const board = await screen.findByTestId('pipeline-board');
    expect(within(board).getByRole('region', { name: 'Lead, 2 prospects' })).toBeInTheDocument();
    expect(within(board).getByRole('region', { name: 'Contacted, 1 prospect' })).toBeInTheDocument();
    expect(within(board).getByRole('region', { name: 'Proposal, 1 prospect' })).toBeInTheDocument();
    expect(within(board).getByRole('region', { name: 'Verbal yes, 1 prospect' })).toBeInTheDocument();
    // Won and Lost are folded: counted, their cards one click away.
    const won = within(board).getByRole('button', { name: /^Won/ });
    expect(won).toHaveAttribute('aria-expanded', 'false');
    expect(within(board).queryByText('Sandpiper Inn')).not.toBeInTheDocument();
    await userEvent.click(won);
    expect(within(board).getByRole('link', { name: 'Sandpiper Inn' })).toHaveAttribute('href', '/clients/c9');
    // A card: owner, value, start, days in stage.
    const harbor = within(board).getByRole('button', { name: /Harbor Hotel, Lead/ });
    expect(harbor).toHaveTextContent('Rosa Ortiz');
    expect(harbor).toHaveTextContent('$229k/yr'); // 200 × 22 × 52 = 228,800
    expect(harbor).toHaveTextContent('$23k weighted'); // × 10%
    expect(harbor).toHaveTextContent('Starts Nov 1, 2026');
    expect(within(board).getByRole('button', { name: /Gulf Logistics, Lead/ })).toHaveTextContent('41d in stage');
    expect(within(board).getByRole('button', { name: /Pine Resort, Contacted/ })).toHaveTextContent('Not priced yet');
  });

  it('adds up the weighted value per column and shows the header the API counted, weights in the tooltip', async () => {
    renderPage();
    const board = await screen.findByTestId('pipeline-board');
    // Lead: 228,800 × 10% + 158,080 × 10% = 22,880 + 15,808 = 38,688 → $39k.
    expect(within(board).getByRole('region', { name: 'Lead, 2 prospects' })).toHaveTextContent('10% chance · $39k weighted');
    // Proposal: 100 × 30 × 52 × 50% = 78,000.
    expect(within(board).getByRole('region', { name: 'Proposal, 1 prospect' })).toHaveTextContent('50% chance · $78k weighted');
    // Verbal: 40 × 25 × 52 × 80% = 41,600.
    expect(within(board).getByRole('region', { name: 'Verbal yes, 1 prospect' })).toHaveTextContent('80% chance · $42k weighted');

    const tiles = screen.getByTestId('pipeline-tiles');
    expect(within(tiles).getByText('$142k/yr')).toBeInTheDocument();
    expect(within(tiles).getByText(/of \$437k if every one closes/)).toBeInTheDocument();
    expect(within(tiles).getByRole('link', { name: '1 not priced' })).toHaveAttribute('href', '/clients/pipeline?view=unpriced');
    expect(within(tiles).getByText('0 won · 2 still open')).toBeInTheDocument();
    // Needs a nudge: Gulf (41 days in Lead) and Bay Foods (start date passed).
    await waitFor(() => expect(within(tiles).getByText('Needs a nudge').closest('a')).toHaveTextContent('2'));

    await userEvent.hover(within(tiles).getByRole('button', { name: 'How it is weighted' }));
    expect((await screen.findAllByText(/Lead 10% · Contacted 25% · Proposal 50% · Verbal yes 80%/)).length).toBeGreaterThan(0);
  });

  it('each tile opens the prospects behind it', async () => {
    renderPage('/clients/pipeline?view=stalled');
    const board = await screen.findByTestId('pipeline-board');
    const cards = within(board).getAllByTestId('prospect-card');
    expect(cards.map((c) => c.textContent)).toEqual([expect.stringContaining('Gulf Logistics'), expect.stringContaining('Bay Foods')]);
    expect(screen.getByText(/^Showing 2 prospects: needs a nudge/)).toBeInTheDocument();
    expect(within(screen.getByTestId('pipeline-tiles')).getByText('Starting in 90 days').closest('a')).toHaveAttribute('href', '/clients/pipeline?view=starts90');
  });

  it('adds a prospect in a dialog, owned by the person adding it, with its value worked out as they type', async () => {
    renderPage();
    await screen.findByTestId('pipeline-board');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add prospect' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a prospect' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Coral Bay Water Park');
    await userEvent.type(within(dialog).getByLabelText('Hours a week (estimate)'), '150');
    await userEvent.type(within(dialog).getByLabelText('Bill rate (estimate, $/hr)'), '21');
    await userEvent.type(within(dialog).getByLabelText('Contact name'), 'Dana Fox');
    // 150 × 21 × 52 = 163,800; at Lead 10% = 16,380.
    expect(within(dialog).getByTestId('prospect-value-preview')).toHaveTextContent('$163,800.00 a year (hours × rate × 52) · $16,380.00 weighted at Lead (10%)');
    expect(within(dialog).getByLabelText('Owner')).toHaveValue('me');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add prospect' }));
    await waitFor(() =>
      expect(createProspect).toHaveBeenCalledWith({
        name: 'Coral Bay Water Park',
        stage: 'LEAD',
        ownerUserId: 'me',
        contactName: 'Dana Fox',
        contactEmail: null,
        estWeeklyHours: 150,
        estBillRate: 21,
        expectedStartDate: null,
        notes: null,
      }),
    );
  });

  it('a card opens its edit dialog, prefilled; save and delete go to the API', async () => {
    vi.mocked(deleteProspect).mockResolvedValue({ ok: true });
    renderPage();
    const board = await screen.findByTestId('pipeline-board');
    await userEvent.click(within(board).getByRole('button', { name: /Harbor Hotel, Lead/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Harbor Hotel' });
    expect(within(dialog).getByRole('textbox', { name: /^Name/ })).toHaveValue('Harbor Hotel');
    expect(within(dialog).getByLabelText('Owner')).toHaveValue('me');
    expect(within(dialog).getByLabelText('Expected start')).toHaveValue('2026-11-01');
    // No stage field when editing: moves happen on the board.
    expect(within(dialog).queryByLabelText('Stage')).not.toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText('Hours a week (estimate)'));
    await userEvent.type(within(dialog).getByLabelText('Hours a week (estimate)'), '250');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateProspect).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'Harbor Hotel', estWeeklyHours: 250, estBillRate: 22, ownerUserId: 'me', expectedStartDate: '2026-11-01' })),
    );

    confirm.mockResolvedValueOnce(true);
    await userEvent.click(within(board).getByRole('button', { name: /Gulf Logistics, Lead/ }));
    const second = await screen.findByRole('dialog', { name: 'Edit Gulf Logistics' });
    await userEvent.click(within(second).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteProspect).toHaveBeenCalledWith('p2'));
  });

  it('Won offers to create the client, prefilled; the new client is linked and the prospect marked won', async () => {
    vi.mocked(createClient).mockResolvedValue({ id: 'c-new', name: 'Destin Marina', industry: null, status: 'ACTIVE', contactEmail: 'gm@destin.example', state: null });
    renderPage();
    await screen.findByTestId('pipeline-board');
    await userEvent.click(screen.getByRole('button', { name: 'Move Destin Marina' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Won…' }));
    const won = await screen.findByRole('dialog', { name: 'Destin Marina won' });
    await userEvent.click(within(won).getByRole('button', { name: 'Create the client' }));

    const create = await screen.findByRole('dialog', { name: 'Create the client' });
    expect(within(create).getByRole('textbox', { name: /^Name/ })).toHaveValue('Destin Marina');
    expect(within(create).getByLabelText('Contact email')).toHaveValue('gm@destin.example');
    await userEvent.click(within(create).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createClient).toHaveBeenCalledWith({ name: 'Destin Marina', industry: null, status: 'ACTIVE', contactEmail: 'gm@destin.example' }));
    await waitFor(() => expect(updateProspect).toHaveBeenCalledWith('p5', { stage: 'WON', wonClientId: 'c-new' }));
  });

  it('Won can be marked now and the client created later', async () => {
    renderPage();
    await screen.findByTestId('pipeline-board');
    await userEvent.click(screen.getByRole('button', { name: 'Move Bay Foods' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Won…' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark won, create the client later' }));
    await waitFor(() => expect(updateProspect).toHaveBeenCalledWith('p4', { stage: 'WON' }));
  });

  it('Won can link a client that already exists — the one named like the prospect is offered first', async () => {
    renderPage();
    await screen.findByTestId('pipeline-board');
    await userEvent.click(screen.getByRole('button', { name: 'Move Bay Foods' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Won…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bay Foods won' });
    const pick = await within(dialog).findByLabelText('Already a client? Link it');
    await waitFor(() => expect(pick).toHaveValue('c2'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link and mark won' }));
    await waitFor(() => expect(updateProspect).toHaveBeenCalledWith('p4', { stage: 'WON', wonClientId: 'c2' }));
  });

  it('Lost asks why, and saves nothing without a reason', async () => {
    renderPage();
    await screen.findByTestId('pipeline-board');
    prompt.mockResolvedValueOnce(null);
    await userEvent.click(screen.getByRole('button', { name: 'Move Pine Resort' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Lost…' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mark Pine Resort lost?', reasonLabel: 'Why was it lost?' })));
    expect(updateProspect).not.toHaveBeenCalled();

    prompt.mockResolvedValueOnce('Chose a cheaper agency.');
    await userEvent.click(screen.getByRole('button', { name: 'Move Pine Resort' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Lost…' }));
    await waitFor(() => expect(updateProspect).toHaveBeenCalledWith('p3', { stage: 'LOST', lostReason: 'Chose a cheaper agency.' }));
  });

  it('a plain move saves the new stage', async () => {
    renderPage();
    await screen.findByTestId('pipeline-board');
    await userEvent.click(screen.getByRole('button', { name: 'Move Harbor Hotel' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Proposal' }));
    await waitFor(() => expect(updateProspect).toHaveBeenCalledWith('p1', { stage: 'PROPOSAL' }));
  });

  it('reopening a won deal says the client link goes, and does nothing if declined', async () => {
    renderPage();
    const board = await screen.findByTestId('pipeline-board');
    await userEvent.click(within(board).getByRole('button', { name: /^Won/ }));
    confirm.mockResolvedValueOnce(false);
    await userEvent.click(screen.getByRole('button', { name: 'Move Sandpiper Inn' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Verbal yes' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reopen Sandpiper Inn?' })));
    expect(updateProspect).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Move Sandpiper Inn' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Verbal yes' }));
    await waitFor(() => expect(updateProspect).toHaveBeenCalledWith('p6', { stage: 'VERBAL' }));
  });

  it('without money access the value tile, the rate field and every amount are gone, not zero', async () => {
    const noMoney = ROWS.map(({ estBillRate: _r, annualValue: _a, weightedValue: _w, ...rest }) => rest as ProspectRow);
    vi.mocked(listProspects).mockResolvedValue(
      response({ money: false, prospects: noMoney, totals: { open: 5, unpriced: 1, startsNext90: 2, startsNext90Won: 0 } }),
    );
    renderPage();
    const board = await screen.findByTestId('pipeline-board');
    expect(screen.queryByText('Weighted pipeline')).not.toBeInTheDocument();
    expect(board).not.toHaveTextContent('$');
    expect(within(board).getByRole('region', { name: 'Lead, 2 prospects' })).toHaveTextContent('10% chance');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add prospect' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a prospect' });
    expect(within(dialog).queryByLabelText('Bill rate (estimate, $/hr)')).not.toBeInTheDocument();
  });

  it('a reader (the executive) sees the board but no way to change it', async () => {
    vi.mocked(listProspects).mockResolvedValue(response({ canWrite: false }));
    renderPage();
    await screen.findByTestId('pipeline-board');
    expect(screen.queryByRole('button', { name: 'Add prospect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move / })).not.toBeInTheDocument();
  });

  it('on a phone the board is a list, a section per stage, moves from each card’s menu', async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    renderPage();
    const list = await screen.findByTestId('pipeline-list');
    expect(screen.queryByTestId('pipeline-board')).not.toBeInTheDocument();
    expect(within(list).getByRole('region', { name: 'Lead, 2' })).toBeInTheDocument();
    expect(within(list).getAllByTestId('prospect-row')).toHaveLength(5); // outcomes folded
    // The filters fold into one chip on a phone.
    expect(screen.getByTestId('filter-sheet-chip')).toHaveTextContent('Filters');
    await userEvent.click(within(list).getByRole('button', { name: 'Move Harbor Hotel' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Contacted' }));
    await waitFor(() => expect(updateProspect).toHaveBeenCalledWith('p1', { stage: 'CONTACTED' }));
  });

  it('an empty pipeline says what fills it and offers the first step', async () => {
    vi.mocked(listProspects).mockResolvedValue(response({ prospects: [], totals: { open: 0, unpriced: 0, weightedValue: 0, unweightedValue: 0, startsNext90: 0, startsNext90Won: 0 } }));
    renderPage();
    expect(await screen.findByText('The pipeline is empty')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add prospect' }).length).toBe(2);
    // No money total is invented for an empty pipeline.
    expect(within(screen.getByTestId('pipeline-tiles')).getByText('—')).toBeInTheDocument();
  });
});
