import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { Role } from '@alto-people/shared';
import type { ClientOverview, ClientSummary } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

const clients = vi.hoisted(() => ({
  getClient: vi.fn(),
  updateClient: vi.fn(),
  setClientState: vi.fn(),
  getClientDunning: vi.fn(),
  updateClientBillingTerms: vi.fn(),
  upsertClientStatement: vi.fn(),
  archiveClient: vi.fn(),
}));
vi.mock('@/lib/clientsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/clientsApi')>()), ...clients }));
const account = vi.hoisted(() => ({
  getClientOverview: vi.fn(),
  createClientContact: vi.fn(),
  updateClientContact: vi.fn(),
  deleteClientContact: vi.fn(),
  listOwnerOptions: vi.fn(),
}));
vi.mock('@/lib/clientAccountApi', async (orig) => ({ ...(await orig<typeof import('@/lib/clientAccountApi')>()), ...account }));
// The facets have their own tests; here the record, the overview, Basics and Settings matter.
vi.mock('@/pages/clients/JobsSection', () => ({ JobsSection: () => null }));
vi.mock('@/pages/clients/RateDefaultsSection', () => ({ RateDefaultsSection: () => null }));
vi.mock('@/pages/clients/StatementsSection', () => ({ StatementsSection: () => <div data-testid="statements-tab" /> }));
vi.mock('@/pages/clients/LocationsSection', () => ({ LocationsSection: () => <div data-testid="locations-tab" /> }));
vi.mock('@/pages/clients/BenefitsPlansSection', () => ({ BenefitsPlansSection: () => null }));
vi.mock('@/pages/clients/PortalAccessSection', () => ({ PortalAccessSection: () => null }));

import { ClientDetail } from '@/pages/clients/ClientDetail';

/**
 * The client's account page (CL-A): it opens on the Overview — numbers,
 * what needs you, contacts, locations, the account and its activity — with
 * money only for statements readers, header actions by capability, Basics
 * read first, Settings holding the configuration (?section=state lands
 * there), and one Actions menu on a phone.
 */

const ID = '00000000-0000-4000-8000-00000000c1a0';

function summary(over: Partial<ClientSummary> = {}): ClientSummary {
  return {
    id: ID,
    name: 'Gulf Front Hotels',
    industry: 'Hospitality',
    status: 'ACTIVE',
    contactEmail: 'ops@gulf.example',
    state: 'FL',
    weekStartsOn: 6,
    fieldglassSiteName: null,
    fieldglassBillRate: 21.21,
    accountOwnerUserId: 'u-owner',
    contractStartDate: '2026-01-01',
    contractEndDate: '2026-11-11',
    legalName: 'Gulf Front Hospitality LLC',
    addressLine1: '100 Beach Rd',
    addressLine2: null,
    city: 'Destin',
    zip: '32541',
    poNumber: 'PO-77',
    paymentTermsDays: 30,
    ...over,
  };
}

