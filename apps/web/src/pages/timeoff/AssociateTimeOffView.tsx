import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Plus, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import type {
  TimeOffBalance,
  TimeOffCategory,
  TimeOffRequest,
  TimeOffRequestListResponse,
} from '@alto-people/shared';
import {
  cancelMyRequest,
  createMyRequest,
  getMyBalance,
  listMyRequests,
} from '@/lib/timeOffApi';
import { listHolidays } from '@/lib/holiday117Api';
import { listMyShifts } from '@/lib/schedulingApi';
import { paidShiftMinutes } from '@/pages/scheduling/ShiftCard';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtHours, fmtShiftRangeTz, parseYmd, ymdLocal } from '@/lib/format';
import { enterStagger } from '@/lib/motion';
import { performWithUndo } from '@/lib/undoToast';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';

type Category = TimeOffCategory;

const CATEGORY_KEYS: Record<Category, MessageKey> = {
  SICK: 'timeoff.cat.SICK',
  VACATION: 'timeoff.cat.VACATION',
  PTO: 'timeoff.cat.PTO',
  BEREAVEMENT: 'timeoff.cat.BEREAVEMENT',
  JURY_DUTY: 'timeoff.cat.JURY_DUTY',
  OTHER: 'timeoff.cat.OTHER',
};

const STATUS_KEYS: Record<TimeOffRequest['status'], MessageKey> = {
  PENDING: 'timeoff.status.PENDING',
  APPROVED: 'timeoff.status.APPROVED',
  DENIED: 'timeoff.status.DENIED',
  CANCELLED: 'timeoff.status.CANCELLED',
};

const STATUS_FILTERS: Array<TimeOffRequest['status']> = [
  'PENDING',
  'APPROVED',
  'DENIED',
  'CANCELLED',
];

/** Minutes → the app-wide hours dialect ("8h", "7.5h", locale-aware) —
 *  this page used to roll its own and drift from every other surface. */
const fmtMins = (minutes: number) => fmtHours(minutes / 60);

/** Dates are date-only "YYYY-MM-DD" — parse at local midnight so they
 *  never render a day early west of UTC. */
const fmtYmd = (iso: string) => fmtDate(parseYmd(iso));

/** Mon–Fri dates ("YYYY-MM-DD") in the inclusive range; [] when invalid. */
function weekdayYmds(startYmd: string, endYmd: string): string[] {
  const start = parseYmd(startYmd);
  const end = parseYmd(endYmd);
  if (!start || !end || end < start) return [];
  const out: string[] = [];
  const cur = new Date(start);
  for (let i = 0; i < 366 && cur <= end; i++) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) out.push(ymdLocal(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// The balance key is SHARED with the dashboard's time-off card
// (AssociateDashboard uses the same ['me','timeOffBalance'] key), so a
// visit to either page primes the cache for the other. The cached shape
// must therefore stay `response | null` on both sides.
const BALANCE_KEY = ['me', 'timeOffBalance'] as const;
const REQUESTS_KEY = ['me', 'timeOffRequests'] as const;

/**
 * Caller isn't an associate — a fully expected 403 that renders as an
 * empty state (null data), never an error toast. Anything else rethrows
 * so the query errors and the load-failed toast fires.
 */
async function emptyOnForbidden<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return null;
    throw err;
  }
}

const NO_REQUESTS: TimeOffRequest[] = [];

