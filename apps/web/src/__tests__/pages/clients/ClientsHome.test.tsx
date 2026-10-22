import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability, type ClientListItem, type Role } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { TooltipProvider } from '@/components/ui/Tooltip';

const api = vi.hoisted(() => ({ listClients: vi.fn() }));
vi.mock('@/lib/clientsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/clientsApi')>()), ...api }));
const prospects = vi.hoisted(() => ({ listProspects: vi.fn() }));
vi.mock('@/lib/prospectsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/prospectsApi')>()), ...prospects }));
const views = vi.hoisted(() => ({ listSavedViews: vi.fn(), createSavedView: vi.fn(), updateSavedView: vi.fn(), deleteSavedView: vi.fn() }));
vi.mock('@/lib/savedViewsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/savedViewsApi')>()), ...views }));

import { ClientsHome } from '@/pages/clients/ClientsHome';

/**
 * The clients list (Clients rebuild): the table by default (and the
 * person's choice remembered), the columns each person may see, the
 * built-in views and saved views (filters + sort + columns), "On
 * assignment" as the people count's only name, and the phone's compact
 * rows behind a filter sheet.
 */

const ME = 'u1';
const today = new Date();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n: number) => ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));

const row = (over: Partial<ClientListItem> & Pick<ClientListItem, 'id' | 'name'>): ClientListItem => ({
  industry: 'hospitality',
  status: 'ACTIVE',
  contactEmail: null,
  state: null,
  weekStartsOn: 6,
  openApplications: 0,
  activeAssociateCount: 0,
  lastPayrollDisbursedAt: null,
  onAssignment: 0,
  shiftsNext7: { total: 0, filled: 0 },
  fillRatePct: null,
  hoursThisWeek: 0,
  health: 'good',
  healthReasons: [],
  accountOwner: null,
  contractEndDate: null,
  ...over,
});

const HARBOR = row({ id: '00000000-0000-4000-8000-0000000000a1', name: 'Harbor Hotel', onAssignment: 12, activeAssociateCount: 12, shiftsNext7: { total: 50, filled: 47 }, fillRatePct: 94, hoursThisWeek: 412.5, health: 'risk', healthReasons: ['$5,760 is 34 days past due'], accountOwner: { id: ME, name: 'Me Myself' }, contractEndDate: inDays(20), outstanding: 5760, billedInRange: 12000, state: 'FL' });
const YARD = row({ id: '00000000-0000-4000-8000-0000000000a2', name: 'Yard Market', onAssignment: 3, activeAssociateCount: 3, shiftsNext7: { total: 10, filled: 9 }, fillRatePct: 90, hoursThisWeek: 80, health: 'watch', healthReasons: ['9 of 10 shifts in the next 7 days filled (90%)'], accountOwner: { id: 'u2', name: 'Olivia Owner' }, outstanding: 0, billedInRange: 3000 });
const ZENITH = row({ id: '00000000-0000-4000-8000-0000000000a3', name: 'Zenith Labs', status: 'INACTIVE', outstanding: 0, billedInRange: 0, contractEndDate: inDays(200) });
const ALL = [HARBOR, YARD, ZENITH];
const noMoney = (r: ClientListItem): ClientListItem => {
  const { outstanding: _o, billedInRange: _b, ...rest } = r;
  return rest;
};

function renderWith(caps: Iterable<Capability>, route = '/clients', role: Role = 'OPERATIONS_MANAGER') {
  const set = new Set(caps);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrap = (ui: ReactNode) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <AuthContext.Provider
          value={{
            isInitializing: false,
            isOffline: false,
            user: { id: ME, email: 'me@example.com', role, status: 'ACTIVE', clientId: null, associateId: null } as never,
            role,
            primaryRole: role,
            availableRoles: [role],
            capabilities: set,
            tenant: DEFAULT_TENANT,
            signIn: vi.fn(),
            submitMfaChallenge: vi.fn(),
            signOut: vi.fn(),
            refreshUser: vi.fn(),
            switchRole: vi.fn(),
            can: (c: Capability) => set.has(c),
          }}
        >
          <TooltipProvider>
            <ConfirmProvider>{ui}</ConfirmProvider>
          </TooltipProvider>
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const r = render(wrap(<ClientsHome />));
  return { ...r, rerenderPage: () => r.rerender(wrap(<ClientsHome key="again" />)) };
}

const FINANCE = ROLE_CAPABILITIES.FINANCE_ACCOUNTANT;
const MANAGER = ROLE_CAPABILITIES.MANAGER;
const ACCOUNT_DESK: Capability[] = ['view:dashboard', 'view:clients'];

