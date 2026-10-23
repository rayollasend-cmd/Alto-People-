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
    // Every item carries its dot in front, and the list sits a dot's width
    // to the left inside a clipping box: the dot that would open a line —
    // the first item's, or a wrapped line's on a phone ("· Payday Fri, Oct
    // 30") — falls in the clipped margin, so a line always starts with words.
    <div className={cn('overflow-hidden', className)}>
      <ul
        className={cn(
          '-ml-4 flex flex-wrap items-center gap-y-1 text-xs text-ink-muted',
          '[&>li]:before:inline-block [&>li]:before:w-4 [&>li]:before:text-center [&>li]:before:text-ink-subtle [&>li]:before:content-["·"]',
        )}
        data-testid="home-meta"
      >
        {shown.map((item, i) => (
          <li key={i} className="whitespace-nowrap">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