export function AssociateTimeOffView() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [openCreate, setOpenCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<
    TimeOffRequest['status'] | 'ALL'
  >('ALL');

  // ?new=1 deep link (dashboard tiles) — auto-open the request dialog;
  // &date=YYYY-MM-DD (a shift card's "Request this shift off") fills the
  // day in. Consumed once with a replace so Back/refresh don't re-open it.
  const [searchParams, setSearchParams] = useSearchParams();
  const wantsNew = searchParams.get('new') === '1';
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  useEffect(() => {
    if (!wantsNew) return;
    const date = searchParams.get('date');
    const shiftId = searchParams.get('shift');
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && parseYmd(date)) setPrefill({ startDate: date, endDate: date, shiftId: shiftId || null });
    setOpenCreate(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('new');
        next.delete('date');
        next.delete('shift');
        return next;
      },
      { replace: true },
    );
    // searchParams is read once, with the param that opened the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsNew, setSearchParams]);

  const balancesQuery = useQuery({
    queryKey: BALANCE_KEY,
    queryFn: () => emptyOnForbidden(getMyBalance()),
  });
  const requestsQuery = useQuery({
    queryKey: REQUESTS_KEY,
    queryFn: () => emptyOnForbidden(listMyRequests()),
  });

  // undefined → still loading (skeleton); null (403) → honest empty state.
  const balances: TimeOffBalance[] | null =
    balancesQuery.data === undefined
      ? null
      : (balancesQuery.data?.balances ?? []);
  const requests: TimeOffRequest[] | null =
    requestsQuery.data === undefined
      ? null
      : (requestsQuery.data?.requests ?? NO_REQUESTS);

  const loadError = balancesQuery.error ?? requestsQuery.error;
  useEffect(() => {
    if (loadError) {
      toast.error(t('timeoff.loadFailed'), {
        description: loadError instanceof Error ? loadError.message : 'Something went wrong.',
      });
    }
  }, [loadError, t]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: BALANCE_KEY });
    queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
  };

  // Same phone gesture as Home/Schedule — this tab used to ignore it.
  const pullState = usePullToRefresh(() =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: BALANCE_KEY }),
      queryClient.invalidateQueries({ queryKey: REQUESTS_KEY }),
    ]),
  );

  const filteredRequests = useMemo(() => {
    if (!requests) return null;
    if (statusFilter === 'ALL') return requests;
    return requests.filter((r) => r.status === statusFilter);
  }, [requests, statusFilter]);

  const onCancel = (id: string) => {
    // Gmail-style undo: flip the row to Withdrawn immediately, commit to
    // the server only after the 5s undo window — no confirm dialog, no
    // lost requests from a mis-tap. The optimistic flip lives in the query
    // cache (snapshot/restore) so it survives this component unmounting
    // during the undo window.
    const before = queryClient.getQueryData<TimeOffRequestListResponse | null>(
      REQUESTS_KEY,
    );
    queryClient.setQueryData<TimeOffRequestListResponse | null>(
      REQUESTS_KEY,
      (prev) =>
        prev
          ? {
              ...prev,
              requests: prev.requests.map((r) =>
                r.id === id ? { ...r, status: 'CANCELLED' as const } : r,
              ),
            }
          : prev,
    );
    performWithUndo({
      message: t('timeoff.withdrawnToast'),
      undoLabel: t('common.undo'),
      onCommit: async () => {
        await cancelMyRequest(id);
        refresh();
      },
      onUndo: () => queryClient.setQueryData(REQUESTS_KEY, before),
      commitFailedMessage: t('timeoff.cancelFailed'),
    });
  };

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      {/* Design system §4.2 (UX upgrade step 6, the sweep): the List template. */}
      <ListTemplate
        title={t('timeoff.title')}
        subtitle={t('timeoff.subtitle')}
        primaryAction={
          <Button onClick={() => setOpenCreate(true)}>
            <Plus className="h-4 w-4" />
            {t('timeoff.request')}
          </Button>
        }
      >

      {/* A failed load used to leave the balance tiles + request rows
          shimmering forever with only a transient toast — no way back
          short of a full reload. */}
      {loadError && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={refresh}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('timeoff.loadFailed')}
        </ErrorBanner>
      )}

      {!loadError && (
        <BalanceHero
          balances={balances}
          requests={requests}
          sickAccrual={balancesQuery.data?.sickAccrual ?? null}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('timeoff.myRequests')}</CardTitle>
          <CardDescription>{t('timeoff.mostRecentFirst')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!requests && !loadError && <SkeletonRows count={3} />}
          {requests && requests.length === 0 && (
            // One quiet line: two big empty cards filled the phone (F500 G2).
            <EmptyState size="sm" icon={CalendarOff} title={t('timeoff.noRequests')} />
          )}
          {requests && requests.length > 0 && (
            <>
              {/* The five-way filter only earns its width once the list is
                  long enough to need filtering — for the typical handful
                  of requests it was pure console furniture. */}
              {requests.length > 5 && (
                <SegmentedControl<TimeOffRequest['status'] | 'ALL'>
                  options={[
                    { value: 'ALL', label: t('timeoff.filterAll') },
                    ...STATUS_FILTERS.map((s) => ({
                      value: s,
                      label: t(STATUS_KEYS[s]),
                    })),
                  ]}
                  value={statusFilter}
                  onChange={setStatusFilter}
                  ariaLabel={t('timeoff.filterAria')}
                  className="mb-3 flex-wrap"
                />
              )}
              {filteredRequests && filteredRequests.length === 0 && (
                <p className="text-sm text-silver py-4 text-center">
                  {t('timeoff.noneWithStatus')}
                </p>
              )}
              <ul className="divide-y divide-navy-secondary">
                {(filteredRequests ?? []).map((r, i) => (
                  <li
                    key={r.id}
                    style={enterStagger(i)}
                    className="py-3 flex items-start gap-4 animate-enter"
                  >
                    <div className="flex-1 min-w-0">
                      {/* Dates lead — people think "my Sep 21–23 trip",
                          not "my VACATION·24h record". */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-white font-medium tabular-nums">
                          {fmtYmd(r.startDate)}
                          {r.startDate !== r.endDate && ` – ${fmtYmd(r.endDate)}`}
                        </span>
                        <StatusBadge status={r.status} />
                      </div>
                      <div className="text-xs text-silver mt-0.5">
                        {t(CATEGORY_KEYS[r.category])} · {fmtMins(r.requestedMinutes)}
                      </div>
                      {r.reason && (
                        <div className="text-xs text-silver/80 mt-1 italic">
                          “{r.reason}”
                        </div>
                      )}
                      {r.reviewerNote && (
                        <div className="text-xs text-silver mt-1">
                          <span className="text-silver/70">
                            {t('timeoff.noteFrom', {
                              who: r.reviewerEmail ?? t('timeoff.hr'),
                            })}
                          </span>{' '}
                          {r.reviewerNote}
                        </div>
                      )}
                    </div>
                    {r.status === 'PENDING' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onCancel(r.id)}
                      >
                        {t('timeoff.withdraw')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {/* Time off and protected leave are two pages; each points to the other. */}
      <p className="text-sm text-silver" data-testid="leave-pointer">
        {t('timeoff.leavePointer')}{' '}
        <Link to="/leave" className="text-gold underline underline-offset-2">
          {t('timeoff.leavePointerLink')}
        </Link>
      </p>

      <CreateRequestDialog
        open={openCreate}
        onOpenChange={(o) => {
          setOpenCreate(o);
          if (!o) setPrefill(null);
        }}
        prefill={prefill}
        balances={balances}
        requests={requests}
        onCreated={() => {
          setOpenCreate(false);
          refresh();
        }}
      />
      </ListTemplate>
    </>
  );
}

/**
 * The page's answer as a SCOREBOARD, not a console grid: total available
 * time as the one hero number, a single human sentence breaking it down
 * by category, and — when something is in flight — the pending request
 * surfaced right here instead of buried in the filtered list below.
 * Same card grammar as the earnings hero (gradient face, inset radial
 * glow — never a negative-offset blur, per the e2e rect guard).
 */
function BalanceHero({
  balances: given,
  requests,
  sickAccrual = null,
}: {
  balances: TimeOffBalance[] | null;
  requests: TimeOffRequest[] | null;
  /** The state's sick-time rule (null: none where they work). */
  sickAccrual?: { hoursWorkedPerHour: number } | null;
}) {
  const { t } = useI18n();
  if (!given) {
    return <Skeleton className="h-36" />;
  }
  // Sick time shows as a row even at 0h where it builds up, with its rule.
  const balances =
    sickAccrual && !given.some((b) => b.category === 'SICK')
      ? [...given, { category: 'SICK' as const, balanceMinutes: 0 }]
      : given;
  if (balances.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-silver" data-testid="timeoff-no-balance">
        <Wallet className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
        {t('timeoff.noBalanceShort')}
      </p>
    );
  }
  const totalMinutes = balances.reduce((sum, b) => sum + b.balanceMinutes, 0);
  if (totalMinutes === 0) {
    // Nothing banked yet: a compact row per category instead of a big zero.
    return (
      <Card>
        <CardContent className="py-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
            <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
            {t('timeoff.balancesTitle')}
          </div>
          <ul className="divide-y divide-line" data-testid="timeoff-balance-rows">
            {balances.map((b) => (
              <li key={b.category} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block text-sm text-ink">{t(CATEGORY_KEYS[b.category])}</span>
                  {b.category === 'SICK' && sickAccrual && (
                    <span className="block text-xs text-silver/70">
                      {t('timeoff.accrualRule', { n: sickAccrual.hoursWorkedPerHour })}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{fmtMins(b.balanceMinutes)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    );
  }
  const pending = (requests ?? []).filter((r) => r.status === 'PENDING');
  const first = pending[0];
  return (
    <Card className="relative overflow-hidden border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent animate-enter">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]"
      />
      <CardContent className="relative">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
          <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
          {t('timeoff.heroTitle')}
        </span>
        <div className="mt-2 text-5xl font-bold tracking-tight tabular-nums text-white">
          {fmtMins(totalMinutes)}
        </div>
        {/* The number always says what it IS: one category → its name;
            several → the one-sentence breakdown. */}
        {balances.length === 1 ? (
          <p className="mt-1.5 text-sm text-silver">
            {t(CATEGORY_KEYS[balances[0].category])}
          </p>
        ) : (
          <p className="mt-1.5 text-sm text-silver tabular-nums">
            {balances
              .map(
                (b) => `${fmtMins(b.balanceMinutes)} ${t(CATEGORY_KEYS[b.category])}`,
              )
              .join(' · ')}
          </p>
        )}
        {sickAccrual && balances.some((b) => b.category === 'SICK') && (
          <p className="mt-1 text-xs text-silver/70">
            {t(CATEGORY_KEYS.SICK)}: {t('timeoff.accrualRule', { n: sickAccrual.hoursWorkedPerHour })}
          </p>
        )}
        {pending.length > 0 && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-warning">
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-warning"
              aria-hidden="true"
            />
            {pending.length === 1 && first
              ? t('timeoff.heroPendingOne', {
                  cat: t(CATEGORY_KEYS[first.category]),
                  dates:
                    first.startDate === first.endDate
                      ? fmtYmd(first.startDate)
                      : `${fmtYmd(first.startDate)} – ${fmtYmd(first.endDate)}`,
                })
              : t('timeoff.heroPendingMany', { count: pending.length })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: TimeOffRequest['status'] }) {
  const { t } = useI18n();
  if (status === 'APPROVED')
    return <Badge variant="success">{t('timeoff.status.APPROVED')}</Badge>;
  if (status === 'DENIED')
    return <Badge variant="destructive">{t('timeoff.status.DENIED')}</Badge>;
  if (status === 'CANCELLED')
    return <Badge variant="outline">{t('timeoff.status.CANCELLED')}</Badge>;
  return <Badge variant="pending">{t('timeoff.status.PENDING')}</Badge>;
}

interface CreateProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  balances: TimeOffBalance[] | null;
  /** The associate's own request history — PENDING rows are subtracted
   *  from the balance-impact preview so it reflects reality. */
  requests: TimeOffRequest[] | null;
  /** The day(s) a shift card asked for ("Request this shift off"). */
  prefill?: Prefill | null;
  onCreated: () => void;
}

/** What a shift card's "Request this shift off" opens the form on. */
type Prefill = { startDate: string; endDate: string; shiftId?: string | null };

/** Tomorrow, local — time off is almost always asked for ahead. */
function tomorrowYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return ymdLocal(d);
}

/** The category to start on. The one they used last (if it still has
 *  time in it); otherwise planned time off — vacation or PTO, whichever has
 *  the most — because a day off filed as sick counts as an absence. Sick is
 *  the pick only when it's the one category with time in it; vacation when
 *  none has any. */
export function defaultCategory(
  balances: readonly TimeOffBalance[] | null,
  requests: readonly Pick<TimeOffRequest, 'category' | 'status' | 'createdAt'>[] | null = null,
): Category {
  const withTime = (balances ?? []).filter((b) => b.balanceMinutes > 0);
  const last = [...(requests ?? [])]
    .filter((r) => r.status !== 'CANCELLED')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (last && withTime.some((b) => b.category === last.category)) return last.category;
  const byMost = [...withTime].sort((a, b) => b.balanceMinutes - a.balanceMinutes);
  const planned = byMost.find((b) => b.category !== 'SICK');
  return planned?.category ?? byMost[0]?.category ?? 'VACATION';
}

/** "YYYY-MM-DD" of an instant at the store (a shift's own day). */
function ymdAt(iso: string, timeZone: string | null | undefined): string {
  if (!timeZone) return ymdLocal(new Date(iso));
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  } catch {
    return ymdLocal(new Date(iso));
  }
}

/**
 * The hours a full-day request covers, day by day: a day with their shifts
 * is those shifts' paid hours; a weekday past the last day their schedule
 * is out for is 8 (not known yet); a day inside the published schedule
 * with no shift is a day off — 0. Holidays count 0. Exported for tests.
 */
export function requestMinutesFor(
  startDate: string,
  endDate: string,
  shifts: ReadonlyArray<{ startsAt: string; timezone?: string | null; minutes: number }>,
  holidays: ReadonlySet<string> | null,
): { minutes: number; fromSchedule: boolean } {
  const byDay = new Map<string, number>();
  let lastScheduled = '';
  for (const s of shifts) {
    const d = ymdAt(s.startsAt, s.timezone);
    if (d > lastScheduled) lastScheduled = d;
    if (d >= startDate && d <= endDate) byDay.set(d, (byDay.get(d) ?? 0) + s.minutes);
  }
  if (byDay.size === 0) {
    const days = weekdayYmds(startDate, endDate).filter((d) => !holidays?.has(d));
    return { minutes: days.length * 8 * 60, fromSchedule: false };
  }
  let minutes = 0;
  const cur = parseYmd(startDate);
  const end = parseYmd(endDate);
  for (let i = 0; cur && end && cur <= end && i < 366; i++) {
    const d = ymdLocal(cur);
    const dow = cur.getDay();
    if (byDay.has(d)) minutes += byDay.get(d)!;
    else if (d > lastScheduled && dow !== 0 && dow !== 6 && !holidays?.has(d)) minutes += 8 * 60;
    cur.setDate(cur.getDate() + 1);
  }
  return { minutes, fromSchedule: true };
}

// "Single day" / "Date range" aren't in the typed i18n catalog (MessageKey
// additions ripple through every locale record, which lives outside this
// page) — inline both languages so Spanish speakers aren't dropped to
// English for just this control.
const RANGE_MODE_LABELS = {
  en: { single: 'Single day', range: 'Date range', date: 'Date', mode: 'Single day or date range' },
  es: { single: 'Un solo día', range: 'Rango de fechas', date: 'Fecha', mode: 'Un solo día o rango de fechas' },
} as const;

function CreateRequestDialog({
  open,
  onOpenChange,
  balances,
  requests,
  prefill = null,
  onCreated,
}: CreateProps) {
  const { t, lang } = useI18n();
  const L = (RANGE_MODE_LABELS as unknown as Partial<Record<string, typeof RANGE_MODE_LABELS.en>>)[lang] ?? RANGE_MODE_LABELS.en;
  const [category, setCategory] = useState<Category>('VACATION');
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [startDate, setStartDate] = useState(tomorrowYmd);
  const [endDate, setEndDate] = useState(tomorrowYmd);
  // Single-day preset collapses the start/end pair to one date input
  // (end mirrors start) — the most common request shape for hourly
  // associates. Off by default so the familiar range form stays put.
  const [singleDay, setSingleDay] = useState(false);
  const [hours, setHours] = useState('8');
  // Once the associate types their own hours, stop auto-computing from the
  // date range — their number wins.
  const [hoursTouched, setHoursTouched] = useState(false);
  const [preset, setPreset] = useState<'FULL' | 'HALF'>('FULL');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Company holiday dates ("YYYY-MM-DD") for the years the range touches.
  // Best-effort: null (not loaded / failed) → the day math simply doesn't
  // exclude holidays rather than blocking the form.


  const reset = () => {
    setCategory('VACATION');
    setCategoryTouched(false);
    setStartDate(tomorrowYmd());
    setEndDate(tomorrowYmd());
    setHours('8');
    setHoursTouched(false);
    setPreset('FULL');
    setReason('');
  };

  const setDates = (nextStart: string, nextEnd: string) => {
    setStartDate(nextStart);
    // Keep the range valid instead of erroring later: dragging the start
    // past the end pulls the end along.
    const effEnd = nextEnd && nextEnd < nextStart ? nextStart : nextEnd;
    setEndDate(effEnd);
  };

  // Fetch holidays for every year the selected range touches (a range can
  // straddle New Year). Only the years matter for the fetch key; the last
  // set stays on screen while a new year loads.
  const startYear = startDate.slice(0, 4);
  const endYear = endDate.slice(0, 4);
  const sy = Number(startYear);
  const ey = Number(endYear);
  const yearsValid =
    Number.isFinite(sy) && Number.isFinite(ey) && ey >= sy && ey - sy <= 2;
  const holidaysQuery = useQuery({
    queryKey: ['TimeOffRequestForm', 'holidays', sy, ey],
    queryFn: () => {
      const years: number[] = [];
      for (let y = sy; y <= ey; y++) years.push(y);
      return Promise.all(years.map((y) => listHolidays({ year: y })));
    },
    enabled: open && yearsValid,
    placeholderData: keepPreviousData,
  });
  const holidayDates: ReadonlySet<string> | null = useMemo(
    () =>
      holidaysQuery.isError || !holidaysQuery.data
        ? null
        : new Set(
            holidaysQuery.data.flatMap((r) => r.holidays.map((h) => h.date.slice(0, 10))),
          ),
    [holidaysQuery.data, holidaysQuery.isError],
  );

  const dayInfo = useMemo(() => {
    const days = weekdayYmds(startDate, endDate);
    const holidays = holidayDates
      ? days.filter((d) => holidayDates.has(d)).length
      : 0;
    return {
      weekdays: days.length,
      holidays,
      effective: days.length - holidays,
    };
  }, [startDate, endDate, holidayDates]);

  // Until they pick one, the category follows their balances (the one with
  // time in it); a shift card's day lands in the dates when it opens.
  useEffect(() => {
    if (!open || categoryTouched) return;
    setCategory(defaultCategory(balances, requests));
  }, [open, categoryTouched, balances, requests]);
  useEffect(() => {
    if (!open || !prefill) return;
    setStartDate(prefill.startDate);
    setEndDate(prefill.endDate);
    setSingleDay(prefill.startDate === prefill.endDate);
    setHoursTouched(false);
    setPreset('FULL');
  }, [open, prefill]);
  // What the form opened on — "unsaved changes" means a change from this,
  // not from tomorrow. A plain open after a shift card's open starts fresh.
  const openedWith = useRef<{ start: string; end: string }>({ start: tomorrowYmd(), end: tomorrowYmd() });
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      if (prefill) openedWith.current = { start: prefill.startDate, end: prefill.endDate };
      else {
        const pristine = !hoursTouched && !categoryTouched && reason === '';
        if (pristine) {
          setStartDate(tomorrowYmd());
          setEndDate(tomorrowYmd());
          openedWith.current = { start: tomorrowYmd(), end: tomorrowYmd() };
        } else {
          openedWith.current = { start: startDate, end: endDate };
        }
      }
    }
    wasOpen.current = open;
    // Runs on the open transition only; the rest is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill]);

  // Their scheduled shifts on the chosen days: a full-day request is the
  // hours they were scheduled for, not a flat 8 per day.
  const shiftsQuery = useQuery({
    queryKey: ['me', 'shifts', 'time-off-form'],
    queryFn: () => listMyShifts(),
    enabled: open,
    staleTime: 60_000,
  });
  // The shift a card's "Request this shift off" was about — its hours alone
  // when the form is still on its day.
  const linkedShift = useMemo(
    () => (prefill?.shiftId ? (shiftsQuery.data?.shifts ?? []).find((s) => s.id === prefill.shiftId) ?? null : null),
    [prefill, shiftsQuery.data],
  );
  const onLinkedDay = !!linkedShift && !!prefill && startDate === prefill.startDate && endDate === prefill.endDate;
  const plan = useMemo(() => {
    if (!startDate || !endDate) return { minutes: 0, fromSchedule: false };
    if (onLinkedDay && linkedShift) return { minutes: paidShiftMinutes(linkedShift), fromSchedule: true };
    const mine = (shiftsQuery.data?.shifts ?? [])
      .filter((s) => s.status === 'ASSIGNED')
      .map((s) => ({ startsAt: s.startsAt, timezone: s.timezone, minutes: paidShiftMinutes(s) }));
    return requestMinutesFor(startDate, endDate, mine, holidayDates);
  }, [shiftsQuery.data, startDate, endDate, holidayDates, onLinkedDay, linkedShift]);
  const scheduledMinutes = plan.fromSchedule ? plan.minutes : 0;
  const fromSchedule = plan.fromSchedule && !hoursTouched && preset === 'FULL';

  // Auto-compute hours from their schedule (or the effective day count) and
  // the chosen full-day/half-day preset until they type their own number.
  useEffect(() => {
    if (!open || hoursTouched) return;
    if (preset === 'FULL' && plan.fromSchedule && plan.minutes > 0) {
      setHours(String(Math.round((plan.minutes / 60) * 100) / 100));
    } else if (dayInfo.effective > 0) {
      setHours(String(dayInfo.effective * (preset === 'FULL' ? 8 : 4)));
    }
  }, [open, hoursTouched, dayInfo.effective, preset, plan]);

  const balance = balances?.find((b) => b.category === category) ?? null;
  const pendingMinutes = useMemo(
    () =>
      (requests ?? [])
        .filter((r) => r.status === 'PENDING' && r.category === category)
        .reduce((sum, r) => sum + r.requestedMinutes, 0),
    [requests, category],
  );
  const hoursNum = Number(hours);
  const requestedMinutes =
    Number.isFinite(hoursNum) && hoursNum > 0 ? Math.round(hoursNum * 60) : null;
  const afterMinutes =
    balance && requestedMinutes !== null
      ? balance.balanceMinutes - pendingMinutes - requestedMinutes
      : null;

  const submit = async () => {
    if (!startDate || !endDate) {
      toast.error(t('timeoff.pickDates'));
      return;
    }
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) {
      toast.error(t('timeoff.hoursPositive'));
      return;
    }
    setSubmitting(true);
    try {
      await createMyRequest({
        category,
        startDate,
        endDate,
        hours: h,
        reason: reason.trim() || undefined,
      });
      toast.success(t('timeoff.submittedToast'));
      reset();
      onCreated();
    } catch (err) {
      toast.error(t('timeoff.submitFailed'), {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const pickPreset = (p: 'FULL' | 'HALF') => {
    setPreset(p);
    setHoursTouched(false);
    if (p === 'FULL' && plan.fromSchedule && plan.minutes > 0) {
      setHours(String(Math.round((plan.minutes / 60) * 100) / 100));
    } else if (dayInfo.effective > 0) {
      setHours(String(dayInfo.effective * (p === 'FULL' ? 8 : 4)));
    }
  };

  /** "1 weekday" / "3 weekdays" — singular/plural key pair with {count}. */
  const nWord = (one: MessageKey, many: MessageKey, count: number) =>
    t(count === 1 ? one : many, { count });

  // Dirty = any field differs from its initial value (the state persists
  // across opens until a successful submit resets it).
  const isDirty = () =>
    categoryTouched ||
    startDate !== openedWith.current.start ||
    endDate !== openedWith.current.end ||
    hoursTouched ||
    reason !== '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange} confirmDiscard={isDirty}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('timeoff.request')}</DialogTitle>
          <DialogDescription>
            {t('timeoff.dialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="grid gap-4"
        >
        <div className="space-y-3">
          <Field label={t('timeoff.category')}>
            {(p) => (
              <Select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value as Category);
                  setCategoryTouched(true);
                }}
                {...p}
              >
                {(Object.keys(CATEGORY_KEYS) as Category[]).map((c) => (
                  <option key={c} value={c}>
                    {t(CATEGORY_KEYS[c])}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {onLinkedDay && linkedShift ? (
            <p className="rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink">
              {t('timeoff.forShift', { position: linkedShift.position, time: fmtShiftRangeTz(linkedShift.startsAt, linkedShift.endsAt, linkedShift.timezone) })}
            </p>
          ) : (
            // Same-day sick calls and tomorrow's day off, one tap each.
            <div className="flex flex-wrap gap-2">
              {([['today', ymdLocal(new Date())], ['tomorrow', tomorrowYmd()]] as const).map(([k, d]) => (
                <Button
                  key={k}
                  type="button"
                  size="xs"
                  variant={startDate === d && endDate === d ? 'secondary' : 'ghost'}
                  aria-pressed={startDate === d && endDate === d}
                  onClick={() => {
                    setSingleDay(true);
                    setDates(d, d);
                  }}
                >
                  {t(k === 'today' ? 'timeoff.today' : 'timeoff.tomorrow')}
                </Button>
              ))}
            </div>
          )}

          <SegmentedControl<'single' | 'range'>
            options={[
              { value: 'single', label: L.single },
              { value: 'range', label: L.range },
            ]}
            value={singleDay ? 'single' : 'range'}
            onChange={(v) => {
              const s = v === 'single';
              setSingleDay(s);
              // Collapsing to one day mirrors the end onto the start.
              if (s) setDates(startDate, startDate);
            }}
            ariaLabel={L.mode}
          />

          {singleDay ? (
            <Field label={L.date} required>
              {(p) => (
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setDates(e.target.value, e.target.value)}
                  {...p}
                />
              )}
            </Field>
          ) : (
            /* Stack the date pair on phones — two native date inputs
               side-by-side don't fit inside the 360px bottom sheet. */
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={t('timeoff.startDate')} required>
                {(p) => (
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setDates(e.target.value, endDate)}
                    {...p}
                  />
                )}
              </Field>
              <Field label={t('timeoff.endDate')} required>
                {(p) => (
                  <Input
                    type="date"
                    value={endDate}
                    min={startDate || undefined}
                    onChange={(e) => setDates(startDate, e.target.value)}
                    {...p}
                  />
                )}
              </Field>
            </div>
          )}

          {dayInfo.weekdays > 0 && (
            <p className="text-xs text-silver tabular-nums">
              {dayInfo.holidays > 0
                ? `${nWord('timeoff.weekdayWord', 'timeoff.weekdayWordPlural', dayInfo.weekdays)} − ${nWord('timeoff.holidayWord', 'timeoff.holidayWordPlural', dayInfo.holidays)} = ${nWord('timeoff.dayWord', 'timeoff.dayWordPlural', dayInfo.effective)}`
                : nWord('timeoff.weekdayWord', 'timeoff.weekdayWordPlural', dayInfo.weekdays)}
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="xs"
              variant={!hoursTouched && preset === 'FULL' ? 'secondary' : 'ghost'}
              disabled={dayInfo.effective <= 0 && scheduledMinutes <= 0}
              onClick={() => pickPreset('FULL')}
            >
              {t('timeoff.fullDays', { hours: scheduledMinutes > 0 ? Math.round((scheduledMinutes / 60) * 100) / 100 : dayInfo.effective * 8 })}
            </Button>
            <Button
              type="button"
              size="xs"
              variant={!hoursTouched && preset === 'HALF' ? 'secondary' : 'ghost'}
              disabled={dayInfo.effective <= 0}
              onClick={() => pickPreset('HALF')}
            >
              {t('timeoff.halfDays', { hours: dayInfo.effective * 4 })}
            </Button>
          </div>

          <Field
            label={t('timeoff.totalHours')}
            required
            hint={fromSchedule ? t('timeoff.hoursFromSchedule') : t('timeoff.totalHoursHint')}
          >
            {(p) => (
              <Input
                type="number"
                step="0.5"
                min="0.5"
                value={hours}
                onChange={(e) => {
                  setHours(e.target.value);
                  setHoursTouched(true);
                }}
                {...p}
              />
            )}
          </Field>

          {balance && requestedMinutes !== null && afterMinutes !== null && (
            <p
              className={
                afterMinutes < 0
                  ? 'text-xs text-alert tabular-nums'
                  : 'text-xs text-silver tabular-nums'
              }
            >
              {afterMinutes < 0
                ? t('timeoff.balanceOver', { over: fmtMins(-afterMinutes) })
                : t('timeoff.balanceLine', {
                    avail: fmtMins(balance.balanceMinutes - pendingMinutes),
                    after: fmtMins(afterMinutes),
                  })}
            </p>
          )}

          <Field label={t('timeoff.reasonOptional')}>
            {(p) => (
              <Input
                type="text"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('timeoff.reasonPlaceholder')}
                {...p}
              />
            )}
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={submitting}>
            {t('timeoff.submit')}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
