import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDateTime, fmtDayShort } from '@/lib/format';
import {
  backgroundProviderView,
  orderBackground,
  providerSummary,
  refreshBackground,
  sendFinalAdverse,
  startPreAdverse,
  withdrawAdverse,
  type BackgroundProviderView,
} from '@/lib/providersApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { CopyValue, useSafeConfirm } from '@/pages/integrations/providers/providerShared';

/**
 * The background check through the connected provider: order it (the
 * person gets the provider's invitation to consent and fill in their
 * details), follow the report, and — when a report comes back "consider" —
 * the FCRA steps: the pre-adverse notice, a waiting period for the person
 * to respond, and only then the final notice. The manual transitions in
 * the drawer footer stay for checks run outside the connection.
 */

const STAGE: Record<string, string> = {
  pending: 'Invitation sent',
  invited: 'Invitation sent',
  completed: 'Person submitted their details',
  complete: 'Report ready',
  suspended: 'On hold at the provider',
  paused: 'On hold at the provider',
  dispute: 'The person is disputing the report',
  canceled: 'Cancelled',
  expired: 'Invitation expired',
};

export function BackgroundProviderPanel({ checkId, personName, canManage, onCleared, onChanged }: { checkId: string; personName: string; canManage: boolean; onCleared: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const confirm = useSafeConfirm();
  const summary = useQuery({ queryKey: ['providers', 'summary'], queryFn: providerSummary, staleTime: 60_000 });
  const connected = summary.data?.connected.BACKGROUND_CHECK;
  const view = useQuery({ queryKey: ['providers', 'background', checkId], queryFn: () => backgroundProviderView(checkId), enabled: !!connected });
  const [pkg, setPkg] = useState('');

  const act = useMutation({
    mutationFn: (fn: () => Promise<BackgroundProviderView>) => fn(),
    onSuccess: (v) => {
      qc.setQueryData(['providers', 'background', checkId], v);
      onChanged();
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : 'The provider didn’t answer. Try again in a moment.');
      void view.refetch();
    },
  });

  if (summary.isLoading) return <Skeleton className="mt-5 h-16 w-full" />;
  if (!connected) {
    return summary.data?.canManageIntegrations ? (
      <p className="mt-5 text-xs text-ink-muted">
        Order checks from here by connecting a screening provider in{' '}
        <Link to="/integrations" className="text-accent underline-offset-2 hover:underline">
          Settings &amp; trust → Integrations
        </Link>
        .
      </p>
    ) : null;
  }
  if (view.isError) return <ErrorBanner className="mt-5">Couldn’t load the check from the provider.</ErrorBanner>;
  if (!view.data) return <Skeleton className="mt-5 h-24 w-full" />;

  const v = view.data;
  const busy = act.isPending;
  const waitDay = v.adverseWaitUntil ? fmtDayShort(v.adverseWaitUntil, { year: false }) : null;

  return (
    <section aria-labelledby={`bg-prov-${checkId}`} className="mt-6 space-y-3 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`bg-prov-${checkId}`} className="text-sm font-medium text-ink">
          Through {v.connected?.label}
          {v.connected?.environment === 'SANDBOX' && (
            <Badge size="sm" variant="outline" className="ml-2">
              Sandbox
            </Badge>
          )}
        </h3>
        {v.ordered && v.rawStatus && (
          <Badge size="sm" variant={v.result === 'consider' ? 'destructive' : v.result === 'clear' ? 'success' : 'pending'}>
            {v.result === 'clear' ? 'Clear' : v.result === 'consider' ? 'Needs a decision' : (STAGE[v.rawStatus] ?? 'In progress')}
          </Badge>
        )}
      </div>

      {v.lastError && <ErrorBanner>The last try didn’t go through: {v.lastError}</ErrorBanner>}

      {!v.ordered ? (
        canManage ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">{personName} gets an email from {v.connected?.label} to consent and fill in their details. The report comes back here on its own.</p>
            <Field label="Package" hint="Leave blank to use the package set for this client or position.">
              {(p) => <Input {...p} value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="Default package" />}
            </Field>
            <Button size="sm" onClick={() => act.mutate(() => orderBackground(checkId, pkg.trim() || undefined))} loading={busy}>
              Order the check
            </Button>
          </div>
        ) : (
          <p className="text-sm text-ink-muted">Not ordered through the provider yet.</p>
        )
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-ink-muted">Package</dt>
            <dd className="text-ink">{v.packageCode ?? '—'}</dd>
            <dt className="text-ink-muted">Where it stands</dt>
            <dd className="text-ink">{v.rawStatus ? (STAGE[v.rawStatus] ?? 'In progress') : '—'}</dd>
            <dt className="text-ink-muted">Last checked</dt>
            <dd className="text-ink">{v.lastSyncAt ? fmtDateTime(v.lastSyncAt) : '—'}</dd>
          </dl>
          {v.invitationUrl && !v.result && <CopyValue label="Invitation link (if they lost the email)" value={v.invitationUrl} />}

          {v.result === 'consider' && !v.adjudication && canManage && (
            <div className="rounded-md border border-alert/40 bg-alert/5 p-3" role="alert">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-hidden="true" />
                <div className="space-y-2 text-sm">
                  <p className="font-medium text-ink">The report came back “consider”. That isn’t a no.</p>
                  <p className="text-ink-muted">
                    Read the report, then decide. To decide against {personName}, the law asks for two notices: a pre-adverse notice with the report and a summary of their rights, a waiting period for them to respond, and then the final notice.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={onCleared} disabled={busy}>
                      Clear to work
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Send the pre-adverse notice?',
                          description: `${v.connected?.label} sends ${personName} the notice, a copy of the report and their rights. They then have at least 7 days to respond before any final decision.`,
                          confirmLabel: 'Send pre-adverse notice',
                        });
                        if (ok) act.mutate(() => startPreAdverse(checkId));
                      }}
                    >
                      Start adverse action
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {v.adjudication === 'PRE_ADVERSE' && (
            <div className="space-y-2 rounded-md border border-line p-3 text-sm">
              <p className="text-ink">
                Pre-adverse notice sent {v.preAdverseSentAt ? fmtDateTime(v.preAdverseSentAt) : ''}. {personName} has until <span className="font-medium">{waitDay}</span> to respond or dispute the report.
              </p>
              {canManage && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => act.mutate(() => withdrawAdverse(checkId))} loading={busy}>
                    Withdraw — clear them
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!v.canSendFinal || busy}
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Send the final adverse action notice?',
                        description: `This ends ${personName}’s application on the strength of the report. Only send it after reviewing anything they sent back.`,
                        confirmLabel: 'Send final notice',
                        destructive: true,
                      });
                      if (ok) act.mutate(() => sendFinalAdverse(checkId));
                    }}
                  >
                    {v.canSendFinal ? 'Send final notice' : `Final notice from ${waitDay}`}
                  </Button>
                </div>
              )}
            </div>
          )}
          {v.adjudication === 'ADVERSE' && <p className="text-sm text-ink-muted">Final adverse action notice sent {v.adverseSentAt ? fmtDateTime(v.adverseSentAt) : ''}.</p>}

          {canManage && !v.adjudication && v.result !== 'clear' && (
            <Button size="sm" variant="ghost" onClick={() => act.mutate(() => refreshBackground(checkId))} loading={busy}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Check for an update
            </Button>
          )}
        </>
      )}
    </section>
  );
}
