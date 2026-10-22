import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { FilterBar, FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { FilterSheet } from '@/components/FilterSheet';
import { useUrlParam } from '@/lib/useUrlState';

/**
 * One filter look, one phone pattern (F1 · SH-1): FilterChip and
 * SegmentedControl draw the same pill in sentence case with a count; the
 * segmented row wraps instead of pushing a phone sideways; and a FilterBar
 * that knows its filters folds them into a sheet below md, keeping the
 * search in view.
 */

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

let restore: () => void = () => {};
afterEach(() => {
  restore();
  restore = () => {};
});

describe('FilterChip and SegmentedControl — one look', () => {
  it('draw the same pill, and the same selected tint', () => {
    render(
      <>
        <FilterChip active>Open</FilterChip>
        <FilterChip>Closed</FilterChip>
        <SegmentedControl ariaLabel="Window" value="7" onChange={() => {}} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} />
      </>,
    );
    const chip = screen.getByRole('button', { name: 'Open' });
    const idleChip = screen.getByRole('button', { name: 'Closed' });
    const seg = screen.getByRole('radio', { name: '7 days' });
    const idleSeg = screen.getByRole('radio', { name: '30 days' });
    for (const el of [chip, idleChip, seg, idleSeg]) {
      expect(el.className).toMatch(/\brounded-full\b/);
      expect(el.className).toMatch(/\bh-8\b/);
      expect(el.className).toMatch(/\btext-sm\b/);
    }
    expect(chip.className).toMatch(/bg-gold\/15/);
    expect(seg.className).toMatch(/bg-gold\/15/);
    expect(idleChip.className).not.toMatch(/bg-gold/);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(seg).toHaveAttribute('aria-checked', 'true');
  });

  it('a chip is always sentence case, even when the page asks for capitals', () => {
    render(<FilterChip className="uppercase tracking-wider">At risk</FilterChip>);
    const chip = screen.getByRole('button', { name: 'At risk' });
    expect(chip.className).not.toMatch(/\buppercase\b/);
    expect(chip.className).not.toMatch(/tracking-wider/);
    expect(chip.className).toMatch(/\bnormal-case\b/);
  });

  it('carries a count when given one', () => {
    render(
      <>
        <FilterChip count={3}>Open</FilterChip>
        <SegmentedControl ariaLabel="Status" value="all" onChange={() => {}} options={[{ value: 'all', label: 'All', count: 1240 }]} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Open 3' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All 1,240' })).toBeInTheDocument();
  });

  it('the segmented row wraps inside its container, and a sentence-long option wraps inside its pill', () => {
    render(
      <SegmentedControl
        ariaLabel="When the account changes"
        value="hold"
        onChange={() => {}}
        options={[
          { value: 'pay', label: 'Pay the previous verified account' },
          { value: 'hold', label: 'Hold the pay until Finance verifies' },
          { value: 'x', label: 'Skip' },
        ]}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'When the account changes' });
    expect(group.className).toMatch(/\bflex-wrap\b/);
    expect(group.className).toMatch(/\bmax-w-full\b/);
    const long = screen.getByRole('radio', { name: 'Pay the previous verified account' });
    expect(long.className).toMatch(/\bwhitespace-normal\b/);
    expect(long.className).not.toMatch(/\bwhitespace-nowrap\b/);
    expect(screen.getByRole('radio', { name: 'Skip' }).className).toMatch(/\bwhitespace-nowrap\b/);
  });

  it('a chip can still be a link (asChild) without a count beside it', () => {
    render(
      <MemoryRouter>
        <FilterChip asChild count={2}>
          <a href="/people?status=PENDING">Pending</a>
        </FilterChip>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Pending' })).toHaveAttribute('href', '/people?status=PENDING');
  });
});

describe('FilterBar', () => {
  it('with no extra props is the same tray around its children as before', () => {
    render(
      <FilterBar data-testid="bar" className="mb-4">
        <FilterChip>Open</FilterChip>
      </FilterBar>,
    );
    const bar = screen.getByTestId('bar');
    expect(bar.className).toMatch(/flex flex-wrap items-center gap-2/);
    expect(bar.className).toMatch(/rounded-md border border-navy-secondary bg-navy-secondary\/20 px-3 py-2/);
    expect(bar.className).toMatch(/mb-4/);
    expect(within(bar).getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('on a desktop keeps the filters inline beside the search, the count and the actions', () => {
    render(
      <FilterBar search={<SearchInput aria-label="Search people" />} activeFilters={1} count={<span>12 of 40</span>} actions={<button type="button">Export</button>}>
        <FilterChip active>Pending</FilterChip>
      </FilterBar>,
    );
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull();
    expect(screen.getByText('12 of 40')).toBeInTheDocument();
  });

  it('below md folds the filters behind "Filters (n)", the search first, and the sheet holds them', async () => {
    restore = atWidth(390);
    render(
      <FilterBar search={<SearchInput aria-label="Search people" />} activeFilters={2} count={<span>12 of 40</span>} actions={<button type="button">More</button>}>
        <FilterChip active>Pending</FilterChip>
        <FilterChip active>W-2</FilterChip>
      </FilterBar>,
    );
    const search = screen.getByRole('searchbox', { name: 'Search people' });
    const chip = screen.getByRole('button', { name: 'Filters (2)' });
    // The search leads; the chip and the count share the next row.
    expect(search.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chip.parentElement).toBe(screen.getByText('12 of 40').parentElement!.parentElement);
    expect(screen.queryByRole('button', { name: 'Pending' })).toBeNull();
    await userEvent.click(chip);
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(sheet).getByRole('button', { name: 'Pending' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'W-2' })).toBeInTheDocument();
  });

  it('urlKey: counts the filters set in the URL and the sheet clears them in one step', async () => {
    restore = atWidth(390);
    function Page() {
      const [status, setStatus] = useUrlParam('status', 'all', ['all', 'pending'] as const);
      const loc = useLocation();
      return (
        <>
          <FilterBar search={<SearchInput aria-label="Search people" />} urlKey={['status', 'site']}>
            <FilterChip active={status === 'pending'} onClick={() => setStatus('pending')}>
              Pending
            </FilterChip>
          </FilterBar>
          <output data-testid="where">{loc.search}</output>
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={['/people?status=pending&site=s1&q=ana']}>
        <Page />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filters (2)' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
    // The search stays; the two filters go.
    expect(screen.getByTestId('where').textContent).toBe('?q=ana');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });
});

describe('FilterSheet', () => {
  it('builds its chip from the count, in the person’s language, and only offers Clear while filters are on', async () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <FilterSheet mobile open={false} onOpenChange={() => {}} activeCount={0} onClear={onClear}>
        <span>filters</span>
      </FilterSheet>,
    );
    expect(screen.getByTestId('filter-sheet-chip')).toHaveTextContent('Filters');
    rerender(
      <FilterSheet mobile open onOpenChange={() => {}} activeCount={3} onClear={onClear}>
        <span>filters</span>
      </FilterSheet>,
    );
    expect(screen.getByTestId('filter-sheet-chip')).toHaveTextContent('Filters (3)');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit summary a page already passes', () => {
    render(
      <FilterSheet mobile open={false} onOpenChange={() => {}} summary="Filters (2)">
        <span>filters</span>
      </FilterSheet>,
    );
    expect(screen.getByTestId('filter-sheet-chip')).toHaveTextContent('Filters (2)');
  });
});
