import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, Download, FileText, Settings2, Stethoscope, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  cancelLeave,
  closeLeave,
  decideLeave,
  getEligibility,
  getLeaveCase,
  getLeaveSummary,
  leaveDocumentUrl,
  leaveNoticeUrl,
  listLeaveCases,
  listLeavePrograms,
  logLeaveUsage,
  openLeaveCase,
  recordReturn,
  sendLeaveNotice,
  uploadLeaveDocument,
  type FmlaBalance,
  type LeaveCase,
  type LeaveDocumentKind,
  type LeaveReason,
  type LeaveSchedule,
  type LeaveType,
} from '@/lib/leaveApi';
import { apiFetch } from '@/lib/api';
import { DeskTemplate } from '@/components/templates';
import { useUrlParam } from '@/lib/useUrlState';
import {
  AssociatePicker,
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  MetricCard,
  MetricStrip,
  SearchInput,
  SectionTitle,
  SegmentedControl,
  Select,
  SkeletonRows,
  Textarea,
  type PickedAssociate,
} from '@/components/ui';
import { ProgressBar } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { MyLeave } from './MyLeave';
import { DOC_LABEL, REASONS_BY_TYPE, REASON_LABEL, SCHEDULE_LABEL, STATUS_META, TYPE_LABEL, YEAR_METHOD_LABEL } from './leaveWords';
import { enumWords, known } from '@/lib/known';

/** STATUS_META for a value from the server — one this screen doesn't know yet reads as words (lib/known). */
const statusMetaOf = (k: string) => known(STATUS_META, k, () => ({ label: enumWords(k), variant: 'outline' as const }));

/**
 * Leave of absence — HR's desk (manage:leave), or the worker's own leave
 * for everyone else.
 *
 * The desk is a queue of cases ordered by what's overdue, beside the open
 * case: its next step with the one action that moves it, the FMLA
 * eligibility tests and the time left, the dated steps so far, the
 * documents (medical — read here only, every read audited) and the
 * notices. Approving continuous leave releases the person's shifts and
 * tells the leads; the person record shows the job-protection flag.
 */

/** The desk's lens: open or all cases, or one of the four tiles (the API's
 *  summary counts and list filter share each tile's definition). */
type Lens = 'open' | 'all' | 'on-leave' | 'notices' | 'certs-due' | 'returning';
const LENSES: readonly Lens[] = ['open', 'all', 'on-leave', 'notices', 'certs-due', 'returning'];
const LENS_LABEL: Record<Lens, string> = {
  open: 'Open cases',
  all: 'All cases',
  'on-leave': 'On leave today',
  notices: 'Notices to send',
  'certs-due': 'Certifications due',
  returning: 'Returning',
};

export function LeaveHome() {
  const { can } = useAuth();
  if (!can('manage:leave')) return <MyLeave />;
  return <LeaveDesk />;
}

