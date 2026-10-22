import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { minuteOfDayInZone } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { coverShift } from '@/lib/floorApi';
import { useI18n, type Translate } from '@/lib/i18n';
import type { MyShiftWindow } from '@/lib/shiftWindowsApi';
import { windowOf } from '@/pages/portal/shiftFocus';
import type { WaveRow } from '@/pages/portal/waves';
import { Button } from '@/components/ui/Button';

/**
 * The gap the hero shows, said where decisions live: a shift window today
 * with fewer people scheduled than the store contracted. "Needs you" used
 * to read all clear above a hero that said 0 of 6 — the queue only knew
 * about decisions already filed, not the hole in tonight's crew.
 *
 * One line per short window that hasn't ended: open shifts in it go to the
 * bench in one tap (the same cover the Open-in-the-next-two-days card runs);
 * a window with nothing posted at all opens today's schedule to add them.
 */

export interface CoverageGap {
  window: MyShiftWindow;
  scheduled: number;
  openShiftIds: string[];
}

export function coverageGaps(roster: WaveRow[], windows: MyShiftWindow[], now: Date = new Date()): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const w of windows) {
    if (w.targetCount <= 0) continue;
    const nowMin = minuteOfDayInZone(now, w.timezone);
    // A same-day window that's over is history; an overnight one runs on.
    if (w.endMinute > w.startMinute && nowMin >= w.endMinute) continue;
    const rows = roster.filter((r) => windowOf(r, [w]) !== null);
    const scheduled = rows.filter((r) => r.state !== 'open').length;
    if (scheduled >= w.targetCount) continue;
    gaps.push({ window: w, scheduled, openShiftIds: rows.filter((r) => r.state === 'open').map((r) => r.shiftId) });
  }
  return gaps;
}

function windowName(w: MyShiftWindow, t: Translate): string {
  // Evening windows read as "tonight" — the way the floor says it.
  return w.startMinute >= 17 * 60 ? t('floorUi.tonightsWindow', { label: w.label }) : t('floorUi.todaysWindow', { label: w.label });
}

export function CoverageGapNotice({ gaps, today }: { gaps: CoverageGap[]; today: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [asked, setAsked] = useState<Record<string, boolean>>({});
  if (gaps.length === 0) return null;

  const fill = async (g: CoverageGap) => {
    const key = `${g.window.locationId}:${g.window.label}`;
    setBusy(key);
    try {
      const results = await Promise.allSettled(g.openShiftIds.map((id) => coverShift(id)));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length === results.length) {
        const first = failed[0] as PromiseRejectedResult | undefined;
        throw first?.reason ?? new Error('failed');
      }
      setAsked((a) => ({ ...a, [key]: true }));
      toast.success(
        g.openShiftIds.length === 1
          ? t('floorUi.benchAskedPosted')
          : t('floorUi.benchAskedForN', { n: g.openShiftIds.length - failed.length }),
      );
      void qc.invalidateQueries({ queryKey: ['floor'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('floorUi.askBenchFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ul className="mb-3 space-y-2" aria-label={t('floorUi.shortStaffedToday')}>
      {gaps.map((g) => {
        const key = `${g.window.locationId}:${g.window.label}`;
        const short = g.window.targetCount - g.scheduled;
        return (
          <li
            key={key}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/[0.07] px-4 py-3"
          >
            <UsersRound className="h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">
                {t('floorUi.windowScheduledOf', { window: windowName(g.window, t), scheduled: g.scheduled, target: g.window.targetCount })}
              </p>
              <p className="text-xs text-ink-muted">
                {t('floorUi.nShort', { n: short })}
                {g.openShiftIds.length > 0
                  ? ` · ${t(g.openShiftIds.length === 1 ? 'floorUi.openShiftPostedOne' : 'floorUi.openShiftsPostedMany', { n: g.openShiftIds.length })}`
                  : ` · ${t('floorUi.nothingPostedRest')}`}
                {` · ${g.window.locationName}`}
              </p>
            </div>
            {g.openShiftIds.length > 0 ? (
              <Button size="sm" onClick={() => void fill(g)} loading={busy === key} disabled={asked[key]}>
                {asked[key] ? t('floorUi.benchAsked') : t('floorUi.fillFromBench')}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" asChild>
                <Link to={`/scheduling?view=day&date=${today}`}>
                  {t('floorUi.addShifts')} <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
