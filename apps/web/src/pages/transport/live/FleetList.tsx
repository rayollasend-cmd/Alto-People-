import type { FleetVan } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { fmtDateTz, fmtTimeTz, zonedDayKey } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Phone } from '@/components/ui/icons';
import '@/lib/i18n/en/fleetOps';
import { agoText, type FleetT } from './fleetT';
import { FLEET_GROUPS, fleetGroup, minutesSince, statusVariant, telHref, vanStatus, type FleetGroup, type VanExtras, type VanStatus } from './fleetModel';

/**
 * The fleet as a list — the map's accessible mirror and the desk's way to
 * read six vans at once: grouped On the road · Leaving later · Idle · Out of
 * service, each van with its driver, its state in a word with its dot, the
 * next stop and when the van gets there against when it was due, who is on
 * board and who is still to pick up, and the driver one tap away.
 */

export function statusText(t: FleetT, s: VanStatus, tz: string): string {
  switch (s.kind) {
    case 'sos':
      return t('fleetOps.chip.sos');
    case 'not_closed':
      return t('fleetOps.chip.notClosed');
    case 'no_signal':
      return t('fleetOps.chip.noSignal');
    case 'late':
      return t('fleetOps.chip.late', { n: s.minutes });
    case 'on_time':
      return t('fleetOps.chip.onTime');
    case 'leaves':
      return t('fleetOps.chip.leaves', { time: fmtTimeTz(s.at, tz) });
    case 'not_left':
      return t('fleetOps.chip.notLeft');
    case 'out':
      return t('fleetOps.chip.out');
    default:
      return t('fleetOps.chip.idle');
  }
}

/** A time today ("2:14 PM"); a day before, the day ("Sep 19") — never a bare time from last month. */
export function whenText(iso: string, tz: string, now: number): string {
  return zonedDayKey(iso, tz) === zonedDayKey(new Date(now), tz) ? fmtTimeTz(iso, tz) : fmtDateTz(iso, tz);
}

const GROUP_KEY = {
  road: 'fleetOps.group.road',
  later: 'fleetOps.group.later',
  idle: 'fleetOps.group.idle',
  out: 'fleetOps.group.out',
} as const;

/** "3 on board · 2 to pick up" — a zero part is left out, never shown in colour. */
export function riderCounts(t: FleetT, run: NonNullable<FleetVan['run']>): string {
  const parts: string[] = [];
  if (run.onBoard > 0) parts.push(t('fleetOps.onBoard', { n: run.onBoard }));
  if (run.toPickUp > 0) parts.push(t('fleetOps.toPickUp', { n: run.toPickUp }));
  return parts.length ? parts.join(' · ') : t('fleetOps.noRidersLeft');
}

export interface VanDetailsProps {
  v: FleetVan;
  status: VanStatus;
  tz: string;
  now: number;
  t: FleetT;
}

