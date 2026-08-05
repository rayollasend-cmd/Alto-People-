import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { ApiError } from '@/lib/api';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
import { performWithUndo } from '@/lib/undoToast';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
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

function fmtHours(minutes: number): string {
  const h = minutes / 60;
  return `${h.toFixed(h % 1 === 0 ? 0 : 1)}h`;
}

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

export function AssociateTimeOffView() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [openCreate, setOpenCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<
    TimeOffRequest['status'] | 'ALL'
  >('ALL');

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
      : (requestsQuery.data?.requests ?? []);

  const loadError = balancesQuery.error ?? requestsQuery.error;
  useEffect(() => {
    if (loadError) {
      toast.error(t('timeoff.loadFailed'), {
        description: loadError instanceof Error ? loadError.message : String(loadError),
      });
    }
  }, [loadError, t]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: BALANCE_KEY });
    queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
  };

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
    <div className="space-y-6">
      <PageHeader
        title={t('timeoff.title')}
        subtitle={t('timeoff.subtitle')}
        primaryAction={
          <Button onClick={() => setOpenCreate(true)}>
            <Plus className="h-4 w-4" />
            {t('timeoff.request')}
          </Button>
        }
      />

      <BalanceGrid balances={balances} />

      <Card>
        <CardHeader>
          <CardTitle>{t('timeoff.myRequests')}</CardTitle>
          <CardDescription>{t('timeoff.mostRecentFirst')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!requests && <SkeletonRows count={3} />}
          {requests && requests.length === 0 && (
            <EmptyState
              icon={CalendarOff}
              title={t('timeoff.noRequests')}
              description={t('timeoff.noRequestsDesc')}
            />
          )}
          {requests && requests.length > 0 && (
            <>
              <SegmentedControl<TimeOffRequest['status'] | 'ALL'>
                options={[
                  { value: 'ALL', label: 'All' },
                  ...STATUS_FILTERS.map((s) => ({
                    value: s,
                    label: t(STATUS_KEYS[s]),
                  })),
                ]}
                value={statusFilter}
                onChange={setStatusFilter}
                ariaLabel="Filter requests by status"
                className="mb-3 flex-wrap"
              />
              {filteredRequests && filteredRequests.length === 0 && (
                <p className="text-sm text-silver py-4 text-center">
                  No requests with this status.
                </p>
              )}
              <ul className="divide-y divide-navy-secondary">
                {(filteredRequests ?? []).map((r) => (
                  <li
                    key={r.id}
                    className="py-3 flex items-start gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-white font-medium">
                          {t(CATEGORY_KEYS[r.category])} · {fmtHours(r.requestedMinutes)}
                        </span>
                        <StatusBadge status={r.status} />
                      </div>
                      <div className="text-xs text-silver mt-0.5">
                        {fmtYmd(r.startDate)}
                        {r.startDate !== r.endDate && ` – ${fmtYmd(r.endDate)}`}
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

      <CreateRequestDialog
        open={openCreate}
        onOpenChange={setOpenCreate}
        balances={balances}
        requests={requests}
        onCreated={() => {
          setOpenCreate(false);
          refresh();
        }}
      />
    </div>
  );
}

function BalanceGrid({ balances }: { balances: TimeOffBalance[] | null }) {
  const { t } = useI18n();
  if (!balances) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (balances.length === 0) {
    return (
      <Card>
        <CardContent className="py-6">
          <EmptyState
            icon={Wallet}
            title={t('timeoff.noBalance')}
            description={t('timeoff.noBalanceDesc')}
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {balances.map((b) => (
        <Card key={b.category}>
          <CardContent className="py-4">
            <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
              {t(CATEGORY_KEYS[b.category])}
            </div>
            <div className="text-2xl text-white font-display mt-1 tabular-nums">
              {fmtHours(b.balanceMinutes)}
            </div>
            <div className="text-xs text-silver/70 mt-0.5">{t('timeoff.available')}</div>
          </CardContent>
        </Card>
      ))}
    </div>
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
  onCreated: () => void;
}

function CreateRequestDialog({
  open,
  onOpenChange,
  balances,
  requests,
  onCreated,
}: CreateProps) {
  const { t } = useI18n();
  const [category, setCategory] = useState<Category>('VACATION');
  const [startDate, setStartDate] = useState(ymdLocal());
  const [endDate, setEndDate] = useState(ymdLocal());
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
  const [holidayDates, setHolidayDates] = useState<ReadonlySet<string> | null>(
    null,
  );

  const reset = () => {
    setCategory('VACATION');
    setStartDate(ymdLocal());
    setEndDate(ymdLocal());
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
  // straddle New Year). Only the years matter for the fetch key.
  const startYear = startDate.slice(0, 4);
  const endYear = endDate.slice(0, 4);
  useEffect(() => {
    if (!open) return;
    const sy = Number(startYear);
    const ey = Number(endYear);
    if (!Number.isFinite(sy) || !Number.isFinite(ey) || ey < sy || ey - sy > 2) {
      return;
    }
    let cancelled = false;
    const years: number[] = [];
    for (let y = sy; y <= ey; y++) years.push(y);
    Promise.all(years.map((y) => listHolidays({ year: y })))
      .then((responses) => {
        if (cancelled) return;
        setHolidayDates(
          new Set(
            responses.flatMap((r) => r.holidays.map((h) => h.date.slice(0, 10))),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setHolidayDates(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, startYear, endYear]);

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

  // Auto-compute hours from the effective day count and the chosen
  // full-day/half-day preset until the associate types their own number.
  useEffect(() => {
    if (!open || hoursTouched) return;
    if (dayInfo.effective > 0) {
      setHours(String(dayInfo.effective * (preset === 'FULL' ? 8 : 4)));
    }
  }, [open, hoursTouched, dayInfo.effective, preset]);

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
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const pickPreset = (p: 'FULL' | 'HALF') => {
    setPreset(p);
    setHoursTouched(false);
    if (dayInfo.effective > 0) {
      setHours(String(dayInfo.effective * (p === 'FULL' ? 8 : 4)));
    }
  };

  // Dirty = any field differs from its initial value (the state persists
  // across opens until a successful submit resets it).
  const isDirty = () =>
    category !== 'VACATION' ||
    startDate !== ymdLocal() ||
    endDate !== ymdLocal() ||
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
                onChange={(e) => setCategory(e.target.value as Category)}
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

          {/* Stack the date pair on phones — two native date inputs
              side-by-side don't fit inside the 360px bottom sheet. */}
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

          {dayInfo.weekdays > 0 && (
            <p className="text-xs text-silver tabular-nums">
              {dayInfo.holidays > 0
                ? `${dayInfo.weekdays} weekday${dayInfo.weekdays === 1 ? '' : 's'} − ${dayInfo.holidays} holiday${dayInfo.holidays === 1 ? '' : 's'} = ${dayInfo.effective} day${dayInfo.effective === 1 ? '' : 's'}`
                : `${dayInfo.weekdays} weekday${dayInfo.weekdays === 1 ? '' : 's'}`}
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="xs"
              variant={!hoursTouched && preset === 'FULL' ? 'secondary' : 'ghost'}
              disabled={dayInfo.effective <= 0}
              onClick={() => pickPreset('FULL')}
            >
              Full days ({dayInfo.effective * 8}h)
            </Button>
            <Button
              type="button"
              size="xs"
              variant={!hoursTouched && preset === 'HALF' ? 'secondary' : 'ghost'}
              disabled={dayInfo.effective <= 0}
              onClick={() => pickPreset('HALF')}
            >
              Half days ({dayInfo.effective * 4}h)
            </Button>
          </div>

          <Field
            label={t('timeoff.totalHours')}
            required
            hint={t('timeoff.totalHoursHint')}
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
              {fmtHours(balance.balanceMinutes)} balance
              {pendingMinutes > 0 && ` − ${fmtHours(pendingMinutes)} pending`}
              {` − ${fmtHours(requestedMinutes)} this request = `}
              {afterMinutes < 0
                ? `${fmtHours(-afterMinutes)} over`
                : `${fmtHours(afterMinutes)} left`}
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
