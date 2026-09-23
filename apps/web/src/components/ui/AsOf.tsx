import { RefreshCw } from 'lucide-react';
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
}: {
  /** `dataUpdatedAt` from the query — 0 or undefined before the first answer. */
  at: number | Date | null | undefined;
  onRefresh?: () => void;
  refreshing?: boolean;
  className?: string;
}) {
  const stamp = at ? fmtTime(typeof at === 'number' ? new Date(at) : at) : null;
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-2xs text-silver/60', className)}
      aria-live="polite"
    >
      <span className="tabular-nums">
        {refreshing ? 'refreshing…' : stamp ? `as of ${stamp}` : 'loading…'}
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
