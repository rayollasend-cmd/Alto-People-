import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/csv', () => ({ downloadCsv: vi.fn() }));
import { downloadCsv } from '@/lib/csv';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';

/**
 * The grid, held to the contract every list now inherits: sort any
 * column, search across them, hide one, export exactly what is on
 * screen, select and act in bulk, and say "N of M" honestly.
 */

type Row = { id: string; name: string; store: string; pct: number | null; note: string | null };

const ROWS: Row[] = [
  { id: 'a', name: 'Rosa Martinez', store: 'Destin', pct: 72, note: null },
  { id: 'b', name: 'Dee Kpakpo', store: 'Front Beach 218', pct: 98, note: 'covering' },
  { id: 'c', name: 'Alan Darison', store: 'Miramar', pct: null, note: null },
];

const COLUMNS: GridColumn<Row>[] = [
  { key: 'name', header: 'Name', accessor: (r) => r.name, sortable: true, primary: true },
  { key: 'store', header: 'Store', accessor: (r) => r.store, sortable: true, cardMeta: true },
  { key: 'pct', header: 'Checklist', accessor: (r) => r.pct, sortable: true, align: 'right', cell: (r) => (r.pct == null ? '—' : `${r.pct}%`) },
  { key: 'note', header: 'Note', accessor: (r) => r.note, defaultHidden: true },
];

