import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import type { ShiftPosition } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

/**
 * Departments & job profiles (/org), F500 G1:
 *   - one list of people: the People tab is gone, and its deep link
 *     (?tab=people&associateId=…, from a person's record) opens that
 *     person's org assignment; a bare ?tab=people goes to People;
 *   - "Shift roles", not a second thing called positions;
 *   - the order schedulers see is set by moving rows, never typed or shown as a number;
 *   - the client is a filter in the tab row, and the tab lives in the URL.
 */

vi.mock('@/lib/useClients', () => ({
  useClients: () => ({ clients: [{ id: 'c1', name: 'Coastal Resort' }, { id: 'c2', name: 'Harbor Inn' }], isError: false, refetch: vi.fn() }),
}));

let positions: ShiftPosition[] = [];
vi.mock('@/lib/orgApi', async (orig) => {
  const real = await orig<typeof import('@/lib/orgApi')>();
  return {
    ...real,
    listShiftPositions: vi.fn(async () => ({ shiftPositions: positions })),
    updateShiftPosition: vi.fn(async (id: string, input: { sortOrder?: number }) => ({ ...positions.find((p) => p.id === id)!, ...input })),
    listDepartments: vi.fn(async () => ({ departments: [{ id: 'd1', name: 'Housekeeping', code: null, parentId: null, clientId: null, description: null }] })),
    listCostCenters: vi.fn(async () => ({ costCenters: [] })),
    listJobProfiles: vi.fn(async () => ({ jobProfiles: [] })),
    listOrgAssociates: vi.fn(async () => ({
      associates: [
        {
          id: 'a1',
          firstName: 'Maria',
          lastName: 'Lopez',
          email: 'maria@example.com',
          managerId: null,
          managerName: null,
          departmentId: 'd1',
          departmentName: 'Housekeeping',
          costCenterId: null,
          costCenterCode: null,
          jobProfileId: null,
          jobProfileTitle: null,
          photoUrl: null,
        },
      ],
    })),
    listAssociateHistory: vi.fn(async () => ({ history: [] })),
  };
});

import { listOrgAssociates, listShiftPositions, updateShiftPosition } from '@/lib/orgApi';
import { OrgHome } from '@/pages/org/OrgHome';

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

function page(route: string) {
  return renderAs(
    'HR_ADMINISTRATOR',
    <>
      <Routes>
        <Route path="/org" element={<OrgHome />} />
        <Route path="/people" element={<p>The People page</p>} />
      </Routes>
      <Where />
    </>,
    route,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  positions = [
    { id: 'p1', clientId: 'c1', name: 'Housekeeper', sortOrder: 0, isLead: false },
    { id: 'p2', clientId: 'c1', name: 'Shift Lead', sortOrder: 1, isLead: true },
    { id: 'p3', clientId: 'c1', name: 'Front desk', sortOrder: 2, isLead: false },
  ];
});

describe('/org', () => {
  it('has no People tab; shift roles lead, and the client is a filter in the tab row', async () => {
    page('/org');
    const tabs = await screen.findByRole('tablist');
    const names = within(tabs).getAllByRole('tab').map((t) => t.textContent?.trim());
    expect(names).toEqual(['Shift roles', 'Departments', 'Cost centers', 'Job profiles', 'Positions', 'Custom fields']);
    expect(screen.getByRole('combobox', { name: /Filter by client/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Shift roles' })).toBeInTheDocument();
  });

  it('a person’s “Edit org assignment” link still opens their org assignment', async () => {
    page('/org?tab=people&associateId=a1');
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save assignment' })).toBeInTheDocument();
    // One person, asked for by id, inside the caller's reach (the API scopes it).
    await waitFor(() => expect(listOrgAssociates).toHaveBeenCalledWith(undefined, { id: 'a1', former: true }));
  });

  it('the old People tab without a person goes to People', async () => {
    page('/org?tab=people');
    expect(await screen.findByText('The People page')).toBeInTheDocument();
  });

  it('keeps the tab in the URL', async () => {
    const user = userEvent.setup();
    page('/org');
    await user.click(await screen.findByRole('tab', { name: 'Departments' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/org?tab=departments'));
  });

  it('shift roles show no order number; moving one saves the new order', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('alto:list.org.client.v1', JSON.stringify('c1'));
    page('/org');
    const rows = await screen.findAllByTestId('shift-role-row');
    expect(rows.map((r) => within(r).getAllByRole('button')[0]!.textContent)).toEqual(['Housekeeper', 'Shift Lead', 'Front desk']);
    // No "Order 0" column or number anywhere in the list.
    expect(screen.queryByText('Order')).not.toBeInTheDocument();
    expect(within(rows[0]!).queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Housekeeper up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Housekeeper down' }));
    // Only the two rows that moved are saved: Shift Lead to 0, Housekeeper to 1.
    await waitFor(() => expect(updateShiftPosition).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateShiftPosition).mock.calls.map((c) => [c[0], c[1]]).sort()).toEqual([
      ['p1', { sortOrder: 1 }],
      ['p2', { sortOrder: 0 }],
    ]);
    expect(listShiftPositions).toHaveBeenCalledWith('c1');
  });

  it('every client at once: no reordering (each client has its own list), and each role names its client', async () => {
    page('/org');
    const rows = await screen.findAllByTestId('shift-role-row');
    expect(within(rows[0]!).getByText(/Coastal Resort/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move .* down/ })).not.toBeInTheDocument();
    expect(screen.getByText('Pick a client to add roles or change their order.')).toBeInTheDocument();
  });
});
