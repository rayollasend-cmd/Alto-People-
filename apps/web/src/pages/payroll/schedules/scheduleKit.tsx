import { Link } from 'react-router-dom';
import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PayFrequencyKind, PayScheduleSummary, ReadinessLevel, RosterPerson, SchedulePeriod } from '@alto-people/shared';
import { getPayCalendar } from '@/lib/paySchedulesApi';
import { CalendarClock, MoveRight } from 'lucide-react';
import { Avatar, type AvatarSize } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { fmtDayShort, fmtMonthYearTz, parseYmd, ymdLocal } from '@/lib/format';

/**
 * The building blocks the pay-schedule pages share: the readiness ring
 * around a face, a person tile, an avatar stack, the pattern in plain words
 * and the pay calendar.
 */

/* ---- Dates ------------------------------------------------------------- */

/** "Fri, Nov 6, 2026" — the weekday is the point of a pay date. */
export function payDay(ymd: string | null | undefined, year = true): string {
  const d = parseYmd(ymd ?? null);
  return d ? fmtDayShort(d, { year, anchored: true }) : '—';
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 22" — for a metric, where the weekday goes in the hint. */
export function shortDay(ymd: string | null | undefined): string {
  const d = parseYmd(ymd ?? null);
  return d ? `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}` : '—';
}

/** "Thursday". */
export function weekdayOf(ymd: string | null | undefined): string {
  const d = parseYmd(ymd ?? null);
  return d ? WEEKDAYS[d.getDay()]! : '';
}

/** Blocking issues first: they decide whether the check is right. */
export function issuesByWeight<T extends { level: ReadinessLevel }>(issues: T[]): T[] {
  return [...issues].sort((a, b) => (a.level === 'BLOCKED' ? 0 : 1) - (b.level === 'BLOCKED' ? 0 : 1));
}

/** "Sat, Oct 31 – Fri, Nov 13". */
export function periodRange(a: string, b: string): string {
  return `${payDay(a, false)} – ${payDay(b, false)}`;
}

export function addDays(ymd: string, n: number): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PERIOD_DAYS: Partial<Record<PayFrequencyKind, number>> = { DAILY: 1, WEEKLY: 7, BIWEEKLY: 14 };

/**
 * The first pay-period start on or after today, worked out from the summary
 * alone: `nextPeriod` is the period behind the next payday, which may already
 * be over. Exact for day/week-based schedules; the 1st or 16th otherwise.
 */
export function estimateChangeDate(s: Pick<PayScheduleSummary, 'frequency' | 'nextPeriod'>, today = ymdLocal()): string {
  const len = PERIOD_DAYS[s.frequency];
  let start = s.nextPeriod.periodStart;
  if (len) {
    while (start < today) start = addDays(start, len);
    return start;
  }
  start = addDays(s.nextPeriod.periodEnd, 1);
  while (start < today) {
    const [y, m, d] = start.split('-').map(Number) as [number, number, number];
    const next = s.frequency === 'SEMIMONTHLY' && d < 16 ? new Date(y, m - 1, 16) : new Date(y, m, 1);
    start = ymdLocal(next);
  }
  return start;
}

/**
 * The earliest day a membership or pattern change can start, and that
 * period's payday: read from the schedule's calendar, estimated until it loads.
 */
export function useChangeDate(s: PayScheduleSummary | null): { date: string; payDate: string | null } {
  const cal = useQuery({ queryKey: ['paySchedules', 'calendar', s?.id], queryFn: () => getPayCalendar(s!.id, 12), enabled: !!s });
  const today = ymdLocal();
  return useMemo(() => {
    if (!s) return { date: '', payDate: null };
    const p = cal.data?.periods.find((x) => x.periodStart >= today);
    return p ? { date: p.periodStart, payDate: p.payDate } : { date: estimateChangeDate(s, today), payDate: null };
  }, [s, cal.data, today]);
}

/* ---- The pattern in plain words ---------------------------------------- */

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export const FREQUENCY_WORDS: Record<PayFrequencyKind, string> = {
  WEEKLY: 'Every week',
  BIWEEKLY: 'Every other week',
  SEMIMONTHLY: 'Twice a month',
  MONTHLY: 'Once a month',
  DAILY: 'Every day',
};

export const PERIODS_PER_YEAR: Record<PayFrequencyKind, number> = { WEEKLY: 52, BIWEEKLY: 26, SEMIMONTHLY: 24, MONTHLY: 12, DAILY: 260 };

/**
 * The sentence a payroll lead would say out loud: "Every other week,
 * Saturday to Friday, paid the next Friday". Mirrors the server's pattern
 * text for the schedules it already has; used live in the setup wizard.
 */
export function patternSentence(frequency: PayFrequencyKind, anchorDate: string, payDateOffsetDays: number): string {
  const start = parseYmd(anchorDate);
  if (!start) return FREQUENCY_WORDS[frequency];
  if (frequency === 'WEEKLY' || frequency === 'BIWEEKLY') {
    const s = start.getDay();
    const e = (s + 6) % 7;
    const pay = (e + payDateOffsetDays) % 7;
    const when = payDateOffsetDays === 0 ? 'paid the last day' : payDateOffsetDays <= 7 ? `paid the next ${WEEKDAYS[pay]}` : `paid ${payDateOffsetDays} days later`;
    return `${FREQUENCY_WORDS[frequency]}, ${WEEKDAYS[s]} to ${WEEKDAYS[e]}, ${when}`;
  }
  if (frequency === 'SEMIMONTHLY') {
    return `Twice a month, the 1st–15th and 16th–end, paid ${payDateOffsetDays === 0 ? 'the last day' : `${payDateOffsetDays} day${payDateOffsetDays === 1 ? '' : 's'} later`}`;
  }
  if (frequency === 'MONTHLY') {
    return `Once a month, the whole month, paid ${payDateOffsetDays === 0 ? 'the last day' : `${payDateOffsetDays} day${payDateOffsetDays === 1 ? '' : 's'} after it ends`}`;
  }
  return 'Every day, paid the next morning';
}

/* ---- Readiness --------------------------------------------------------- */

export const READINESS_LABEL: Record<ReadinessLevel, string> = {
  READY: 'Ready to be paid',
  ATTENTION: 'Needs a look',
  BLOCKED: 'Won’t be paid correctly',
};

const RING: Record<ReadinessLevel, string> = {
  READY: 'ring-success',
  ATTENTION: 'ring-warning',
  BLOCKED: 'ring-alert',
};

/** A face with a coloured ring saying whether this payday's check is right. The colour is never the only signal. */
export function ReadinessRing({ src, name, level, size = 'lg', className }: { src: string | null; name: string; level: ReadinessLevel; size?: AvatarSize; className?: string }) {
  return (
    <span className={cn('relative inline-flex shrink-0 rounded-full p-[3px] ring-2', RING[level], className)} title={READINESS_LABEL[level]}>
      <Avatar src={src} name={name} size={size} />
      <span className="sr-only">{READINESS_LABEL[level]}</span>
      {level !== 'READY' && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full border-2 border-surface-raised text-3xs font-bold leading-none text-on-alert',
            level === 'BLOCKED' ? 'bg-alert' : 'bg-warning',
          )}
        >
          !
        </span>
      )}
    </span>
  );
}

