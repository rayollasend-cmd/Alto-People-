import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bot, Check, Clock, Scale, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import { AGENT_GATED_ACTION_LABELS, type AgentApprovalSummary, type ProposalAffectedKind } from '@alto-people/shared';
import { AgentGlyph } from '@/components/agents/AgentGlyph';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtRelativeDate } from '@/lib/format';
import { decideProposal, PROPOSAL_DECISION_INVALIDATES } from '@/lib/agentProposalsApi';

/**
 * A proposal as a decision ("agents propose, people decide"). One card: what
 * the agent proposes in a sentence, the evidence behind it (why, the
 * alternatives it weighed, the impact, the rule that put it here, who it
 * touches), the agent with its glyph and owner, the time left, and Approve
 * or Reject with a reason. Used wherever a person decides: the Approvals
 * page's Proposals queue and the Agents page.
 */

const MIN_REASON = 3;

/** "2h left", "3 days left", "Expired". */
export function timeLeft(expiresAt: string, now: number = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'Expired';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} min left`;
  const hrs = Math.round(min / 60);
  if (hrs < 48) return `${hrs}h left`;
  const days = Math.round(hrs / 24);
  return `${days} days left`;
}

function decisionError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'approval_decided') return 'This proposal was already decided.';
    if (code === 'approval_expired') return 'This proposal expired before it was decided.';
    if (code === 'not_the_approver' || code === 'forbidden') return 'This one is not yours to decide.';
    return err.message || 'Could not record the decision.';
  }
  return 'Could not record the decision.';
}

export function ProposalCard({
  approval,
  canDecide,
  focused = false,
  onDecided,
  className,
}: {
  approval: AgentApprovalSummary;
  /** When the row does not say (`mayDecide`), whether this person may decide it. */
  canDecide?: boolean;
  /** Deep-linked: scroll into view and ring it. */
  focused?: boolean;
  onDecided?: (decided: AgentApprovalSummary) => void | Promise<void>;
  className?: string;
}) {
  const term = useTerm();
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [decided, setDecided] = useState<AgentApprovalSummary | null>(null);

  const row = decided ?? approval;
  const pending = row.status === 'PENDING';
  const may = approval.mayDecide ?? canDecide ?? false;
  // A row cached before evidence existed still renders: the summary stands in for the case.
  const e = row.evidence ?? { why: row.summary, alternatives: [], impact: [], policy: null, affects: [] };
  // A generic block repeats the summary as its reason; the sentence is not shown twice.
  const showWhy = e.why.trim() !== row.summary.trim();

  useEffect(() => {
    if (focused && ref.current && typeof ref.current.scrollIntoView === 'function') ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused]);

  const kindLabel = useMemo<Record<ProposalAffectedKind, string>>(
    () => ({ person: term('worker'), site: term('site'), shift: 'Shift', case: 'Case', client: 'Client' }),
    [term],
  );

  const reasonOk = reason.trim().length >= MIN_REASON;

  const decide = async (decision: 'APPROVE' | 'REJECT') => {
    if (decision === 'REJECT' && !reasonOk) {
      setTouched(true);
      return;
    }
    setSaving(decision);
    try {
      const r = await decideProposal(row.id, decision === 'REJECT' ? { decision, reason: reason.trim() } : { decision });
      setDecided(r);
      setRejecting(false);
      toast.success(decision === 'APPROVE' ? 'Approved. The agent carries it out now.' : 'Rejected. The agent will not propose this again.');
      await Promise.all(PROPOSAL_DECISION_INVALIDATES.map((key) => qc.invalidateQueries({ queryKey: [...key] })));
      await onDecided?.(r);
    } catch (err) {
      toast.error(decisionError(err));
    } finally {
      setSaving(null);
    }
  };

  const expired = pending && new Date(row.expiresAt).getTime() <= Date.now();

  return (
    <Card
      ref={ref}
      id={`proposal-${row.id}`}
      data-testid="proposal-card"
      className={cn('animate-enter', focused && 'ring-2 ring-gold/60', className)}
    >
      <CardContent className="space-y-4 p-5">
        {/* The agent, its owner and the clock. */}
        <div className="flex flex-wrap items-center gap-3">
          <AgentGlyph family={row.agentFamily} size="sm" />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium text-ink">{row.agentName}</span>
            {row.agentOwner && <span className="text-ink-muted"> · owned by {row.agentOwner.name}</span>}
          </div>
          <Badge variant={pending ? 'pending' : row.status === 'REJECTED' ? 'destructive' : 'success'} size="sm">
            {AGENT_GATED_ACTION_LABELS[row.action]}
          </Badge>
          {pending && (
            <span className={cn('inline-flex items-center gap-1 text-xs2 tabular-nums', expired ? 'text-alert' : 'text-ink-muted')} title={`Expires ${fmtDateTime(row.expiresAt)}`}>
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {timeLeft(row.expiresAt)}
            </span>
          )}
        </div>

        {/* What it proposes, in one sentence. */}
        <h3 className="text-base font-medium leading-snug text-ink">{row.summary}</h3>

        {/* The evidence. */}
        <div className="grid gap-4 md:grid-cols-2">
          {showWhy && (
            <section aria-label="Why" className="space-y-1 md:col-span-2">
              <div className="flex items-center gap-1.5 text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">
                <Scale className="h-3.5 w-3.5" aria-hidden="true" />
                Why
              </div>
              <p className="text-sm text-ink">{e.why}</p>
            </section>
          )}

          {e.alternatives.length > 0 && (
            <section aria-label="Alternatives considered" className="space-y-1">
              <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">Alternatives considered</div>
              <ul className="space-y-1 text-sm">
                {e.alternatives.map((a, i) => (
                  <li key={`${a.label}-${i}`} className="flex gap-2">
                    <span className="shrink-0 font-medium text-ink">{a.label}</span>
                    <span className="text-ink-muted">— {a.note}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {e.impact.length > 0 && (
            <section aria-label="Impact" className="space-y-1">
              <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">Impact</div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                {e.impact.map((m, i) => (
                  <div key={`${m.label}-${i}`} className="contents">
                    <dt className="text-ink-muted">{m.label}</dt>
                    <dd className="tabular-nums text-ink">{m.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {e.policy && (
            <section aria-label="Policy" className="space-y-1">
              <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">Policy</div>
              <p className="text-sm text-ink-muted">{e.policy}</p>
            </section>
          )}

          {e.affects.length > 0 && (
            <section aria-label="Who is affected" className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">
                <Users className="h-3.5 w-3.5" aria-hidden="true" />
                Who it touches
              </div>
              <ul className="flex flex-wrap gap-1.5 text-sm">
                {e.affects.map((a) => (
                  <li key={`${a.kind}:${a.id}`} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1">
                    <span className="text-xs2 uppercase tracking-wide text-ink-muted">{kindLabel[a.kind]}</span>
                    {a.kind === 'person' ? (
                      <AssociateLink associateId={a.id} className="text-ink">
                        {a.name}
                      </AssociateLink>
                    ) : a.kind === 'site' ? (
                      <Link to={`/control-room?locationId=${encodeURIComponent(a.id)}`} className="text-ink hover:underline">
                        {a.name}
                      </Link>
                    ) : (
                      <span className="text-ink">{a.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Decided: by whom, when, and why. */}
        {!pending && (
          <div className={cn('rounded-md border px-3 py-2 text-sm', row.status === 'REJECTED' ? 'border-alert/30 bg-alert/5' : 'border-success/30 bg-success/5')} role="status">
            <span className="font-medium text-ink">
              {row.status === 'REJECTED' ? 'Rejected' : row.status === 'EXPIRED' ? 'Expired' : row.status === 'CONSUMED' ? 'Approved and carried out' : 'Approved'}
            </span>
            {row.decidedBy && <span className="text-ink-muted"> by {row.decidedBy.name}</span>}
            {row.decidedAt && <span className="text-ink-muted"> · {fmtRelativeDate(row.decidedAt)}</span>}
            {row.decisionNote && <p className="mt-1 text-ink-muted">“{row.decisionNote}”</p>}
          </div>
        )}

        {/* The decision. */}
        {pending && may && !rejecting && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setRejecting(true)} disabled={saving !== null}>
              <X className="mr-1 h-4 w-4" aria-hidden="true" />
              Reject
            </Button>
            <Button type="button" size="sm" onClick={() => void decide('APPROVE')} disabled={saving !== null || expired} loading={saving === 'APPROVE'}>
              <Check className="mr-1 h-4 w-4" aria-hidden="true" />
              {saving === 'APPROVE' ? 'Approving…' : 'Approve'}
            </Button>
          </div>
        )}
        {pending && may && rejecting && (
          <form
            className="space-y-3 rounded-md border border-alert/30 bg-alert/5 p-3"
            onSubmit={(ev) => {
              ev.preventDefault();
              void decide('REJECT');
            }}
          >
            <Field label="Why are you rejecting this?" required hint="Kept with the decision; the agent will not propose this again." error={touched && !reasonOk ? 'Say why, in a few words.' : undefined}>
              {(p) => (
                <Textarea
                  {...p}
                  value={reason}
                  onChange={(ev) => setReason(ev.target.value)}
                  onBlur={() => setTouched(true)}
                  rows={2}
                  maxLength={500}
                  autoFocus
                  data-testid="reject-reason"
                />
              )}
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
        {pending && !may && <p className="text-xs2 text-ink-muted">Waiting on the person your organization's rule names to decide it.</p>}
      </CardContent>
    </Card>
  );
}

export function ProposalList({
  approvals,
  loading = false,
  error = null,
  onRetry,
  canDecide,
  focusId = null,
  onFocusMissing,
  onDecided,
  emptyTitle = 'No proposals waiting',
  emptyDescription = 'When an agent proposes something that needs a person, it lands here with its reasons.',
  className,
}: {
  approvals: AgentApprovalSummary[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  canDecide?: boolean;
  /** A deep-linked proposal's id (?proposal=): scrolled to and ringed. */
  focusId?: string | null;
  /** Called once when the list has loaded and the deep-linked proposal is not in it. */
  onFocusMissing?: () => void;
  onDecided?: (decided: AgentApprovalSummary) => void | Promise<void>;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}) {
  // Oldest first: the one closest to expiring is decided first.
  const rows = useMemo(() => (approvals ?? []).slice().sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)), [approvals]);
  const loaded = approvals !== undefined && !loading;
  const focusMissing = loaded && !!focusId && !rows.some((a) => a.id === focusId);
  const toldRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusMissing || !focusId || toldRef.current === focusId) return;
    toldRef.current = focusId;
    onFocusMissing?.();
  }, [focusMissing, focusId, onFocusMissing]);

  if (error) {
    return (
      <ErrorBanner action={onRetry ? <Button size="xs" variant="outline" onClick={onRetry}>Retry</Button> : undefined} className={className}>
        Could not load the proposals.
      </ErrorBanner>
    );
  }
  if (!loaded) {
    return (
      <div className={cn('space-y-3', className)} aria-busy="true">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (rows.length === 0) {
    return <EmptyState icon={Bot} title={emptyTitle} description={emptyDescription} className={className} />;
  }
  return (
    <ul className={cn('space-y-3', className)} aria-label="Agent proposals">
      {rows.map((a) => (
        <li key={a.id}>
          <ProposalCard approval={a} canDecide={canDecide} focused={a.id === focusId} onDecided={onDecided} />
        </li>
      ))}
    </ul>
  );
}