function overview(over: Partial<ClientOverview> = {}): ClientOverview {
  return {
    clientId: ID,
    asOf: '2026-10-22T14:00:00.000Z',
    canSeeMoney: true,
    kpis: {
      onAssignment: 41,
      hoursThisWeek: 312.5,
      hoursLastWeek: 1180,
      hoursLastWeekToDate: 250,
      hoursChangePct: 25,
      shiftsNext7: { total: 40, filled: 37 },
      fillRatePct: 92.5,
      overtimePct: 6.2,
      health: 'risk',
      healthReasons: ['$5,760 is 40 days past due'],
      money: {
        outstanding: 6960.5,
        aging: { current: 1200.5, d1_30: 0, d31_60: 5760, d61_90: 0, d90plus: 0 },
        billedThisMonth: 1200.5,
        lastStatementTotal: 1200.5,
        lastStatementAt: '2026-10-20T15:00:00.000Z',
        marginPct: 21.4,
        targetMarginPct: 25,
      },
    },
    needsYou: [
      { kind: 'overdue_statements', severity: 'risk', title: '$5,760.00 past due on 1 statement', detail: 'The oldest, No. 0012, is 40 days past due.', count: 1, href: `/clients/${ID}?section=statements` },
      { kind: 'unfilled_shifts', severity: 'risk', title: '3 shifts with no one on them', detail: '1 starts in the next 48 hours.', count: 3, href: `/scheduling?client=${ID}&open=1` },
      { kind: 'no_primary_contact', severity: 'watch', title: 'No primary contact', detail: 'Add the person you call at Gulf Front Hotels.', href: `/clients/${ID}?section=overview#contacts` },
    ],
    contacts: [
      { id: 'k1', clientId: ID, name: 'Dana Reyes', title: 'General manager', email: 'dana@gulf.example', phone: '(850) 555-0100', role: 'PRIMARY', isPrimary: true, notes: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'k2', clientId: ID, name: 'Ben Ortiz', title: null, email: null, phone: null, role: 'BILLING', isPrimary: false, notes: 'Pays on the 15th.', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
    ],
    locations: {
      count: 7,
      items: [
        { id: 'l1', name: 'North Tower', city: 'Destin', state: 'FL', onAssignment: 22 },
        { id: 'l2', name: 'South Tower', city: 'Miramar Beach', state: 'FL', onAssignment: 19 },
      ],
    },
    owner: { id: 'u-owner', name: 'Pat Lee', email: 'pat@altohr.com' },
    contract: { start: '2026-01-01', end: '2026-11-11', daysLeft: 20 },
    paymentTermsDays: 30,
    recentActivity: [
      { id: 'a1', kind: 'statement_finalized', at: '2026-10-20T15:00:00.000Z', actor: 'Harper Lane', text: 'Statement No. 0013 finalized: $1,200.50', href: `/clients/${ID}?section=statements` },
      { id: 'a2', kind: 'request_opened', at: '2026-10-19T15:00:00.000Z', actor: 'store@gulf.example', text: 'Request from the client: Four more for Friday', href: null },
    ],
    ...over,
  };
}

function renderRecord(role: Role, query = '') {
  return renderAs(
    role,
    <Routes>
      <Route path="/clients/:id" element={<ClientDetail />} />
      <Route path="/scheduling" element={<div data-testid="scheduling-page" />} />
    </Routes>,
    `/clients/${ID}${query}`,
  );
}

const realMatchMedia = window.matchMedia;
function phone() {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  clients.getClient.mockResolvedValue(summary());
  clients.getClientDunning.mockResolvedValue({ poNumber: 'PO-77', paymentTermsDays: 30, salesTaxable: false, salesTaxRatePct: null, paused: null, reminders: [] });
  account.getClientOverview.mockResolvedValue(overview());
  account.listOwnerOptions.mockResolvedValue({ options: [{ id: 'u-owner', name: 'Pat Lee', email: 'pat@altohr.com', role: 'MANAGER' }] });
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('the Overview tab', () => {
  it('opens by default with the numbers, what needs you, the account, contacts, locations and activity', async () => {
    renderRecord('HR_ADMINISTRATOR');
    const kpis = await screen.findByTestId('client-kpis');
    expect(within(screen.getByTestId('kpi-outstanding')).getByText('$6,960.50')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-outstanding')).getByRole('img', { name: /31–60 \$5,760\.00/ })).toBeInTheDocument();
    expect(screen.getByTestId('kpi-outstanding').closest('a')).toHaveAttribute('href', `/clients/${ID}?section=statements`);
    expect(within(screen.getByTestId('kpi-billed')).getByText('$1,200.50')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-margin')).getByText('21.4%')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-margin')).getByText('3.6 pts under the 25% target')).toBeInTheDocument();
    expect(await within(kpis).findByText('41', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByTestId('kpi-people').closest('a')).toHaveAttribute('href', `/people?client=${ID}&status=ACTIVE`);
    expect(screen.getByTestId('kpi-people')).toHaveTextContent('22 at North Tower, the busiest');
    expect(within(screen.getByTestId('kpi-hours')).getByText('312.5h')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-hours')).getByText(/by now last week/)).toHaveTextContent('vs 250.0h by now last week');
    expect(within(screen.getByTestId('kpi-fill')).getByText('92.5%')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-fill')).getByText('37 of 40 shifts filled')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-fill').closest('a')).toHaveAttribute('href', `/scheduling?client=${ID}&open=1`);
    expect(within(screen.getByTestId('kpi-overtime')).getByText('6.2%')).toBeInTheDocument();

    const needs = screen.getByTestId('needs-you');
    const links = within(needs).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/clients/${ID}?section=statements`, `/scheduling?client=${ID}&open=1`, `/clients/${ID}?section=overview#contacts`]);
    expect(links[0]).toHaveTextContent('$5,760.00 past due on 1 statement');
    expect(screen.getByTestId('client-health')).toHaveTextContent('At risk');

    const acct = screen.getByTestId('client-account');
    expect(acct).toHaveTextContent('Pat Lee');
    expect(acct).toHaveTextContent('20 days left');
    expect(acct).toHaveTextContent('Net 30');

    const contacts = screen.getByTestId('client-contacts');
    expect(within(contacts).getByRole('link', { name: 'dana@gulf.example' })).toHaveAttribute('href', 'mailto:dana@gulf.example');
    expect(within(contacts).getByRole('link', { name: '(850) 555-0100' })).toHaveAttribute('href', 'tel:8505550100');
    expect(within(contacts).getByText('Primary')).toBeInTheDocument();

    expect(within(screen.getByTestId('client-locations')).getByText('North Tower')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All 7 locations/ })).toBeInTheDocument();
    expect(within(screen.getByTestId('client-activity')).getByText('Statement No. 0013 finalized: $1,200.50')).toBeInTheDocument();
    expect(screen.getByTestId('client-activity')).toHaveTextContent('Harper Lane');
  });

  it('the header line carries the owner, the contract, the primary contact, locations and people', async () => {
    renderRecord('HR_ADMINISTRATOR');
    await screen.findByTestId('client-kpis');
    expect(screen.getByText(/^Owner Pat Lee/)).toHaveTextContent('Owner Pat Lee · Contract ends Nov 11, 2026 · Primary contact Dana Reyes · 7 locations · 41 on assignment');
    // Health beside the status, one tap from the list that needs someone.
    const health = screen.getByTestId('client-health-link');
    expect(health).toHaveTextContent('At risk · 3 need you');
    expect(health).toHaveAttribute('href', `/clients/${ID}?section=overview#needs-you`);
  });

  it('hides the money tiles — absent, not zero — when the overview carries no money', async () => {
    const o = overview({ canSeeMoney: false });
    delete o.kpis!.money;
    account.getClientOverview.mockResolvedValue(o);
    renderRecord('HR_ADMINISTRATOR');
    await screen.findByTestId('client-kpis');
    expect(screen.queryByTestId('kpi-outstanding')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-billed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-margin')).not.toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(screen.getByTestId('kpi-people')).toBeInTheDocument();
  });

  it('says plainly when there is nothing to count', async () => {
    account.getClientOverview.mockResolvedValue(
      overview({
        kpis: { onAssignment: 0, hoursThisWeek: 0, hoursLastWeek: 0, hoursLastWeekToDate: 0, hoursChangePct: null, shiftsNext7: { total: 0, filled: 0 }, fillRatePct: null, overtimePct: null, health: 'good', healthReasons: [], money: { outstanding: 0, aging: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 }, billedThisMonth: 0, lastStatementTotal: null, lastStatementAt: null, marginPct: null, targetMarginPct: null } },
        needsYou: [],
        contacts: [],
        recentActivity: [],
        locations: { count: 0, items: [] },
      }),
    );
    renderRecord('HR_ADMINISTRATOR');
    await screen.findByTestId('client-kpis');
    expect(within(screen.getByTestId('kpi-hours')).getByText('No hours yet')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-fill')).getByText('No shifts')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-people')).toHaveTextContent('No one working here now');
    expect(within(screen.getByTestId('kpi-overtime')).getByText('No hours')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs you on this account.')).toBeInTheDocument();
    expect(screen.getByText('No contacts on file.')).toBeInTheDocument();
    expect(screen.getByTestId('client-health')).toHaveTextContent('Healthy');
    expect(screen.getByTestId('client-health-link')).toHaveTextContent(/^Healthy$/);
    expect(within(screen.getByTestId('kpi-margin')).getByText('Nothing billed')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-outstanding')).getByText('Every finalized statement is paid.')).toBeInTheDocument();
    expect(screen.queryByTestId('aging-bar')).not.toBeInTheDocument();
  });

  it('adds a contact from the card', async () => {
    const user = userEvent.setup();
    account.createClientContact.mockResolvedValue({ contact: {} });
    renderRecord('HR_ADMINISTRATOR');
    await screen.findByTestId('client-contacts');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.type(screen.getByLabelText(/^Name/), 'Sam Shore');
    await user.type(screen.getByLabelText('Email'), 'sam@gulf.example');
    await user.click(screen.getByRole('button', { name: 'Add contact' }));
    await waitFor(() =>
      expect(account.createClientContact).toHaveBeenCalledWith(ID, { name: 'Sam Shore', title: null, role: 'PRIMARY', email: 'sam@gulf.example', phone: null, notes: null, isPrimary: false }),
    );
  });

  it('a manager names the owner and the contract term from the Account card', async () => {
    const user = userEvent.setup();
    clients.updateClient.mockResolvedValue(summary());
    renderRecord('HR_ADMINISTRATOR');
    const acct = await screen.findByTestId('client-account');
    await user.click(within(acct.closest('[data-card]') as HTMLElement).getByRole('button', { name: 'Edit' }));
    const end = screen.getByLabelText('Contract ends');
    await user.clear(end);
    await user.type(end, '2027-06-30');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(clients.updateClient).toHaveBeenCalledWith(ID, { accountOwnerUserId: 'u-owner', contractStartDate: '2026-01-01', contractEndDate: '2027-06-30' }));
  });
});

