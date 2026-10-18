import { useSafeConfirm } from '@/pages/integrations/providers/providerShared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDateTime, fmtDayShort, parseYmd } from '@/lib/format';
import {
  closeEVerify,
  everifyProviderView,
  providerSummary,
  recordEVerifyDecision,
  refreshEVerify,
  submitEVerify,
  type EVerifyClosure,
  type EVerifyProviderView,
} from '@/lib/providersApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * E-Verify through the connected provider, on the person's case drawer:
 * open the case from the I-9, check for a result, and walk a mismatch
 * (Tentative Nonconfirmation) the way the law asks — the notice, the
 * employee's choice, the referral and its 8-federal-working-day window —
 * then close the case. The manual recorder below stays for anyone not
 * connected.
 */

const STATUS: Record<NonNullable<EVerifyProviderView['status']>, { label: string; variant: 'success' | 'destructive' | 'pending' | 'outline' }> = {
  PENDING: { label: 'Waiting for E-Verify', variant: 'pending' },
  EMPLOYMENT_AUTHORIZED: { label: 'Employment authorized', variant: 'success' },
  TENTATIVE_NONCONFIRMATION: { label: 'Mismatch — needs action', variant: 'destructive' },
  FINAL_NONCONFIRMATION: { label: 'Final nonconfirmation', variant: 'destructive' },
  CLOSE_CASE_AND_RESUBMIT: { label: 'Close and resubmit', variant: 'outline' },
};

const CLOSURE: Array<{ value: EVerifyClosure; label: string }> = [
  { value: 'EMPLOYEE_CONTINUES_TO_WORK', label: 'They keep working here' },
  { value: 'EMPLOYEE_NO_LONGER_EMPLOYED', label: 'They no longer work here' },
  { value: 'TERMINATED_FOR_FINAL_NONCONFIRMATION', label: 'Employment ended because of the final nonconfirmation' },
  { value: 'INCORRECT_DATA', label: 'The case was opened with wrong information' },
  { value: 'DUPLICATE_CASE', label: 'It duplicates another case' },
];

const day = (ymd: string | null) => (ymd ? fmtDayShort(parseYmd(ymd), { anchored: true }) : null);

