import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CalendarDays } from 'lucide-react';
import { toast } from 'sonner';
import { becauseSentence, type AssociatePaySchedule } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDayShort, parseYmd, ymdLocal } from '@/lib/format';
import {
  getAssociatePaySchedule,
  getPayScheduleCalendarForFlow,
  listPayScheduleChoices,
  listPaySchedulesForFlow,
  PAY_SCHEDULES_FLOW_KEY,
  setAssociatePaySchedule,
} from '@/lib/payScheduleFlowApi';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * Which pay schedule one person is on — the schedule, its pattern, since
 * when and why, a move already booked, and the next payday — with a
 * "Change" for whoever runs payroll (and, for a hire, onboarding).
 *
 *  - `hire` (onboarding approve): what the rules will put the hire on, or an
 *    amber "No pay schedule covers this hire — choose one". A change is an
 *    individual rule from the server's default date; it never blocks approval.
 *  - `record` (the person's employment tab): a row with an effective-date
 *    picker that defaults to the chosen schedule's next period start, so a
 *    move never splits a period already under way.
 *
 * Contract: GET/PUT /associates/:id/pay-schedule (packages/shared/src/paySchedules.ts).
 *
 * The onboarding desk (manage:onboarding without view:payroll — the
 * recruiter) changes it on the application, and on the record of someone
 * still a new hire (the API's `newHire`, lib/hirePay). It cannot read the
 * payroll schedule list, so its picker reads the person's own choices
 * (GET /associates/:id/pay-schedule/choices) and names schedules without
 * linking into payroll.
 */
export function PayScheduleAssignment({
  associateId,
  variant,
  className,
}: {
  associateId: string;
  variant: 'hire' | 'record';
  className?: string;
}) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const key = ['associatePaySchedule', associateId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => getAssociatePaySchedule(associateId),
    retry: false,
  });
  const [editing, setEditing] = useState(false);

  const save = useMutation({
    mutationFn: (body: { scheduleId: string; effectiveFrom?: string }) => setAssociatePaySchedule(associateId, body),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      void queryClient.invalidateQueries({ queryKey: PAY_SCHEDULES_FLOW_KEY });
      setEditing(false);
      toast.success(next.pending ? `Moves to ${next.pending.name ?? 'the new schedule'} on ${fmtYmd(next.pending.effectiveFrom)}` : 'Pay schedule saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change the pay schedule.'),
  });

  if (query.isPending) return <Skeleton className={cn('h-14 w-full', className)} />;
  if (query.error) {
    // No reach (403) or an API without pay schedules (404): say nothing.
    if (query.error instanceof ApiError && (query.error.status === 403 || query.error.status === 404)) return null;
    return <p className={cn('text-xs text-alert', className)}>Couldn't load the pay schedule.</p>;
  }
  const ps = query.data;
  // A hire's schedule is onboarding's call too — on the application, and on
  // the record while they are still a new hire; otherwise the record's is payroll's.
  const canChange = can('process:payroll') || (can('manage:onboarding') && (variant === 'hire' || ps.newHire === true));
  const readsPayroll = can('view:payroll');
  const uncovered = !ps.current && !ps.pending?.scheduleId && !ps.ruleDefault;

  const form = editing || (uncovered && canChange) ? (
    <ChangeForm
      associateId={associateId}
      variant={variant}
      currentId={ps.current?.scheduleId ?? ps.pending?.scheduleId ?? ps.ruleDefault?.scheduleId ?? null}
      saving={save.isPending}
      onCancel={uncovered ? null : () => setEditing(false)}
      onSave={(body) => save.mutate(body)}
    />
  ) : null;

  return (
    <section aria-label="Pay schedule" className={cn('space-y-2', className)}>
      {uncovered ? (
        <div role="status" className="rounded-md border border-warning/40 bg-warning/[0.07] px-3 py-2.5 text-sm">
          <div className="flex items-center gap-2 font-medium text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {variant === 'hire' ? 'No pay schedule covers this hire — choose one' : 'No pay schedule covers this person — choose one'}
          </div>
          <p className="mt-1 text-xs text-silver">
            {canChange
              ? 'Until one does, no payroll run pays them.'
              : 'Until one does, no payroll run pays them. Payroll or HR can choose it.'}
            {readsPayroll && (
              <>
                {' '}
                <Link to="/payroll/schedules" className="text-gold hover:underline">
                  Pay schedules
                </Link>
              </>
            )}
          </p>
        </div>
      ) : (
        <Summary associateId={associateId} ps={ps} variant={variant} canChange={canChange && !editing} onChange={() => setEditing(true)} />
      )}
      {form}
    </section>
  );
}

