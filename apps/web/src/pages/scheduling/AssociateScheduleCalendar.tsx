import { useMemo, useState } from 'react';
import type { Shift } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import { fmtDateTz, zonedDayKey } from '@/lib/format';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ShiftCard, shiftMinutes } from './ShiftCard';

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
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

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
  if (!visible) return null;
  return (
    <p className="mt-3 text-xs text-silver/70">
      {hasOlder ? (
        <>
          You're looking before the loaded history.{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={onLoadOlder}
            loading={loadingOlder}
            disabled={loadingOlder}
            className="inline-flex"
          >
            Load older shifts
          </Button>
        </>
      ) : (
        "That's before your recorded shift history."
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
}: CalendarProps) {
  const [offset, setOffset] = useState(0);
  const byDay = useMemo(() => bucketByDay(shifts), [shifts]);

  const weekStart = new Date(startOfWeek(now).getTime() + offset * 7 * DAY_MS);
  const todayKey = localKey(new Date(now));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart.getTime() + i * DAY_MS);
    return { date: d, key: localKey(d) };
  });
  const weekEnd = new Date(weekStart.getTime() + 6 * DAY_MS);
  const weekMinutes = days.reduce(
    (sum, d) => sum + (byDay.get(d.key) ?? []).reduce((m, s) => m + shiftMinutes(s), 0),
    0,
  );
  // fmtDateTz with no zone = browser-local "Jun 28" — the grid's dates are
  // the viewer's own calendar days.
  const fmtHeader = (d: Date) => fmtDateTz(d);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="text-sm text-white font-medium tabular-nums">
          {fmtHeader(weekStart)} – {fmtHeader(weekEnd)}
          <span className="text-silver font-normal">
            {' '}· {(weekMinutes / 60).toFixed(1)}h scheduled
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Previous week"
            onClick={() => setOffset((o) => o - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {offset !== 0 && (
            <Button variant="ghost" size="sm" onClick={() => setOffset(0)}>
              Today
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Next week"
            onClick={() => setOffset((o) => o + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
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
                  'text-[11px] uppercase tracking-wider mb-1.5',
                  isToday ? 'text-gold' : 'text-silver/80',
                ].join(' ')}
              >
                {WEEKDAYS[d.date.getDay()]}, {fmtHeader(d.date)}
                {isToday && ' · Today'}
                {isBlocked && (
                  <span className="normal-case tracking-normal text-silver/60">
                    {' '}
                    · Unavailable
                  </span>
                )}
              </h3>
              {dayShifts.length === 0 ? (
                <p className="text-xs text-silver/50 border border-dashed border-navy-secondary/60 rounded px-3 py-2">
                  {isBlocked ? 'Day off' : 'No shifts'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {dayShifts.map((s) => (
                    <ShiftCard
                      key={s.id}
                      shift={s}
                      isNext={false}
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
}: CalendarProps) {
  const [offset, setOffset] = useState(0);
  const byDay = useMemo(() => bucketByDay(shifts), [shifts]);

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
            aria-label="Previous month"
            onClick={() => changeMonth(-1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {offset !== 0 && (
            <Button variant="ghost" size="sm" onClick={() => changeMonth('today')}>
              Today
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Next month"
            onClick={() => changeMonth(1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-[10px] uppercase tracking-wider text-silver/60 py-1">
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
              aria-label={`${MONTHS[monthStart.getMonth()]} ${day}${
                count > 0 ? `, ${count} shift${count === 1 ? '' : 's'}` : ''
              }${isBlocked ? ', unavailable' : ''}`}
              className={[
                'rounded-md py-1.5 flex flex-col items-center gap-0.5 border transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
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
              <span className="h-1.5 flex items-center gap-0.5" aria-hidden="true">
                {Array.from({ length: Math.min(count, 3) }, (_, j) => (
                  <span key={j} className="h-1 w-1 rounded-full bg-gold/80" />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {selectedKey !== null && (blockedDays?.has(selectedKey) ?? false) && (
          <p className="text-xs text-silver/60 mb-2">
            You've marked this day as unavailable.
          </p>
        )}
        {selectedKey === null ? (
          <p className="text-xs text-silver/70">Pick a day to see its shifts.</p>
        ) : selectedShifts.length === 0 ? (
          <p className="text-xs text-silver/70">
            No shifts on this day.
          </p>
        ) : (
          <ul className="space-y-2">
            {selectedShifts.map((s) => (
              <ShiftCard
                key={s.id}
                shift={s}
                isNext={false}
                muted={new Date(s.endsAt).getTime() < now}
                onSwapCreated={onSwapCreated}
              />
            ))}
          </ul>
        )}
        {selectedShifts.length > 1 && (
          <p className="mt-2 text-xs text-silver/60 tabular-nums">
            {(selectedShifts.reduce((m, s) => m + shiftMinutes(s), 0) / 60).toFixed(1)}h
            scheduled this day
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