export function EVerifyProviderPanel({
  associateId,
  personName,
  canManage,
  onChanged,
  children,
}: {
  associateId: string;
  personName: string;
  canManage: boolean;
  onChanged: () => void;
  /** The manual case recorder: shown as is when nothing is connected, tucked away when the provider holds the case. */
  children?: ReactNode;
}) {
  const qc = useQueryClient();
  const confirm = useSafeConfirm();
  const summary = useQuery({ queryKey: ['providers', 'summary'], queryFn: providerSummary, staleTime: 60_000 });
  const connected = summary.data?.connected.EVERIFY;
  const view = useQuery({ queryKey: ['providers', 'everify', associateId], queryFn: () => everifyProviderView(associateId), enabled: !!connected && canManage });
  const [closure, setClosure] = useState<EVerifyClosure>('EMPLOYEE_CONTINUES_TO_WORK');

  const act = useMutation({
    mutationFn: (fn: () => Promise<EVerifyProviderView>) => fn(),
    onSuccess: (v) => {
      qc.setQueryData(['providers', 'everify', associateId], v);
      onChanged();
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : 'E-Verify didn’t answer. Try again in a moment.');
      void view.refetch();
    },
  });

  if (summary.isLoading) return <Skeleton className="h-16 w-full" />;
  if (!connected) {
    return (
      <>
        {summary.data?.canManageIntegrations && (
          <p className="mb-3 text-xs text-ink-muted">
            Open cases straight from the I-9 by connecting E-Verify in{' '}
            <Link to="/integrations" className="text-accent underline-offset-2 hover:underline">
              Settings &amp; trust → Integrations
            </Link>
            . Until then, record the case below.
          </p>
        )}
        {children}
      </>
    );
  }
  if (!canManage) return <>{children}</>;
  if (view.isLoading || !view.data)
    return (
      <>
        {view.isError ? <ErrorBanner className="mb-3">Couldn’t load the E-Verify case.</ErrorBanner> : <Skeleton className="mb-3 h-24 w-full" />}
        {view.isError && children}
      </>
    );

  const v = view.data;
  const st = v.status ? STATUS[v.status] : null;
  const busy = act.isPending;
  const due = day(v.dueBy);
  const duePassed = v.dueBy ? v.dueBy < new Date().toISOString().slice(0, 10) : false;

  return (
    <>
    <div className="mb-4 space-y-3 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-ink">
          Through <span className="font-medium">{v.connected?.label}</span>
          {v.connected?.environment === 'SANDBOX' && (
            <Badge size="sm" variant="outline" className="ml-2">
              Sandbox
            </Badge>
          )}
        </div>
        {st && (
          <Badge size="sm" variant={st.variant}>
            {st.label}
          </Badge>
        )}
      </div>

      {v.lastError && (
        <ErrorBanner>
          The last try didn’t go through: {v.lastError}
        </ErrorBanner>
      )}

      {!v.caseNumber ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-muted">
            {v.section2Done
              ? 'Section 2 is done. Open the case now — E-Verify wants it within 3 business days of the first day worked.'
              : 'Finish I-9 Section 2 first; E-Verify needs the documents examined.'}
          </p>
          <Button size="sm" onClick={() => act.mutate(() => submitEVerify(associateId))} loading={busy} disabled={!v.section2Done}>
            Open E-Verify case
          </Button>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-ink-muted">Case number</dt>
            <dd className="font-mono text-ink">{v.caseNumber}</dd>
            <dt className="text-ink-muted">Opened</dt>
            <dd className="text-ink">{v.openedAt ? fmtDateTime(v.openedAt) : '—'}</dd>
            {due && (
              <>
                <dt className="text-ink-muted">{duePassed ? 'Was due' : 'Due by'}</dt>
                <dd className="text-ink">{due}</dd>
              </>
            )}
            <dt className="text-ink-muted">Last checked</dt>
            <dd className="text-ink">{v.lastSyncAt ? fmtDateTime(v.lastSyncAt) : '—'}</dd>
          </dl>

          {v.status === 'TENTATIVE_NONCONFIRMATION' && (
            <div className={cn('rounded-md border p-3', v.tnc.decision ? 'border-line' : 'border-alert/40 bg-alert/5')} role={v.tnc.decision ? undefined : 'alert'}>
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-hidden="true" />
                <div className="min-w-0 space-y-2 text-sm">
                  {!v.tnc.decision ? (
                    <>
                      <p className="font-medium text-ink">E-Verify found a mismatch for {personName}.</p>
                      <ol className="list-decimal space-y-1 pl-5 text-ink-muted">
                        <li>Give {personName} the Further Action Notice in private, in a language they read well.</li>
                        <li>Ask whether they will take action to resolve it, and record their answer here.</li>
                        <li>Don’t delay their start, cut hours or treat them differently while the case is open.</li>
                      </ol>
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button size="sm" onClick={() => act.mutate(() => recordEVerifyDecision(associateId, 'CONTEST'))} loading={busy}>
                          They’ll take action
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={async () => {
                            const ok = await confirm({
                              title: `${personName} won’t take action?`,
                              description: 'The mismatch becomes a final nonconfirmation. Only record this if they told you, after receiving the notice, that they won’t contact SSA or DHS.',
                              confirmLabel: 'Record their choice',
                              destructive: true,
                            });
                            if (ok) act.mutate(() => recordEVerifyDecision(associateId, 'NO_CONTEST'));
                          }}
                        >
                          They won’t take action
                        </Button>
                      </div>
                    </>
                  ) : v.tnc.decision === 'CONTEST' ? (
                    <p className="text-ink">
                      Referred {v.tnc.referredAt ? fmtDateTime(v.tnc.referredAt) : ''}. {personName} has until{' '}
                      <span className="font-medium">{day(v.tnc.referralDeadline) ?? 'the deadline'}</span> — 8 federal working days — to contact SSA or DHS.
                      They keep working meanwhile.
                    </p>
                  ) : (
                    <p className="text-ink">{personName} chose not to take action. Close the case below.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {v.status === 'EMPLOYMENT_AUTHORIZED' && !v.closureReason && (
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {personName} is authorized to work. Nothing more to do.
            </p>
          )}

          <div className="flex flex-wrap items-end gap-2">
            {!v.closedAt && (
              <Button size="sm" variant="ghost" onClick={() => act.mutate(() => refreshEVerify(associateId))} loading={busy}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Check for a result
              </Button>
            )}
          </div>

          {(v.status === 'FINAL_NONCONFIRMATION' || v.status === 'CLOSE_CASE_AND_RESUBMIT' || (v.tnc.decision === 'NO_CONTEST' && !v.closureReason)) && !v.closureReason && (
            <div className="space-y-2 border-t border-line pt-3">
              <label htmlFor={`ev-close-${associateId}`} className="text-sm font-medium text-ink">
                Close the case
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select id={`ev-close-${associateId}`} value={closure} onChange={(e) => setClosure(e.target.value as EVerifyClosure)} className="sm:flex-1">
                  {CLOSURE.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant="outline" onClick={() => act.mutate(() => closeEVerify(associateId, closure))} loading={busy}>
                  Close case
                </Button>
              </div>
            </div>
          )}
          {v.closureReason && <p className="text-xs text-ink-muted">Closed — {CLOSURE.find((c) => c.value === v.closureReason)?.label.toLowerCase() ?? 'recorded'}.</p>}
        </>
      )}
    </div>
    {children && (
      <details className="group mb-2">
        <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink coarse:min-h-11">Record a case by hand instead</summary>
        <div className="mt-3">{children}</div>
      </details>
    )}
    </>
  );
}
