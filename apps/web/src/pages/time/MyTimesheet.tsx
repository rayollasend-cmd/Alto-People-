import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import type { TimeEntry } from '@alto-people/shared';
import { listMyTimeEntries } from '@/lib/timeApi';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDateTz, fmtTime, fmtWeekdayTz } from '@/lib/format';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * Read-only punch history for hourly associates — the answer to "how
 * many hours did I get approved for?" without asking a manager. Shows
 * each entry's date, kiosk in/out times, break time, net hours, and
 * review status, plus approved/pending totals for the range.
 *
 * Read-only on purpose: associates PUNCH at the kiosk and DISPUTE with
 * their manager; this page is the receipt, not a control surface.
 */

const STATUS_KEY: Record<TimeEntry['status'], MessageKey> = {
  ACTIVE: 'time.status.ACTIVE',
  COMPLETED: 'time.status.COMPLETED',
  APPROVED: 'time.status.APPROVED',
  REJECTED: 'time.status.REJECTED',
};

const STATUS_VARIANT: Record<
  TimeEntry['status'],
  'success' | 'pending' | 'destructive' | 'accent'
> = {
  ACTIVE: 'accent',
  COMPLETED: 'pending',
  APPROVED: 'success',
  REJECTED: 'destructive',
};

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultFromYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() - 13); // last 14 days inclusive
  return ymdLocal(d);
}

function fmtH(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}

/** "Wed, Jul 2" — house weekday+date formatting (browser-local). */
function fmtEntryDay(iso: string): string {
  return `${fmtWeekdayTz(iso)}, ${fmtDateTz(iso)}`;
}

export function MyTimesheet() {
  const { t } = useI18n();
  const [fromYmd, setFromYmd] = useState(defaultFromYmd());
  const [toYmd, setToYmd] = useState(ymdLocal(new Date()));

  const query = useQuery({
    queryKey: ['me', 'timeEntries', fromYmd, toYmd],
    queryFn: async () => {
      try {
        return await listMyTimeEntries({
          from: new Date(`${fromYmd}T00:00:00`).toISOString(),
          to: new Date(
            new Date(`${toYmd}T00:00:00`).getTime() + 24 * 3_600_000,
          ).toISOString(),
        });
      } catch (err) {
        // Not linked to an associate record yet → honest empty state.
        if (err instanceof ApiError && err.status === 403) return { entries: [] };
        throw err;
      }
    },
  });

  const entries = query.data?.entries ?? null;
  const approvedMin = (entries ?? [])
    .filter((e) => e.status === 'APPROVED')
    .reduce((s, e) => s + (e.netMinutes ?? e.minutesElapsed), 0);
  const pendingMin = (entries ?? [])
    .filter((e) => e.status === 'COMPLETED' || e.status === 'ACTIVE')
    .reduce((s, e) => s + (e.netMinutes ?? e.minutesElapsed), 0);

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{t('time.myTimesheet')}</CardTitle>
        <CardDescription>{t('time.myTimesheetDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-silver">
              {t('common.from')}
            </span>
            <Input
              type="date"
              value={fromYmd}
              max={toYmd}
              onChange={(e) => setFromYmd(e.target.value)}
              className="mt-1 w-40"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-silver">
              {t('common.to')}
            </span>
            <Input
              type="date"
              value={toYmd}
              min={fromYmd}
              onChange={(e) => setToYmd(e.target.value)}
              className="mt-1 w-40"
            />
          </label>
          {entries && entries.length > 0 && (
            <div className="ml-auto flex items-center gap-2 text-xs tabular-nums">
              <span className="rounded-full border border-success/40 bg-success/10 px-2.5 py-1 text-success">
                {t('time.approvedTotal', { hours: fmtH(approvedMin) })}
              </span>
              {pendingMin > 0 && (
                <span className="rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 text-gold">
                  {t('time.pendingTotal', { hours: fmtH(pendingMin) })}
                </span>
              )}
            </div>
          )}
        </div>

        {query.isError && (
          <p role="alert" className="text-sm text-alert">
            {query.error instanceof ApiError
              ? query.error.message
              : t('time.loadFailed')}
          </p>
        )}
        {!entries && !query.isError && <SkeletonRows count={4} rowHeight="h-14" />}
        {entries && entries.length === 0 && (
          <EmptyState
            icon={History}
            title={t('time.noEntries')}
            description={t('time.noEntriesDesc')}
          />
        )}
        {entries && entries.length > 0 && (
          <ul className="divide-y divide-navy-secondary">
            {entries.map((e) => {
              const breakMin = (e.breaks ?? []).reduce((s, b) => s + b.minutes, 0);
              return (
                <li key={e.id} className="py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-white font-medium">
                      {fmtEntryDay(e.clockInAt)}
                    </div>
                    <div className="text-xs text-silver mt-0.5 tabular-nums">
                      {fmtTime(e.clockInAt)}
                      {' – '}
                      {e.clockOutAt ? fmtTime(e.clockOutAt) : t('time.stillOn')}
                      {breakMin > 0 &&
                        ` · ${t('time.breakMinutes', { minutes: breakMin })}`}
                    </div>
                    {e.rejectionReason && (
                      <div className="text-xs text-alert mt-1">
                        {e.rejectionReason}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-sm text-white tabular-nums">
                      {fmtH(e.netMinutes ?? e.minutesElapsed)}
                    </span>
                    <Badge variant={STATUS_VARIANT[e.status]}>
                      {t(STATUS_KEY[e.status])}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