function LeaveDesk() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const openId = params.get('case');
  // The lens is in ?status= so a notification can open "Notices to send".
  const [status, setStatus] = useUrlParam<Lens>('status', 'open', LENSES);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [opening, setOpening] = useState(false);
  const [settings, setSettings] = useState(false);

  const summary = useQuery({ queryKey: ['leave', 'summary'], queryFn: getLeaveSummary });
  const list = useQuery({ queryKey: ['leave', 'cases', status, type, q], queryFn: () => listLeaveCases({ status, type, q: q.trim() || undefined }) });
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('case', id);
    else next.delete('case');
    setParams(next, { replace: false });
  };
  const refresh = () => void qc.invalidateQueries({ queryKey: ['leave'] });

  const s = summary.data;
  // A tile is the filter (F500 G2: tiles and a chip row said the same
  // things); tapping the picked tile again goes back to every open case.
  const tile = (lens: Lens) => ({
    onClick: () => setStatus(status === lens ? 'open' : lens),
    selected: status === lens,
  });
  // On a phone with an item open, the item takes the screen: the counts and filters step aside.
  const filters = (
    <div className={cn('space-y-3', openId && 'hidden lg:block')}>
      <MetricStrip label="Leave cases by next step">
        <MetricCard label="On leave today" value={s?.onLeave ?? '—'} hint={s ? `${s.open} open cases` : undefined} {...tile('on-leave')} />
        <MetricCard
          label="Notices to send"
          value={s?.noticesOwed ?? '—'}
          hint="Due within 5 business days of a request"
          tone={s && s.noticesOwed > 0 ? 'warning' : 'default'}
          {...tile('notices')}
        />
        <MetricCard label="Certifications due" value={s?.certificationsDueThisWeek ?? '—'} hint="In the next 7 days" {...tile('certs-due')} />
        <MetricCard label="Returning" value={s?.returningThisWeek ?? '—'} hint="Expected back within 7 days" {...tile('returning')} />
      </MetricStrip>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter cases">
        <SegmentedControl<Lens>
          ariaLabel="Which cases"
          value={status === 'all' ? 'all' : 'open'}
          onChange={setStatus}
          options={[
            { value: 'open', label: status !== 'open' && status !== 'all' ? LENS_LABEL[status] : 'Open' },
            { value: 'all', label: 'All' },
          ]}
        />
        <label htmlFor="leave-type" className="sr-only">
          Leave type
        </label>
        <Select id="leave-type" size="sm" value={type} onChange={(e) => setType(e.target.value)} className="w-auto">
          <option value="">Every type</option>
          {(Object.keys(TYPE_LABEL) as LeaveType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        <div className="min-w-[12rem] flex-1 sm:max-w-xs">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" aria-label="Find a person" />
        </div>
      </div>
    </div>
  );

  const cases = list.data?.cases ?? null;
  // On a wide screen the most urgent case opens beside the queue instead of
  // "Pick a case" (F500 G2); a phone keeps the list until a tap.
  const firstId = cases?.[0]?.id ?? null;
  useEffect(() => {
    if (openId || !firstId) return;
    if (typeof window === 'undefined' || !window.matchMedia?.('(min-width: 1024px)').matches) return;
    const next = new URLSearchParams(params);
    next.set('case', firstId);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId, openId]);
  const queue = list.isError ? (
    <QueryError what="leave cases" query={list} />
  ) : cases === null ? (
    <SkeletonRows count={6} />
  ) : cases.length === 0 ? (
    <EmptyState
      icon={Stethoscope}
      title={status === 'open' ? 'No open leave' : status === 'all' ? 'No cases match' : `Nothing under “${LENS_LABEL[status]}”`}
      description={status === 'open' ? 'When someone asks for leave — from their phone or through you — the case lands here with its next step.' : 'Try another filter.'}
      action={status === 'open' ? <Button onClick={() => setOpening(true)}>Open a case</Button> : undefined}
      className="py-8"
    />
  ) : (
    <Card>
      <CardContent className="p-0 first:pt-0">
        <ul className="divide-y divide-line" aria-label="Leave cases">
          {cases.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setOpen(c.id)}
                aria-current={openId === c.id ? 'true' : undefined}
                className={cn('flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-surface-raised coarse:min-h-14', openId === c.id && 'bg-surface-raised')}
              >
                <Avatar name={c.associateName} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{c.associateName}</span>
                    <Badge size="sm" variant={statusMetaOf(c.status).variant}>
                      {statusMetaOf(c.status).label}
                    </Badge>
                  </span>
                  <span className="block truncate text-xs text-ink-muted">
                    {c.stateProgramName ?? TYPE_LABEL[c.type]} · {SCHEDULE_LABEL[c.schedule].toLowerCase()} · from {fmtDate(c.startDate)}
                  </span>
                  {c.next && (
                    <span className={cn('mt-0.5 block text-xs', c.next.overdue ? 'font-medium text-alert' : 'text-ink-muted')}>
                      {c.next.overdue ? 'Overdue: ' : ''}
                      {c.next.label}
                      {c.next.dueAt ? ` · by ${fmtDate(c.next.dueAt)}` : ''}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {list.data && list.data.total > cases.length && (
          <p className="border-t border-line px-3 py-2 text-xs text-ink-muted">
            Showing {cases.length} of {list.data.total}. Narrow the filter to see the rest.
          </p>
        )}
      </CardContent>
    </Card>
  );

  const item = openId ? (
    <CaseView id={openId} onBack={() => setOpen(null)} onChanged={refresh} />
  ) : (
    <Card>
      <CardContent className="p-0 first:pt-0">
        <EmptyState icon={FileText} title="Pick a case" description="The case opens here with its next step, eligibility, FMLA time left, documents and notices." className="py-10" />
      </CardContent>
    </Card>
  );

  return (
    <>
      <DeskTemplate
        title="Leave of absence"
        subtitle="FMLA, state paid leave, military and accommodation leave — from the request to the return to work."
        actions={[
          { key: 'open', label: 'Open a case', primary: true, onSelect: () => setOpening(true) },
          { key: 'settings', label: 'Settings', icon: Settings2, onSelect: () => setSettings(true) },
        ]}
        filters={filters}
        queue={queue}
        item={item}
        itemOpen={!!openId}
      />
      {opening && (
        <OpenCaseDialog
          onClose={() => setOpening(false)}
          onOpened={(id) => {
            setOpening(false);
            refresh();
            setOpen(id);
          }}
        />
      )}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </>
  );
}

/* ----- The open case ------------------------------------------------------ */

function CaseView({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const q = useQuery({ queryKey: ['leave', 'case', id], queryFn: () => getLeaveCase(id) });
  const [deciding, setDeciding] = useState(false);
  const [returning, setReturning] = useState(false);
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => onChanged(),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'That didn’t go through. Try again.'),
  });
  if (q.isError) return <QueryError what="this case" query={q} />;
  if (!q.data) return <SkeletonRows count={8} />;
  const c = q.data.case;
  const balance = q.data.balance;

  const primary = (() => {
    switch (c.next?.key) {
      case 'notice':
        return (
          <Button loading={act.isPending} onClick={() => act.mutate(async () => { await sendLeaveNotice(c.id); toast.success(c.certificationRequired ? 'Notice sent. The 15-day certification clock has started.' : 'Notice sent.'); })}>
            Send the eligibility notice
          </Button>
        );
      case 'certification':
      case 'decide':
        return <Button onClick={() => setDeciding(true)}>Decide</Button>;
      case 'fitness':
      case 'return':
        return <Button onClick={() => setReturning(true)}>Record the return</Button>;
      case 'close':
        return (
          <Button variant="secondary" loading={act.isPending} onClick={() => act.mutate(async () => { await closeLeave(c.id); toast.success('Case closed.'); })}>
            Close the case
          </Button>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="lg:hidden" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All cases
      </Button>
      <Card>
        <CardContent className="space-y-4 p-4 md:p-5">
          <div className="flex flex-wrap items-start gap-3">
            <Avatar name={c.associateName} size="md" />
            <div className="min-w-0 flex-1">
              <SectionTitle className="mb-0" title={<Link to={`/people/${c.associateId}`} className="hover:underline">{c.associateName}</Link>} />
              <p className="text-sm text-ink-muted">
                {c.stateProgramName ?? TYPE_LABEL[c.type]} · {REASON_LABEL[c.reason].toLowerCase()} · {SCHEDULE_LABEL[c.schedule].toLowerCase()}
              </p>
              <p className="text-sm text-ink-muted">
                {fmtDate(c.startDate)} – {c.endDate ? fmtDate(c.endDate) : 'end date open'}
                {c.intermittentPattern ? ` · ${c.intermittentPattern}` : ''}
                {c.reducedHoursPerWeek ? ` · ${c.reducedHoursPerWeek} h a week` : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={statusMetaOf(c.status).variant}>{statusMetaOf(c.status).label}</Badge>
              {c.jobProtected && <Badge variant="info">Job protected</Badge>}
              {c.requestedBySelf && <Badge variant="outline">Asked from their phone</Badge>}
            </div>
          </div>

          {c.next && (
            <div className={cn('flex flex-wrap items-center gap-3 rounded-lg border p-3', c.next.overdue ? 'border-alert/50 bg-alert/5' : 'border-line bg-surface-raised')}>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">Next step</div>
                <div className="text-sm font-medium text-ink">
                  {c.next.label}
                  {c.next.dueAt && <span className={cn('font-normal', c.next.overdue ? 'text-alert' : 'text-ink-muted')}> · {c.next.overdue ? 'was due' : 'by'} {fmtDate(c.next.dueAt)}</span>}
                </div>
              </div>
              {primary}
            </div>
          )}

          {(c.status === 'REQUESTED' || c.status === 'PENDING_CERTIFICATION') && (
            <div className="flex flex-wrap gap-2">
              {c.next?.key !== 'certification' && c.next?.key !== 'decide' && (
                <Button size="sm" variant="secondary" onClick={() => setDeciding(true)}>
                  Decide now
                </Button>
              )}
              <Button size="sm" variant="ghost" loading={act.isPending} onClick={() => act.mutate(async () => { await cancelLeave(c.id); toast.success('Request cancelled.'); })}>
                Cancel the request
              </Button>
            </div>
          )}
          {c.shiftsReleased > 0 && (
            <p className="text-sm text-ink-muted">
              {c.shiftsReleased} assigned shift{c.shiftsReleased === 1 ? ' was' : 's were'} released to open when the leave was approved; the leads were told.
            </p>
          )}
        </CardContent>
      </Card>

      {c.type === 'FMLA' && c.eligibility && !c.eligibility.eligible && c.designatedFmla && (
        <p role="note" className="rounded-lg border border-warning/50 bg-warning/5 p-3 text-sm text-ink">
          Designated as FMLA leave although the eligibility check says they don’t qualify. Check the facts, or treat it as company leave.
        </p>
      )}
      {c.type === 'FMLA' && c.eligibility && <EligibilityCard e={c.eligibility} />}
      {balance && <BalanceCard b={balance} />}

      <Timeline c={c} />

      {c.schedule !== 'CONTINUOUS' && c.status === 'APPROVED' && <UsageCard c={c} onChanged={onChanged} />}

      <DocumentsCard c={c} onChanged={onChanged} />

      <Card>
        <CardContent className="space-y-2 p-4 md:p-5">
          <h3 className="text-sm font-semibold text-ink">Notices</h3>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="secondary">
              <a href={leaveNoticeUrl(c.id, 'eligibility')} target="_blank" rel="noreferrer">
                <Download className="h-4 w-4" aria-hidden="true" />
                Eligibility & rights (WH-381)
              </a>
            </Button>
            {c.designationSentAt ? (
              <Button asChild size="sm" variant="secondary">
                <a href={leaveNoticeUrl(c.id, 'designation')} target="_blank" rel="noreferrer">
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Designation (WH-382)
                </a>
              </Button>
            ) : (
              <span className="self-center text-xs text-ink-muted">The designation notice is ready once the leave is decided.</span>
            )}
          </div>
          {c.decisionNote && <p className="text-sm text-ink-muted">Decision note: {c.decisionNote}</p>}
          {c.benefitsNote && <p className="text-sm text-ink-muted">Benefits: {c.benefitsNote}</p>}
          {c.notes && <p className="whitespace-pre-line text-sm text-ink-muted">{c.notes}</p>}
        </CardContent>
      </Card>

      {deciding && <DecideDialog c={c} onClose={() => setDeciding(false)} onDone={() => { setDeciding(false); onChanged(); }} />}
      {returning && <ReturnDialog c={c} onClose={() => setReturning(false)} onDone={() => { setReturning(false); onChanged(); }} />}
    </div>
  );
}

function Check1({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" /> : <X className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-hidden="true" />}
      <span className="text-ink">
        <span className="sr-only">{ok ? 'Meets: ' : 'Does not meet: '}</span>
        {children}
      </span>
    </li>
  );
}

function EligibilityCard({ e }: { e: NonNullable<LeaveCase['eligibility']> }) {
  return (
    <Card>
      <CardContent className="space-y-2 p-4 md:p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">FMLA eligibility</h3>
          <Badge variant={e.eligible ? 'success' : 'destructive'}>{e.eligible ? 'Eligible' : 'Not eligible'}</Badge>
        </div>
        <ul className="space-y-1">
          <Check1 ok={e.monthsOfService >= 12}>{e.monthsOfService} months with the employer (12 needed)</Check1>
          <Check1 ok={e.hoursLast12Months >= 1250}>{e.hoursLast12Months.toLocaleString()} hours worked in the last 12 months (1,250 needed)</Check1>
          <Check1 ok={e.worksiteMeets50In75}>50 employees within 75 miles of their worksite</Check1>
          <Check1 ok={e.coveredEmployer}>The employer is FMLA-covered</Check1>
        </ul>
        <p className="text-xs text-ink-muted">Checked as of {fmtDate(e.asOf)}, from the time clock.</p>
      </CardContent>
    </Card>
  );
}

function BalanceCard({ b }: { b: FmlaBalance }) {
  const pct = b.entitlementHours ? (b.usedHours / b.entitlementHours) * 100 : 0;
  return (
    <Card>
      <CardContent className="space-y-2 p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">FMLA time</h3>
          <span className="text-sm tabular-nums text-ink">
            {b.remainingHours.toLocaleString()} hours left <span className="text-ink-muted">({b.remainingWeeks} weeks)</span>
          </span>
        </div>
        <ProgressBar percent={pct} label={`${Math.round(pct)}% of FMLA time used`} hideLabel />
        <p className="text-xs text-ink-muted">
          {b.usedHours.toLocaleString()} of {b.entitlementHours.toLocaleString()} hours used, at {b.weeklyHours} hours a week · counted {fmtDate(b.periodStart)} – {fmtDate(b.periodEnd)} ({YEAR_METHOD_LABEL[b.method].toLowerCase()}).
        </p>
      </CardContent>
    </Card>
  );
}

function Timeline({ c }: { c: LeaveCase }) {
  const steps: Array<{ label: string; at: string | null; note?: string }> = [
    { label: c.requestedBySelf ? 'Requested from their phone' : 'Case opened', at: c.createdAt },
    { label: 'Eligibility notice sent', at: c.noticeSentAt },
    ...(c.certificationRequired
      ? [{ label: 'Certification received', at: c.certificationReceivedAt, note: !c.certificationReceivedAt && c.certificationDueAt ? `due ${fmtDate(c.certificationDueAt)}` : undefined }]
      : []),
    { label: c.status === 'DENIED' ? 'Denied' : 'Approved and designated', at: c.decidedAt },
    ...(c.fitnessForDutyRequired ? [{ label: 'Fitness for duty received', at: c.fitnessForDutyReceivedAt }] : []),
    { label: 'Back at work', at: c.actualReturnDate, note: !c.actualReturnDate && c.expectedReturnDate ? `expected ${fmtDate(c.expectedReturnDate)}` : undefined },
  ];
  return (
    <Card>
      <CardContent className="p-4 md:p-5">
        <h3 className="mb-3 text-sm font-semibold text-ink">Steps</h3>
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              <span className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border', s.at ? 'border-success bg-success/10 text-success' : 'border-line text-ink-muted')} aria-hidden="true">
                {s.at ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={s.at ? 'text-ink' : 'text-ink-muted'}>{s.label}</span>
                <span className="text-ink-muted">{s.at ? ` · ${fmtDate(s.at)}` : s.note ? ` · ${s.note}` : ' · not yet'}</span>
              </span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function UsageCard({ c, onChanged }: { c: LeaveCase; onChanged: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState('8');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => logLeaveUsage(c.id, { date, hours: Number(hours), note: note.trim() || null }),
    onSuccess: () => {
      toast.success('Leave time logged.');
      setNote('');
      onChanged();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not log the time.'),
  });
  return (
    <Card>
      <CardContent className="space-y-3 p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Time taken</h3>
          <span className="text-sm tabular-nums text-ink-muted">{c.usedHours} hours so far</span>
        </div>
        <form
          className="grid gap-3 sm:grid-cols-[9rem_6rem_minmax(0,1fr)_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <Field label="Date">{(p) => <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Hours">{(p) => <Input {...p} type="number" min={0.25} max={24} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} />}</Field>
          <Field label="Note">{(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />}</Field>
          <Button type="submit" loading={m.isPending} disabled={!Number(hours)}>
            Log time
          </Button>
        </form>
        {c.usage.length > 0 && (
          <ul className="divide-y divide-line text-sm">
            {c.usage.map((u) => (
              <li key={u.id} className="flex justify-between gap-3 py-1.5">
                <span className="text-ink">{fmtDate(u.date)}</span>
                <span className="min-w-0 flex-1 truncate text-ink-muted">{u.note}</span>
                <span className="tabular-nums text-ink">{u.hours} h</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DocumentsCard({ c, onChanged }: { c: LeaveCase; onChanged: () => void }) {
  const [kind, setKind] = useState<LeaveDocumentKind>(c.type === 'MILITARY_USERRA' ? 'MILITARY_ORDERS' : 'MEDICAL_CERTIFICATION');
  const input = useRef<HTMLInputElement>(null);
  const m = useMutation({
    mutationFn: (file: File) => uploadLeaveDocument(c.id, kind, file),
    onSuccess: () => {
      toast.success('Document added to the case.');
      onChanged();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not upload.'),
  });
  return (
    <Card>
      <CardContent className="space-y-3 p-4 md:p-5">
        <div>
          <h3 className="text-sm font-semibold text-ink">Documents</h3>
          <p className="text-xs text-ink-muted">Medical information: only leave admins can open these, and every opening is recorded.</p>
        </div>
        {c.documents.length === 0 ? (
          <p className="text-sm text-ink-muted">No documents on file — add one below.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {c.documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                <FileText className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{DOC_LABEL[d.kind]}</span>
                  <span className="block truncate text-xs text-ink-muted">
                    {d.filename} · {fmtDate(d.createdAt)}
                  </span>
                </span>
                <Button asChild size="sm" variant="ghost">
                  <a href={leaveDocumentUrl(d.id)}>Open</a>
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Add a document" className="min-w-[12rem] flex-1">
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as LeaveDocumentKind)}>
                {(Object.keys(DOC_LABEL) as LeaveDocumentKind[]).map((k) => (
                  <option key={k} value={k}>
                    {DOC_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <input
            ref={input}
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            className="sr-only"
            aria-label="Choose a file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) m.mutate(f);
              e.target.value = '';
            }}
          />
          <Button variant="secondary" loading={m.isPending} onClick={() => input.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden="true" />
            Upload
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ----- Dialogs ------------------------------------------------------------- */

function DecideDialog({ c, onClose, onDone }: { c: LeaveCase; onClose: () => void; onDone: () => void }) {
  const [decision, setDecision] = useState<'APPROVE' | 'DENY'>('APPROVE');
  const eligible = c.eligibility?.eligible ?? true;
  const [designated, setDesignated] = useState(eligible);
  const [fitness, setFitness] = useState(c.reason === 'OWN_HEALTH' && c.schedule === 'CONTINUOUS');
  const [note, setNote] = useState('');
  const [benefits, setBenefits] = useState(c.benefitsNote ?? '');
  const [back, setBack] = useState(c.expectedReturnDate ?? '');
  const m = useMutation({
    mutationFn: () =>
      decideLeave(c.id, {
        decision,
        designatedFmla: c.type === 'FMLA' ? designated : undefined,
        note: note.trim() || undefined,
        fitnessForDutyRequired: fitness,
        benefitsNote: benefits.trim() || undefined,
        expectedReturnDate: back || null,
      }),
    onSuccess: (r) => {
      toast.success(
        decision === 'APPROVE'
          ? r.case.shiftsReleased
            ? `Approved. ${r.case.shiftsReleased} shift${r.case.shiftsReleased === 1 ? '' : 's'} released to open, and the leads were told.`
            : 'Approved. The designation notice is ready.'
          : 'Denied. The designation notice explains why.',
      );
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not record the decision.'),
  });
  const certMissing = c.certificationRequired && !c.certificationReceivedAt;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Decide {c.associateName}’s leave</DialogTitle>
          <DialogDescription>
            The decision goes on the designation notice (WH-382 content).{' '}
            {decision === 'APPROVE' && c.schedule === 'CONTINUOUS' ? 'Approving releases their assigned shifts in the window and tells the leads.' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <SegmentedControl
            ariaLabel="Decision"
            value={decision}
            onChange={setDecision}
            options={[
              { value: 'APPROVE', label: 'Approve' },
              { value: 'DENY', label: 'Deny' },
            ]}
          />
          {certMissing && decision === 'APPROVE' && <p className="rounded-md bg-warning/10 p-2 text-sm text-ink">The certification hasn’t arrived. You can still approve provisionally.</p>}
          {decision === 'APPROVE' && c.type === 'FMLA' && !eligible && (
            <p className="rounded-md bg-warning/10 p-2 text-sm text-ink">They don’t meet FMLA’s tests ({c.eligibility?.reasons.join(' ')}). You can still approve the leave — as company leave, not FMLA-protected.</p>
          )}
          {decision === 'APPROVE' && c.type === 'FMLA' && (
            <label className="flex items-center gap-2 text-sm text-ink coarse:min-h-11">
              <input type="checkbox" className="h-4 w-4" checked={designated} onChange={(e) => setDesignated(e.target.checked)} />
              Designate as FMLA-protected leave
            </label>
          )}
          {decision === 'APPROVE' && (
            <>
              <label className="flex items-center gap-2 text-sm text-ink coarse:min-h-11">
                <input type="checkbox" className="h-4 w-4" checked={fitness} onChange={(e) => setFitness(e.target.checked)} />
                Ask for a fitness-for-duty certification before they return
              </label>
              <Field label="Expected back">{(p) => <Input {...p} type="date" value={back} onChange={(e) => setBack(e.target.value)} />}</Field>
              <Field label="Benefits while on leave" hint="Shown on the notice — e.g. how their premium share is paid.">
                {(p) => <Input {...p} value={benefits} maxLength={1000} onChange={(e) => setBenefits(e.target.value)} />}
              </Field>
            </>
          )}
          <Field label={decision === 'DENY' ? 'Why it is denied' : 'Note (optional)'} required={decision === 'DENY'}>
            {(p) => <Textarea {...p} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={decision === 'DENY' ? 'destructive' : 'primary'} loading={m.isPending} disabled={decision === 'DENY' && note.trim().length < 3} onClick={() => m.mutate()}>
            {decision === 'APPROVE' ? 'Approve' : 'Deny'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReturnDialog({ c, onClose, onDone }: { c: LeaveCase; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(c.expectedReturnDate ?? new Date().toISOString().slice(0, 10));
  const [override, setOverride] = useState('');
  const missing = c.fitnessForDutyRequired && !c.fitnessForDutyReceivedAt;
  const m = useMutation({
    mutationFn: () => recordReturn(c.id, { actualReturnDate: date, overrideReason: override.trim() || undefined }),
    onSuccess: () => {
      toast.success(`${c.associateName} is back at work.`);
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not record the return.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record {c.associateName}’s return</DialogTitle>
          <DialogDescription>{missing ? 'Their fitness-for-duty certification hasn’t arrived. Upload it on the case, or record why they may return without it.' : 'The case moves to “back at work”; close it when nothing is left.'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="First day back">{(p) => <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          {missing && (
            <Field label="Why they may return without it" required>
              {(p) => <Textarea {...p} rows={2} maxLength={500} value={override} onChange={(e) => setOverride(e.target.value)} />}
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} disabled={missing && override.trim().length < 3} onClick={() => m.mutate()}>
            Record the return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OpenCaseDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const [person, setPerson] = useState<PickedAssociate | null>(null);
  const [type, setType] = useState<LeaveType>('FMLA');
  const [reason, setReason] = useState<LeaveReason>('OWN_HEALTH');
  const [program, setProgram] = useState('');
  const [schedule, setSchedule] = useState<LeaveSchedule>('CONTINUOUS');
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState('');
  const [pattern, setPattern] = useState('');
  const [hours, setHours] = useState('');
  const [notes, setNotes] = useState('');
  const programs = useQuery({ queryKey: ['leave', 'programs'], queryFn: listLeavePrograms, staleTime: Infinity });
  const elig = useQuery({ queryKey: ['leave', 'eligibility', person?.id, start], queryFn: () => getEligibility(person!.id, start), enabled: !!person && type === 'FMLA' });
  useEffect(() => {
    if (!REASONS_BY_TYPE[type].includes(reason)) setReason(REASONS_BY_TYPE[type][0]!);
  }, [type, reason]);
  const m = useMutation({
    mutationFn: () =>
      openLeaveCase({
        associateId: person!.id,
        type,
        reason,
        stateProgram: type === 'STATE_PFML' ? program : null,
        schedule,
        startDate: start,
        endDate: end || null,
        intermittentPattern: schedule === 'INTERMITTENT' ? pattern.trim() || null : null,
        reducedHoursPerWeek: schedule === 'REDUCED' && hours ? Number(hours) : null,
        notes: notes.trim() || null,
      }),
    onSuccess: (r) => {
      toast.success('Case opened. Next: send the eligibility notice.');
      onOpened(r.case.id);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not open the case.'),
  });
  const valid = !!person && !!start && (type !== 'STATE_PFML' || !!program) && (!end || end >= start);
  const e = elig.data?.eligibility;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Open a leave case</DialogTitle>
          <DialogDescription>For a request someone made by phone, email or in person. People can also ask from their own phone.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who" className="sm:col-span-2">
            {(p) => <AssociatePicker id={p.id} value={person} onChange={setPerson} />}
          </Field>
          <Field label="Leave">
            {(p) => (
              <Select {...p} value={type} onChange={(ev) => setType(ev.target.value as LeaveType)}>
                {(Object.keys(TYPE_LABEL) as LeaveType[]).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="For">
            {(p) => (
              <Select {...p} value={reason} onChange={(ev) => setReason(ev.target.value as LeaveReason)}>
                {REASONS_BY_TYPE[type].map((r) => (
                  <option key={r} value={r}>
                    {REASON_LABEL[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {type === 'STATE_PFML' && (
            <Field label="State program" className="sm:col-span-2" hint="The state pays the benefit; you protect the job and keep the record.">
              {(p) => (
                <Select {...p} value={program} onChange={(ev) => setProgram(ev.target.value)}>
                  <option value="">Pick a program</option>
                  {programs.data?.programs.map((pr) => (
                    <option key={pr.code} value={pr.code}>
                      {pr.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <div className="sm:col-span-2">
            <div className="mb-1.5 text-sm text-ink">Schedule</div>
            <SegmentedControl
              ariaLabel="Schedule"
              value={schedule}
              onChange={setSchedule}
              options={(Object.keys(SCHEDULE_LABEL) as LeaveSchedule[]).map((k) => ({ value: k, label: SCHEDULE_LABEL[k] }))}
            />
          </div>
          <Field label="From">{(p) => <Input {...p} type="date" value={start} onChange={(ev) => setStart(ev.target.value)} />}</Field>
          <Field label="Until" hint="Leave blank if it isn’t known yet.">{(p) => <Input {...p} type="date" value={end} min={start} onChange={(ev) => setEnd(ev.target.value)} />}</Field>
          {schedule === 'INTERMITTENT' && (
            <Field label="Expected pattern" className="sm:col-span-2" hint="e.g. Up to 2 days a month for flare-ups">
              {(p) => <Input {...p} value={pattern} maxLength={300} onChange={(ev) => setPattern(ev.target.value)} />}
            </Field>
          )}
          {schedule === 'REDUCED' && (
            <Field label="Hours a week while reduced">{(p) => <Input {...p} type="number" min={0} max={80} value={hours} onChange={(ev) => setHours(ev.target.value)} />}</Field>
          )}
          <Field label="Note" className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={2} maxLength={4000} value={notes} onChange={(ev) => setNotes(ev.target.value)} />}
          </Field>
        </div>
        {type === 'FMLA' && person && (
          <div className="rounded-lg border border-line bg-surface-raised p-3 text-sm" aria-live="polite">
            {elig.isLoading ? (
              <span className="text-ink-muted">Checking FMLA eligibility…</span>
            ) : e ? (
              <>
                <span className={cn('font-medium', e.eligible ? 'text-success' : 'text-alert')}>{e.eligible ? 'Eligible for FMLA' : 'Not eligible for FMLA'}</span>
                <span className="text-ink-muted">
                  {' '}
                  · {e.monthsOfService} months · {e.hoursLast12Months.toLocaleString()} hours in 12 months
                  {elig.data?.balance ? ` · ${elig.data.balance.remainingWeeks} weeks left` : ''}
                </span>
                {!e.eligible && <span className="mt-1 block text-ink-muted">{e.reasons.join(' ')} You can still open the case as another kind of leave.</span>}
              </>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} disabled={!valid} onClick={() => m.mutate()}>
            Open the case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface LeaveSettingsView {
  fmlaYearMethod: keyof typeof YEAR_METHOD_LABEL;
  fmlaFixedYearStart: string | null;
  fmlaCoveredEmployer: boolean;
  worksiteAttestation: Record<string, boolean>;
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['leave', 'settings'], queryFn: () => apiFetch<LeaveSettingsView>('/leave/settings') });
  const [form, setForm] = useState<LeaveSettingsView | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);
  const m = useMutation({
    mutationFn: () =>
      apiFetch('/leave/settings', {
        method: 'PUT',
        body: { fmlaYearMethod: form!.fmlaYearMethod, fmlaFixedYearStart: form!.fmlaYearMethod === 'FIXED' ? form!.fmlaFixedYearStart : null, fmlaCoveredEmployer: form!.fmlaCoveredEmployer, worksiteAttestation: form!.worksiteAttestation },
      }),
    onSuccess: () => {
      toast.success('Leave settings saved.');
      void qc.invalidateQueries({ queryKey: ['leave'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const methods = useMemo(() => Object.entries(YEAR_METHOD_LABEL) as Array<[keyof typeof YEAR_METHOD_LABEL, string]>, []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Leave settings</DialogTitle>
          <DialogDescription>How FMLA time is counted, and the facts eligibility can’t compute.</DialogDescription>
        </DialogHeader>
        {!form ? (
          <SkeletonRows count={3} />
        ) : (
          <div className="space-y-4">
            <Field label="The 12-month FMLA period">
              {(p) => (
                <Select {...p} value={form.fmlaYearMethod} onChange={(e) => setForm({ ...form, fmlaYearMethod: e.target.value as LeaveSettingsView['fmlaYearMethod'] })}>
                  {methods.map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {form.fmlaYearMethod === 'FIXED' && (
              <Field label="The leave year starts on (MM-DD)">{(p) => <Input {...p} value={form.fmlaFixedYearStart ?? ''} placeholder="07-01" maxLength={5} onChange={(e) => setForm({ ...form, fmlaFixedYearStart: e.target.value })} />}</Field>
            )}
            <label className="flex items-start gap-2 text-sm text-ink coarse:min-h-11">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.fmlaCoveredEmployer} onChange={(e) => setForm({ ...form, fmlaCoveredEmployer: e.target.checked })} />
              We employ 50 or more people (FMLA applies to us)
            </label>
            <label className="flex items-start gap-2 text-sm text-ink coarse:min-h-11">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={form.worksiteAttestation.default !== false}
                onChange={(e) => setForm({ ...form, worksiteAttestation: { ...form.worksiteAttestation, default: e.target.checked } })}
              />
              Our worksites have 50 employees within 75 miles
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} disabled={!form} onClick={() => m.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
