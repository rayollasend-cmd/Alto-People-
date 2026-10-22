import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import * as React from 'react';

vi.mock('@/lib/csv', () => ({ downloadCsv: vi.fn() }));
import { downloadCsv } from '@/lib/csv';
import { DataGrid, type DataGridProps, type GridColumn } from '@/components/ui/DataGrid';
import { FilterChip } from '@/components/ui/FilterBar';
import { useUrlParam } from '@/lib/useUrlState';

/**
 * The grid's chrome, held to the Fortune-500 pass (F1 · SH-1): no toolbar
 * over an empty list, one tray not two, the count that a server-paged list
 * actually has, a footnote under the table, one ⋯ on a phone, filters in a
 * sheet on a phone, and search/sort/filters that survive in the URL.
 */

type Row = { id: string; name: string; store: string };
const ROWS: Row[] = [
  { id: 'a', name: 'Rosa Martinez', store: 'Destin' },
  { id: 'b', name: 'Dee Kpakpo', store: 'Front Beach 218' },
  { id: 'c', name: 'Alan Darison', store: 'Miramar' },
];
const COLUMNS: GridColumn<Row>[] = [
  { key: 'name', header: 'Name', accessor: (r) => r.name, sortable: true, primary: true },
  { key: 'store', header: 'Store', accessor: (r) => r.store, sortable: true },
];

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.search}</output>;
}

function renderGrid(props: Partial<DataGridProps<Row>> = {}, url = '/list') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <DataGrid<Row> id="t" caption="Test rows" rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} {...props} />
      <Where />
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId('where').textContent;

/** Make the window `width` px wide for min-width queries (sm 640, md 768). */
function atWidth(width: number) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return { ...original(query), matches: m ? width >= Number(m[1]) : false };
  }) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(downloadCsv).mockClear();
});

