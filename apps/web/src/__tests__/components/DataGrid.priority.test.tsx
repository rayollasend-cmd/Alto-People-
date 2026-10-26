import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '@/lib/auth';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';

/**
 * Column priority by room (F500 2026-10-26: the People and Onboarding tables
 * scrolled sideways at 1440 with the sidebar open). A column with
 * `hideBelow` leaves the TABLE while the grid's own box is narrower than
 * that — never the primary column, and never the export or the chooser.
 */

type Row = { id: string; name: string; phone: string; store: string };
const ROWS: Row[] = [{ id: 'a', name: 'Rosa Martinez', phone: '555-0100', store: 'Destin' }];
const COLUMNS: GridColumn<Row>[] = [
  { key: 'name', header: 'Name', accessor: (r) => r.name, primary: true, hideBelow: 5000 },
  { key: 'store', header: 'Store', accessor: (r) => r.store },
  { key: 'phone', header: 'Phone', accessor: (r) => r.phone, hideBelow: 1000 },
];

const auth = {
  isInitializing: false,
  isOffline: false,
  user: { id: 'u1', email: 'x@y.z', role: 'HR_ADMINISTRATOR', status: 'ACTIVE', clientId: null, associateId: null },
  role: 'HR_ADMINISTRATOR',
  capabilities: new Set(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  can: () => true,
};

function renderAt(width: number) {
  const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
  render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <AuthContext.Provider value={auth as any}>
      <MemoryRouter>
        <DataGrid<Row> id="prio" caption="Prio rows" rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return spy;
}

const headers = () => within(screen.getByRole('table', { name: 'Prio rows' })).getAllByRole('columnheader').map((h) => h.textContent);

afterEach(() => vi.restoreAllMocks());

describe('DataGrid column priority (hideBelow)', () => {
  it('drops a low-priority column while the grid is narrower than its mark', () => {
    renderAt(900);
    expect(headers()).toEqual(['Name', 'Store']);
  });

  it('keeps it when there is room', () => {
    renderAt(1200);
    expect(headers()).toEqual(['Name', 'Store', 'Phone']);
  });

  it('never drops the primary column', () => {
    renderAt(300);
    expect(headers()).toContain('Name');
  });
});