function renderGrid(props: Partial<React.ComponentProps<typeof DataGrid<Row>>> = {}) {
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
  return render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <AuthContext.Provider value={auth as any}>
      <MemoryRouter initialEntries={['/list']}>
        <DataGrid<Row>
          id="test"
          caption="Test rows"
          rows={ROWS}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          {...props}
        />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const bodyNames = () => {
  const table = screen.getByRole('table', { name: 'Test rows' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]!.textContent);
};

describe('DataGrid', () => {
  // The column choice is remembered per grid, per person — which is the
  // feature, and also why each test starts from a clean slate.
  beforeEach(() => window.localStorage.clear());

  it('sorts by any sortable column, and a third click restores the original order', async () => {
    renderGrid();
    expect(bodyNames()).toEqual(['Rosa Martinez', 'Dee Kpakpo', 'Alan Darison']);

    const nameHead = screen.getByRole('button', { name: 'Name' });
    await userEvent.click(nameHead);
    expect(bodyNames()).toEqual(['Alan Darison', 'Dee Kpakpo', 'Rosa Martinez']);
    await userEvent.click(nameHead);
    expect(bodyNames()).toEqual(['Rosa Martinez', 'Dee Kpakpo', 'Alan Darison']);
    await userEvent.click(nameHead);
    expect(bodyNames()).toEqual(['Rosa Martinez', 'Dee Kpakpo', 'Alan Darison']);

    // Nulls sink whichever way the numbers go.
    await userEvent.click(screen.getByRole('button', { name: 'Checklist' }));
    expect(bodyNames()).toEqual(['Rosa Martinez', 'Dee Kpakpo', 'Alan Darison']);
    await userEvent.click(screen.getByRole('button', { name: 'Checklist' }));
    expect(bodyNames()).toEqual(['Dee Kpakpo', 'Rosa Martinez', 'Alan Darison']);
  });

  it('searches across the searchable columns and says how many it kept', async () => {
    renderGrid();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search Test rows' }), 'front');
    expect(bodyNames()).toEqual(['Dee Kpakpo']);
    expect(screen.getByText('1 of 3')).toBeInTheDocument();

    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search Test rows' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search Test rows' }), 'nobody');
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(bodyNames()).toHaveLength(3);
  });

  it('hides and shows columns, and never lets the primary column go', async () => {
    renderGrid();
    // "Note" starts hidden by default.
    expect(screen.queryByRole('columnheader', { name: 'Note' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Choose columns' }));
    // The primary column cannot be hidden.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Name' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Note' }));
    // The chooser stays open so several columns can be ticked in one go —
    // and an open menu hides the page from role queries, so close it first.
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByRole('columnheader', { name: 'Note' })).toBeInTheDocument();
  });

  it('exports exactly what is on screen — visible columns, current sort, current search', async () => {
    renderGrid();
    await userEvent.click(screen.getByRole('button', { name: 'Store' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search Test rows' }), 'a');
    await userEvent.click(screen.getByRole('button', { name: /Export Test rows/ }));

    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [filename, rows] = vi.mocked(downloadCsv).mock.calls[0]!;
    expect(filename).toBe('test-rows.csv');
    // Header is the visible columns only (Note is hidden).
    expect(rows[0]).toEqual(['Name', 'Store', 'Checklist']);
    // Sorted by store, filtered to names containing "a"; the null renders empty.
    expect(rows.slice(1)).toEqual([
      ['Rosa Martinez', 'Destin', 72],
      ['Dee Kpakpo', 'Front Beach 218', 98],
      ['Alan Darison', 'Miramar', ''],
    ]);
  });

  it('selects rows and offers the bulk bar, skipping rows that cannot be chosen', async () => {
    const actions = vi.fn((ids: string[]) => <span>acting on {ids.length}</span>);
    renderGrid({ selectable: { disabled: (r) => r.id === 'c', actions } });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select every row' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(actions).toHaveBeenLastCalledWith(['a', 'b'], expect.any(Function));

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('opens a row when asked, by keyboard as well as by mouse', async () => {
    const onRowClick = vi.fn();
    renderGrid({ onRowClick, rowActionLabel: (r) => `Open ${r.name}` });
    // The test stub answers min-width queries as matching, so this is the
    // desktop table.
    const row = within(screen.getByRole('table', { name: 'Test rows' })).getByRole('button', { name: 'Open Dee Kpakpo' });
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1]);
  });

  it('on a phone mounts the card stack and no table — never both', async () => {
    // Hiding the inactive layout with CSS would still commit every row
    // twice; the grid reads the breakpoint and renders one layout only.
    const desktopStub = window.matchMedia;
    window.matchMedia = ((query: string) => ({ ...desktopStub(query), matches: false })) as typeof window.matchMedia;
    try {
      const onRowClick = vi.fn();
      renderGrid({ onRowClick, rowActionLabel: (r) => `Open ${r.name}` });
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      const cards = screen.getByRole('list', { name: 'Test rows' });
      expect(within(cards).getAllByRole('listitem')).toHaveLength(3);
      await userEvent.click(within(cards).getByRole('button', { name: 'Open Dee Kpakpo' }));
      expect(onRowClick).toHaveBeenCalledWith(ROWS[1]);
    } finally {
      window.matchMedia = desktopStub;
    }
  });

  it('shows the loading, error and empty states rather than an empty table', () => {
    const { rerender } = renderGrid({ rows: null, loading: true });
    expect(screen.getByLabelText('Loading Test rows')).toBeInTheDocument();

    const onRetry = vi.fn();
    rerender(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <AuthContext.Provider value={{ user: { id: 'u1' } } as any}>
        <MemoryRouter>
          <DataGrid<Row> id="test" caption="Test rows" rows={null} error="Could not load." onRetry={onRetry} columns={COLUMNS} rowKey={(r) => r.id} />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByText('Could not load.')).toBeInTheDocument();
  });
});

describe('DataGrid — controlled selection', () => {
  it('lets a page own the chosen ids, and draws no bulk bar of its own', async () => {
    const onChange = vi.fn();
    renderGrid({
      selectable: { selection: { selected: new Set(['a']), onChange } },
    });
    // The page's choice is what the boxes show.
    const table = screen.getByRole('table', { name: 'Test rows' });
    expect(within(table).getByRole('checkbox', { name: 'Select Rosa Martinez' })).toBeChecked();
    expect(within(table).getByRole('checkbox', { name: 'Select Dee Kpakpo' })).not.toBeChecked();
    // No `actions` means the page draws its own bar.
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).not.toBeInTheDocument();

    await userEvent.click(within(table).getByRole('checkbox', { name: 'Select Dee Kpakpo' }));
    expect(onChange).toHaveBeenLastCalledWith(new Set(['a', 'b']));

    await userEvent.click(within(table).getByRole('checkbox', { name: 'Select every row' }));
    expect(onChange).toHaveBeenLastCalledWith(new Set(['a', 'b', 'c']));
  });

  it('adds and removes only its own rows from a choice that spans other grids', async () => {
    // 'z' belongs to some other grid on the page (another expiry bucket).
    const onChange = vi.fn();
    renderGrid({
      selectable: { selection: { selected: new Set(['z']), onChange } },
    });
    const table = screen.getByRole('table', { name: 'Test rows' });
    await userEvent.click(within(table).getByRole('checkbox', { name: 'Select every row' }));
    expect(onChange).toHaveBeenLastCalledWith(new Set(['z', 'a', 'b', 'c']));

    onChange.mockClear();
    const { unmount } = renderGrid({
      selectable: { selection: { selected: new Set(['z', 'a', 'b', 'c']), onChange } },
    });
    const tables = screen.getAllByRole('table', { name: 'Test rows' });
    await userEvent.click(
      within(tables[tables.length - 1]!).getByRole('checkbox', { name: 'Clear selection' }),
    );
    expect(onChange).toHaveBeenLastCalledWith(new Set(['z']));
    unmount();
  });
});

describe('DataGrid — grouping', () => {
  it('draws one table with a heading row where the group changes, and exports flat', async () => {
    renderGrid({
      groupBy: {
        key: (r) => r.store,
        header: (key, rows) => `${key} (${rows.length})`,
      },
    });
    const table = screen.getByRole('table', { name: 'Test rows' });
    const rows = within(table).getAllByRole('row').slice(1);
    // Group heading, its row, next heading, its row… in the rows' order.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Destin (1)'),
      expect.stringContaining('Rosa Martinez'),
      expect.stringContaining('Front Beach 218 (1)'),
      expect.stringContaining('Dee Kpakpo'),
      expect.stringContaining('Miramar (1)'),
      expect.stringContaining('Alan Darison'),
    ]);

    // Sorting by a column keeps every row inside its group.
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    const sortedRows = within(table).getAllByRole('row').slice(1);
    expect(sortedRows[0]).toHaveTextContent('Miramar (1)');
    expect(sortedRows[1]).toHaveTextContent('Alan Darison');

    // The export has no heading rows in it.
    await userEvent.click(screen.getByRole('button', { name: /Export Test rows/ }));
    const [, csv] = vi.mocked(downloadCsv).mock.calls.at(-1)!;
    expect(csv).toHaveLength(4);
  });
});
