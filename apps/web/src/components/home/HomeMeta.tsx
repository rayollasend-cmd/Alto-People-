import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * The quiet line under a home's greeting — today's date, the company clock
 * (week end, close, payday). One look on every home: items separated by a
 * dot drawn BETWEEN them (never a "·" leading a wrapped phone line), no
 * year where it is this year, and no role pill (the account menu already
 * says who you are).
 *
 *   <HomeMeta items={[<LiveNow render={(n) => fmtDayShort(n)} />, ...clockParts]} />
 */
export function HomeMeta({ items, className }: { items: React.ReactNode[]; className?: string }) {
  const shown = items.filter((i) => i !== null && i !== undefined && i !== false && i !== '');
  if (shown.length === 0) return null;
  return (
    <ul
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted',
        // The separator belongs to the item after it, and a wrapped line
        // starts with an item, not a dot.
        '[&>li+li]:before:mr-2 [&>li+li]:before:text-ink-subtle [&>li+li]:before:content-["·"]',
        className,
      )}
      data-testid="home-meta"
    >
      {shown.map((item, i) => (
        <li key={i} className="whitespace-nowrap">
          {item}
        </li>
      ))}
    </ul>
  );
}
