import { useMemo, useState } from 'react';
import type { Shift } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import { fmtDateTz, fmtHours, fmtMoneyEst, zonedDayKey } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { ShiftCard, paidShiftMinutes } from './ShiftCard';

/**
 * Day-dot colour for the month grid, ordered by what the associate still
 * owes: an upcoming assigned shift they haven't confirmed is the only thing
 * that needs a tap, so it keeps the gold (the brand's "act here" accent).
 * Everything else recedes to a status tone.
 */
function dayDotTone(shift: Shift, now: number): string {
  if (shift.status === 'CANCELLED') return 'bg-alert/60';
  if (shift.status === 'OPEN') return 'bg-warning/80';
  const upcoming = new Date(shift.startsAt).getTime() > now;
  if (shift.status === 'ASSIGNED' && upcoming && !shift.acknowledgedAt) {
    return 'bg-gold';
  }
  return 'bg-success/70';
}

/**
 * Week and month calendar views for My Schedule.
 *
 * Both render from the shifts the page already has (all upcoming + the
 * loaded slice of history) — no extra fetching. Shifts bucket into their
 * STORE-local day (zonedDayKey with the shift's timezone), matching the
 * list view's grouping, while the grid itself is plain browser-local
 * calendar dates: an associate's "my July" is their own calendar.
 *
 * `onLoadOlder` appears when the user navigates before the loaded window
 * and more history exists, so back-navigation is honest about coverage
 * instead of silently showing empty days.
 */

interface CalendarProps {
  shifts: Shift[];
  now: number;
  /** Browser-local day keys the associate can't work (days off + approved
   *  PTO) — painted so unavailability is visible at a glance. */
  blockedDays?: Set<string>;
  onSwapCreated?: () => void;
  /** True when older shifts exist beyond what's loaded. */
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** The associate's hourly rate — prices the ~$ on tiles and totals.
   *  Null (fetch failed) just leaves the money off. */
  estRate: number | null;
  /** Confirming from a calendar card must update the page's shift copy,
   *  or the next-shift hero above keeps nagging after the tap. */
  onAcknowledged?: (shiftId: string, acknowledgedAt: string) => void;
}

const DAY_MS = 86_400_000;

/** Locale-derived weekday/month names — the calendar was the one surface
 *  still hardcoding English day names on an otherwise-Spanish page.
 *  2021-08-01 (a Sunday) anchors the weekday sequence; UTC rendering keeps
 *  the anchor date from shifting in western zones. */
function calendarNames(lang: string): { weekdays: string[]; months: string[] } {
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2021, 7, 1 + i)).toLocaleDateString(locale, {
      weekday: 'short',
      timeZone: 'UTC',
    }),
  );
  const months = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(2021, i, 1)).toLocaleDateString(locale, {
      month: 'long',
      timeZone: 'UTC',
    }),
  );
  return { weekdays, months };
}

/** Browser-local YYYY-MM-DD for a Date (zonedDayKey with no zone). */
const localKey = (d: Date) => zonedDayKey(d);

function startOfWeek(t: number): Date {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Sunday start, matching the hours strip
  return d;
}

/** Store-local day key → that day's shifts, each list chronological. */
function bucketByDay(shifts: Shift[]): Map<string, Shift[]> {
  const map = new Map<string, Shift[]>();
  for (const s of shifts) {
    const key = zonedDayKey(s.startsAt, s.timezone);
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }
  return map;
}

/** The oldest instant covered by loaded data (the 30-day main window or
 *  the oldest history page). Anything before it may just not be loaded. */
function coverageStart(shifts: Shift[], now: number): number {
  let oldest = now - 30 * DAY_MS;
  for (const s of shifts) {
    const t = new Date(s.startsAt).getTime();
    if (t < oldest) oldest = t;
  }
  return oldest;
}

/** PAID minutes across a day/week, with CANCELLED shifts excluded — a
 *  struck shift still renders (as history), but it must never inflate
 *  "32h scheduled" or price into a ~$ total. */
function countedMinutes(shifts: Shift[]): number {
  return shifts.reduce(
    (m, s) => (s.status === 'CANCELLED' ? m : m + paidShiftMinutes(s)),
    0,
  );
}

