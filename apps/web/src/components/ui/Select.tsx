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
  ({ className, invalid, size = 'md', children, ...props }, ref) => {
    const sm = size === 'sm';
    return (
      <div className="relative">
        <select
          ref={ref}
          aria-invalid={invalid || undefined}
          className={cn(
            'appearance-none flex w-full rounded-md border bg-navy-secondary/40 transition-colors',
            'border-navy-secondary hover:border-silver/40 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/40',
            'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-navy-secondary text-white',
            sm ? 'h-8 pl-2.5 pr-7 text-xs' : 'h-10 pl-3 pr-9 text-sm',
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
