import { ROBOT_STATUS_LABELS, type RobotConnectorStatus, type RobotStatusSampleSummary } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

/** Brief 3-1 — the small vocabulary every robot screen shares. */

const STATUS_VARIANT: Record<RobotConnectorStatus, 'success' | 'info' | 'outline' | 'destructive' | 'pending'> = {
  WORKING: 'success',
  CHARGING: 'info',
  IDLE: 'outline',
  ERROR: 'destructive',
  OFFLINE: 'outline',
  STOPPED: 'destructive',
};

export function RobotStatusBadge({ status, size = 'sm' }: { status: RobotConnectorStatus | null | undefined; size?: 'sm' | 'default' }) {
  if (!status) {
    return (
      <Badge variant="outline" size={size}>
        No reading
      </Badge>
    );
  }
  return (
    <Badge variant={STATUS_VARIANT[status]} size={size}>
      {ROBOT_STATUS_LABELS[status]}
    </Badge>
  );
}

/** A battery meter: the number, then the bar; red under 20, amber under 40. */
export function BatteryMeter({ pct, className }: { pct: number | null | undefined; className?: string }) {
  if (pct === null || pct === undefined) return <span className={cn('text-xs text-ink-muted', className)}>—</span>;
  const tone = pct < 20 ? 'bg-alert' : pct < 40 ? 'bg-warning' : 'bg-success';
  return (
    <span className={cn('inline-flex items-center gap-2', className)} aria-label={`Battery ${pct} percent`}>
      <span className="w-10 text-right text-xs tabular-nums text-ink">{pct}%</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-navy-secondary/70" aria-hidden="true">
        <span className={cn('block h-full rounded-full', tone)} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </span>
    </span>
  );
}

export function sampleLine(s: RobotStatusSampleSummary | null | undefined): string {
  if (!s) return 'No reading yet';
  const parts = [ROBOT_STATUS_LABELS[s.status]];
  if (s.currentTask) parts.push(s.currentTask);
  if (s.errorCode) parts.push(`error ${s.errorCode}`);
  return parts.join(' · ');
}
