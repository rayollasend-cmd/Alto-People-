import * as React from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useMinWidth } from '@/lib/useViewport';
import { useI18n } from '@/lib/i18n';
import { useUrlFilters } from '@/lib/useUrlState';
import { Button, type ButtonProps } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FilterSheet } from '@/components/FilterSheet';
import { filterPillClass } from './filterPill';

export { filterPillClass };

/**
 * The one filter-row surface. Audits found 68 hand-rolled toolbar wrappers
 * with three different border/background/padding recipes — this is the
 * canonical one (subtle navy tray, wrapping row, 8px gaps).
 *
 * With no extra props it is exactly that tray around its children. The
 * slots below give a list page the rest of the pattern without wiring it
 * by hand:
 *
 *   <FilterBar
 *     search={<SearchInput … />}       // stays in view on every width
 *     activeFilters={2}                // or urlKey={['status', 'site']}
 *     count={<span>12 of 40</span>}    // the count line
 *     actions={<Button>Export</Button>}
 *   >
 *     {chips and selects}
 *   </FilterBar>
 *
 * Below md, a bar that knows its filters (`activeFilters` or `urlKey`)
 * folds them behind one "Filters (2)" chip that opens a bottom sheet, so a
 * phone's first screen shows the search and the first records — not three
 * rows of chips (People, Recruiting, HR cases, Goals). From md up the
 * filters sit inline as before.
 */
export interface FilterBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The search field. Never folded: on a phone it leads the first row. */
  search?: React.ReactNode;
  /** The count line ("12 of 40 people"). Right-aligned; on a phone it sits opposite the Filters chip. */
  count?: React.ReactNode;
  /** Controls that stay in the row on every width (a ⋯ menu, Export). */
  actions?: React.ReactNode;
  /**
   * How many filters are off their default. Passing it opts the bar into
   * the phone sheet; the chip reads "Filters (n)".
   */
  activeFilters?: number;
  /**
   * The URL params the filters keep (useUrlParam keys). The bar counts the
   * set ones itself — a default is never written, so a set param is a
   * filter in use — and the phone sheet offers Clear for them in one step.
   * Implies the phone sheet.
   */
  urlKey?: string | readonly string[];
  /** Clears the filters; offered in the phone sheet when any are in use. */
  onClearFilters?: () => void;
  /** Force the phone sheet on or off. Default: on when the bar knows its filters. */
  collapse?: boolean;
  /** No tray: the controls sit on the page (a grid's quiet count line). */
  bare?: boolean;
  /** The sheet's one-line help. */
  sheetDescription?: string;
}

const TRAY = 'rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 py-2';

export const FilterBar = React.forwardRef<HTMLDivElement, FilterBarProps>((props, ref) =>
  props.urlKey !== undefined ? <UrlFilterBar {...props} ref={ref} /> : <FilterBarCore {...props} ref={ref} />,
);
FilterBar.displayName = 'FilterBar';

const UrlFilterBar = React.forwardRef<HTMLDivElement, FilterBarProps>(({ urlKey, activeFilters, onClearFilters, ...rest }, ref) => {
  const keys = typeof urlKey === 'string' ? [urlKey] : (urlKey ?? []);
  const url = useUrlFilters(keys);
  return (
    <FilterBarCore
      {...rest}
      ref={ref}
      collapse={rest.collapse ?? true}
      activeFilters={activeFilters ?? url.active}
      onClearFilters={onClearFilters ?? url.clear}
    />
  );
});
UrlFilterBar.displayName = 'UrlFilterBar';