const originalMatchMedia = window.matchMedia;
function asPhone() {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  api.listClients.mockResolvedValue({ clients: ALL, nextCursor: null });
  prospects.listProspects.mockResolvedValue({ today: ymd(today), prospects: [], totals: { open: 4, unpriced: 0, startsNext90: 0, startsNext90Won: 0 }, weights: {}, money: false, canWrite: true });
  views.listSavedViews.mockResolvedValue({ views: [] });
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent?.replace(/\u00a0/g, ' ').trim());

describe('the clients list', () => {
  it('opens as a table with the account columns, money for statements readers', async () => {
    renderWith(FINANCE);
    const table = await screen.findByRole('table', { name: 'Clients' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    const month = today.toLocaleDateString('en-US', { month: 'short' });
    expect(headers()).toEqual(['Name', 'Health', 'Owner', 'On assignment', 'Filled, next 7 days', 'Hours this week', `Billed · ${month}`, 'Outstanding', 'Contract ends', 'Last payroll', 'Status', 'Report']);
    // The people count is "On assignment" everywhere; "Active" is only ever the account status.
    expect(screen.queryByRole('columnheader', { name: 'Active' })).toBeNull();
    const harbor = within(table).getByRole('row', { name: /Harbor Hotel/ });
    expect(harbor).toHaveTextContent('12');
    expect(harbor).toHaveTextContent('94%');
    expect(harbor).toHaveTextContent('47 of 50');
    expect(harbor).toHaveTextContent('413h');
    expect(harbor).toHaveTextContent('$5.8k');
    expect(harbor).toHaveTextContent('At risk');
    expect(within(harbor).getByRole('link', { name: '$5.8k' })).toHaveAttribute('href', `/clients/${HARBOR.id}?section=statements`);
    expect(within(harbor).getByRole('link', { name: /94%/ })).toHaveAttribute('href', `/scheduling?client=${HARBOR.id}`);
    expect(within(harbor).getByRole('link', { name: '12' })).toHaveAttribute('href', `/people?client=${HARBOR.id}&status=ACTIVE`);
    expect(within(harbor).getByRole('button', { name: 'At risk: $5,760 is 34 days past due' })).toBeInTheDocument();
    // The billed range goes to the API: this month to date by default.
    expect(api.listClients).toHaveBeenCalledWith(expect.objectContaining({ metrics: true, from: `${ymd(today).slice(0, 8)}01`, to: ymd(today) }));
    // No "Federal default" pin: a state shows only when one is set.
    expect(screen.queryByText(/federal default/i)).toBeNull();
    expect(within(harbor).getByText('FL')).toBeInTheDocument();
  });

  it('leaves the money columns, the report and the money tile out for someone who reads clients without statements', async () => {
    api.listClients.mockResolvedValue({ clients: ALL.map(noMoney), nextCursor: null });
    renderWith(ACCOUNT_DESK);
    await screen.findByRole('table', { name: 'Clients' });
    expect(headers()).toEqual(['Name', 'Health', 'Owner', 'On assignment', 'Filled, next 7 days', 'Hours this week', 'Contract ends', 'Last payroll', 'Status']);
    expect(screen.queryByText('Outstanding')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Billed in' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Weekly statements/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Pipeline/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New client/ })).toBeNull();
    expect(screen.getByText('Shifts next 7 days')).toBeInTheDocument();
  });

  it('gives a manager New client, Weekly statements and Pipeline with its open count', async () => {
    renderWith(MANAGER);
    await screen.findByRole('table', { name: 'Clients' });
    expect(screen.getByRole('button', { name: /New client/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Weekly statements/ })).toHaveAttribute('href', '/clients/statements');
    const pipeline = await screen.findByRole('link', { name: /Pipeline/ });
    expect(pipeline).toHaveAttribute('href', '/clients/pipeline');
    await waitFor(() => expect(pipeline).toHaveTextContent('4'));
    // Status chips: All / Active / Inactive; Prospect only when an account has that status.
    const status = screen.getByRole('group', { name: 'Status' });
    expect(within(status).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Active', 'Inactive']);
  });

  it('narrows to the built-in views, each with its count', async () => {
    const user = userEvent.setup();
    renderWith(FINANCE);
    const table = await screen.findByRole('table', { name: 'Clients' });
    const viewsGroup = screen.getByRole('group', { name: 'Views' });
    expect(within(viewsGroup).getByRole('button', { name: /Needs attention/ })).toHaveTextContent('2');
    expect(within(viewsGroup).getByRole('button', { name: /Mine/ })).toHaveTextContent('1');
    expect(within(viewsGroup).getByRole('button', { name: /Contract ending/ })).toHaveTextContent('1');
    expect(within(viewsGroup).getByRole('button', { name: /Inactive/ })).toHaveTextContent('1');
    const names = () => within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('link')[0]!.textContent);

    await user.click(within(viewsGroup).getByRole('button', { name: /Needs attention/ }));
    await waitFor(() => expect(names()).toEqual(['Harbor Hotel', 'Yard Market']));
    await user.click(within(viewsGroup).getByRole('button', { name: /Mine/ }));
    await waitFor(() => expect(names()).toEqual(['Harbor Hotel']));
    await user.click(within(viewsGroup).getByRole('button', { name: /Inactive/ }));
    await waitFor(() => expect(names()).toEqual(['Zenith Labs']));
    await user.click(within(viewsGroup).getByRole('button', { name: /^All/ }));
    await waitFor(() => expect(names()).toEqual(['Harbor Hotel', 'Yard Market', 'Zenith Labs']));
  });

  it('applies a saved view — its filters, sort and columns — and saves the list on screen as a new one', async () => {
    const user = userEvent.setup();
    views.listSavedViews.mockResolvedValue({
      views: [{ id: '00000000-0000-4000-8000-0000000000e1', scope: 'clients.list', name: 'Late money', query: { attention: '1', sort: 'outstanding', dir: 'desc', cols: 'owner' }, shared: false, mine: true, ownerName: 'Me', updatedAt: '2026-10-22T00:00:00.000Z' }],
    });
    views.createSavedView.mockImplementation(async (body: { name: string; query: Record<string, string> }) => ({ id: '00000000-0000-4000-8000-0000000000e2', scope: 'clients.list', shared: false, mine: true, ownerName: 'Me', updatedAt: '', ...body }));
    renderWith(FINANCE);
    const table = await screen.findByRole('table', { name: 'Clients' });
    await user.click(screen.getByRole('button', { name: /^Saved views/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Late money/ }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
    expect(screen.queryByRole('columnheader', { name: 'Owner' })).toBeNull();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Harbor Hotel');
    expect(rows[1]).toHaveTextContent('Yard Market');

    // Save a new one from what is on screen: the Inactive view, keeping the sort and the columns on screen.
    await user.click(within(screen.getByRole('group', { name: 'Views' })).getByRole('button', { name: /Inactive/ }));
    await user.click(screen.getByRole('button', { name: /^Saved views/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Save these filters as a view/ }));
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Gone quiet');
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(views.createSavedView).toHaveBeenCalled());
    expect(views.createSavedView.mock.calls[0]![0]).toEqual({ scope: 'clients.list', name: 'Gone quiet', query: { status: 'INACTIVE', sort: 'outstanding', dir: 'desc', cols: 'owner' }, shared: false });
  });

  it('remembers the table or the cards for this person, and the cards carry the same numbers', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWith(FINANCE);
    await screen.findByRole('table', { name: 'Clients' });
    await user.click(screen.getByRole('button', { name: 'Cards' }));
    expect(window.localStorage.getItem(`alto.clients.layout.v2.${ME}`)).toBe('cards');
    unmount();
    renderWith(FINANCE);
    const card = (await screen.findAllByRole('link', { name: /Harbor Hotel/ }))[0]!;
    expect(screen.queryByRole('table', { name: 'Clients' })).toBeNull();
    expect(card).toHaveTextContent('On assignment');
    expect(card).toHaveTextContent('12');
    expect(card).toHaveTextContent('94%');
    expect(card).toHaveTextContent('413h');
    expect(card).toHaveTextContent('$5.8k');
    expect(card).not.toHaveTextContent(/\bActive\b.*\b12\b/);
  });

  it('shows a phone one compact row per account, with its filters behind a sheet and the search in view', async () => {
    asPhone();
    const user = userEvent.setup();
    renderWith(FINANCE);
    const list = await screen.findByRole('list', { name: 'Clients' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Harbor Hotel');
    expect(items[0]).toHaveTextContent('12 on assignment · 94% filled · $5.8k due');
    expect(within(items[0]!).getByText(/At risk: \$5,760 is 34 days past due/)).toBeInTheDocument();
    expect(items[2]).toHaveTextContent('Inactive');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search clients' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Views' })).toBeNull();
    await user.click(screen.getByTestId('filter-sheet-chip'));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(within(sheet).getByRole('group', { name: 'Views' })).getByRole('button', { name: /Needs attention/ }));
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Clients' })).getAllByRole('listitem')).toHaveLength(2));
    expect(screen.getByTestId('filter-sheet-chip')).toHaveTextContent('Filters (1)');
  });
});
