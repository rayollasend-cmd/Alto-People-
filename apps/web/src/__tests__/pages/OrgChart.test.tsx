import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OrgNode } from '@/lib/orgChartApi';
import { renderAs } from './hrPack/harness';
import { ancestorsOf, filterByDepartment, indexNodes, managerChoices, roleLabelFor, searchNodes } from '@/pages/org/orgChartModel';

const getOrgChart = vi.fn();
const setStaffReportsTo = vi.fn();
const assignOrgFields = vi.fn();
vi.mock('@/lib/orgChartApi', () => ({
  getOrgChart: (...a: unknown[]) => getOrgChart(...a),
  setStaffReportsTo: (...a: unknown[]) => setStaffReportsTo(...a),
}));
vi.mock('@/lib/orgApi', () => ({ assignOrgFields: (...a: unknown[]) => assignOrgFields(...a) }));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [{ id: 'c1', name: 'Coastal' }, { id: 'c2', name: 'Seaside' }] }) }));
// Desktop unless a test says otherwise.
let phone = false;
vi.mock('@/lib/useViewport', () => ({ useMediaQuery: () => phone }));

import { OrgChart } from '@/pages/org/OrgChart';

const node = (o: Partial<OrgNode> & Pick<OrgNode, 'id' | 'kind' | 'name'>): OrgNode => ({
  parentId: null,
  subtitle: null,
  role: null,
  shiftLabels: null,
  photoUrl: null,
  associateId: null,
  userId: null,
  departmentId: null,
  departmentName: null,
  clientId: null,
  clientName: null,
  siteName: null,
  reports: 0,
  shiftsToday: null,
  filledToday: null,
  positionStatus: null,
  former: false,
  ...o,
});

const COMPANY: OrgNode[] = [
  node({ id: 'u:ceo', kind: 'staff', name: 'Cora Chief', role: 'EXECUTIVE_CHAIRMAN', userId: 'ceo' }),
  node({ id: 'a:hr', parentId: 'u:ceo', kind: 'staff', name: 'Hana Ruiz', role: 'HR_ADMINISTRATOR', userId: 'hr', associateId: 'hr-a', departmentId: 'd1', departmentName: 'People' }),
  node({ id: 'a:rec', parentId: 'a:hr', kind: 'person', name: 'Rafa Ortiz', subtitle: 'Recruiter', associateId: 'rec-a', departmentId: 'd1', departmentName: 'People' }),
  node({ id: 'a:deep', parentId: 'a:rec', kind: 'person', name: 'Deepa Sharma', subtitle: 'Sourcer', associateId: 'deep-a', departmentId: 'd1', departmentName: 'People' }),
  node({ id: 'u:fin', parentId: 'u:ceo', kind: 'staff', name: 'Finn Accounts', role: 'FINANCE_ACCOUNTANT', userId: 'fin', departmentId: 'd2', departmentName: 'Finance' }),
  node({ id: 'p:1', parentId: 'a:hr', kind: 'vacancy', name: 'Payroll analyst', subtitle: 'P-1', positionStatus: 'PLANNED' }),
];

const FIELD: OrgNode[] = [
  node({ id: 'r:1', kind: 'region', name: 'Panhandle' }),
  node({ id: 'c:1@1', parentId: 'r:1', kind: 'client', name: 'Coastal', clientId: 'c1', clientName: 'Coastal' }),
  node({ id: 's:1', parentId: 'c:1@1', kind: 'store', name: 'Front Beach', clientId: 'c1', clientName: 'Coastal', shiftsToday: 4, filledToday: 3, reports: 1 }),
  node({ id: 'l:1', parentId: 's:1', kind: 'lead', name: 'Lee Lead', role: 'SHIFT_SUPERVISOR', shiftLabels: ['Mornings'], userId: 'lead' }),
  node({ id: 'a:c@1', parentId: 's:1', kind: 'person', name: 'Cal Crew', associateId: 'cal' }),
  node({ id: 'group:unplaced', kind: 'group', name: 'Not yet placed', subtitle: 'No open assignment anywhere', reports: 1 }),
  node({ id: 'a:u@unplaced', parentId: 'group:unplaced', kind: 'person', name: 'Una Placed', associateId: 'una' }),
];

