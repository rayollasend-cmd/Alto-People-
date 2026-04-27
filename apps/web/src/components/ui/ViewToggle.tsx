import { useCallback, useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from './Tooltip';

/**
 * Phase 72 — segmented control between view modes (e.g. table / cards).
 * Stateless visually; the page owns the value and persistence is handled
 * by the `useViewMode` hook below.
 */

export interface ViewToggleOption<V extends string = string> {
  value: V;
  label: string;
  icon: LucideIcon;
}

interface ViewToggleProps<V extends string = string> {
  value: V;
  onChange: (value: V) => void;
  options: ViewToggleOption<V>[];
  className?: string;
  /** Tooltips on each segment. Defaults to "<label> view". */
  tooltips?: Partial<Record<V, string>>;
  /** Visually-only, accessible name for the group ("View"). */
  ariaLabel?: string;
}

export function ViewToggle<V extends string = string>({
  value,
  onChange,
  options,
  className,
  tooltips,
  ariaLabel = 'View',
}: ViewToggleProps<V>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center rounded-md border border-navy-secondary bg-navy-secondary/30 p-0.5',
        className
      )}
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          <Tooltip key={opt.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onChange(opt.value)}
                aria-pressed={active}
                aria-label={opt.label}
                className={cn(
                  'inline-flex items-center justify-center h-7 w-7 rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                  active
                    ? 'bg-navy text-white shadow-sm'
                    : 'text-silver hover:text-white'
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {tooltips?.[opt.value] ?? `${opt.label} view`}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Persisted per-page view-mode preference.
 *
 * Usage:
 *   const [view, setView] = useViewMode('applications', 'table', ['table', 'cards']);
 *
 * `key` is the storage key suffix; the values list constrains rehydration
 * (so a stale value from before an option was renamed gets discarded).
 */
export function useViewMode<V extends string>(
  key: string,
  defaultValue: V,
  allowed: readonly V[]
): [V, (next: V) => void] {
  const storageKey = `alto.view.${key}`;
  const [value, setValue] = useState<V>(() => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored && (allowed as readonly string[]).includes(stored)) {
        return stored as V;
      }
    } catch {
      /* private mode etc. */
    }
    return defaultValue;
  });

  // Re-validate if `allowed` shifts (rare; mostly a development conveinience).
  useEffect(() => {
    if (!(allowed as readonly string[]).includes(value)) {
      setValue(defaultValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback(
    (next: V) => {
      setValue(next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        /* persistence is best-effort */
      }
    },
    [storageKey]
  );

  return [value, set];
}
