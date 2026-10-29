import { useContext } from 'react';
import { AlertTriangle, Bus, Check, ChevronRight, Home, Route, Store } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n';
import { fmtRelativeDayTz, fmtTimeTz } from '@/lib/format';
import type { RideRun } from '@/lib/transportApi';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { ShiftMapContext } from './driveKit';
import { conflictsOf, riding, runTz, shortName, stopsFor, storeNames, tripOfRun, type DayPlan } from './driveModel';
import '@/lib/i18n/en/drive';
import '@/lib/i18n/en/ride';

/**
 * Below NOW: the rest of the driver's day, compact — one row a run (time ·
 * van · way · riders · stops; tap for its stops), today's finished runs as
 * a line each, and the runs that never ran as one small line of history.
 */

const direction = (run: RideRun, t: ReturnType<typeof useI18n>['t']) => (run.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork'));

export function LaterToday({ plan, runs, onOpen }: { plan: DayPlan; runs: RideRun[]; onOpen: (run: RideRun) => void }) {
  const { t } = useI18n();
  if (plan.later.length === 0 && plan.finished.length === 0 && plan.notRun.length === 0) return null;
  return (
    <section aria-labelledby="drive-later" className="space-y-3" data-testid="later-today">
      {plan.later.length > 0 && (
        <>
          <SectionTitle id="drive-later" title={t('drive.laterToday')} />
          <ul className="divide-y divide-line-subtle overflow-hidden rounded-lg border border-line bg-surface">
            {plan.later.map((run) => (
              <LaterRow key={run.id} run={run} runs={runs} onOpen={() => onOpen(run)} />
            ))}
          </ul>
        </>
      )}
      {plan.later.length === 0 && <SectionTitle id="drive-later" title={t('drive.restOfToday')} />}
      {plan.finished.length > 0 && (
        <ul className="space-y-1" aria-label={t('drive.finishedToday')}>
          {plan.finished.map((run) => {
            const rides = run.rides.filter(riding);
            const rode = rides.filter((r) => r.status === 'BOARDED' || r.status === 'COMPLETED').length;
            return (
              <li key={run.id} className="flex min-h-11 items-center gap-2 text-base text-ink-muted">
                <Check className="h-4 w-4 shrink-0 text-positive-700" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="tabular-nums text-ink">{fmtTimeTz(run.departAt, runTz(run))}</span> · {run.van.name} · {direction(run, t)}
                </span>
                <span className="shrink-0 tabular-nums">{t('drive.finishedRiders', { rode, total: rides.length })}</span>
              </li>
            );
          })}
        </ul>
      )}
      {plan.notRun.length > 0 && (
        <p className="text-base text-ink-muted" data-testid="didnt-run">
          <span className="font-medium text-ink">{t('drive.didntRun')}</span>{' '}
          {plan.notRun.map((run) => `${fmtRelativeDayTz(run.departAt, runTz(run))} ${fmtTimeTz(run.departAt, runTz(run))} · ${run.van.name}`).join(', ')}
          {' — '}
          {t('drive.didntRunNote')}
        </p>
      )}
    </section>
  );
}

function LaterRow({ run, runs, onOpen }: { run: RideRun; runs: RideRun[]; onOpen: () => void }) {
  const { t } = useI18n();
  const tz = runTz(run);
  const riders = run.rides.filter(riding).length;
  const stops = stopsFor(run).pickups.length;
  const clash = conflictsOf(run, runs).length > 0;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright"
      >
        <span className="min-w-[5.75rem] shrink-0 whitespace-nowrap text-lg font-semibold tabular-nums text-ink">{fmtTimeTz(run.departAt, tz)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-lg text-ink">
            {run.van.name} · {direction(run, t)}
          </span>
          <span className="block truncate text-base text-ink-muted">
            {[riders === 1 ? t('drive.ridersOne') : t('drive.ridersCount', { count: riders }), stops === 1 ? t('drive.stopsOne') : t('drive.stopsCount', { count: stops })].join(' · ')}
            {run.status === 'ACTIVE' ? ` · ${t('drive.status.ACTIVE')}` : ''}
          </span>
        </span>
        {clash && (
          <span className="inline-flex shrink-0 items-center text-caution-800">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">{t('drive.overlaps')}</span>
          </span>
        )}
        <ChevronRight className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
      </button>
    </li>
  );
}

/** A later run, opened: when, where, who — before it's NOW. */
export function RunSheet({ run, runs, dispatchPhone, onClose }: { run: RideRun; runs: RideRun[]; dispatchPhone: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const openShiftMap = useContext(ShiftMapContext);
  const tz = runTz(run);
  const { pickups, drops } = stopsFor(run);
  const trip = tripOfRun(run);
  const conflicts = conflictsOf(run, runs);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="tabular-nums">
            {fmtRelativeDayTz(run.departAt, tz)} · {t('drive.departs', { time: fmtTimeTz(run.departAt, tz) })}
          </DialogTitle>
          <DialogDescription className="text-base">
            {run.van.name} · {direction(run, t)} · {storeNames(run, runs).join(', ')}
          </DialogDescription>
        </DialogHeader>
        {conflicts.map((c, i) => (
          <ErrorBanner key={i} severity="warning" className="text-base">
            {c.kind === 'driver'
              ? c.other
                ? t('drive.overlapRun', { time: fmtTimeTz(c.other.departAt, runTz(c.other)), van: c.other.van.name })
                : t('drive.overlapOther', { minutes: c.overlapMinutes })
              : t('drive.overlapVan', { van: run.van.name })}
            {dispatchPhone && (
              <>
                {' '}
                <a className="font-semibold underline" href={`tel:${dispatchPhone}`}>
                  {dispatchPhone}
                </a>
              </>
            )}
          </ErrorBanner>
        ))}
        <ol className="divide-y divide-line-subtle" aria-label={t('drive.route')}>
          {pickups.map((s, i) => (
            <li key={s.key} className="flex items-center gap-3 py-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-raised text-base font-semibold tabular-nums text-ink">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg text-ink">{s.label}</span>
                <span className="block truncate text-base text-ink-muted">{s.rides.map((r) => shortName(r.rider.name)).join(', ')}</span>
              </span>
              <span className="shrink-0 text-base tabular-nums text-ink-muted">{s.at ? fmtTimeTz(s.at, tz) : ''}</span>
            </li>
          ))}
          {drops.map((d) => (
            <li key={d.key} className="flex items-center gap-3 py-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-raised text-ink">
                {d.kind === 'store' ? <Store className="h-4 w-4" aria-hidden="true" /> : <Home className="h-4 w-4" aria-hidden="true" />}
              </span>
              <span className="min-w-0 flex-1 truncate text-lg text-ink">{t('drive.dropOffAt', { place: d.label })}</span>
            </li>
          ))}
        </ol>
        {trip && (
          <Button
            variant="secondary"
            className="h-12 w-full text-base"
            onClick={() => {
              onClose();
              openShiftMap(trip);
            }}
          >
            <Route className="h-4 w-4" />
            {t('drive.shiftStopsBtn')}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** No run left today: the day's done (or there was none), and when the next one is. */
export function DayDone({ plan }: { plan: DayPlan }) {
  const { t } = useI18n();
  const next = plan.nextDay;
  const nextLine = next ? t('drive.nextRunLine', { day: fmtRelativeDayTz(next.departAt, runTz(next)), time: fmtTimeTz(next.departAt, runTz(next)), van: next.van.name }) : undefined;
  if (plan.counts.total > 0) {
    return (
      <div className="rounded-lg border border-line bg-surface p-5" data-testid="drive-done">
        <p className="flex items-center gap-3 text-3xl font-bold tracking-tight text-ink">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-positive-100 text-positive-800">
            <Check className="h-6 w-6" aria-hidden="true" />
          </span>
          {t('drive.allDone')}
        </p>
        <p className="mt-2 text-lg tabular-nums text-ink">
          {t('drive.allDoneLine', { runs: plan.counts.done, riders: plan.finished.reduce((n, r) => n + r.rides.filter((x) => x.status === 'BOARDED' || x.status === 'COMPLETED').length, 0) })}
        </p>
        {nextLine && <p className="mt-1 text-base text-ink-muted">{nextLine}</p>}
      </div>
    );
  }
  return <EmptyState icon={Bus} title={t('drive.none')} description={nextLine ?? t('drive.noneBody')} />;
}
