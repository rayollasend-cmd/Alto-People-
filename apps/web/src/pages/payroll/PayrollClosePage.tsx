import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Check, Circle, MinusCircle } from '@/components/ui/icons';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { RunPageShell, type RunSubPageProps } from './RunPageShell';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { useMediaQuery } from '@/lib/useViewport';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { RunFundingCard } from '@/pages/payrollBanking/FundingCard';
import { centsToMoney, downloadAchFile, markAchFileUploaded } from '@/lib/bankingApi';
import { useConfirm } from '@/lib/confirm';
import { createRunTaxDeposit } from '@/lib/payrollDeskApi';
import { markTaxDepositPaid } from '@/lib/payrollApi';
import { RunTotalsMismatch } from '@/components/payroll/RunTotalsMismatch';
import { RunStatusBadge } from '@/lib/payrollRunStatus';

/**
 * The guided close: one payroll run, step by step, each with what blocks it
 * and where to go. Readiness → exceptions → workers' own checks → finalize
 * → the review report signed off → disburse → the tax deposit → QuickBooks.
 * The actions live where they always did; this page is the order and
 * the count of what is in the way.
 */

type StepState = 'done' | 'current' | 'todo' | 'blocked' | 'warn' | 'skip';

interface CloseStep {
  key: string;
  label: string;
  state: StepState;
  blockers: number;
  warnings: number;
  /** Why the step is blocked, in the server's words (e.g. the run isn't funded yet). */
  note?: string;
  to: string;
}

export interface PayrollClose {
  run: {
    id: string;
    status: 'DRAFT' | 'FINALIZED' | 'DISBURSED' | 'CANCELLED';
    kind: string;
    clientName: string | null;
    periodStart: string;
    periodEnd: string;
    totalGross: number;
    totalNet: number;
    totalEmployerTax: number;
    finalizedAt: string | null;
    approvedAt: string | null;
    approvedByEmail: string | null;
    disbursedAt: string | null;
    /** The stored totals checked against the paychecks (apps/api/src/lib/payrollRunTotals.ts). */
    itemsGross?: number;
    itemsNet?: number;
    paychecks?: number;
    totalsAgree?: boolean;
  };
  approvalRequired: boolean;
  review?: {
    required: boolean;
    signedByName: string | null;
    signedAt: string | null;
    soleReviewer: boolean;
    staleSignedByName: string | null;
    staleSignedAt: string | null;
  };
  items: { pending: number; disbursed: number; held: number; failed: number; voided: number };
  /** Own-account ACH: the run's in-house file, which a person carries to the bank and marks uploaded. */
  bankFile?: { id: string; status: string; effectiveDate: string; entryCount: number; totalCreditCents: number; format: 'UNBALANCED' | 'BALANCED'; bank: string } | null;
  heldItems: Array<{ id: string; name: string; netPay: number; reason: string | null }>;
  paidItems?: Array<{ id: string; name: string; netPay: number }>;
  rerouted: number;
  readiness: { missingW4: string[]; missingPayout: string[]; unverifiedPayout: string[]; unsupportedState: string[] };
  exceptions: { counts: { blocking: number; warning: number; info: number }; rows: Array<{ associateName: string; kind: string; severity: string; message: string }> } | null;
  deposit: { id: string; status: 'PENDING' | 'PAID'; dueDate: string; amount: number; confirmationNumber: string | null } | null;
  remittances: Array<{ id: string; status: string; payeeName: string; amount: number }>;
  /** The company's own QuickBooks (Books → QuickBooks sync); the run's entries go over through the books outbox. */
  quickbooks: { connected: boolean; status: string | null; companyName: string | null };
  /** Paid by paper check this time, and the run's checks once issued (lib/paperChecks). */
  payByCheck?: Array<{ itemId: string; name: string; reason: string; source: 'PAYROLL' | 'ASSOCIATE' }>;
  checks?: { issued: number; printed: number; voided: number };
  payPreview?: { people: number; confirmed: number; flagged: number; openFlags: number; unanswered: number; confirmationRate: number } | null;
  steps: CloseStep[];
}

