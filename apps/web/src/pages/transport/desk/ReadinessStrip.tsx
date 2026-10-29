import type { TransportReadiness, TransportReadinessItem } from '@alto-people/shared';
import { Check, Wand2 } from '@/components/ui/icons';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { fmtDateOnly } from '@/lib/format';
import { useTransportReadiness } from '@/lib/transportOpsApi';

/**
 * Is the next day ready to run? The six checks the desk would otherwise walk
 * by hand — every rider placed, no van over its seats, no driver double-booked
 * or out of hours, every driver's papers current, every van fit to drive, no
 * van on two runs — as one strip: a headline ("Tomorrow: 31 riders on 4 runs"),
 * a chip per check, and for each one that fails, what's wrong and where to fix
 * it. Riders still without a van make "Plan tomorrow" the page's one primary
 * button; a ready day is one calm line.
 */

export type ReadinessAction = NonNullable<TransportReadinessItem['action']>;

interface Props {
  /** The day to check (YYYY-MM-DD). */
  date: string;
  /** "Tomorrow" when it is; the day's name otherwise. */
  dayLabel: string;
  manage: boolean;
  /** Runs an item's fix: plan the day, open the riders without a van, Setup, the board. */
  onAction: (action: ReadinessAction, date: string) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A chip's word or two; the server's sentence ("Every rider has a van") is its tooltip and the line below. */
const CHIP: Record<string, string> = {
  riders_placed: 'Riders placed',
  seats: 'Seats',
  drivers_assigned_ok: 'Drivers',
  credentials: 'Drivers’ papers',
  vans_ready: 'Vans fit to drive',
  vans_double_booked: 'Van bookings',
};

export function useReadiness(date: string | null) {
  return useTransportReadiness(date, { enabled: !!date });
}

/** Riders still without a van that day — the strip's primary action. */
export function needsPlan(r: TransportReadiness | undefined): boolean {
  return !!r && r.items.some((i) => i.id === 'riders_placed' && !i.ok);
}

export function ReadinessStrip({ date, dayLabel, manage, onAction }: Props) {
  const q = useReadiness(date);
  const label = dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1);
  if (q.isLoading) return <Skeleton className="h-16" />;
  if (q.isError || !q.data) {
    return (
      <section aria-label={`${label}’s readiness`} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink-muted">
        Couldn’t check whether {dayLabel} is ready.
        <Button size="xs" variant="ghost" onClick={() => void q.refetch()}>
          Try again
        </Button>
      </section>
    );
  }
  const r = q.data;
  const failing = r.items.filter((i) => !i.ok);
  const plan = manage && needsPlan(r);
  const headline = r.riders === 0 ? 'nothing booked yet' : `${plural(r.riders, 'rider')} on ${plural(r.runs, 'run')}`;
  const when = fmtDateOnly(r.date, { weekday: true, year: 'auto' });

  // A ready day (or one with nothing booked) is one quiet line.
  if (r.ready || r.riders === 0) {
    return (
      <section aria-label={`${label}’s readiness`} data-testid="readiness-strip" data-ready="true" className="flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
        {r.riders > 0 && <Check className="h-4 w-4 shrink-0 text-positive-700" aria-hidden="true" />}
        <span className="min-w-0 text-ink">
          <span className="font-medium">{label}</span>
          <span className="text-ink-muted"> · {when}</span>
          {r.riders === 0 ? (
            <span className="text-ink-muted"> — nothing booked yet.</span>
          ) : (
            <>
              {' '}
              — ready: {headline}, every check passed.
            </>
          )}
        </span>
      </section>
    );
  }

  return (
    <section aria-label={`${label}’s readiness`} data-testid="readiness-strip" data-ready="false" className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-base font-medium text-ink">
            {label}: <span className="tabular-nums">{headline}</span>
          </h3>
          <p className="text-xs2 text-ink-muted">
            {when} · {failing.length === 1 ? 'one thing to fix' : `${failing.length} things to fix`} before the vans leave
          </p>
        </div>
        {plan && (
          <Button size="sm" onClick={() => onAction({ label: 'Plan', kind: 'plan' }, r.date)}>
            <Wand2 className="h-3.5 w-3.5" />
            Plan {dayLabel === 'tomorrow' ? 'tomorrow' : 'the day'}
          </Button>
        )}
      </div>
      <ul aria-label="The checks" className="mt-3 flex flex-wrap gap-1.5">
        {r.items.map((i) => (
          <li key={i.id}>
            <Badge size="default" variant={i.ok ? 'default' : 'pending'} withDot={false} title={i.ok ? i.label : i.detail} className={cn(i.ok && 'text-ink-muted')}>
              {i.ok ? <Check className="h-3 w-3 text-positive-700" aria-hidden="true" /> : null}
              {CHIP[i.id] ?? i.label}
              {!i.ok && i.count > 0 && <span className="tabular-nums">· {i.count}</span>}
              <span className="sr-only">{i.ok ? ' — ok' : ' — needs fixing'}</span>
            </Badge>
          </li>
        ))}
      </ul>
      <ul className="mt-2 divide-y divide-line">
        {failing.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-caution-700" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-sm text-ink">{i.detail}</span>
            {/* "Plan" is the primary above; the others are a quiet way in. */}
            {i.action && i.action.kind !== 'plan' && (
              <Button size="xs" variant="outline" onClick={() => onAction(i.action!, r.date)}>
                {i.action.label}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
