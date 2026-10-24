import { useEffect, useState } from 'react';
import { RefreshCw } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { fmtTime } from '@/lib/format';
import { Button } from './Button';

/**
 * "as of 10:32" — the one line every live surface owes its reader.
 *
 * Nine pages said when their numbers were true; the rest let a
 * screenshot taken at nine be read at eleven as though nothing had
 * moved. React Query already knows the answer (`dataUpdatedAt`), so this
 * takes that and a refetch and prints them, in the display timezone,
 * with an honest "refreshing…" while a new answer is on its way.
 *
 * Put it in the header of the surface, beside the title, not in a footer
 * nobody reads.
 */
export function AsOf({
  at,
  onRefresh,
  refreshing = false,
  className,
  relative = false,
}: {
  /** `dataUpdatedAt` from the query — 0 or undefined before the first answer. */
  at: number | Date | null | undefined;
  onRefresh?: () => void;
  refreshing?: boolean;
  className?: string;
  /** "updated 3 min ago" instead of a clock time — for a board whose other
   *  times are on a store's clock, so the reader's own clock can't
   *  disagree with them (F500 G2). The clock time stays in the tooltip. */
  relative?: boolean;
}) {
  const when = at ? (typeof at === 'number' ? new Date(at) : at) : null;
  const clockStamp = when ? fmtTime(when) : null;
  const [, tick] = useState(0);
  const atMs = when ? when.getTime() : 0;
  useEffect(() => {
    if (!relative || !atMs) return;
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [relative, atMs]);
  const stamp = relative && when ? agoWords(when) : clockStamp;
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-2xs text-silver/60', className)}
      aria-live="polite"
    >
      <span className="tabular-nums" title={relative && clockStamp ? `as of ${clockStamp}` : undefined}>
        {refreshing ? 'refreshing…' : stamp ? (relative ? stamp : `as of ${stamp}`) : 'loading…'}
      </span>
      {onRefresh && (
        <Button
          variant="ghost"
          size="xs"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh now"
          className="h-6 w-6 p-0"
        >
          <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} aria-hidden="true" />
        </Button>
      )}
    </span>
  );
}

/** "updated just now" / "updated 4 min ago" / "updated 2 h ago". */
function agoWords(at: Date): string {
  const mins = Math.max(0, Math.floor((Date.now() - at.getTime()) / 60_000));
  if (mins < 1) return 'updated just now';
  if (mins < 60) return `updated ${mins} min ago`;
  return `updated ${Math.floor(mins / 60)} h ago`;
}