export function ReadinessBadge({ level }: { level: ReadinessLevel }) {
  return (
    <Badge size="sm" withDot={false} variant={level === 'READY' ? 'success' : level === 'ATTENTION' ? 'pending' : 'destructive'}>
      {level === 'READY' ? 'Ready' : level === 'ATTENTION' ? 'Needs a look' : 'Blocked'}
    </Badge>
  );
}

/* ---- Tiles and stacks -------------------------------------------------- */

/** One person on a schedule: face with the readiness ring, name, where they work, and the first thing to fix. */
export function PersonTile({ person, onOpen, menu }: { person: RosterPerson; onOpen: () => void; menu?: ReactNode }) {
  const sorted = issuesByWeight(person.issues);
  const issue = sorted[0];
  const more = sorted.length - 1;
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full w-full flex-col items-center gap-2 rounded-xl border border-line bg-surface-raised px-3 pb-3 pt-4 text-center transition-colors hover:border-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={`${person.name} — ${READINESS_LABEL[person.readiness]}${issue ? `: ${issue.label}` : ''}`}
      >
        <ReadinessRing src={person.photoUrl} name={person.name} level={person.readiness} />
        <span className="w-full truncate text-sm font-medium text-ink">{person.name}</span>
        <span className="w-full truncate text-2xs text-ink-muted">{person.jobTitle ?? person.siteName ?? person.clientName ?? '—'}</span>
        {issue ? (
          <span className={cn('flex w-full min-w-0 justify-center gap-1 text-2xs font-medium', issue.level === 'BLOCKED' ? 'text-alert' : 'text-warning')} title={sorted.map((i) => i.label).join('\n')}>
            <span className="truncate">{issue.label.split(' — ')[0]}</span>
            {more > 0 && <span className="shrink-0 font-normal tabular-nums text-ink-muted">+{more}</span>}
          </span>
        ) : person.pendingMove ? (
          <span className="inline-flex items-center gap-1 text-2xs text-ink-muted">
            <MoveRight className="h-3 w-3" aria-hidden="true" />
            {person.pendingMove.toScheduleName ?? 'Off'} · {payDay(person.pendingMove.effectiveFrom, false)}
          </span>
        ) : person.isNewHire ? (
          <span className="text-2xs font-medium text-accent">New hire</span>
        ) : (
          <span className="text-2xs text-ink-muted">{person.rateLabel ?? ' '}</span>
        )}
      </button>
      {menu && <div className="absolute right-1.5 top-1.5">{menu}</div>}
    </div>
  );
}