describe('header actions by capability', () => {
  it('a manager: ONE primary (Post open shifts); Edit, New statement, Email the primary contact and Archive under More', async () => {
    const user = userEvent.setup();
    renderRecord('HR_ADMINISTRATOR');
    const bar = await screen.findByTestId('client-record-actions');
    // F500 2026-10-26: four equal outline buttons and no primary → one primary + More.
    expect(within(bar).getByRole('link', { name: /Post open shifts/ })).toHaveAttribute('href', `/scheduling?client=${ID}&new=shift`);
    expect(within(bar).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: /New statement/ })).not.toBeInTheDocument();
    await screen.findByTestId('client-kpis');
    await user.click(within(bar).getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /Edit basics/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /New statement/ })).toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: /Email Dana/ })).toHaveAttribute('href', 'mailto:dana@gulf.example');
    expect(screen.getByRole('menuitem', { name: /Archive client/ })).toBeInTheDocument();
  });

  it('finance: shifts and statements, no Edit or Archive', async () => {
    const user = userEvent.setup();
    renderRecord('FINANCE_ACCOUNTANT');
    const bar = await screen.findByTestId('client-record-actions');
    expect(within(bar).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: /Post open shifts/ })).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /New statement/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Edit basics|Archive/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    // Finance reads the account but does not edit it.
    await screen.findByTestId('client-account');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('the chairman reads: only the email to the primary contact', async () => {
    const user = userEvent.setup();
    renderRecord('EXECUTIVE_CHAIRMAN');
    const bar = await screen.findByTestId('client-record-actions');
    await screen.findByTestId('client-kpis');
    await user.click(await within(bar).findByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /Email Dana/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /New statement/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Post open shifts/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('New statement drafts the chosen month and opens Statements', async () => {
    const user = userEvent.setup();
    clients.upsertClientStatement.mockResolvedValue({});
    renderRecord('HR_ADMINISTRATOR');
    await screen.findByTestId('client-kpis');
    await user.click(within(await screen.findByTestId('client-record-actions')).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /New statement/ }));
    await user.click(await screen.findByRole('button', { name: 'Draft statement' }));
    await waitFor(() => expect(clients.upsertClientStatement).toHaveBeenCalledWith(ID, expect.stringMatching(/^\d{4}-\d{2}-01$/), expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)));
    expect(await screen.findByTestId('statements-tab')).toBeInTheDocument();
  });

  it('on a phone the actions collapse into one menu and the tiles sit two to a row', async () => {
    phone();
    const user = userEvent.setup();
    renderRecord('HR_ADMINISTRATOR');
    await screen.findByTestId('client-kpis');
    const bar = screen.getByTestId('client-record-actions');
    expect(within(bar).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(bar).queryByRole('link', { name: /Post open shifts/ })).not.toBeInTheDocument();
    expect(within(bar).getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByTestId('client-actions-menu'));
    for (const name of ['Edit basics', 'Post open shifts', 'New statement', /Email Dana Reyes/, 'Archive client']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    expect(screen.getByTestId('client-kpis').className).toMatch(/\bgrid-cols-2\b/);
    expect(screen.getByTestId('kpi-outstanding').className).toMatch(/\bcol-span-2\b/);
  });
});

