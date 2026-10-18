import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, ClipboardCheck, Clock, X } from 'lucide-react';
import { toast } from 'sonner';
import { APPROVAL_REQUEST_KIND_LABELS, type ApprovalRequestSummary } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtRelativeDate } from '@/lib/format';
import { APPROVAL_DECISION_INVALIDATES, cancelApprovalRequest, decideApprovalRequest } from '@/lib/approvalRequestsApi';

/**
 * A change waiting on a second person, as one decision: what changes (the
 * before and the after, in words), who asked and when, the subject to open,
 * and Approve or Reject with a reason. The same card the Approvals page's
 * Requests queue and a person's own "mine" list use.
 */

const MIN_REASON = 3;

function decisionError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'approval_decided') return 'This request was already decided.';
    if (code === 'maker_checker') return 'You asked for this change; a second person has to decide it.';
    if (code === 'not_the_approver' || code === 'forbidden') return 'This one is not yours to decide.';
    return err.message || 'Could not record the decision.';
  }
  return 'Could not record the decision.';
}

/** Where a decider opens the subject of a request. */
export function subjectPath(r: ApprovalRequestSummary): string | null {
  switch (r.kind) {
    case 'PAY_RATE_CHANGE':
    case 'PROMOTION':
      return r.associateId ? `/people/${r.associateId}?tab=pay` : null;
    case 'SELF_SERVICE_CHANGE':
      return r.associateId ? `/people/${r.associateId}` : null;
    case 'BILL_RATE_CHANGE':
      return r.clientId ? `/clients/${r.clientId}` : '/scheduling';
    case 'SEPARATION_COMPLETE':
      return '/separations';
    case 'REQUISITION':
      return '/org?tab=positions';
    case 'ROLE_CHANGE':
      return '/admin/users';
    case 'WORKFLOW_GATE':
      return '/workflows?tab=runs';
    case 'LABOR_RULES_LIVE':
      return '/payroll/labor-rules';
    default:
      return null;
  }
}

const money = (v: unknown) => (typeof v === 'number' ? `$${v.toFixed(2)}` : v == null ? '—' : String(v));

