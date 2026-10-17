import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightLeft } from 'lucide-react';
import { getHandover } from '@/lib/floorApi';
import { cn } from '@/lib/cn';

/**
 * The last shift's written handover, as the banner the next lead sees
 * first: what was left unfinished, what broke, what the coach said —
 * until it is decided on their own shift record.
 */

const KIND_LABEL: Record<string, string> = {
  COACH_COMPLAINT: 'Coach complaint',
  EQUIPMENT: 'Equipment',
  STOCKING: 'Stocking',
  SPECIAL_ORDER: 'Special order',
  UNFINISHED_TASK: 'Unfinished',
  NOTE: 'Note',
};

export function HandoverBanner({ className }: { className?: string }) {
  const q = useQuery({ queryKey: ['floor', 'handover'], queryFn: getHandover, refetchInterval: 5 * 60_000 });
  const items = q.data?.items ?? [];
  if (items.length === 0) return null;
  const high = items.some((i) => i.priority === 'HIGH');
  const from = items[0]!.from;
  const by = from.by ? `${from.by.split(' ')[0]}’s` : 'The last';
  return (
    <Link
      to="/ops?tab=shift"
      data-testid="handover-banner"
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4 transition-colors animate-enter',
        high ? 'border-alert/50 bg-alert/[0.07] hover:bg-alert/10' : 'border-gold/40 bg-gold/[0.06] hover:bg-gold/10',
        className,
      )}
    >
      <ArrowRightLeft className={cn('mt-0.5 h-5 w-5 shrink-0', high ? 'text-alert' : 'text-gold')} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">
          {by} {from.position} shift handed over {items.length} {items.length === 1 ? 'note' : 'notes'}
        </div>
        <ul className="mt-1 space-y-0.5">
          {items.slice(0, 3).map((i) => (
            <li key={i.id} className="truncate text-xs text-silver">
              <span className={cn('font-medium', i.priority === 'HIGH' ? 'text-alert' : 'text-gold')}>{KIND_LABEL[i.kind] ?? i.kind}</span> · {i.body}
            </li>
          ))}
          {items.length > 3 && <li className="text-xs text-silver/70">+{items.length - 3} more</li>}
        </ul>
      </div>
      <span className={cn('shrink-0 text-sm font-medium', high ? 'text-alert' : 'text-gold')}>Open →</span>
    </Link>
  );
}
