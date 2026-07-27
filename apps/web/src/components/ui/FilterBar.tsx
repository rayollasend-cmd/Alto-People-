import * as React from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button, type ButtonProps } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

/**
 * The one filter-row surface. Audits found 68 hand-rolled toolbar wrappers
 * with three different border/background/padding recipes — this is the
 * canonical one (subtle navy tray, wrapping row, 8px gaps).
 */
export const FilterBar = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 py-2',
        className,
      )}
      {...props}
    />
  ),
);
FilterBar.displayName = 'FilterBar';

/**
 * Canonical filter chip: outline button that turns gold-tinted when
 * active. Replaces the eight competing chip languages (gold fill,
 * grey fill, steel segmented, raw buttons, trays...).
 */
export interface FilterChipProps extends Omit<ButtonProps, 'variant' | 'size'> {
  active?: boolean;
}

export const FilterChip = React.forwardRef<HTMLButtonElement, FilterChipProps>(
  ({ active, className, ...props }, ref) => (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="xs"
      aria-pressed={active}
      className={cn(
        active && 'border-gold text-gold bg-gold/10 hover:border-gold hover:text-gold',
        className,
      )}
      {...props}
    />
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