/** The before → after of a request, as short rows a person can read at a glance. */
export function changeRows(r: ApprovalRequestSummary): Array<{ label: string; before: string | null; after: string }> {
  const p = (r.proposed ?? {}) as Record<string, unknown>;
  const b = (r.before ?? null) as Record<string, unknown> | null;
  switch (r.kind) {
    case 'PAY_RATE_CHANGE':
      return [
        { label: 'Rate', before: b ? `${money(b.amount)} ${b.payType === 'SALARY' ? 'per year' : 'per hour'}` : null, after: `${money(p.amount)} ${p.payType === 'SALARY' ? 'per year' : 'per hour'}` },
        { label: 'Effective', before: null, after: typeof p.effectiveFrom === 'string' ? p.effectiveFrom.slice(0, 10) : '—' },
        { label: 'Reason', before: null, after: typeof p.reason === 'string' ? p.reason.replace(/_/g, ' ').toLowerCase() : '—' },
      ];
    case 'BILL_RATE_CHANGE':
      return [
        { label: 'Bill rate', before: b ? `${money(b.billRate)}/h` : null, after: `${money(p.billRate)}/h` },
        { label: 'Pay rate', before: b ? `${money(b.payRate)}/h` : null, after: `${money(p.payRate)}/h` },
        { label: 'Effective', before: null, after: typeof p.effectiveFrom === 'string' ? p.effectiveFrom : 'today' },
      ];
    case 'PROMOTION':
      return [
        ...(p.newTitle || p.jobProfileId ? [{ label: 'Seat', before: b && typeof b.jobProfileTitle === 'string' ? b.jobProfileTitle : null, after: typeof p.newTitle === 'string' ? p.newTitle : 'new job profile' }] : []),
        ...(p.level ? [{ label: 'Level', before: null, after: String(p.level) }] : []),
        ...(p.amount != null ? [{ label: 'Pay', before: b && b.amount != null ? money(b.amount) : null, after: money(p.amount) }] : []),
        { label: 'Effective', before: null, after: typeof p.effectiveFrom === 'string' ? p.effectiveFrom : '—' },
      ];
    case 'REQUISITION':
      return [
        { label: 'Status', before: b && typeof b.status === 'string' ? b.status.toLowerCase() : null, after: 'open' },
        { label: 'Budget', before: null, after: p.budgetAmount != null ? `$${Number(p.budgetAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${p.budgetPeriod === 'MONTHLY' ? 'per month' : 'per year'}` : 'not set' },
        { label: 'FTE', before: null, after: String(p.fteAuthorized ?? '1') },
      ];
    case 'ROLE_CHANGE':
      return [
        ...(p.role ? [{ label: 'Role', before: b && typeof b.role === 'string' ? b.role.replace(/_/g, ' ').toLowerCase() : null, after: String(p.role).replace(/_/g, ' ').toLowerCase() }] : []),
        ...(Array.isArray(p.additionalRoles) ? [{ label: 'Also works as', before: Array.isArray(b?.additionalRoles) ? (b!.additionalRoles as string[]).map((x) => x.replace(/_/g, ' ').toLowerCase()).join(', ') || 'nothing' : null, after: (p.additionalRoles as string[]).map((x) => x.replace(/_/g, ' ').toLowerCase()).join(', ') || 'nothing' }] : []),
      ];
    case 'SEPARATION_COMPLETE':
      return [{ label: 'Status', before: b && typeof b.status === 'string' ? b.status.replace(/_/g, ' ').toLowerCase() : null, after: 'complete' }];
    case 'LABOR_RULES_LIVE': {
      const report = (p.changeReport ?? null) as { people?: number; amountDifference?: number; premiumAmount?: number } | null;
      return [
        { label: 'Pay by', before: 'Federal rules (shadow)', after: String(p.jurisdictionLabel ?? p.jurisdiction ?? 'the state') + ' rules' },
        { label: 'Counsel', before: null, after: [p.counselName, p.counselFirm].filter(Boolean).join(', ') + (typeof p.counselSignedOn === 'string' ? ` · signed ${p.counselSignedOn}` : '') },
        ...(report && typeof report.amountDifference === 'number'
          ? [{ label: 'Recent runs', before: null, after: `${report.people ?? 0} people would be paid ${report.amountDifference >= 0 ? '+' : '−'}${money(Math.abs(report.amountDifference))}${report.premiumAmount ? `, incl. ${money(report.premiumAmount)} premiums` : ''}` }]
          : []),
      ];
    }
    case 'SELF_SERVICE_CHANGE': {
      const op = String(p.op ?? '');
      if (op === 'profile') {
        const data = (p.data ?? {}) as Record<string, string | null>;
        return [{ label: 'Address', before: b && typeof b.address === 'string' ? b.address : null, after: [data.addressLine1, data.addressLine2, data.city, [data.state, data.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—' }];
      }
      const data = (p.data ?? {}) as Record<string, unknown>;
      return [{ label: 'Dependent', before: b && typeof b.firstName === 'string' ? `${b.firstName} ${b.lastName ?? ''}`.trim() : null, after: op === 'dependent.delete' ? 'removed' : `${data.firstName ?? ''} ${data.lastName ?? ''}`.trim() || 'updated' }];
    }
    default:
      return [];
  }
}

export function ApprovalRequestCard({
  request,
  focused = false,
  onDecided,
  className,
}: {
  request: ApprovalRequestSummary;
  focused?: boolean;
  onDecided?: (decided: ApprovalRequestSummary) => void | Promise<void>;
  className?: string;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState(request);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState<'APPROVE' | 'REJECT' | 'CANCEL' | null>(null);
  useEffect(() => setRow(request), [request]);

  const pending = row.status === 'PENDING';
  const mine = !!user && row.requester?.id === user.id;
  const rows = useMemo(() => changeRows(row), [row]);
  const open = subjectPath(row);
  const reasonOk = reason.trim().length >= MIN_REASON;

  useEffect(() => {
    if (focused && ref.current && typeof ref.current.scrollIntoView === 'function') ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused]);

  const invalidate = () => Promise.all(APPROVAL_DECISION_INVALIDATES.map((key) => qc.invalidateQueries({ queryKey: [...key] })));

  const decide = async (decision: 'APPROVE' | 'REJECT') => {
    if (decision === 'REJECT' && !reasonOk) {
      setTouched(true);
      return;
    }
    setSaving(decision);
    try {
      const r = await decideApprovalRequest(row.id, decision === 'REJECT' ? { decision, reason: reason.trim() } : { decision });
      setRow(r);
      setRejecting(false);
      if (decision === 'APPROVE') toast[r.applyError ? 'error' : 'success'](r.applyError ? `Approved, but it could not be applied: ${r.applyError}` : 'Approved and applied.');
      else toast.success('Rejected. The person who asked has been told.');
      await invalidate();
      await onDecided?.(r);
    } catch (err) {
      toast.error(decisionError(err));
    } finally {
      setSaving(null);
    }
  };

  const withdraw = async () => {
    setSaving('CANCEL');
    try {
      const r = await cancelApprovalRequest(row.id);
      setRow(r);
      toast.success('Withdrawn.');
      await invalidate();
      await onDecided?.(r);
    } catch (err) {
      toast.error(decisionError(err));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card ref={ref} id={`approval-${row.id}`} data-testid="approval-request-card" className={cn('animate-enter', focused && 'ring-2 ring-gold/60', className)}>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-accent-fill/15 text-accent" aria-hidden="true">
            <ClipboardCheck className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium text-ink">{row.requester ? row.requester.name : 'A workflow'}</span>
            <span className="text-ink-muted"> asked · {fmtRelativeDate(row.createdAt)}</span>
          </div>
          <Badge variant={pending ? 'pending' : row.status === 'REJECTED' || row.status === 'CANCELLED' ? 'destructive' : 'success'} size="sm">
            {APPROVAL_REQUEST_KIND_LABELS[row.kind]}
          </Badge>
          {pending && (
            <span className="inline-flex items-center gap-1 text-xs2 tabular-nums text-ink-muted" title={`Asked ${fmtDateTime(row.createdAt)}`}>
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              Waiting
            </span>
          )}
        </div>

        <h3 className="text-base font-medium leading-snug text-ink">{row.title}</h3>
        {row.summary && <p className="text-sm text-ink-muted">{row.summary}</p>}

        {rows.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label="What changes">
            {rows.map((r) => (
              <div key={r.label} className="contents">
                <dt className="text-ink-muted">{r.label}</dt>
                <dd className="tabular-nums text-ink">
                  {r.before != null && <span className="text-ink-muted line-through decoration-ink-muted/60">{r.before}</span>}
                  {r.before != null && <span className="text-ink-muted"> → </span>}
                  <span className="font-medium">{r.after}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}

        {!pending && (
          <div className={cn('rounded-md border px-3 py-2 text-sm', row.status === 'APPROVED' ? 'border-success/30 bg-success/5' : 'border-alert/30 bg-alert/5')} role="status">
            <span className="font-medium text-ink">
              {row.status === 'APPROVED' ? (row.applyError ? 'Approved, not applied' : row.appliedAt ? 'Approved and applied' : 'Approved') : row.status === 'REJECTED' ? 'Rejected' : 'Withdrawn'}
            </span>
            {row.decidedBy && <span className="text-ink-muted"> by {row.decidedBy.name}</span>}
            {row.decidedAt && <span className="text-ink-muted"> · {fmtRelativeDate(row.decidedAt)}</span>}
            {row.reason && <p className="mt-1 text-ink-muted">“{row.reason}”</p>}
            {row.applyError && <p className="mt-1 text-alert">{row.applyError}</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {open && (
              <Button asChild size="sm" variant="link" className="px-0">
                <Link to={open}>Open the record</Link>
              </Button>
            )}
          </div>
          {pending && row.mayDecide && !rejecting && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setRejecting(true)} disabled={saving !== null}>
                <X className="mr-1 h-4 w-4" aria-hidden="true" />
                Reject
              </Button>
              <Button type="button" size="sm" onClick={() => void decide('APPROVE')} disabled={saving !== null} loading={saving === 'APPROVE'}>
                <Check className="mr-1 h-4 w-4" aria-hidden="true" />
                {saving === 'APPROVE' ? 'Approving…' : 'Approve'}
              </Button>
            </div>
          )}
          {pending && !row.mayDecide && mine && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void withdraw()} disabled={saving !== null} loading={saving === 'CANCEL'}>
              Withdraw
            </Button>
          )}
        </div>
        {pending && row.mayDecide && rejecting && (
          <form
            className="space-y-3 rounded-md border border-alert/30 bg-alert/5 p-3"
            onSubmit={(ev) => {
              ev.preventDefault();
              void decide('REJECT');
            }}
          >
            <Field label="Why are you rejecting this?" required hint="Kept with the decision and sent to the person who asked." error={touched && !reasonOk ? 'Say why, in a few words.' : undefined}>
              {(p) => <Textarea {...p} value={reason} onChange={(ev) => setReason(ev.target.value)} onBlur={() => setTouched(true)} rows={2} maxLength={2000} autoFocus data-testid="approval-reject-reason" />}
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRejecting(false);
                  setTouched(false);
                }}
                disabled={saving !== null}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" size="sm" disabled={saving !== null || !reasonOk} loading={saving === 'REJECT'}>
                {saving === 'REJECT' ? 'Rejecting…' : 'Confirm rejection'}
              </Button>
            </div>
          </form>
        )}
        {pending && !row.mayDecide && !mine && <p className="text-xs2 text-ink-muted">Waiting on a second person — the rule names who.</p>}
        {pending && mine && <p className="text-xs2 text-ink-muted">You asked for this; a second person decides it.</p>}
      </CardContent>
    </Card>
  );
}

export function ApprovalRequestList({
  requests,
  loading = false,
  error = null,
  onRetry,
  focusId = null,
  onDecided,
  emptyTitle = 'Nothing waiting on you',
  emptyDescription = 'When a change needs a second person — a pay or bill rate, a separation, a promotion, a requisition, an access change — it lands here with its before and after.',
  className,
}: {
  requests: ApprovalRequestSummary[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  focusId?: string | null;
  onDecided?: (decided: ApprovalRequestSummary) => void | Promise<void>;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}) {
  const loaded = requests !== undefined && !loading;
  if (error) {
    return (
      <ErrorBanner action={onRetry ? <Button size="xs" variant="outline" onClick={onRetry}>Retry</Button> : undefined} className={className}>
        Could not load the requests.
      </ErrorBanner>
    );
  }
  if (!loaded) {
    return (
      <div className={cn('space-y-3', className)} aria-busy="true">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
    );
  }
  if (requests.length === 0) return <EmptyState icon={ClipboardCheck} title={emptyTitle} description={emptyDescription} className={className} />;
  return (
    <ul className={cn('space-y-3', className)} aria-label="Approval requests">
      {requests.map((r) => (
        <li key={r.id}>
          <ApprovalRequestCard request={r} focused={r.id === focusId} onDecided={onDecided} />
        </li>
      ))}
    </ul>
  );
}
