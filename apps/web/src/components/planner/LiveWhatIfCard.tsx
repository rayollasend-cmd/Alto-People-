import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarCheck2, FlaskConical } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLaborCostVisible } from '@/lib/useLaborCostVisible';
import { fmtDayShort, fmtMoney } from '@/lib/format';
import { applySeasonPlanLive, discardSeasonPlanLive, getSeasonPlanLive, type LiveWhatIfRow } from '@/lib/seasonPlansApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DetailsTable } from '@/pages/portal/portalCharts';
import { Skeleton } from '@/components/ui/Skeleton';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';

/**
 * What-if on the live schedule: this plan's demand for one week against
 * the shifts actually on the calendar, store by store. "Apply" writes the
 * shortfall as draft open shifts the scheduler publishes or deletes;
 * "Discard" takes exactly those back. Nothing published is ever touched.
 */

const PART_LABEL: Record<LiveWhatIfRow['part'], string> = { day: 'Day', evening: 'Evening', overnight: 'Overnight' };

function weekOptions(weeks: string[], current: string): string[] {
  const set = new Set([current, ...weeks]);
  return [...set].sort();
}

/** "Oct 17" for an org-week start — the app's own short day format. */
const fmtWeek = (ymd: string) => fmtDayShort(ymd);

export function LiveWhatIfCard({ planId, weeks }: { planId: string; weeks: string[] }) {
  const { can } = useAuth();
  const showCost = useLaborCostVisible();
  const qc = useQueryClient();
  const [week, setWeek] = useState<string | undefined>(undefined);
  const q = useQuery({ queryKey: ['season-plans', 'live', planId, week ?? 'current'], queryFn: () => getSeasonPlanLive(planId, week) });
  const canApply = can('manage:scheduling');
  const data = q.data;

  const apply = useMutation({
    mutationFn: () => applySeasonPlanLive(planId, data?.week),
    onSuccess: async (r) => {
      toast.success(r.created > 0 ? `${r.created} draft shift${r.created === 1 ? '' : 's'} added to the week of ${fmtWeek(r.week)}. Publish them from the schedule.` : 'Nothing to add — the week already meets the plan.');
      await qc.invalidateQueries({ queryKey: ['season-plans', 'live', planId] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not apply the plan.'),
  });
  const discard = useMutation({
    mutationFn: () => discardSeasonPlanLive(planId, data?.week),
    onSuccess: async (r) => {
      toast.success(r.removed > 0 ? `${r.removed} draft shift${r.removed === 1 ? '' : 's'} taken back.` : 'No drafts from this plan to take back.');
      await qc.invalidateQueries({ queryKey: ['season-plans', 'live', planId] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not discard.'),
  });

  const bySite = new Map<string, { name: string; client: string; gap: number; over: number; planned: number; scheduled: number; drafted: number }>();
  for (const r of data?.rows ?? []) {
    const b = bySite.get(r.locationId) ?? { name: r.siteName, client: r.clientName, gap: 0, over: 0, planned: 0, scheduled: 0, drafted: 0 };
    b.gap += r.gap;
    b.over += r.over;
    b.planned += r.planned;
    b.scheduled += r.scheduled;
    b.drafted += r.drafted;
    bySite.set(r.locationId, b);
  }

  return (
    <Card data-testid="live-what-if">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-gold" aria-hidden="true" />
          Try it on the live week
        </CardTitle>
        <CardDescription>
          The plan’s floor headcount against the shifts on the calendar, store by store and shift by shift. Apply writes the shortfall as draft open shifts; nothing published changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-silver" htmlFor="live-week">
            Week of
          </label>
          <Select id="live-week" size="sm" value={data?.week ?? week ?? ''} onChange={(e) => setWeek(e.target.value)} className="w-auto">
            {weekOptions(weeks, data?.week ?? week ?? weeks[0] ?? '').map((w) => (
              <option key={w} value={w}>
                {fmtWeek(w)}
              </option>
            ))}
          </Select>
          {data && (
            <span className="text-sm tabular-nums text-silver">
              Planned <span className="text-ink">{data.totals.planned}</span> · scheduled <span className="text-ink">{data.totals.scheduled}</span> ·{' '}
              <span className={cn(data.totals.gap > 0 ? 'text-warning' : 'text-success')}>{data.totals.gap} short</span>
              {data.totals.over > 0 && <span className="text-silver/70"> · {data.totals.over} over</span>}
              {data.totals.drafted > 0 && <span className="text-gold"> · {data.totals.drafted} drafted</span>}
            </span>
          )}
        </div>
        {!data ? (
          <Skeleton className="h-32" />
        ) : data.rows.length === 0 ? (
          <p className="text-sm text-silver">The plan has no demand for this week.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Shifts short" value={String(data.totals.gap)} tone={data.totals.gap > 0 ? 'warn' : 'good'} />
              <Stat label="Hours short" value={String(data.totals.gapHours)} tone={data.totals.gap > 0 ? 'warn' : 'good'} />
              {showCost && (
                <Stat
                  label="Cost of the gap"
                  value={data.totals.gapCost === null ? '—' : fmtMoney(data.totals.gapCost)}
                  hint={data.totals.unpriced > 0 ? `${data.totals.unpriced} unpriced` : 'at the rate card'}
                  tone={data.totals.gap > 0 ? 'warn' : 'good'}
                />
              )}
              <Stat label="Over the plan" value={String(data.totals.over)} tone={data.totals.over > 0 ? 'neutral' : 'good'} />
            </div>
            <ul className="divide-y divide-navy-secondary/60">
              {[...bySite.entries()].map(([id, s]) => (
                <li key={id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {s.name} <span className="text-silver/70">· {s.client}</span>
                  </span>
                  <span className="tabular-nums text-silver">
                    {s.scheduled}/{s.planned}
                  </span>
                  <span className={cn('w-16 text-right tabular-nums', s.gap > 0 ? 'text-warning' : 'text-success')}>{s.gap > 0 ? `${s.gap} short` : 'met'}</span>
                </li>
              ))}
            </ul>
            <DetailsTable
              label="Shift by shift"
              columns={['Store', 'Date', 'Shift', 'Planned', 'Scheduled', 'Drafted', 'Short', 'Over']}
              rows={data.rows.map((r) => [r.siteName, r.date, PART_LABEL[r.part], r.planned, r.scheduled, r.drafted, r.gap, r.over])}
            />
            {canApply && (
              <div className="flex flex-wrap items-center gap-2">
                <Button loading={apply.isPending} disabled={apply.isPending || discard.isPending || data.totals.gap === 0} onClick={() => apply.mutate()}>
                  <CalendarCheck2 className="mr-2 h-4 w-4" aria-hidden="true" />
                  Apply as draft shifts
                </Button>
                <Button variant="outline" loading={discard.isPending} disabled={apply.isPending || discard.isPending || data.totals.drafted === 0} onClick={() => discard.mutate()}>
                  Discard the drafts
                </Button>
                <Link to="/scheduling" className="text-sm text-gold underline-offset-2 hover:underline">
                  Open the schedule →
                </Link>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone: 'good' | 'warn' | 'neutral' }) {
  return (
    <div className="rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 py-2">
      <div className="text-2xs uppercase tracking-wider text-silver/70">{label}</div>
      <div className={cn('text-xl font-semibold tabular-nums', tone === 'warn' ? 'text-warning' : tone === 'good' ? 'text-success' : 'text-ink')}>{value}</div>
      {hint && <div className="text-2xs text-silver/60">{hint}</div>}
    </div>
  );
}