function fmtYmd(ymd: string | null | undefined): string {
  const d = ymd ? parseYmd(ymd) : null;
  return d ? fmtDate(d) : '—';
}

function fmtPayday(ymd: string | null | undefined): string {
  const d = ymd ? parseYmd(ymd) : null;
  return d ? fmtDayShort(d, { year: true, anchored: true }) : '—';
}

const lowerFirst = (t: string) => (t ? t[0]!.toLowerCase() + t.slice(1) : t);

/** What a picker reads of a schedule; the payroll list carries more, the person's choices exactly this. */
interface ScheduleOption {
  id: string;
  name: string;
  pattern: string;
  isActive: boolean;
  nextPeriod: { periodStart: string; payDate: string };
  /** The first period start from today (the choices carry it; the payroll list asks the calendar). */
  firstStart?: string;
}

/**
 * The schedules to choose from: the payroll list for whoever reads payroll,
 * the person's own choices for the onboarding desk (which cannot).
 */
function useScheduleOptions(associateId: string): { isPending: boolean; schedules: ScheduleOption[]; readsPayroll: boolean } {
  const { can } = useAuth();
  const readsPayroll = can('view:payroll');
  const payroll = useQuery({ queryKey: PAY_SCHEDULES_FLOW_KEY, queryFn: listPaySchedulesForFlow, enabled: readsPayroll, retry: false, staleTime: 60_000 });
  const choices = useQuery({
    queryKey: ['payScheduleFlow', 'choices', associateId],
    queryFn: () => listPayScheduleChoices(associateId),
    enabled: !readsPayroll,
    retry: false,
    staleTime: 60_000,
  });
  const q = readsPayroll ? payroll : choices;
  return { isPending: q.isPending, schedules: (q.data?.schedules ?? []) as ScheduleOption[], readsPayroll };
}

function Summary({
  associateId,
  ps,
  variant,
  canChange,
  onChange,
}: {
  associateId: string;
  ps: AssociatePaySchedule;
  variant: 'hire' | 'record';
  canChange: boolean;
  onChange: () => void;
}) {
  const options = useScheduleOptions(associateId);
  const patternOf = (id: string | null | undefined) => (id ? options.schedules.find((s) => s.id === id)?.pattern ?? null : null);

  // A hire not yet on a schedule shows what the rules will choose.
  const shown = ps.current
    ? { id: ps.current.scheduleId, name: ps.current.name, pattern: ps.current.pattern, because: ps.current.because, since: ps.current.since }
    : variant === 'hire' && ps.pending?.scheduleId
      ? { id: ps.pending.scheduleId, name: ps.pending.name ?? 'A pay schedule', pattern: patternOf(ps.pending.scheduleId), because: ps.pending.because, since: ps.pending.effectiveFrom }
      : ps.ruleDefault
        ? { id: ps.ruleDefault.scheduleId, name: ps.ruleDefault.name, pattern: patternOf(ps.ruleDefault.scheduleId), because: ps.ruleDefault.because, since: null }
        : null;
  const pendingMove = ps.pending && (variant === 'record' || ps.current) ? ps.pending : null;

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-1.5 text-2xs uppercase tracking-widest text-silver/80">
          <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
          Pay schedule
        </div>
        {shown ? (
          <>
            <div className="text-sm text-ink">
              {options.readsPayroll ? (
                <Link to={`/payroll/schedules/${shown.id}`} className="font-medium hover:text-gold hover:underline">
                  {shown.name}
                </Link>
              ) : (
                <span className="font-medium">{shown.name}</span>
              )}
              {shown.pattern ? <span className="text-silver"> · {shown.pattern}</span> : null}
            </div>
            <p className="text-xs text-silver">
              {shown.since ? `Since ${fmtYmd(shown.since)} · ` : variant === 'hire' && !ps.current ? 'Will be on it from the hire date · ' : ''}
              {becauseSentence(shown.because)}
            </p>
          </>
        ) : (
          <p className="text-sm text-silver">Not on a pay schedule now.</p>
        )}
        {pendingMove && (
          <p className="flex items-start gap-1.5 text-xs text-gold">
            <CalendarClock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {pendingMove.scheduleId
                ? `Moves to ${pendingMove.name ?? 'another schedule'} on ${fmtYmd(pendingMove.effectiveFrom)}`
                : `Leaves this schedule on ${fmtYmd(pendingMove.effectiveFrom)}`}
              {pendingMove.because ? ` — ${lowerFirst(becauseSentence(pendingMove.because))}` : ''}
            </span>
          </p>
        )}
        {ps.nextPayDate && (
          <p className="text-xs text-silver">
            {variant === 'hire' && !ps.current ? 'First payday' : 'Next payday'}{' '}
            <span className="tabular-nums text-ink">{fmtPayday(ps.nextPayDate)}</span>
          </p>
        )}
      </div>
      {canChange && (
        <Button type="button" size="sm" variant="secondary" onClick={onChange}>
          Change
        </Button>
      )}
    </div>
  );
}

