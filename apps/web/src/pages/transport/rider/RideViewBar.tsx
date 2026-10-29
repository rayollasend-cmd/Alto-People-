import { useRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * The Ride page's views — Upcoming · History · Charges · Places — as ONE
 * segmented row. The pills it replaces wrapped to two rows at 390px (the
 * page reads at 16px on a phone); this row never wraps, and scrolls
 * sideways in a language whose words don't fit.
 */
export function RideViewBar<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  ariaLabel: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (from: number, by: number) => {
    const next = (from + by + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div className={cn('-mx-4 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0', className)}>
      <div role="radiogroup" aria-label={ariaLabel} className="flex w-max min-w-full gap-1 rounded-lg border border-line bg-surface p-1">
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(i, 1);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  move(i, -1);
                }
              }}
              className={cn(
                // text-[15px], not text-sm: the page's phone rule lifts every .text-sm to 16px.
                'min-h-10 flex-1 whitespace-nowrap rounded-md border px-3 text-[15px] font-medium transition-colors coarse:min-h-11',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                on ? 'border-accent-300 bg-accent-100 text-accent-800' : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
