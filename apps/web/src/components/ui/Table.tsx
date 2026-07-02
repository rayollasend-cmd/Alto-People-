import * as React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Simple semantic table primitives. Phase 28 will swap to TanStack Table
 * for sortable / filterable / paginated grids; today these are styled
 * <table> elements with consistent borders, padding, and hover states.
 */
export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /**
   * Screen-reader-only table name (VPAT 1.3.1). Most tables sit under a
   * visible heading sighted users associate by proximity; AT users get
   * "table, 6 columns" with no context. Pass the same name the heading
   * shows — it renders as an sr-only <caption>, so nothing changes
   * visually. For a VISIBLE caption, use <TableCaption> instead.
   */
  caption?: string;
}

export const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, caption, children, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table
        ref={ref}
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  )
);
Table.displayName = 'Table';

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      // Phase 69 — sticky to the top of any scrolling container so the
      // column labels stay visible when the user pages through long
      // tables. The bg shim sits *behind* the row so we don't see
      // content bleeding through during scroll.
      // Slightly darker than the surrounding card so the header band
      // visually separates from the body without needing a dividing
      // line that fights with the per-row borders.
      'sticky top-0 z-10 bg-navy-secondary/50 [&_tr]:border-b [&_tr]:border-navy-secondary',
      className,
    )}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn('[&_tr:last-child]:border-0', className)}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

export const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      'border-t border-navy-secondary bg-navy-secondary/30 font-medium',
      className
    )}
    {...props}
  />
));
TableFooter.displayName = 'TableFooter';

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, onKeyDown, tabIndex, role, ...props }, ref) => {
  // Convention: callers mark a row interactive by adding `cursor-pointer`
  // to className alongside an onClick. We promote those to a fully
  // keyboard-accessible button — Enter/Space activate, tab order stops
  // here, screen readers announce role="button". Non-interactive rows
  // are untouched.
  const interactive = (className ?? '').includes('cursor-pointer');
  const handleKeyDown = interactive
    ? (e: React.KeyboardEvent<HTMLTableRowElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          // Skip if the user pressed Enter/Space inside a nested
          // button/link/input — that nested control should handle the key.
          const t = e.target as HTMLElement;
          if (t !== e.currentTarget && t.closest('button, a, input, select, textarea, [contenteditable]')) {
            onKeyDown?.(e);
            return;
          }
          e.preventDefault();
          e.currentTarget.click();
        }
        onKeyDown?.(e);
      }
    : onKeyDown;
  return (
    <tr
      ref={ref}
      onKeyDown={handleKeyDown}
      tabIndex={interactive ? (tabIndex ?? 0) : tabIndex}
      role={interactive ? (role ?? 'button') : role}
      className={cn(
        'border-b border-navy-secondary transition-colors',
        // Default subtle hover for any row.
        'hover:bg-navy-secondary/40',
        // Stronger hover when the row is interactive (callers add `cursor-pointer`).
        '[&.cursor-pointer]:hover:bg-navy-secondary/60',
        // Keyboard focus ring for the interactive rows promoted above.
        '[&.cursor-pointer]:focus-visible:outline-none [&.cursor-pointer]:focus-visible:ring-2 [&.cursor-pointer]:focus-visible:ring-gold-bright [&.cursor-pointer]:focus-visible:ring-inset',
        // Selected: brighter background plus a thin gold rail on the first cell.
        'data-[state=selected]:bg-navy-secondary',
        '[&[data-state=selected]>td:first-child]:border-l-2 [&[data-state=selected]>td:first-child]:border-l-gold',
        className
      )}
      {...props}
    />
  );
});
TableRow.displayName = 'TableRow';

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    scope="col"
    className={cn(
      'h-10 px-3 text-left align-middle text-[10px] font-semibold uppercase tracking-widest text-silver',
      className
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn('px-3 py-3 align-middle text-sm text-white', className)}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

/* ===== Column sorting ===================================================== */

export type SortDirection = 'asc' | 'desc';

export interface TableSortState<K extends string = string> {
  key: K | null;
  direction: SortDirection;
}

/**
 * Client-side column sorting for the admin lists (these tables cap at a
 * few hundred rows, so in-memory sorting is exact, not approximate).
 *
 *   const { sorted, sortState, toggleSort } = useTableSort(rows, {
 *     name: (r) => r.name,
 *     date: (r) => new Date(r.createdAt).getTime(),
 *   });
 *   …
 *   <SortableTableHead sortKey="name" state={sortState} onSort={toggleSort}>
 *     Associate
 *   </SortableTableHead>
 *
 * With no active sort the input order (usually the server's) is kept.
 * Strings compare case-insensitively via localeCompare; null/undefined
 * accessor values always sink to the bottom in either direction.
 */
export function useTableSort<T, K extends string>(
  rows: T[],
  accessors: Record<K, (row: T) => string | number | null | undefined>,
  initial?: TableSortState<K>,
): {
  sorted: T[];
  sortState: TableSortState<K>;
  toggleSort: (key: K) => void;
} {
  const [sortState, setSortState] = React.useState<TableSortState<K>>(
    initial ?? { key: null, direction: 'asc' },
  );

  const toggleSort = React.useCallback((key: K) => {
    setSortState((prev) =>
      prev.key === key
        ? prev.direction === 'asc'
          ? { key, direction: 'desc' }
          : // Third click clears back to the server's order.
            { key: null, direction: 'asc' }
        : { key, direction: 'asc' },
    );
  }, []);

  const sorted = React.useMemo(() => {
    if (!sortState.key) return rows;
    const accessor = accessors[sortState.key];
    const dir = sortState.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls sink regardless of direction
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' }) * dir;
    });
    // accessors is expected to be a stable literal; keying the memo on the
    // state + rows keeps re-sorts cheap without demanding useMemo at every
    // call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortState]);

  return { sorted, sortState, toggleSort };
}

export interface SortableTableHeadProps<K extends string = string>
  extends React.ThHTMLAttributes<HTMLTableCellElement> {
  sortKey: K;
  state: TableSortState<K>;
  onSort: (key: K) => void;
}

/** TableHead with a click-to-sort affordance and aria-sort announcement. */
export function SortableTableHead<K extends string>({
  sortKey,
  state,
  onSort,
  className,
  children,
  ...props
}: SortableTableHeadProps<K>) {
  const active = state.key === sortKey;
  const direction = active ? state.direction : undefined;
  return (
    <TableHead
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('p-0', className)}
      {...props}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'flex h-10 w-full items-center gap-1 px-3 text-left text-[10px] font-semibold uppercase tracking-widest transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright',
          active ? 'text-gold' : 'text-silver hover:text-white',
        )}
      >
        <span className="truncate">{children}</span>
        {active ? (
          direction === 'asc' ? (
            <ArrowUp className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <ArrowDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-60 [th:hover>&]:opacity-60" aria-hidden="true" />
        )}
      </button>
    </TableHead>
  );
}

export const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn('mt-3 text-xs text-silver', className)}
    {...props}
  />
));
TableCaption.displayName = 'TableCaption';
