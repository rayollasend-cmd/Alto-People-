import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Simple semantic table primitives. Phase 28 will swap to TanStack Table
 * for sortable / filterable / paginated grids; today these are styled
 * <table> elements with consistent borders, padding, and hover states.
 */
export const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto">
    <table
      ref={ref}
      className={cn('w-full caption-bottom text-sm', className)}
      {...props}
    />
  </div>
));
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
      'sticky top-0 z-10 bg-navy [&_tr]:border-b [&_tr]:border-navy-secondary',
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