function ChangeForm({
  associateId,
  variant,
  currentId,
  saving,
  onCancel,
  onSave,
}: {
  associateId: string;
  variant: 'hire' | 'record';
  currentId: string | null;
  saving: boolean;
  onCancel: (() => void) | null;
  onSave: (body: { scheduleId: string; effectiveFrom?: string }) => void;
}) {
  const schedules = useScheduleOptions(associateId);
  const active = useMemo(() => schedules.schedules.filter((s) => s.isActive), [schedules.schedules]);
  const [scheduleId, setScheduleId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const chosen = active.find((s) => s.id === scheduleId) ?? null;
  // The first period that starts today or later: a schedule's "next"
  // period can be the one already under way.
  const calendar = useQuery({
    queryKey: ['payScheduleFlow', 'calendar', scheduleId],
    queryFn: () => getPayScheduleCalendarForFlow(scheduleId, 3),
    // The calendar is payroll's to read; the onboarding desk's choices carry the first start.
    enabled: variant === 'record' && !!scheduleId && schedules.readsPayroll,
    retry: false,
    staleTime: 60_000,
  });
  const today = ymdLocal();
  const nextStart =
    calendar.data?.periods.find((p) => p.periodStart >= today)?.periodStart ??
    chosen?.firstStart ??
    (chosen && chosen.nextPeriod.periodStart >= today ? chosen.nextPeriod.periodStart : null);

  // The effective date follows the chosen schedule's next period start
  // until someone picks another date.
  const [dateTouched, setDateTouched] = useState(false);
  useEffect(() => {
    if (!dateTouched) setEffectiveFrom(nextStart ?? today);
  }, [nextStart, dateTouched, today]);

  const unchanged = !!scheduleId && scheduleId === currentId;
  const canSave = !!scheduleId && !unchanged && (variant === 'hire' || (!!effectiveFrom && effectiveFrom >= today)) && !saving;

  return (
    // A group, not a <form>: onboarding renders this inside the approve form.
    <div role="group" aria-label="Change pay schedule" className="space-y-3 rounded-md border border-navy-secondary bg-navy-secondary/20 p-3">
      <div className={cn('grid gap-3 [&>*]:min-w-0', variant === 'record' && 'sm:grid-cols-2')}>
        <Field
          label="Pay schedule"
          hint={unchanged ? 'Already on this schedule.' : chosen ? `${chosen.pattern} · next payday ${fmtPayday(chosen.nextPeriod.payDate)}` : undefined}
        >
          {(p) => (
            <Select
              value={scheduleId}
              onChange={(e) => setScheduleId(e.target.value)}
              disabled={schedules.isPending}
              {...p}
            >
              <option value="">{schedules.isPending ? 'Loading schedules…' : active.length ? 'Choose a schedule…' : 'No active schedules'}</option>
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {variant === 'record' && (
          <Field
            label="Effective from"
            hint={nextStart && effectiveFrom === nextStart ? 'The start of its next pay period' : effectiveFrom && effectiveFrom < today ? 'A change starts today or later.' : 'Days before stay on the current schedule.'}
          >
            {(p) => (
              <Input
                type="date"
                min={today}
                value={effectiveFrom}
                onChange={(e) => {
                  setDateTouched(true);
                  setEffectiveFrom(e.target.value);
                }}
                {...p}
              />
            )}
          </Field>
        )}
      </div>
      {!schedules.isPending && active.length === 0 && (
        <p className="text-xs text-silver">
          {schedules.readsPayroll ? (
            <>
              <Link to="/payroll/schedules" className="text-gold hover:underline">
                Set up a pay schedule
              </Link>{' '}
              first.
            </>
          ) : (
            'Payroll sets up pay schedules; ask them for one.'
          )}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          loading={saving}
          disabled={!canSave}
          onClick={() => canSave && onSave(variant === 'record' ? { scheduleId, effectiveFrom } : { scheduleId })}
        >
          {variant === 'hire' ? 'Use this schedule' : 'Save change'}
        </Button>
      </div>
    </div>
  );
}