/** Faces overlapping, "+N" for the rest. */
export function AvatarStack({ people, max = 5, size = 'sm' }: { people: Array<{ name: string; photoUrl: string | null }>; max?: number; size?: AvatarSize }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className="inline-flex items-center">
      {shown.map((p, i) => (
        // A smaller overlap for the small faces: -ml-2 covered the second letter of "AE" (F500 G3).
        <span key={`${p.name}-${i}`} className={cn('rounded-full ring-2 ring-surface-raised', i > 0 && (size === 'xs' ? '-ml-1' : '-ml-1.5'))}>
          <Avatar src={p.photoUrl} name={p.name} size={size} />
        </span>
      ))}
      {rest > 0 && (
        <span className={cn('grid min-w-8 place-items-center rounded-full bg-surface-raised px-1.5 text-2xs font-semibold tabular-nums text-ink-muted ring-2 ring-surface-raised', size === 'xs' ? '-ml-1 h-6 min-w-6' : '-ml-1.5 h-8')}>
          +{rest}
        </span>
      )}
    </span>
  );
}

/* ---- The pay calendar -------------------------------------------------- */

/** Pay periods grouped by the month they're paid in, each payday with its holiday or weekend move explained. */
export function PayCalendar({ periods, linkRun }: { periods: SchedulePeriod[]; linkRun?: (runId: string) => string }) {
  const byMonth = new Map<string, SchedulePeriod[]>();
  for (const p of periods) {
    const d = parseYmd(p.payDate);
    // parseYmd is local midnight, so the browser zone names the same calendar month.
    const key = d ? fmtMonthYearTz(d) : p.payDate.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), p]);
  }
  if (periods.length === 0) return <p className="text-sm text-ink-muted">No pay periods to show.</p>;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {[...byMonth.entries()].map(([month, list]) => (
        <section key={month} className="rounded-xl border border-line bg-surface-raised p-4">
          <h3 className="text-sm font-semibold text-ink">{month}</h3>
          <ul className="mt-3 space-y-3">
            {list.map((p) => (
              <li key={p.periodStart} className="flex gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-accent-fill/15 text-center leading-none text-accent">
                  <span className="text-2xs font-semibold uppercase">{WEEKDAYS[parseYmd(p.payDate)?.getDay() ?? 0].slice(0, 3)}</span>
                  <span className="text-base font-semibold tabular-nums">{parseYmd(p.payDate)?.getDate()}</span>
                </span>
                <span className="min-w-0 text-sm">
                  <span className="block font-medium text-ink">Payday {payDay(p.payDate, false)}</span>
                  <span className="block text-xs text-ink-muted">For {periodRange(p.periodStart, p.periodEnd)}</span>
                  {p.adjustedFor && p.unadjustedPayDate && (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-warning">
                      <CalendarClock className="h-3 w-3 shrink-0" aria-hidden="true" />
                      {p.adjustedFor} on {payDay(p.unadjustedPayDate, false)} — paid {payDay(p.payDate, false)} instead
                    </span>
                  )}
                  {p.versionChange && (
                    <span className="mt-0.5 block text-xs text-accent">
                      {p.bridge ? 'A short bridge period — the new pay pattern starts here' : 'The pay pattern changes from this period'}
                    </span>
                  )}
                  {p.run && (
                    <span className="mt-0.5 block text-xs">
                      {linkRun ? (
                        <Link className="text-accent underline underline-offset-2" to={linkRun(p.run.id)}>
                          Run {p.run.status.toLowerCase()}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">Run {p.run.status.toLowerCase()}</span>
                      )}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