function OlderNote({
  visible,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: {
  visible: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  const { t } = useI18n();
  if (!visible) return null;
  return (
    <p className="mt-3 text-xs text-silver/70">
      {hasOlder ? (
        <>
          {t('cal.beforeHistory')}{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={onLoadOlder}
            loading={loadingOlder}
            disabled={loadingOlder}
            className="inline-flex"
          >
            {t('sched.loadOlder')}
          </Button>
        </>
      ) : (
        t('cal.beforeRecorded')
      )}
    </p>
  );
}

export function ScheduleWeekView({
  shifts,
  now,
  blockedDays,
  onSwapCreated,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  estRate,
  onAcknowledged,
}: CalendarProps) {
  const [offset, setOffset] = useState(0);
  const byDay = useMemo(() => bucketByDay(shifts), [shifts]);
  const { t, lang } = useI18n();
  const { weekdays: WEEKDAYS } = useMemo(() => calendarNames(lang), [lang]);

  // Calendar-day arithmetic (setDate), NOT raw ms offsets — adding
  // 86.4M-ms increments drifts an hour across a DST transition and can
  // mislabel a day (July review).
  const weekStart = startOfWeek(now);
  weekStart.setDate(weekStart.getDate() + offset * 7);
  const todayKey = localKey(new Date(now));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return { date: d, key: localKey(d) };
  });
  const weekEnd = days[6]!.date;
  const weekMinutes = countedMinutes(
    days.flatMap((d) => byDay.get(d.key) ?? []),
  );
  // fmtDateTz with no zone = browser-local "Jun 28" — the grid's dates are
  // the viewer's own calendar days.
  const fmtHeader = (d: Date) => fmtDateTz(d);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm text-white font-medium tabular-nums">
          {fmtHeader(weekStart)} – {fmtHeader(weekEnd)}
          <span className="text-silver font-normal">
            {' '}· {t('cal.scheduled', { hours: fmtHours(weekMinutes / 60) })}
          </span>
          {/* The week as money — same grain as the list view's ~$ tiles. */}
          {estRate != null && weekMinutes > 0 && (
            <span className="font-semibold text-gold">
              {' '}· {fmtMoneyEst((weekMinutes / 60) * estRate)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('cal.prevWeek')}
            onClick={() => setOffset((o) => o - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {offset !== 0 && (
            <Button variant="ghost" size="sm" onClick={() => setOffset(0)}>
              {t('cal.today')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('cal.nextWeek')}
            onClick={() => setOffset((o) => o + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Key for the tile status shapes — learnable, not innately obvious. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-silver/70">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-gold" aria-hidden="true" />
          {t('shift.confirmNeeded')}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-success/70" aria-hidden="true" />
          {t('shift.confirmed')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Check className="h-3 w-3 text-success" strokeWidth={3} aria-hidden="true" />
          {t('shift.worked')}
        </span>
        <span className="inline-flex items-center gap-1">
          <X className="h-3 w-3 text-alert" strokeWidth={3} aria-hidden="true" />
          {t('shift.cancelled')}
        </span>
      </div>

      <div className="space-y-3">
        {days.map((d) => {
          const dayShifts = byDay.get(d.key) ?? [];
          const isToday = d.key === todayKey;
          const isBlocked = blockedDays?.has(d.key) ?? false;
          return (
            <section key={d.key}>
              <h3
                className={[
                  'text-sm mb-1.5',
                  isToday
                    ? 'font-semibold text-gold'
                    : 'font-medium text-silver',
                ].join(' ')}
              >
                {WEEKDAYS[d.date.getDay()]}, {fmtHeader(d.date)}
                {isToday && ` · ${t('cal.today')}`}
                {isBlocked && (
                  <span className="font-normal text-silver/60">
                    {' '}· {t('cal.unavailable')}
                  </span>
                )}
              </h3>
              {dayShifts.length === 0 ? (
                // A quiet line, not a dashed placeholder box — a normal
                // 3-shift week shouldn't be mostly empty-state furniture.
                <p className="text-xs text-silver/40 py-0.5">
                  {isBlocked ? t('cal.dayOff') : t('cal.noShifts')}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {dayShifts.map((s, i) => (
                    <ShiftCard
                      key={s.id}
                      shift={s}
                      face="tile"
                      isNext={false}
                      appearIndex={i}
                      estRate={estRate}
                      onAcknowledged={onAcknowledged}
                      muted={new Date(s.endsAt).getTime() < now}
                      onSwapCreated={onSwapCreated}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <OlderNote
        visible={weekStart.getTime() < coverageStart(shifts, now)}
        hasOlder={hasOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={onLoadOlder}
      />
    </div>
  );
}

export function ScheduleMonthView({
  shifts,
  now,
  blockedDays,
  onSwapCreated,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  estRate,
  onAcknowledged,
}: CalendarProps) {
  const [offset, setOffset] = useState(0);
  const byDay = useMemo(() => bucketByDay(shifts), [shifts]);
  const { t, lang } = useI18n();
  const { weekdays: WEEKDAYS, months: MONTHS } = useMemo(
    () => calendarNames(lang),
    [lang],
  );

  const base = new Date(now);
  const monthStart = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const daysInMonth = new Date(
    monthStart.getFullYear(),
    monthStart.getMonth() + 1,
    0,
  ).getDate();
  const todayKey = localKey(new Date(now));
  const keyFor = (day: number) =>
    localKey(new Date(monthStart.getFullYear(), monthStart.getMonth(), day));

  // Default selection: today when viewing the current month.
  const [selectedKey, setSelectedKey] = useState<string | null>(
    offset === 0 ? todayKey : null,
  );
  const changeMonth = (delta: number | 'today') => {
    const next = delta === 'today' ? 0 : offset + delta;
    setOffset(next);
    setSelectedKey(next === 0 ? todayKey : null);
  };

  const selectedShifts = selectedKey ? byDay.get(selectedKey) ?? [] : [];

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="text-sm text-white font-medium">
          {MONTHS[monthStart.getMonth()]} {monthStart.getFullYear()}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('cal.prevMonth')}
            onClick={() => changeMonth(-1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {offset !== 0 && (
            <Button variant="ghost" size="sm" onClick={() => changeMonth('today')}>
              {t('cal.today')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('cal.nextMonth')}
            onClick={() => changeMonth(1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-2xs uppercase tracking-wider text-silver/60 py-1">
            {w}
          </div>
        ))}
        {Array.from({ length: monthStart.getDay() }, (_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const key = keyFor(day);
          const count = (byDay.get(key) ?? []).length;
          const isToday = key === todayKey;
          const isSelected = key === selectedKey;
          const isBlocked = blockedDays?.has(key) ?? false;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedKey(key)}
              aria-pressed={isSelected}
              aria-label={[
                `${MONTHS[monthStart.getMonth()]} ${day}`,
                count > 0
                  ? t(count === 1 ? 'sched.shiftsWord' : 'sched.shiftsWordPlural', {
                      count,
                    })
                  : '',
                isBlocked ? t('cal.unavailable') : '',
              ]
                .filter(Boolean)
                .join(', ')}
              className={[
                // py-2.5 on touch lifts the cell to ~44px tap height.
                'rounded-md py-1.5 coarse:py-2.5 flex flex-col items-center gap-0.5 border transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright active:bg-navy-secondary/50',
                // Steel selected state, same idiom as SegmentedControl.
                // Blocked days get a hatched-feel muted fill.
                isSelected
                  ? 'border-steel bg-steel/20'
                  : isBlocked
                    ? 'border-transparent bg-navy-secondary/40 hover:border-navy-secondary'
                    : 'border-transparent hover:border-navy-secondary',
              ].join(' ')}
            >
              <span
                className={[
                  'text-sm tabular-nums',
                  isToday
                    ? 'text-gold font-semibold'
                    : isBlocked
                      ? 'text-silver/40 line-through'
                      : count > 0
                        ? 'text-white'
                        : 'text-silver/60',
                ].join(' ')}
              >
                {day}
              </span>
              {/* One dot per shift, toned by what that shift needs from the
                  associate. Every dot used to be gold, so the month grid
                  could tell you a day was busy but not whether anything on
                  it was still waiting on you — which is the whole reason to
                  open the month view. */}
              <span className="h-1.5 flex items-center gap-0.5" aria-hidden="true">
                {(byDay.get(key) ?? []).slice(0, 3).map((s) => (
                  <span
                    key={s.id}
                    className={[
                      'h-1 w-1 rounded-full',
                      dayDotTone(s, now),
                    ].join(' ')}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      {/* Key for the day dots — new colour meaning needs to be learnable. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-silver/70">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-gold" aria-hidden="true" />
          {t('shift.confirmNeeded')}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-success/70" aria-hidden="true" />
          {t('shift.confirmed')}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-warning/80" aria-hidden="true" />
          {t('shift.open')}
        </span>
      </div>

      <div className="mt-4">
        {selectedKey !== null && (blockedDays?.has(selectedKey) ?? false) && (
          <p className="text-xs text-silver/60 mb-2">
            {t('cal.markedUnavailable')}
          </p>
        )}
        {selectedKey === null ? (
          <p className="text-xs text-silver/70">{t('cal.pickDay')}</p>
        ) : selectedShifts.length === 0 ? (
          <p className="text-xs text-silver/70">{t('cal.noShiftsDay')}</p>
        ) : (
          <ul className="space-y-2">
            {selectedShifts.map((s) => (
              <ShiftCard
                key={s.id}
                shift={s}
                isNext={false}
                estRate={estRate}
                onAcknowledged={onAcknowledged}
                muted={new Date(s.endsAt).getTime() < now}
                onSwapCreated={onSwapCreated}
              />
            ))}
          </ul>
        )}
        {selectedShifts.length > 1 && (
          <p className="mt-2 text-xs text-silver/60 tabular-nums">
            {t('cal.scheduled', {
              hours: fmtHours(countedMinutes(selectedShifts) / 60),
            })}
          </p>
        )}
      </div>

      <OlderNote
        visible={monthStart.getTime() < coverageStart(shifts, now)}
        hasOlder={hasOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={onLoadOlder}
      />
    </div>
  );
}
