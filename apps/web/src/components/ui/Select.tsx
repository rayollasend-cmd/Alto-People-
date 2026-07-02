import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  invalid?: boolean;
  /** 'md' (h-10, default) for forms; 'sm' (h-8) for inline filter rows. */
  size?: 'sm' | 'md';
}

/**
 * Styled wrapper around the native <select>. Native is intentional —
 * we get free a11y, mobile pickers, and keyboard navigation, and the
 * dropdown panel stays usable on every platform without us reinventing
 * Radix Select. The chevron is rendered ourselves because native
 * appearance:none is required to apply our border + bg tokens.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, invalid, size = 'md', required, children, ...props }, ref) => {
    const sm = size === 'sm';
    return (
      <div className="relative">
        <select
          ref={ref}
          required={required}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          className={cn(
            'appearance-none flex w-full rounded-md border bg-navy-secondary/40 transition-colors',
            'border-navy-secondary hover:border-silver/40 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/40',
            'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-navy-secondary text-white',
            // Touch: 44px tall and 16px text regardless of size — a 32px
            // select with 12px text is both hard to hit and triggers the
            // iOS focus-zoom. Pointer-keyed so iPads qualify; precise
            // pointers keep the compact variants.
            sm
              ? 'h-8 coarse:h-11 pl-2.5 pr-7 text-xs coarse:text-base'
              : 'h-10 coarse:h-11 pl-3 pr-9 text-sm coarse:text-base',
            invalid && 'border-alert hover:border-alert focus:border-alert focus:ring-alert/40',
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          className={cn(
            'pointer-events-none absolute top-1/2 -translate-y-1/2 text-silver/70',
            sm ? 'right-2 h-3.5 w-3.5' : 'right-2.5 h-4 w-4',
          )}
          aria-hidden="true"
        />
      </div>
    );
  },
);
Select.displayName = 'Select';
