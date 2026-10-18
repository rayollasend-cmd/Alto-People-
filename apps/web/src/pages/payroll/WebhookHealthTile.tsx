import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CircleDashed, Info, ServerCrash, ShieldAlert } from 'lucide-react';
import {
  getDisbursementWebhookStatus,
  type DisbursementWebhookStatus,
  type WebhookHealth,
} from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

const POLL_INTERVAL_MS = 60_000;

/**
 * One line per health state: the badge, the icon and the ring. The words
 * are product copy — a payroll person reads "Simulated", never a mode name
 * or an environment variable.
 */
const STYLE: Record<
  WebhookHealth,
  {
    label: string;
    badge: 'success' | 'outline' | 'pending' | 'destructive' | 'default';
    iconBox: string;
    ring: string;
    Icon: typeof CheckCircle2;
  }
> = {
  healthy: { label: 'Healthy', badge: 'success', iconBox: 'bg-success/15 text-success', ring: 'ring-success/30', Icon: CheckCircle2 },
  idle: { label: 'Idle', badge: 'outline', iconBox: 'bg-navy-secondary/40 text-silver', ring: 'ring-navy-secondary', Icon: CircleDashed },
  stale: { label: 'Stale', badge: 'pending', iconBox: 'bg-warning/15 text-warning', ring: 'ring-warning/30', Icon: AlertTriangle },
  erroring: { label: 'Erroring', badge: 'destructive', iconBox: 'bg-alert/15 text-alert', ring: 'ring-alert/30', Icon: ServerCrash },
  unconfigured: { label: 'Not applicable', badge: 'outline', iconBox: 'bg-navy-secondary/40 text-silver', ring: 'ring-navy-secondary', Icon: ShieldAlert },
  stub: { label: 'Simulated', badge: 'default', iconBox: 'bg-info/15 text-info', ring: 'ring-info/30', Icon: Info },
};

/**
 * The disbursement rail's health.
 *
 * On the Payroll page (`surface="payroll"`) it speaks only when the payroll
 * person has something to do: a stale or erroring webhook is the tile, a
 * simulated provider is one calm line pointing at Integrations, and a
 * healthy, idle or not-applicable rail says nothing at all — that state
 * lives on Settings & Trust › Integrations (`surface="integrations"`),
 * where the whole tile always renders.
 */
export function WebhookHealthTile({ surface }: { surface: 'payroll' | 'integrations' }) {
  const statusQuery = useQuery({
    queryKey: ['WebhookHealthTile', 'status'],
    queryFn: () => getDisbursementWebhookStatus(),
    // Skip polls in a backgrounded tab; catch up as soon as it returns.
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const data: DisbursementWebhookStatus | null = statusQuery.data ?? null;
  // 403 = this person doesn't hold payroll; the rail is not theirs to watch.
  if (statusQuery.error instanceof ApiError && statusQuery.error.status === 403) return null;
  const error = statusQuery.error
    ? statusQuery.error instanceof ApiError
      ? statusQuery.error.message
      : "Couldn't load the disbursement status."
    : null;

  if (error) {
    // The tile re-polls itself every minute, so no explicit Retry needed.
    return <ErrorBanner severity="warning">{error}</ErrorBanner>;
  }
  if (!data) {
    if (surface === 'payroll') return null;
    return (
      <div className="rounded-lg border border-navy-secondary bg-navy elev-1 p-3 flex items-start gap-3">
        <Skeleton className="h-8 w-8 rounded-full shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-3 w-72" />
        </div>
      </div>
    );
  }

  if (surface === 'payroll') {
    if (data.health === 'healthy' || data.health === 'idle' || data.health === 'unconfigured') return null;
    if (data.health === 'stub') {
      return (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-info/30 bg-info/[0.06] px-3 py-2 text-sm text-silver"
        >
          <Info className="h-4 w-4 shrink-0 text-info" aria-hidden="true" />
          <span className="text-ink">Payments are simulated.</span>
          <span>Runs marked disbursed move no money until a disbursement provider is connected.</span>
          <Link to="/integrations" className="font-medium text-gold hover:underline">
            Connect a provider
          </Link>
        </p>
      );
    }
  }

  // An unknown or missing health reads as idle rather than crashing the payroll page.
  const style = STYLE[data.health] ?? STYLE.idle;
  const Icon = style.Icon;
  return (
    <div
      className={cn('rounded-lg border border-navy-secondary bg-navy p-3 ring-1 elev-1 flex items-start gap-3', style.ring)}
      role="status"
      aria-label={`Payroll disbursement is ${style.label.toLowerCase()}`}
    >
      <span className={cn('rounded-full p-2', style.iconBox)}>
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 break-words text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-ink">Payroll disbursement</span>
          <Badge variant={style.badge} size="sm">
            {style.label}
          </Badge>
          {data.health !== 'stub' && <span className="text-xs text-silver">· {data.provider}</span>}
        </div>
        <p className="mt-0.5 text-silver">{data.detail}</p>
        {data.health === 'erroring' && data.latestError?.notes && (
          <p className="mt-1 text-xs text-alert break-words">
            Latest error ({fmtDateTime(data.latestError.at)}):{' '}
            {data.latestError.notes}
          </p>
        )}
        {data.health !== 'stub' && data.health !== 'unconfigured' && (
          <p className="mt-1 text-xs text-silver">
            {data.eventsLast24h} event(s) in the last 24h ·{' '}
            {data.errorsLast7d} error(s) in the last 7 days ·{' '}
            {data.pendingFinalizedItems} item(s) awaiting disbursement
          </p>
        )}
      </div>
    </div>
  );
}