describe('DataGrid — an empty list is the empty state alone', () => {
  it('draws no search, no "0 rows" and no Export over nothing, and names what is missing from the noun', () => {
    renderGrid({ rows: [], noun: { one: 'driver', many: 'drivers' } });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByText(/0 (rows|drivers)/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
    expect(document.querySelector('[data-grid-toolbar]')).toBeNull();
    expect(screen.getByRole('heading', { name: 'No drivers yet' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing here yet')).toBeNull();
  });

  it('without a noun the title comes from the caption, keeping an acronym or a brand as written', () => {
    const { unmount } = renderGrid({ rows: [], caption: 'Payroll runs' });
    expect(screen.getByRole('heading', { name: 'No payroll runs yet' })).toBeInTheDocument();
    unmount();
    renderGrid({ rows: [], caption: 'COBRA offers' });
    expect(screen.getByRole('heading', { name: 'No COBRA offers yet' })).toBeInTheDocument();
  });

  it('a page’s own empty state wins, with its next step', () => {
    renderGrid({
      rows: [],
      empty: { title: 'No statements yet', description: 'Finalize a week to send the first one.', action: <button type="button">Open this week</button> },
    });
    expect(screen.getByRole('heading', { name: 'No statements yet' })).toBeInTheDocument();
    expect(screen.getByText('Finalize a week to send the first one.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open this week' })).toBeInTheDocument();
  });

  it('keeps the filters when it cannot know whether they emptied the list', () => {
    renderGrid({ rows: [], filters: <FilterChip active>Open</FilterChip> });
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('hides filters that are all at their defaults over an empty list', () => {
    renderGrid({ rows: [], activeFilters: 0, filters: <FilterChip>Open</FilterChip> });
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'No test rows yet' })).toBeInTheDocument();
  });

  it('when filters emptied it, says so and offers to clear them', async () => {
    const onClearFilters = vi.fn();
    renderGrid({ rows: [], activeFilters: 2, onClearFilters, filters: <FilterChip active>Open</FilterChip> });
    expect(screen.getByRole('heading', { name: 'Nothing matches these filters' })).toBeInTheDocument();
    // The filters stay, so the way back is on screen too.
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('a search that matches nothing hides Columns and Export but keeps the search box', async () => {
    renderGrid();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search Test rows' }), 'nobody');
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search Test rows' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export Test rows/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose columns' })).toBeNull();
  });
});

describe('DataGrid — one tray, not two', () => {
  it('with a search it is the boxed bar', () => {
    renderGrid();
    expect(document.querySelector('[data-grid-toolbar]')).toHaveAttribute('data-grid-toolbar', 'bar');
    expect(document.querySelector('[data-grid-toolbar]')!.className).toMatch(/border/);
  });

  it('with no search and no filters the count, Columns and Export sit on one quiet line', () => {
    renderGrid({ search: false });
    const line = document.querySelector('[data-grid-toolbar]')!;
    expect(line).toHaveAttribute('data-grid-toolbar', 'line');
    expect(line.className).not.toMatch(/\bborder\b/);
    expect(within(line as HTMLElement).getByText('3 rows')).toBeInTheDocument();
    expect(within(line as HTMLElement).getByRole('button', { name: /Export Test rows/ })).toBeInTheDocument();
  });

  it("toolbar='inline' never draws a box, even with a search, for a grid under the page's own filter row", () => {
    renderGrid({ toolbar: 'inline' });
    const line = document.querySelector('[data-grid-toolbar]')!;
    expect(line).toHaveAttribute('data-grid-toolbar', 'line');
    expect(within(line as HTMLElement).getByRole('searchbox')).toBeInTheDocument();
  });

  it('toolbar={{ into }} puts the count and buttons in the page’s own row', () => {
    function Page() {
      const [slot, setSlot] = React.useState<HTMLElement | null>(null);
      return (
        <MemoryRouter>
          <div data-testid="page-row" ref={setSlot} />
          <DataGrid<Row> id="t" caption="Test rows" rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} search={false} toolbar={{ into: slot }} />
        </MemoryRouter>
      );
    }
    render(<Page />);
    const row = screen.getByTestId('page-row');
    expect(within(row).getByText('3 rows')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Export Test rows/ })).toBeInTheDocument();
    expect(document.querySelector('[data-grid-toolbar]')).toBeNull();
  });

  it('exportCsv={false} leaves the page’s own Export the only one', () => {
    renderGrid({ exportCsv: false });
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
  });

  it('draws the footnote under the table, not glued to the count', () => {
    renderGrid({ footnote: 'Capped at 500, narrow the dates.' });
    const note = screen.getByText('Capped at 500, narrow the dates.');
    const toolbar = document.querySelector('[data-grid-toolbar]')!;
    expect(toolbar.contains(note)).toBe(false);
    const table = screen.getByRole('table', { name: 'Test rows' });
    // The note comes after the table in the document.
    expect(table.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(toolbar as HTMLElement).getByText('3 rows')).toBeInTheDocument();
  });
});

describe('DataGrid — a server-paged list reads its real total', () => {
  it('says "1,060 entries · 1–200 shown" for a page of 200, and the next page says 201–400', () => {
    const page = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, name: `Entry ${i}`, store: 'Destin' }));
    const { unmount } = renderGrid({ rows: page, search: false, noun: { one: 'entry', many: 'entries' }, server: { total: 1060 } });
    expect(screen.getByText('1,060 entries · 1–200 shown')).toBeInTheDocument();
    unmount();
    renderGrid({ rows: page, search: false, noun: { one: 'entry', many: 'entries' }, server: { total: 1060, offset: 200 } });
    expect(screen.getByText('1,060 entries · 201–400 shown')).toBeInTheDocument();
  });

  it('says just the total when everything is on screen', () => {
    renderGrid({ search: false, noun: { one: 'entry', many: 'entries' }, server: { total: 3 } });
    expect(screen.getByText('3 entries')).toBeInTheDocument();
  });

  it('a search inside the loaded page says it searched what is loaded', async () => {
    renderGrid({ server: { total: 1060 } });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search Test rows' }), 'rosa');
    expect(screen.getByText('1 of 3 loaded')).toBeInTheDocument();
  });

  it('Export hands off to the page’s export of every match', async () => {
    const onExport = vi.fn();
    renderGrid({ server: { total: 1060, onExport } });
    await userEvent.click(screen.getByRole('button', { name: /Export Test rows/ }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(downloadCsv).not.toHaveBeenCalled();
  });

  it('keeps the plain capped reading ("2 of 612") for `total` alone', () => {
    renderGrid({ rows: ROWS.slice(0, 2), search: false, total: 612 });
    expect(screen.getByText('2 of 612')).toBeInTheDocument();
  });
});