describe('Basics, read first', () => {
  it('reads as a list; Edit turns it into the form; Save waits for a change; Cancel puts it back', async () => {
    const user = userEvent.setup();
    clients.updateClient.mockImplementation(async (_id: string, body: Partial<ClientSummary>) => summary({ ...body } as Partial<ClientSummary>));
    renderRecord('HR_ADMINISTRATOR', '?section=basics');
    const read = await screen.findByTestId('client-basics-read');
    expect(read).toHaveTextContent('Gulf Front Hospitality LLC');
    expect(read).toHaveTextContent('100 Beach Rd');
    expect(read).toHaveTextContent('Destin, FL 32541');
    expect(read).toHaveTextContent('PO-77');
    expect(read).toHaveTextContent('Net 30');
    expect(screen.queryByText('Fieldglass site name')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    await user.click(within(read.closest('[data-card]') as HTMLElement).getByRole('button', { name: 'Edit' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('client-basics-read')).toBeInTheDocument();

    await user.click(within(screen.getByTestId('client-basics-read').closest('[data-card]') as HTMLElement).getByRole('button', { name: 'Edit' }));
    const po = screen.getByLabelText('PO number');
    await user.clear(po);
    await user.type(po, 'PO-88');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(clients.updateClient).toHaveBeenCalledWith(ID, expect.objectContaining({ poNumber: 'PO-88', legalName: 'Gulf Front Hospitality LLC', paymentTermsDays: 30 })));
    expect(await screen.findByTestId('client-basics-read')).toHaveTextContent('PO-88');
  });

  it("the header's Edit opens Basics in its form", async () => {
    const user = userEvent.setup();
    renderRecord('HR_ADMINISTRATOR');
    await screen.findByTestId('client-kpis');
    await user.click(within(screen.getByTestId('client-record-actions')).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit basics/ }));
    expect(await screen.findByLabelText('Legal name')).toHaveValue('Gulf Front Hospitality LLC');
    expect(screen.getByRole('tab', { name: 'Basics' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Settings', () => {
  it('?section=state opens Settings with the work-site state, the week, billing and exports', async () => {
    renderRecord('HR_ADMINISTRATOR', '?section=state');
    expect(await screen.findByTestId('client-settings')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('State')).toHaveValue('FL');
    expect(screen.getByLabelText('Week starts on')).toHaveValue('6');
    expect(screen.getByLabelText('Fieldglass bill rate ($/h)')).toHaveValue(21.21);
    expect(screen.getByText(/Only on the Fieldglass timesheet export/)).toHaveTextContent('What you bill lives in Rates.');
    expect(await screen.findByLabelText('Target margin (%)')).toHaveValue(25);
  });

  it('saves the scheduling week', async () => {
    const user = userEvent.setup();
    clients.updateClient.mockResolvedValue(summary({ weekStartsOn: 1 }));
    renderRecord('HR_ADMINISTRATOR', '?section=settings');
    await user.selectOptions(await screen.findByLabelText('Week starts on'), '1');
    await user.click(within(screen.getByLabelText('Week starts on').closest('[data-card]') as HTMLElement).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(clients.updateClient).toHaveBeenCalledWith(ID, { weekStartsOn: 1 }));
  });

  it('?section=basics still opens Basics, and older ?tab= links open their tab', async () => {
    renderRecord('HR_ADMINISTRATOR', '?section=basics');
    expect(await screen.findByTestId('client-basics-read')).toBeInTheDocument();
  });

  it('?tab=statements (the finance pages\' links) opens Statements', async () => {
    renderRecord('FINANCE_ACCOUNTANT', '?tab=statements');
    expect(await screen.findByTestId('statements-tab')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Statements' })).toHaveAttribute('aria-selected', 'true');
  });
});