const STEP_HINT: Record<string, string> = {
  readiness: 'W-4s on file, a verified pay account for everyone, and a state the engine withholds for.',
  exceptions: 'What the run would pay wrong or not at all. Blocking ones stop finalize.',
  payPreview: 'Two days before payday each worker checks their pay. A flag they raise stays open until it’s handled.',
  approve: 'Lock the figures so nothing else lands on the run.',
  review: 'Read the review report: totals, cash, taxes and every paycheck that moved. Sign off on these exact numbers.',
  disburse: 'Send every payment. Held and failed items need a decision before the run completes.',
  deposits: 'The withheld taxes became trust-fund money on a deadline the moment the run paid out.',
  quickbooks: 'The run’s entries are in the books; they go over to QuickBooks through the sync when the company is connected.',
};

function StepIcon({ state }: { state: StepState }) {
  const base = 'grid h-7 w-7 shrink-0 place-items-center rounded-full border';
  if (state === 'done') return <span className={cn(base, 'border-success/60 bg-success/15 text-success')}><Check className="h-4 w-4" aria-hidden="true" /></span>;
  if (state === 'blocked') return <span className={cn(base, 'border-alert/60 bg-alert/15 text-alert')}><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /></span>;
  if (state === 'warn') return <span className={cn(base, 'border-warning/60 bg-warning/15 text-warning')}><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /></span>;
  if (state === 'current') return <span className={cn(base, 'border-accent bg-accent-fill/15 text-accent')}><Circle className="h-2.5 w-2.5 fill-current" aria-hidden="true" /></span>;
  if (state === 'skip') return <span className={cn(base, 'border-line text-ink-muted')}><MinusCircle className="h-3.5 w-3.5" aria-hidden="true" /></span>;
  return <span className={cn(base, 'border-line text-ink-muted')}><span className="h-2 w-2 rounded-full border border-current" aria-hidden="true" /></span>;
}


const STATE_LABEL: Record<StepState, string> = {
  done: 'Done',
  current: 'Up next',
  todo: 'Later',
  blocked: 'Blocked',
  warn: 'Needs a look',
  skip: 'Not applicable',
};

/** The step a person should act on now: blocked first, then the current one, then one that needs a look. */
export function openStep(steps: CloseStep[]): CloseStep | null {
  return steps.find((s) => s.state === 'blocked') ?? steps.find((s) => s.state === 'current') ?? steps.find((s) => s.state === 'warn') ?? null;
}

/** A step that is "done" only because the run moved past it: a paid run whose review was never signed. */
function skipped(s: CloseStep, data: PayrollClose): boolean {
  return s.key === 'review' && s.state === 'done' && !!data.review?.required && !data.review.signedAt;
}

