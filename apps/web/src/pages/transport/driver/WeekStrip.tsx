import { useContext, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, Route } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { fmtDayHeaderTz, fmtTimeTz, fmtWeekdayTz, parseYmd, zonedDayKey } from '@/lib/format';
import { getDriverShifts, getDriverWeek } from '@/lib/transportApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import type { TripKey } from '../ShiftMap';
import { ShiftMapContext } from './driveKit';
import { shortName } from './driveModel';
import '@/lib/i18n/en/drive';
import '@/lib/i18n/en/ride';

/**
 * This week, compact: seven days in a strip (a dot per run, a bar for the
 * driver's own shift, blue for seats still asked for), and the picked
 * day's runs as a line each with the riders in pickup order — first names,
 * tap one for their card. Opens on tomorrow: today is NOW and "Later
 * today" above it.
 */
export function WeekStrip({ onRider }: { onRider: (associateId: string) => void }) {
  const { t } = useI18n();
  const openShiftMap = useContext(ShiftMapContext);
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = zonedDayKey(new Date(), localTz);
  const q = useQuery({ queryKey: ['transport', 'driver', 'week', today], queryFn: () => getDriverWeek(today, 7), refetchInterval: 60_000 });
  // The driver's own shifts, day by day — the one schedule view.
  const shiftsQ = useQuery({ queryKey: ['transport', 'driver', 'shifts', 7, today], queryFn: () => getDriverShifts(today, 7), refetchInterval: 5 * 60_000 });
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: date arithmetic on a day key's UTC anchor
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${today}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  const [picked, setPicked] = useState(days[1]!);
  if (q.isError) return <QueryError what={t('drive.load.week')} query={q} />;
  if (q.isPending) return <Skeleton className="h-28 w-full rounded-lg" />;
  if (!q.data) return null;
  const runsOn = (d: string) => q.data.runs.filter((r) => r.serviceDate === d);
  const askingOn = (d: string) => q.data.asking.filter((a) => a.serviceDate === d);
  const shiftsOn = (d: string) => (shiftsQ.data?.shifts ?? []).filter((sh) => zonedDayKey(new Date(sh.startsAt), localTz) === d);
  const label = (d: string) => {
    const at = parseYmd(d)!;
    return { dow: fmtWeekdayTz(at), num: at.getDate(), long: fmtDayHeaderTz(at) };
  };
  const runs = runsOn(picked);
  const asking = askingOn(picked);
  const shifts = shiftsOn(picked);
  return (
    <section aria-labelledby="drive-week">
      <SectionTitle id="drive-week" title={t('drive.thisWeek')} />
      <Card>
        <CardContent className="p-3 md:p-4">
          <div className="grid grid-cols-7 gap-1" role="tablist" aria-label={t('drive.week')}>
            {days.map((d) => {
              const n = runsOn(d).length;
              const ask = askingOn(d).reduce((m, a) => m + a.count, 0);
              const on = d === picked;
              const l = label(d);
              return (
                <button
                  key={d}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-label={l.long}
                  onClick={() => setPicked(d)}
                  className={cn(
                    'flex min-h-14 min-w-0 flex-col items-center justify-center rounded-md border py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    on ? 'border-accent bg-accent-100' : 'border-line-subtle hover:border-line',
                  )}
                >
                  <span className={cn('text-xs2 uppercase', on ? 'text-accent-800' : 'text-ink-muted')}>{l.dow}</span>
                  <span className={cn('text-lg font-semibold tabular-nums', on ? 'text-accent-800' : 'text-ink')}>{l.num}</span>
                  <span className="mt-0.5 flex h-1.5 gap-0.5" aria-hidden="true">
                    {shiftsOn(d).length > 0 && <span className="h-1.5 w-1.5 rounded-sm bg-ink-muted" />}
                    {Array.from({ length: Math.min(3, n) }, (_, i) => (
                      <span key={i} className="h-1.5 w-1.5 rounded-full bg-accent-fill" />
                    ))}
                    {ask > 0 && <span className="h-1.5 w-1.5 rounded-full bg-info-700" />}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-base font-medium text-ink">{label(picked).long}</p>
          {runs.length === 0 && asking.length === 0 && shifts.length === 0 && <p className="py-2 text-base text-ink-muted">{t('drive.weekNone')}</p>}
          <ul className="mt-1 divide-y divide-line-subtle">
            {shifts.map((sh) => (
              <li key={sh.id} className="flex min-h-11 items-center gap-2 py-2 text-base" data-testid="week-shift">
                <Clock className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="text-ink-muted">{t('drive.myShiftLine')}</span>
                <span className="tabular-nums text-ink">
                  {fmtTimeTz(sh.startsAt, localTz)}–{fmtTimeTz(sh.endsAt, localTz)}
                </span>
              </li>
            ))}
            {runs.map((run) => {
              const trip: TripKey | null = run.storeId
                ? { locationId: run.storeId, direction: run.direction, date: run.serviceDate, windowLabel: run.shift, storeName: run.stores[0] ?? '' }
                : null;
              return (
                <li key={run.id} className="py-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-lg font-semibold tabular-nums text-ink">
                        {fmtTimeTz(run.departAt, run.timezone)}
                        <span className="font-normal text-ink-muted">
                          {' · '}
                          {run.shift ? t('ride.shiftTag', { shift: run.shift }) : null}
                          {run.shift ? ' · ' : null}
                          {run.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')}
                        </span>
                      </p>
                      <p className="truncate text-base text-ink-muted">
                        {run.van.name} · {run.stores.join(', ')}
                      </p>
                    </div>
                    <Badge size="lg" className="shrink-0 text-sm tabular-nums" variant={run.seats.taken >= run.seats.capacity ? 'success' : 'default'}>
                      {t('drive.seats', { taken: run.seats.taken, capacity: run.seats.capacity })}
                    </Badge>
                  </div>
                  {run.riders.length > 0 && (
                    <ol className="mt-1 flex flex-wrap gap-x-1" aria-label={t('drive.route')}>
                      {run.riders.map((r, i) => (
                        <li key={r.rideId}>
                          <button
                            type="button"
                            onClick={() => onRider(r.associateId)}
                            title={r.place}
                            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-1.5 text-base text-ink hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                          >
                            <span className="tabular-nums text-ink-muted">{i + 1}</span>
                            {shortName(r.name)}
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                  {trip && (
                    <Button variant="ghost" className="mt-1 h-11 px-2 text-base" onClick={() => openShiftMap(trip)}>
                      <Route className="h-4 w-4" />
                      {t('drive.shiftStopsBtn')}
                    </Button>
                  )}
                </li>
              );
            })}
            {asking.map((a) => (
              <li key={`${a.store.id}|${a.direction}|${a.windowLabel ?? a.targetAt}`} className="flex min-h-11 items-center gap-2.5 py-2 text-base">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-info-100 text-sm font-semibold tabular-nums text-info-800">{a.count}</span>
                <span className="min-w-0 flex-1 truncate text-ink-muted">
                  {t('drive.asking', { count: a.count })}
                  {' · '}
                  <span className="text-ink">{a.windowLabel ? t('ride.shiftTag', { shift: a.windowLabel }) : fmtTimeTz(a.targetAt, a.store.timezone)}</span>
                  {' · '}
                  {a.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')} · {a.store.name}
                </span>
                <Button
                  variant="ghost"
                  className="h-11 shrink-0 px-2 text-base"
                  aria-label={`${t('drive.shiftStopsBtn')}: ${a.store.name}`}
                  onClick={() => openShiftMap({ locationId: a.store.id, direction: a.direction, date: a.serviceDate, windowLabel: a.windowLabel, storeName: a.store.name })}
                >
                  <Route className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
