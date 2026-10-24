import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDateTime, fmtDayShort } from '@/lib/format';
import { drugProviderView, orderDrug, providerSummary, refreshDrug, type DrugProviderView, type DrugReason } from '@/lib/providersApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { CopyValue } from '@/pages/integrations/providers/providerShared';

/**
 * The drug test through the connected lab: order it (the person gets a
 * donor pass with the nearest collection site and a deadline), then the
 * result. A non-negative is never final until a Medical Review Officer
 * has verified it — the screen says so instead of showing "failed".
 */

const REASONS: Array<{ value: DrugReason; label: string }> = [
  { value: 'PRE_EMPLOYMENT', label: 'Before they start' },
  { value: 'RANDOM', label: 'Random selection' },
  { value: 'POST_ACCIDENT', label: 'After an accident' },
  { value: 'REASONABLE_SUSPICION', label: 'Reasonable suspicion' },
  { value: 'RETURN_TO_DUTY', label: 'Returning to duty' },
  { value: 'FOLLOW_UP', label: 'Follow-up' },
];

function resultLine(v: DrugProviderView): { text: string; variant: 'success' | 'destructive' | 'pending' } | null {
  if (v.resultCode === 'NEGATIVE') return { text: 'Negative', variant: 'success' };
  if (v.resultCode === 'POSITIVE') return v.mroVerifiedAt ? { text: 'Positive, verified by the MRO', variant: 'destructive' } : { text: 'Not negative — waiting for the Medical Review Officer', variant: 'pending' };
  if (v.resultCode === 'DILUTE') return { text: 'Dilute — a retest is usually needed', variant: 'pending' };
  if (v.resultCode === 'CANCELLED') return { text: 'Cancelled by the lab', variant: 'pending' };
  return null;
}

export function DrugProviderPanel({ testId, personName, canManage, onChanged }: { testId: string; personName: string; canManage: boolean; onChanged: () => void }) {
  const qc = useQueryClient();
  const summary = useQuery({ queryKey: ['providers', 'summary'], queryFn: providerSummary, staleTime: 60_000 });
  const connected = summary.data?.connected.DRUG_TEST;
  const view = useQuery({ queryKey: ['providers', 'drug', testId], queryFn: () => drugProviderView(testId), enabled: !!connected });
  const [reason, setReason] = useState<DrugReason>('PRE_EMPLOYMENT');
  const [panel, setPanel] = useState('');

  const act = useMutation({
    mutationFn: (fn: () => Promise<DrugProviderView>) => fn(),
    onSuccess: (v) => {
      qc.setQueryData(['providers', 'drug', testId], v);
      onChanged();
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : 'The lab didn’t answer. Try again in a moment.');
      void view.refetch();
    },
  });

  if (summary.isLoading) return <Skeleton className="mt-5 h-16 w-full" />;
  if (!connected) {
    return summary.data?.canManageIntegrations ? (
      <p className="mt-5 text-xs text-ink-muted">
        Order tests from here by connecting a lab in{' '}
        <Link to="/integrations" className="text-accent underline-offset-2 hover:underline">
          Settings &amp; trust → Integrations
        </Link>
        .
      </p>
    ) : null;
  }
  if (view.isError) return <ErrorBanner className="mt-5">Couldn’t load the test from the lab.</ErrorBanner>;
  if (!view.data) return <Skeleton className="mt-5 h-24 w-full" />;

  const v = view.data;
  const busy = act.isPending;
  const r = resultLine(v);
  const passExpired = v.donorPassExpiresAt ? new Date(v.donorPassExpiresAt).getTime() < Date.now() : false;

  return (
    <section aria-labelledby={`dt-prov-${testId}`} className="mt-6 space-y-3 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`dt-prov-${testId}`} className="text-sm font-medium text-ink">
          Through {v.connected?.label}
          {v.connected?.environment === 'SANDBOX' && (
            <Badge size="sm" variant="outline" className="ml-2">
              Sandbox
            </Badge>
          )}
        </h3>
        {r && (
          <Badge size="sm" variant={r.variant}>
            {r.text}
          </Badge>
        )}
      </div>
      {v.lastError && <ErrorBanner>The last try didn’t go through: {v.lastError}</ErrorBanner>}

      {!v.ordered ? (
        canManage ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">{personName} gets a donor pass by email with the nearest collection site and how long it’s valid.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Reason">
                {(p) => (
                  <Select {...p} value={reason} onChange={(e) => setReason(e.target.value as DrugReason)}>
                    {REASONS.map((x) => (
                      <option key={x.value} value={x.value}>
                        {x.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Panel" hint="Leave blank for the default panel.">
                {(p) => <Input {...p} value={panel} onChange={(e) => setPanel(e.target.value)} placeholder="Default panel" />}
              </Field>
            </div>
            <Button size="sm" onClick={() => act.mutate(() => orderDrug(testId, { reason, panel: panel.trim() || undefined }))} loading={busy}>
              Order the test
            </Button>
          </div>
        ) : (
          <p className="text-sm text-ink-muted">Not ordered through the lab yet.</p>
        )
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-ink-muted">Reason</dt>
            <dd className="text-ink">{REASONS.find((x) => x.value === v.reason)?.label ?? '—'}</dd>
            <dt className="text-ink-muted">Panel</dt>
            <dd className="text-ink">{v.panelCode ?? '—'}</dd>
            {v.collectionSite && (
              <>
                <dt className="text-ink-muted">Collection site</dt>
                <dd className="text-ink">{v.collectionSite}</dd>
              </>
            )}
            {v.donorPassExpiresAt && (
              <>
                <dt className="text-ink-muted">Collect by</dt>
                <dd className={passExpired && !v.resultCode ? 'text-alert' : 'text-ink'}>
                  {fmtDayShort(v.donorPassExpiresAt)}
                  {passExpired && !v.resultCode ? ' — expired, order again' : ''}
                </dd>
              </>
            )}
            <dt className="text-ink-muted">Last checked</dt>
            <dd className="text-ink">{v.lastSyncAt ? fmtDateTime(v.lastSyncAt) : '—'}</dd>
          </dl>
          {v.donorPassUrl && !v.resultCode && <CopyValue label="Donor pass link (if they lost the email)" value={v.donorPassUrl} />}
          {v.resultCode === 'POSITIVE' && !v.mroVerifiedAt && (
            <p className="text-xs text-ink-muted">The Medical Review Officer contacts {personName} first — they may have a prescription that explains it. Don’t act on this result until it’s verified.</p>
          )}
          {canManage && (!v.resultCode || (v.resultCode === 'POSITIVE' && !v.mroVerifiedAt)) && (
            <Button size="sm" variant="ghost" onClick={() => act.mutate(() => refreshDrug(testId))} loading={busy}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Check for a result
            </Button>
          )}
        </>
      )}
    </section>
  );
}