export function PayrollClosePage({ runId, embedded = false }: RunSubPageProps = {}) {
  const params = useParams<{ id: string }>();
  const id = runId ?? params.id;
  const q = useQuery({
    queryKey: ['payroll', 'close', id],
    queryFn: () => apiFetch<PayrollClose>(`/payroll/runs/${id}/close`),
    enabled: !!id,
    refetchInterval: 30_000,
  });
  const data = q.data;
  const phone = !useMediaQuery('(min-width: 640px)');
  const firstOpenRef = useRef<HTMLLIElement | null>(null);
  const scrolledRef = useRef(false);
  const crumbs = [{ label: 'Payroll', to: '/payroll' }, { label: 'Run', to: `/payroll/runs/${id}` }, { label: 'Close' }];
  useEffect(() => {
    // On a phone the finished steps used to fill the first screen: go to the one that needs you.
    if (!phone || !data || scrolledRef.current || !firstOpenRef.current) return;
    scrolledRef.current = true;
    firstOpenRef.current.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [phone, data]);
  if (q.isError) {
    return (
      <RunPageShell embedded={embedded} title="Guided close" breadcrumbs={crumbs}>
        <QueryError what="this run" query={q} />
      </RunPageShell>
    );
  }
  if (!data) {
    return (
      <RunPageShell embedded={embedded} title="Guided close" breadcrumbs={crumbs}>
        <Skeleton className="h-64" />
      </RunPageShell>
    );
  }
  const r = data.run;
  const blockers = data.steps.reduce((s, x) => s + x.blockers, 0);
  const current = openStep(data.steps);
  const paychecks = data.items.pending + data.items.disbursed + data.items.held + data.items.failed;
  const firstOpenKey = data.steps.find((s) => s.state !== 'done' && s.state !== 'skip')?.key ?? null;

  return (
    <RunPageShell
      embedded={embedded}
      title={`Close payroll · ${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}`}
      topbarTitle="Guided close"
      subtitle={
        <span className="inline-flex items-center gap-2">
          {r.clientName ?? 'All clients'}
          <RunStatusBadge status={r.status} />
        </span>
      }
      breadcrumbs={crumbs}
      // The step to act on is the header's primary, whether it's blocked, up next or needs a look.
      // As the run record's tab, the record's own primary is that step already: not a second gold button.
      actions={
        current && !embedded
          ? [
              {
                key: 'open-step',
                label: current.state === 'blocked' ? `Clear ${current.blockers} blocker${current.blockers === 1 ? '' : 's'}` : current.label,
                to: current.to,
                icon: ArrowRight,
                primary: true,
              },
            ]
          : undefined
      }
      summary={
        <div className="space-y-3">
          <RunTotalsMismatch check={r} />
          {/* The run's numbers: the record's header has them when this is its tab. */}
          {!embedded && (
            <MetricStrip label="Run totals">
              <MetricCard label="Gross" value={fmtMoney(r.totalGross)} />
              <MetricCard label="Net" value={fmtMoney(r.totalNet)} />
              <MetricCard label="Employer tax" value={fmtMoney(r.totalEmployerTax)} />
              <MetricCard label="Paychecks" value={String(paychecks)} hint={blockers > 0 ? `${blockers} blocking` : undefined} tone={blockers > 0 ? 'alert' : 'default'} />
            </MetricStrip>
          )}
        </div>
      }
    >
      <div className="mb-3">
        <RunFundingCard runId={r.id} runFinalized={r.status === 'FINALIZED'} />
      </div>
      <ol className="space-y-2" aria-label="Close steps">
        {data.steps.map((s, i) => {
          const isSkipped = skipped(s, data);
          const finished = (s.state === 'done' && !isSkipped) || s.state === 'skip';
          if (finished) {
            // A finished step is one line: what it was, that it's done, and when.
            return (
              <li key={s.key}>
                <Link to={s.to} className="flex items-center gap-3 rounded-lg border border-line px-4 py-2.5 text-sm hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <StepIcon state={s.state} />
                  <span className="min-w-0 flex-1 text-ink">
                    {i + 1}. {s.label}
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">{doneWhen(s, data) ?? STATE_LABEL[s.state]}</span>
                </Link>
              </li>
            );
          }
          return (
            <li key={s.key} ref={s.key === firstOpenKey ? firstOpenRef : undefined}>
              <Card className={cn(s.state === 'blocked' && 'border-alert/40', s.state === 'current' && 'border-accent/50')}>
                <CardContent className="flex items-start gap-3">
                  <StepIcon state={isSkipped ? 'warn' : s.state} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      {/* The title is the link: no separate "Open" under every step. */}
                      <h3 className="text-sm font-medium">
                        <Link to={s.to} className="text-ink hover:text-accent hover:underline">
                          {i + 1}. {s.label}
                        </Link>
                      </h3>
                      <span className={cn('text-2xs uppercase tracking-wider', s.state === 'blocked' ? 'text-alert' : isSkipped ? 'text-warning' : 'text-ink-muted')}>
                        {isSkipped ? 'Skipped' : STATE_LABEL[s.state]}
                        {s.blockers > 0 && ` · ${s.blockers} blocking`}
                        {s.warnings > 0 && ` · ${s.warnings} to check`}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-muted">{STEP_HINT[s.key]}</p>
                    {s.note && <p className="mt-1 text-xs text-alert">{s.note}</p>}
                    <StepDetail step={s} data={data} />
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ol>
    </RunPageShell>
  );
}

/** When a finished step finished, when the run says. */
function doneWhen(s: CloseStep, data: PayrollClose): string | null {
  const r = data.run;
  if (s.key === 'approve') return r.finalizedAt ? `Finalized ${fmtDate(r.finalizedAt)}` : 'Finalized';
  if (s.key === 'review' && data.review?.signedAt) return `Signed ${fmtDate(data.review.signedAt)}`;
  if (s.key === 'disburse' && r.disbursedAt) return `Paid ${fmtDate(r.disbursedAt)}`;
  if (s.key === 'deposits' && data.deposit?.status === 'PAID') return 'Deposited';
  return null;
}

function List({ items, max = 5 }: { items: string[]; max?: number }) {
  if (items.length === 0) return null;
  return (
    <span>
      {items.slice(0, max).join(', ')}
      {items.length > max && ` and ${items.length - max} more`}
    </span>
  );
}

function StepDetail({ step, data }: { step: CloseStep; data: PayrollClose }) {
  const r = data.run;
  switch (step.key) {
    case 'readiness': {
      const rd = data.readiness;
      if (!rd.missingW4.length && !rd.unsupportedState.length && !rd.missingPayout.length && !rd.unverifiedPayout.length) return null;
      return (
        <ul className="mt-2 space-y-1 text-xs">
          {rd.unsupportedState.length > 0 && (
            <li className="text-alert">
              State not supported: <List items={rd.unsupportedState} />
            </li>
          )}
          {rd.missingW4.length > 0 && (
            <li className="text-alert">
              No W-4: <List items={rd.missingW4} />
            </li>
          )}
          {rd.missingPayout.length > 0 && (
            <li className="text-warning">
              No pay account: <List items={rd.missingPayout} />
            </li>
          )}
          {rd.unverifiedPayout.length > 0 && (
            <li className="text-warning">
              Pay account not yet verified: <List items={rd.unverifiedPayout} />
            </li>
          )}
        </ul>
      );
    }
    case 'exceptions':
      if (!data.exceptions || data.exceptions.rows.length === 0) return null;
      return (
        <ul className="mt-2 space-y-1 text-xs">
          {data.exceptions.rows.slice(0, 6).map((e, i) => (
            <li key={i} className={cn(e.severity === 'BLOCKING' ? 'text-alert' : e.severity === 'WARNING' ? 'text-warning' : 'text-ink-muted')}>
              <span className="text-ink">{e.associateName}</span> — {e.message}
            </li>
          ))}
          {data.exceptions.rows.length > 6 && <li className="text-ink-muted">and {data.exceptions.rows.length - 6} more</li>}
        </ul>
      );
    case 'approve':
      // The text follows the step's own state (finance walk 3): a done step never reads "not yet".
      if (step.state === 'done') return <p className="mt-2 text-xs text-ink-muted">{r.finalizedAt ? `Finalized ${fmtDateTime(r.finalizedAt)}` : 'Finalized'}</p>;
      return <p className="mt-2 text-xs text-ink-muted">Not finalized yet</p>;
    case 'review': {
      const rv = data.review;
      if (!rv) return null;
      if (rv.signedAt) {
        return (
          <p className="mt-2 text-xs text-ink-muted">
            Signed off by {rv.signedByName ?? 'a reviewer'} {fmtDateTime(rv.signedAt)}
            {rv.soleReviewer && ' · the only person who processes payroll'}
          </p>
        );
      }
      if (rv.staleSignedAt) return null; // The step's note says it.
      if (step.state === 'skip' || !rv.required) return <p className="mt-2 text-xs text-ink-muted">Not required for this run.</p>;
      if (step.state === 'done') return <p className="mt-2 text-xs text-warning">Paid out with no sign-off on record.</p>;
      return <p className="mt-2 text-xs text-ink-muted">No sign-off yet. The run can’t pay out without one.</p>;
    }
    case 'disburse':
      return (
        <div className="mt-2 text-xs text-ink-muted">
          <span className="tabular-nums">
            {data.items.disbursed} paid · {data.items.pending} pending · {data.items.held + data.items.failed} held
            {data.rerouted > 0 && ` · ${data.rerouted} re-sent after a bank return`}
          </span>
          {data.heldItems.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {data.heldItems.slice(0, 5).map((h) => (
                <li key={h.id} className="text-warning">
                  {h.name} · {fmtMoney(h.netPay)} — {h.reason ?? 'held'}
                </li>
              ))}
            </ul>
          )}
          {(data.payByCheck?.length ?? 0) > 0 && (
            <p className="mt-1">
              Paid by paper check this time: <List items={data.payByCheck!.map((p) => p.name)} />
            </p>
          )}
          {((data.checks?.issued ?? 0) > 0 || (data.payByCheck?.length ?? 0) > 0) && (
            <Link to={`/payroll/runs/${r.id}/checks`} className="mt-1 inline-flex items-center gap-1 text-accent underline underline-offset-2">
              {data.checks && data.checks.issued > 0
                ? `Paper checks: ${data.checks.issued} issued, ${data.checks.printed} printed`
                : 'Paper checks'}
              <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          )}
          {data.bankFile && <BankFileStep runId={r.id} file={data.bankFile} />}
          {(data.paidItems?.length ?? 0) > 0 && <RecordReturn runId={r.id} items={data.paidItems!} />}
        </div>
      );
    case 'deposits':
      return r.status === 'DISBURSED' || data.deposit ? <DepositStep runId={r.id} deposit={data.deposit} remittances={data.remittances} /> : null;
    case 'payPreview':
      return data.payPreview ? (
        <p className="mt-2 text-xs text-ink-muted tabular-nums">
          {data.payPreview.confirmed} of {data.payPreview.people} confirmed · {data.payPreview.openFlags} open flag{data.payPreview.openFlags === 1 ? '' : 's'} · {data.payPreview.unanswered} no answer yet
        </p>
      ) : null;
    case 'quickbooks':
      if (!data.quickbooks.connected) {
        return (
          <p className="mt-2 text-xs text-ink-muted">
            {data.quickbooks.status ? `The QuickBooks connection is ${data.quickbooks.status.toLowerCase().replace(/_/g, ' ')} — reconnect it under Books → QuickBooks sync.` : 'QuickBooks isn’t connected; the books here are complete on their own.'}
          </p>
        );
      }
      return (
        <p className="mt-2 text-xs text-ink-muted">
          {data.quickbooks.companyName ? `Connected to ${data.quickbooks.companyName} — ` : ''}
          {r.disbursedAt ? 'the run’s entries went to the sync outbox when it disbursed.' : 'the run’s entries go over when it disburses.'}
        </p>
      );
    default:
      return null;
  }
}

/**
 * Own-account ACH: the run's file, the download, and the one button that
 * makes its paychecks read paid — "it reached the bank".
 */
function BankFileStep({ runId, file }: { runId: string; file: NonNullable<PayrollClose['bankFile']> }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const waiting = file.status === 'CREATED' || file.status === 'DOWNLOADED';
  const mark = useMutation({
    mutationFn: () => markAchFileUploaded(file.id),
    onSuccess: (r) => {
      toast.success(r.already ? 'That file was already marked uploaded.' : `Marked uploaded: ${r.paid} paycheck${r.paid === 1 ? '' : 's'} now read paid.`);
      void qc.invalidateQueries({ queryKey: ['payroll', 'close', runId] });
      void qc.invalidateQueries({ queryKey: ['payroll-banking'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not mark the file uploaded.'),
  });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
      <span className="tabular-nums">
        Bank file ({file.format === 'BALANCED' ? 'balanced' : 'unbalanced'}) · {file.entryCount} entr{file.entryCount === 1 ? 'y' : 'ies'} · {centsToMoney(file.totalCreditCents)} · posts {fmtDate(file.effectiveDate)} ·{' '}
        {waiting ? 'not yet uploaded' : file.status === 'SUBMITTED' ? `uploaded to ${file.bank}` : file.status.toLowerCase()}
      </span>
      <Button size="xs" variant="outline" onClick={() => downloadAchFile(file.id).then(() => void qc.invalidateQueries({ queryKey: ['payroll', 'close', runId] })).catch((e: Error) => toast.error(e.message))}>
        Download
      </Button>
      {waiting && (
        <Button
          size="xs"
          variant="primary"
          loading={mark.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: `Mark this file uploaded to ${file.bank}?`,
              description: `${file.entryCount} entr${file.entryCount === 1 ? 'y' : 'ies'} for ${centsToMoney(file.totalCreditCents)}, posting ${fmtDate(file.effectiveDate)}. Do this only after the bank’s portal accepted the file: the paychecks in it read paid, dated now.`,
              confirmLabel: 'Mark uploaded',
              destructive: true,
            });
            if (ok) mark.mutate();
          }}
        >
          Mark uploaded to {file.bank}
        </Button>
      )}
    </div>
  );
}

/**
 * A bank sent a deposit back on a rail with no webhook (a check that
 * bounced, the stub, Wise): record it, and the paycheck is re-sent to the
 * person's last verified other account — else by paper check.
 */
function RecordReturn({ runId, items }: { runId: string; items: Array<{ id: string; name: string; netPay: number }> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [itemId, setItemId] = useState('');
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => apiFetch<{ outcome: string; to?: string; reason?: string }>(`/payroll/items/${itemId}/returned`, { method: 'POST', body: { reason: reason || null } }),
    onSuccess: (r) => {
      if (r.outcome === 'held') toast.error(`Could not re-send automatically: ${r.reason ?? 'unknown'}. It is in the held list.`);
      else toast.success(`Re-sent to ${r.to}.`);
      setOpen(false);
      setItemId('');
      setReason('');
      void qc.invalidateQueries({ queryKey: ['payroll', 'close', runId] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the return.'),
  });
  if (!open) {
    return (
      <button type="button" className="mt-2 block text-xs text-accent underline underline-offset-2" onClick={() => setOpen(true)}>
        Record a bank return
      </button>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (itemId) send.mutate();
      }}
    >
      <label className="text-xs text-ink-muted">
        Paycheck
        <Select size="sm" className="mt-1 block" value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="Returned paycheck">
          <option value="">Choose…</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} · {fmtMoney(i.netPay)}
            </option>
          ))}
        </Select>
      </label>
      <label className="min-w-[12rem] flex-1 text-xs text-ink-muted">
        Bank&rsquo;s reason (R-code)
        <Input className="mt-1" value={reason} maxLength={200} placeholder="R03 No account" onChange={(e) => setReason(e.target.value)} />
      </label>
      <Button size="sm" type="submit" loading={send.isPending} disabled={!itemId || send.isPending}>
        Re-send
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * The tax deposit, done on the step itself (finance walk 18): a paid run
 * with withholding and no deposit on record gets "Create the deposit"; a
 * pending one shows its due date with the EFTPS confirmation field.
 */
function DepositStep({ runId, deposit, remittances }: { runId: string; deposit: PayrollClose['deposit']; remittances: PayrollClose['remittances'] }) {
  const qc = useQueryClient();
  const [confirmation, setConfirmation] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payroll', 'close', runId] });
  const create = useMutation({
    mutationFn: () => createRunTaxDeposit(runId),
    onSuccess: (r) => {
      toast.success(r.created ? `Deposit created: ${fmtMoney(r.deposit.amount)} due ${fmtDate(r.deposit.dueDate)}.` : 'The deposit was already on record.');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create the deposit.'),
  });
  const pay = useMutation({
    mutationFn: (id: string) => markTaxDepositPaid(id, confirmation.trim() || null),
    onSuccess: () => {
      toast.success('Deposit recorded as paid.');
      setConfirmation('');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not record the payment.'),
  });
  const openRemits = remittances.filter((x) => x.status !== 'SENT').length;
  if (!deposit) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-warning">This run withheld taxes and no deposit is on record.</span>
        <Button size="xs" onClick={() => create.mutate()} loading={create.isPending}>
          Create the deposit
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-2 text-xs">
      <p className="tabular-nums text-ink-muted">
        {fmtMoney(deposit.amount)} due {fmtDate(deposit.dueDate)} ·{' '}
        {deposit.status === 'PAID' ? `paid${deposit.confirmationNumber ? ` (EFTPS ${deposit.confirmationNumber})` : ''}` : 'not paid yet'}
        {remittances.length > 0 && ` · ${openRemits} of ${remittances.length} garnishment remittances to send`}
      </p>
      {deposit.status !== 'PAID' && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            pay.mutate(deposit.id);
          }}
        >
          <label htmlFor={`eftps-${deposit.id}`} className="text-ink-muted">
            EFTPS confirmation
          </label>
          <Input id={`eftps-${deposit.id}`} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="15-digit number" className="h-8 w-44" inputMode="numeric" />
          <Button size="xs" type="submit" loading={pay.isPending}>
            Record as paid
          </Button>
        </form>
      )}
    </div>
  );
}