describe('DataGrid — on a phone', () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  it('folds Columns and Export into one ⋯ menu beside the search, and Export works from it', async () => {
    restore = atWidth(390);
    renderGrid({ cards: false });
    expect(screen.queryByRole('button', { name: 'Choose columns' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Export Test rows/ })).toBeNull();
    const more = screen.getByRole('button', { name: 'More options for Test rows' });
    // On the search's row, not wrapped onto one of its own.
    expect(more.parentElement).toBe(screen.getByRole('searchbox').closest('[data-grid-toolbar]'));
    await userEvent.click(more);
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Store' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /Export Test rows/ }));
    expect(downloadCsv).toHaveBeenCalledTimes(1);
  });

  it('with the card list there is no column chooser — the menu only exports', async () => {
    restore = atWidth(390);
    renderGrid();
    await userEvent.click(screen.getByRole('button', { name: 'More options for Test rows' }));
    expect(await screen.findByRole('menuitem', { name: /Export Test rows/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
  });

  it('folds the filters behind "Filters (n)" with the search still in view, and the sheet holds them', async () => {
    restore = atWidth(390);
    renderGrid({ activeFilters: 1, filters: <FilterChip active>Open</FilterChip> });
    expect(screen.getByRole('searchbox', { name: 'Search Test rows' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Filters (1)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(sheet).getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('between sm and md: Columns and Export are buttons again, filters still fold', () => {
    restore = atWidth(700);
    renderGrid({ cards: false, filters: <FilterChip>Open</FilterChip> });
    expect(screen.getByRole('button', { name: 'Choose columns' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export Test rows/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });
});

describe('DataGrid — the view is a link', () => {
  it('urlKey keeps two grids’ searches apart: ?runs.q= and ?runs.sort=', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderGrid({ urlKey: 'runs', urlState: false });
      await user.type(screen.getByRole('searchbox', { name: 'Search Test rows' }), 'rosa');
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(new URLSearchParams(where()!).get('runs.q')).toBe('rosa');
      expect(new URLSearchParams(where()!).get('q')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Store' }));
      const p = new URLSearchParams(where()!);
      expect(p.get('runs.sort')).toBe('store');
      expect(p.get('runs.dir')).toBe('asc');
      // The search survived the sort write.
      expect(p.get('runs.q')).toBe('rosa');
    } finally {
      vi.useRealTimers();
    }
  });

  it('urlKey reads a shared link: the search and sort come back', () => {
    renderGrid({ urlKey: 'runs' }, '/list?runs.q=dee&runs.sort=name&runs.dir=desc');
    expect(screen.getByRole('searchbox', { name: 'Search Test rows' })).toHaveValue('dee');
    const table = screen.getByRole('table', { name: 'Test rows' });
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['Dee Kpakpo']);
  });

  it('filterKeys: a filter set in the URL counts, and Clear filters removes every one in one step', async () => {
    function Page() {
      const [status, setStatus] = useUrlParam('status', 'all', ['all', 'open', 'closed'] as const);
      const [site] = useUrlParam('site', '');
      const rows = ROWS.filter((r) => (status === 'closed' ? false : true) && (!site || r.store === site));
      return (
        <DataGrid<Row>
          id="t"
          caption="Test rows"
          rows={rows}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          filterKeys={['status', 'site']}
          filters={<FilterChip active={status === 'closed'} onClick={() => setStatus('closed')}>Closed</FilterChip>}
        />
      );
    }
    render(
      <MemoryRouter initialEntries={['/list?status=closed&site=Destin&tab=2']}>
        <Page />
        <Where />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Nothing matches these filters' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(where()).toBe('?tab=2');
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });
});