/** The van's card body — the same words in the list row and the map's card. */
export function VanDetails({ v, status, tz, now, t }: VanDetailsProps) {
  const group = fleetGroup(v);
  const run = v.run;
  const driver = run?.driverName ?? v.nextRun?.driverName ?? null;
  const direction = run ? (run.direction === 'TO_WORK' ? t('fleetOps.toWork') : t('fleetOps.fromWork')) : null;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-semibold text-ink">{v.name}</span>
        {v.plate && <span className="shrink-0 text-xs2 text-ink-muted">{v.plate}</span>}
        <Badge size="sm" variant={statusVariant(status)} withDot className="ml-auto shrink-0">
          {statusText(t, status, tz)}
        </Badge>
      </div>
      {(driver || direction) && <p className="mt-0.5 truncate text-xs2 text-ink-muted">{[driver, direction].filter(Boolean).join(' · ')}</p>}
      {group === 'road' && run && status.kind === 'not_closed' && <p className="mt-1.5 text-xs2 text-caution-800">{t('fleetOps.notClosedLine')}</p>}
      {group === 'road' && run && status.kind !== 'not_closed' && (
        <>
          {run.nextStop && (
            <p className="mt-1.5 text-sm text-ink">
              <span className="text-ink-muted">{t('fleetOps.next')}</span> {run.nextStop.label}
              {run.nextStop.etaAt && (
                <span className="tabular-nums text-ink-muted">
                  {' · '}
                  {t('fleetOps.eta', { time: fmtTimeTz(run.nextStop.etaAt, tz) })}
                  {run.nextStop.scheduledAt && fmtTimeTz(run.nextStop.scheduledAt, tz) !== fmtTimeTz(run.nextStop.etaAt, tz) && (
                    <> {t('fleetOps.due', { time: fmtTimeTz(run.nextStop.scheduledAt, tz) })}</>
                  )}
                </span>
              )}
            </p>
          )}
          <p className="mt-0.5 text-xs2 tabular-nums text-ink-muted">{riderCounts(t, run)}</p>
          {v.state === 'no_signal' ? (
            <p className="mt-0.5 text-xs2 text-caution-800">
              {v.positionAgeMinutes !== null ? t('fleetOps.lastSeen', { ago: agoText(t, v.positionAgeMinutes) }) : t('fleetOps.noSignalYet')}
            </p>
          ) : (
            v.position && <p className="mt-0.5 text-xs2 text-ink-muted">{t('fleetOps.updated', { ago: agoText(t, minutesSince(v.position.at, now)) })}</p>
          )}
        </>
      )}
      {group === 'later' && v.nextRun && (
        <p className="mt-1 text-xs2 tabular-nums text-ink-muted">
          {t(status.kind === 'not_left' ? 'fleetOps.dueOutWith' : 'fleetOps.leavesWith', { time: fmtTimeTz(v.nextRun.departAt, tz), count: v.nextRun.riders })}
        </p>
      )}
      {group === 'idle' && (
        <p className="mt-1 text-xs2 text-ink-muted">
          {v.position ? t('fleetOps.parkedSince', { time: whenText(v.position.at, tz, now) }) : t('fleetOps.nothingToday')}
        </p>
      )}
      {group === 'out' && v.nextRun && <p className="mt-1 text-xs2 text-caution-800">{t('fleetOps.outHasRun', { time: fmtTimeTz(v.nextRun.departAt, tz) })}</p>}
    </>
  );
}

export interface FleetListProps {
  vans: Record<FleetGroup, FleetVan[]>;
  extrasFor: (v: FleetVan) => VanExtras;
  tz: string;
  now: number;
  t: FleetT;
  selected: string | null;
  onSelect: (vanId: string) => void;
  /** Set (manage:transport): a run nobody closed gets its Close run. */
  onCloseRun?: (runId: string, vanName: string) => void;
  rowRef?: (vanId: string, el: HTMLElement | null) => void;
}

export function FleetList({ vans, extrasFor, tz, now, t, selected, onSelect, onCloseRun, rowRef }: FleetListProps) {
  return (
    <div className="space-y-4" data-testid="fleet-list">
      {FLEET_GROUPS.map((g) => {
        const list = vans[g];
        if (list.length === 0) return null;
        const id = `fleet-group-${g}`;
        return (
          <section key={g} aria-labelledby={id}>
            <h3 id={id} className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-ink">
              {t(GROUP_KEY[g])}
              <span className="text-sm font-normal tabular-nums text-ink-muted">{list.length}</span>
            </h3>
            <ul className="space-y-2">
              {list.map((v) => {
                const status = vanStatus(v, extrasFor(v));
                const tel = telHref(v.run?.driverPhone);
                const closeable = status.kind === 'not_closed' && v.run && onCloseRun;
                const isSel = selected === v.vanId;
                return (
                  <li
                    key={v.vanId}
                    ref={(el) => rowRef?.(v.vanId, el)}
                    data-van-id={v.vanId}
                    className={cn(
                      'rounded-lg border bg-surface transition-colors',
                      isSel ? 'border-accent bg-surface-raised/60' : 'border-line-subtle hover:border-line',
                      v.state === 'out_of_service' && 'opacity-90',
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={isSel}
                      onClick={() => onSelect(v.vanId)}
                      className="block w-full rounded-lg px-3 pb-2 pt-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <VanDetails v={v} status={status} tz={tz} now={now} t={t} />
                    </button>
                    {(tel || closeable) && (
                      <div className="flex flex-wrap gap-2 px-3 pb-2.5">
                        {tel && v.run && (
                          <Button size="xs" variant="outline" asChild>
                            <a href={tel} aria-label={t('fleetOps.callNamed', { name: v.run.driverName })}>
                              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                              {t('fleetOps.callDriver')}
                            </a>
                          </Button>
                        )}
                        {closeable && (
                          <Button size="xs" variant="secondary" onClick={() => onCloseRun!(v.run!.runId, v.name)}>
                            {t('fleetOps.closeRun')}
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