beforeEach(() => {
  phone = false;
  getOrgChart.mockReset();
  setStaffReportsTo.mockReset();
  assignOrgFields.mockReset();
  getOrgChart.mockImplementation(({ view }: { view: string }) =>
    Promise.resolve({ view, nodes: view === 'field' ? FIELD : COMPANY, fieldOnly: view === 'field' ? 0 : 12, unplaced: 1, truncated: false, limit: 5000 }),
  );
});

describe('the model', () => {
  const index = indexNodes(COMPANY);
  const label = roleLabelFor((k) => k);
  it('searches in reading order and walks the path to a match', () => {
    expect(searchNodes(index, 'people', label).map((n) => n.name)).toEqual(['Hana Ruiz', 'Rafa Ortiz', 'Deepa Sharma']);
    expect(ancestorsOf(index, 'a:deep').map((n) => n.name)).toEqual(['Cora Chief', 'Hana Ruiz', 'Rafa Ortiz']);
  });
  it('a department keeps its people and the path down to them', () => {
    expect(filterByDepartment(COMPANY, 'd2').map((n) => n.name)).toEqual(['Cora Chief', 'Finn Accounts']);
  });
  it('never offers someone their own team as a manager; a person record needs a person-record manager', () => {
    const hr = index.byId.get('a:hr')!;
    const names = managerChoices(index, hr).map((n) => n.name);
    expect(names).not.toContain('Rafa Ortiz');
    expect(names).not.toContain('Deepa Sharma');
    expect(names).not.toContain('Hana Ruiz');
    // Rafa (person record only) can't go under Finn (account only).
    expect(managerChoices(index, index.byId.get('a:rec')!).map((n) => n.name)).not.toContain('Finn Accounts');
  });
});