const FilterBarCore = React.forwardRef<HTMLDivElement, FilterBarProps>(
  (
    {
      className,
      children,
      search,
      count,
      actions,
      activeFilters,
      urlKey: _urlKey,
      onClearFilters,
      collapse,
      bare,
      sheetDescription,
      ...props
    },
    ref,
  ) => {
    const roomy = useMinWidth(768);
    const [open, setOpen] = React.useState(false);
    const hasFilters = React.Children.toArray(children).length > 0;
    const folds = hasFilters && !roomy && (collapse ?? activeFilters !== undefined);
    const slotted = search !== undefined || count !== undefined || actions !== undefined;
    const countNode = count != null && count !== false ? <div className="ml-auto min-w-0 shrink-0 text-xs tabular-nums text-ink-muted">{count}</div> : null;

    if (folds) {
      // Phone: the search (and the menu) on the first row; the Filters chip
      // and the count on the second. Nothing ends up alone on a row.
      const sheet = (
        <FilterSheet
          mobile
          open={open}
          onOpenChange={setOpen}
          activeCount={activeFilters ?? 0}
          onClear={onClearFilters}
          description={sheetDescription}
        >
          <div className="flex flex-wrap items-center gap-2">{children}</div>
        </FilterSheet>
      );
      return (
        <div ref={ref} className={cn('flex flex-col gap-2', !bare && TRAY, className)} {...props}>
          {search != null && search !== false && (
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">{search}</div>
              {actions}
            </div>
          )}
          <div className="flex min-w-0 items-center gap-2">
            {sheet}
            {countNode}
            {(search == null || search === false) && actions}
          </div>
        </div>
      );
    }

    return (
      <div ref={ref} className={cn('flex flex-wrap items-center gap-2', !bare && TRAY, className)} {...props}>
        {slotted && search != null && search !== false ? (
          // A phone gives the box the room the count and menu leave; from
          // sm up it keeps a usable minimum and the row wraps around it.
          <div className="min-w-0 flex-1 basis-40 sm:min-w-[12rem]">{search}</div>
        ) : null}
        {children}
        {countNode}
        {actions}
      </div>
    );
  },
);
FilterBarCore.displayName = 'FilterBarCore';

/** The count inside a chip: "Open 3". */
export function FilterCount({ value, className }: { value: number; className?: string }) {
  const { lang } = useI18n();
  return <span className={cn('tabular-nums text-xs opacity-80', className)}>{value.toLocaleString(lang)}</span>;
}

/**
 * Canonical filter chip: a pill that turns gold-tinted when active.
 * Replaces the eight competing chip languages (gold fill, grey fill,
 * steel segmented, raw buttons, trays...). Pass `count` for a status
 * filter ("Open 3").
 */
export interface FilterChipProps extends Omit<ButtonProps, 'variant' | 'size'> {
  active?: boolean;
  /** How many records the filter would show. */
  count?: number;
}

export const FilterChip = React.forwardRef<HTMLButtonElement, FilterChipProps>(
  ({ active, count, className, children, asChild, ...props }, ref) => (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="xs"
      aria-pressed={active}
      className={filterPillClass(Boolean(active), className)}
      asChild={asChild}
      {...props}
    >
      {/* A Slot takes exactly one child: no count beside a link chip. */}
      {asChild ? (
        children
      ) : (
        <>
          {children}
          {/* The space keeps the name "Open 3" for a screen reader; flex drops it visually. */}
          {count != null && ' '}
          {count != null && <FilterCount value={count} />}
        </>
      )}
    </Button>
  ),
);
FilterChip.displayName = 'FilterChip';

/**
 * Search input with the leading icon baked in — settles the pl-9 vs pl-8
 * split (16 hand-rolled copies with two different offsets).
 */
export interface SearchInputProps
  extends Omit<React.ComponentProps<typeof Input>, 'type'> {
  /**
   * Classes for the positioning wrapper, not the input. The wrapper is the
   * flex child inside a FilterBar, so layout utilities (`ml-auto`,
   * `flex-1`, `w-64`) have to land here to have any effect.
   */
  wrapperClassName?: string;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, wrapperClassName, ...props }, ref) => (
    <div className={cn('relative', wrapperClassName)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-silver/70"
        aria-hidden="true"
      />
      <Input ref={ref} type="search" className={cn('pl-9', className)} {...props} />
    </div>
  ),
);
SearchInput.displayName = 'SearchInput';

/**
 * Micro-label / eyebrow — the `text-2xs uppercase tracking` pattern that
 * was hand-rolled 190 times with three different tracking values.
 */
export const EyebrowLabel = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'text-2xs font-medium uppercase tracking-[0.14em] text-silver/70',
        className,
      )}
      {...props}
    />
  ),
);
EyebrowLabel.displayName = 'EyebrowLabel';
