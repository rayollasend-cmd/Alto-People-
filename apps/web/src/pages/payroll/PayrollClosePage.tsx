import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Check, Circle, MinusCircle } from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { statusTone } from '@/lib/status';

/**
 * The guided close: one payroll run, six steps, each with what blocks it
 * and where to go. Readiness → exceptions → finalize (and the second
 * approval, where it is on) → disburse → the tax deposit → QuickBooks.
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
    qboJournalEntryId: string | null;
    qboSyncError: string | null;
  };
  approvalRequired: boolean;
  items: { pending: number; disbursed: number; held: number; failed: number; voided: number };
  heldItems: Array<{ id: string; name: string; netPay: number; reason: string | null }>;
  paidItems?: Array<{ id: string; name: string; netPay: number }>;
  rerouted: number;
  readiness: { missingW4: string[]; missingPayout: string[]; unverifiedPayout: string[]; unsupportedState: string[] };
  exceptions: { counts: { blocking: number; warning: number; info: number }; rows: Array<{ associateName: string; kind: string; severity: string; message: string }> } | null;
  deposit: { id: string; status: 'PENDING' | 'PAID'; dueDate: string; amount: number; confirmationNumber: string | null } | null;
  remittances: Array<{ id: string; status: string; payeeName: string; amount: number }>;
  quickbooks: { connected: boolean; glByCostCenter: boolean };
  steps: CloseStep[];
}

const STEP_HINT: Record<string, string> = {
  readiness: 'W-4s on file, a verified pay account for everyone, and a state the engine withholds for.',
  exceptions: 'What the run would pay wrong or not at all. Blocking ones stop finalize.',
  approve: 'Lock the figures. With four-eyes on, a second person signs before money moves.',
  disburse: 'Send every payment. Held and failed items need a decision before the run completes.',
  deposits: 'The withheld taxes became trust-fund money on a deadline the moment the run paid out.',
  quickbooks: 'Post the journal entry — split by cost center when the client has it on.',
};

function StepIcon({ state }: { state: StepState }) {
  const base = 'grid h-7 w-7 shrink-0 place-items-center rounded-full border';
  if (state === 'done') return <span className={cn(base, 'border-success/60 bg-success/15 text-success')}><Check className="h-4 w-4" aria-hidden="true" /></span>;
  if (state === 'blocked') return <span className={cn(base, 'border-alert/60 bg-alert/15 text-alert')}><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /></span>;
  if (state === 'warn') return <span className={cn(base, 'border-warning/60 bg-warning/15 text-warning')}><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /></span>;
  if (state === 'current') return <span className={cn(base, 'border-accent bg-accent-fill/15 text-accent')}><Circle className="h-2.5 w-2.5 fill-current" aria-hidden="true" /></span>;
  if (state === 'skip') return <span className={cn(base, 'border-line text-ink-muted')}><MinusCircle className="h-3.5 w-3.5" aria-hidden="true" /></span>;
  return <span className={cn(base, 'border-line text-ink-muted')}><Circle className="h-2 w-2" aria-hidden="true" /></span>;
}

const RUN_STATUS_LABEL: Record<PayrollClose['run']['status'], string> = {
  DRAFT: 'Draft',
  FINALIZED: 'Finalized',
  DISBURSED: 'Paid',
  CANCELLED: 'Voided',
};

const STATE_LABEL: Record<StepState, string> = {
  done: 'Done',
  current: 'Up next',
  todo: 'Later',
  blocked: 'Blocked',
  warn: 'Needs a look',
  skip: 'Not applicable',
};

export function PayrollClosePage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ['payroll', 'close', id],
    queryFn: () => apiFetch<PayrollClose>(`/payroll/runs/${id}/close`),
    enabled: !!id,
    refetchInterval: 30_000,
  });
  const data = q.data;
  if (q.isError) {
    return (
      <ListTemplate title="Guided close" breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Close' }]}>
        <EmptyState
          title="Could not load this run"
          action={
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        />
      </ListTemplate>
    );
  }
  if (!data) {
    return (
      <ListTemplate title="Guided close" breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Close' }]}>
        <Skeleton className="h-64" />
      </ListTemplate>
    );
  }
  const r = data.run;
  const blockers = data.steps.reduce((s, x) => s + x.blockers, 0);
  const current = data.steps.find((s) => s.state === 'current' || s.state === 'blocked');

  return (
    <ListTemplate
      title={`Close payroll · ${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}`}
      topbarTitle="Guided close"
      subtitle={
        <span className="inline-flex items-center gap-2">
          {r.clientName ?? 'All clients'}
          <Badge variant={statusTone(r.status)}>{RUN_STATUS_LABEL[r.status]}</Badge>
        </span>
      }
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Close' }]}
      primaryAction={
        current ? (
          <Button asChild>
            <Link to={current.to}>
              {current.state === 'blocked' ? `Clear ${current.blockers} blocker${current.blockers === 1 ? '' : 's'}` : current.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        ) : undefined
      }
      summary={
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-ink-muted">
          <span>Gross {fmtMoney(r.totalGross)}</span>
          <span>Net {fmtMoney(r.totalNet)}</span>
          <span>Employer tax {fmtMoney(r.totalEmployerTax)}</span>
          <span>{data.items.pending + data.items.disbursed + data.items.held + data.items.failed} paychecks</span>
          {blockers > 0 && <span className="text-alert">{blockers} blocking</span>}
        </div>
      }
    >
      <ol className="space-y-3" aria-label="Close steps">
        {data.steps.map((s, i) => (
          <li key={s.key}>
            <Card className={cn(s.state === 'blocked' && 'border-alert/40', s.state === 'current' && 'border-accent/50')}>
              <CardContent className="flex items-start gap-3">
                <StepIcon state={s.state} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-medium text-ink">
                      {i + 1}. {s.label}
                    </h3>
                    <span className={cn('text-2xs uppercase tracking-wider', s.state === 'blocked' ? 'text-alert' : s.state === 'done' ? 'text-success' : 'text-ink-muted')}>
                      {STATE_LABEL[s.state]}
                      {s.blockers > 0 && ` · ${s.blockers} blocking`}
                      {s.warnings > 0 && ` · ${s.warnings} to check`}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">{STEP_HINT[s.key]}</p>
                  <StepDetail step={s} data={data} />
                  {s.state !== 'skip' && (
                    <Link to={s.to} className="mt-2 inline-flex items-center gap-1 text-xs text-accent underline underline-offset-2">
                      Open
                      <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
    </ListTemplate>
  );
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
      return (
        <p className="mt-2 text-xs text-ink-muted">
          {r.finalizedAt ? `Finalized ${fmtDateTime(r.finalizedAt)}` : 'Not finalized yet'}
          {data.approvalRequired && (r.approvedAt ? ` · approved by ${r.approvedByEmail ?? 'a second person'} ${fmtDateTime(r.approvedAt)}` : ' · second approval still needed')}
        </p>
      );
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
          {(data.paidItems?.length ?? 0) > 0 && <RecordReturn runId={r.id} items={data.paidItems!} />}
        </div>
      );
    case 'deposits':
      if (!data.deposit) return r.status === 'DISBURSED' ? <p className="mt-2 text-xs text-warning">No deposit accrued for this run — check the tax desk.</p> : null;
      return (
        <p className="mt-2 text-xs text-ink-muted tabular-nums">
          {fmtMoney(data.deposit.amount)} due {fmtDate(data.deposit.dueDate)} ·{' '}
          {data.deposit.status === 'PAID' ? `paid${data.deposit.confirmationNumber ? ` (EFTPS ${data.deposit.confirmationNumber})` : ''}` : 'pending'}
          {data.remittances.length > 0 && ` · ${data.remittances.filter((x) => x.status !== 'SENT').length} of ${data.remittances.length} garnishment remittances to send`}
        </p>
      );
    case 'quickbooks':
      if (!data.quickbooks.connected) return <p className="mt-2 text-xs text-ink-muted">{r.clientName ? 'This client has no QuickBooks connection.' : 'A cross-client run posts to no single QuickBooks company.'}</p>;
      return (
        <p className="mt-2 text-xs text-ink-muted">
          {r.qboJournalEntryId ? `Journal entry ${r.qboJournalEntryId}` : r.qboSyncError ? `Last sync error: ${r.qboSyncError}` : 'Posts when the run disburses'}
          {data.quickbooks.glByCostCenter && ' · split by cost center'}
        </p>
      );
    default:
      return null;
  }
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