describe('<OrgChart>', () => {
  it('draws the company: the top, a team, the open seat, and the count left to the Field chart', async () => {
    renderAs('HR_ADMINISTRATOR', <OrgChart />, '/org/chart');
    const canvas = await screen.findByTestId('org-canvas');
    expect(within(canvas).getByText('Cora Chief')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /12 more in the field chart/i })).toBeInTheDocument();
    // Into Cora's team: Hana with the seat she is hiring for stacked beneath.
    await userEvent.click(within(canvas).getByRole('button', { name: 'Cora Chief' }));
    expect(await within(screen.getByTestId('org-canvas')).findByText('Payroll analyst')).toBeInTheDocument();
    expect(within(screen.getByTestId('org-canvas')).getByText('Open seat · P-1')).toBeInTheDocument();
  });

  it('search counts matches and Enter steps through them, opening the way to each', async () => {
    renderAs('HR_ADMINISTRATOR', <OrgChart />, '/org/chart?layout=list');
    await screen.findByRole('tree', { name: 'Company org chart' });
    const search = screen.getByRole('searchbox', { name: /search the org chart/i });
    await userEvent.type(search, 'sourcer');
    expect(await screen.findByText('1 of 1')).toBeInTheDocument();
    // Deepa sits three levels down — the search opened the path to her.
    expect(await screen.findByText('Deepa Sharma')).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'people{Enter}');
    expect(await screen.findByText('2 of 3')).toBeInTheDocument();
  });

  it('the list is a real tree: right opens, down moves, left closes', async () => {
    renderAs('HR_ADMINISTRATOR', <OrgChart />, '/org/chart?layout=list');
    const tree = await screen.findByRole('tree', { name: 'Company org chart' });
    const rows = () => within(tree).getAllByRole('treeitem');
    const first = rows()[0]!;
    first.focus();
    expect(first).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(first).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(first).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows()[1]);
  });

  it('the field: store coverage, the lead and their shift, the unplaced, and the client filter', async () => {
    renderAs('HR_ADMINISTRATOR', <OrgChart />, '/org/chart?view=field&layout=list');
    const tree = await screen.findByRole('tree', { name: 'Field org chart' });
    expect(within(tree).getByText('3 of 4 shifts filled today')).toBeInTheDocument();
    expect(within(tree).getByText('Not yet placed')).toBeInTheDocument();
    await userEvent.click(within(tree).getAllByRole('treeitem').find((r) => r.textContent?.includes('Front Beach'))!.querySelector('button')!);
    expect(await within(tree).findByText(/Shift supervisor · Mornings/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Client'), 'c2');
    await waitFor(() => expect(getOrgChart).toHaveBeenLastCalledWith({ view: 'field', clientId: 'c2', former: false }));
  });

  it('moves a reporting line: an account-only manager goes through the staff route', async () => {
    setStaffReportsTo.mockResolvedValue({ ok: true });
    renderAs('HR_ADMINISTRATOR', <OrgChart />, '/org/chart?layout=list');
    const tree = await screen.findByRole('tree', { name: 'Company org chart' });
    await userEvent.click(within(tree).getByRole('button', { name: /change who finn accounts reports to/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Reports to'), 'a:hr');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setStaffReportsTo).toHaveBeenCalledWith('fin', 'hr'));
  });

  it('a phone gets the list, never the canvas', async () => {
    phone = true;
    renderAs('HR_ADMINISTRATOR', <OrgChart />, '/org/chart');
    expect(await screen.findByRole('tree')).toBeInTheDocument();
    expect(screen.queryByTestId('org-canvas')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'How to show it' })).toBeNull();
  });

  it('only people who manage the org can move anyone', async () => {
    renderAs('FINANCE_ACCOUNTANT', <OrgChart />, '/org/chart?layout=list');
    await screen.findByRole('tree');
    expect(screen.queryByRole('button', { name: /reports to/i })).toBeNull();
  });

  it('an account with no name reads as the start of its email, on one line, with the role under it', async () => {
    getOrgChart.mockImplementation(({ view }: { view: string }) =>
      Promise.resolve({ view, nodes: [node({ id: 'u:mgr', kind: 'staff', name: 'manager@altohr.com', role: 'MANAGER', userId: 'mgr' })], fieldOnly: 0, unplaced: 0, truncated: false, limit: 5000 }),
    );
    renderAs('HR_ADMINISTRATOR', <OrgChart />, '/org/chart');
    const canvas = await screen.findByTestId('org-canvas');
    const name = within(canvas).getByText('manager');
    expect(name).toHaveAttribute('title', 'manager@altohr.com');
    expect(within(canvas).queryByText('@altohr.com')).not.toBeInTheDocument();
    // US spelling in the chart's controls.
    expect(screen.getByRole('option', { name: 'No color' })).toBeInTheDocument();
  });

  it('with no reporting lines it offers to set them, for many people at once', async () => {
    const FLAT: OrgNode[] = [
      node({ id: 'u:boss', kind: 'staff', name: 'ops@altohr.com', role: 'OPERATIONS_MANAGER', userId: 'boss' }),
      node({ id: 'u:hr', kind: 'staff', name: 'admin@altohr.com', role: 'HR_ADMINISTRATOR', userId: 'hr' }),
      node({ id: 'a:tg', kind: 'person', name: 'Tasha Grant', subtitle: 'Transportation director', associateId: 'tg', userId: 'tgu' }),
      node({ id: 'a:mc', kind: 'person', name: 'Mike Chen', subtitle: 'Driver', associateId: 'mc' }),
    ];
    getOrgChart.mockImplementation(({ view }: { view: string }) => Promise.resolve({ view, nodes: FLAT, fieldOnly: 0, unplaced: 0, truncated: false, limit: 5000 }));
    setStaffReportsTo.mockResolvedValue({});
    assignOrgFields.mockResolvedValue({});
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <OrgChart />, '/org/chart');
    expect(await screen.findByText('Nobody has a manager on this chart yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /Set reporting lines/ })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Set reporting lines' });
    await user.selectOptions(within(dialog).getByLabelText('Manager'), 'u:boss');
    // Mike has only a person record: an account-only manager can't take him.
    const mike = within(dialog).getByRole('checkbox', { name: /Mike Chen/ });
    expect(mike).toBeDisabled();
    expect(within(dialog).getByText('Needs a manager with a person record')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Everyone at the top \(2\)/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save for 2' }));
    // Accounts go through the staff route; Tasha has an account too, so hers moves the same way.
    await waitFor(() => expect(setStaffReportsTo).toHaveBeenCalledTimes(2));
    expect(setStaffReportsTo.mock.calls.map((c) => c.join('→')).sort()).toEqual(['hr→boss', 'tgu→boss']);
    expect(assignOrgFields).not.toHaveBeenCalled();
  });

  it('the bulk reporting-lines action is not offered to someone who can’t edit the chart', async () => {
    renderAs('FINANCE_ACCOUNTANT', <OrgChart />, '/org/chart');
    await screen.findByTestId('org-canvas');
    expect(screen.queryByRole('button', { name: /Set reporting lines/ })).not.toBeInTheDocument();
  });
});
