import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  deleteProviderConnection,
  patchProviderConnection,
  providerEvents,
  rotateProviderSecret,
  testProviderConnection,
  type ProviderConnection,
  type ProviderEventRow,
  type ProviderInfo,
} from '@/lib/providersApi';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Activity } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { CopyValue, HEALTH_BADGE, TechnicalDetail, WHAT_TO_DO, apiErrorDetail, kindLook, environmentLabel, healthLine, useSafeConfirm } from './providerShared';

/**
 * One connection: how it is doing (and what to do when it isn't), a test
 * button, sandbox ↔ live, pause, credentials (blank keeps what's stored),
 * the webhook address and secret, and the recent activity.
 */

const EVENT_LABEL: Record<string, string> = {
  'connection.test': 'Connection test',
  'case.created': 'E-Verify case opened',
  'case.updated': 'E-Verify case updated',
  'order.created': 'Order placed',
  'order.updated': 'Order updated',
  'return.transmitted': 'Return e-filed',
  'efile.status_change': 'Agency answered',
  'transfers#state-change': 'Transfer update',
  'report.completed': 'Report ready',
  'report.updated': 'Report updated',
  'invitation.completed': 'Person finished the invitation',
};

const EVENT_STATUS: Record<ProviderEventRow['status'], { label: string; variant: 'success' | 'destructive' | 'outline' | 'pending' }> = {
  PROCESSED: { label: 'Done', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  IGNORED: { label: 'Not ours', variant: 'outline' },
  RECEIVED: { label: 'Received', variant: 'pending' },
};

export function ProviderManageDrawer({
  connection,
  info,
  canManage,
  onClose,
  onChanged,
}: {
  connection: ProviderConnection | null;
  info: ProviderInfo | null;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const confirm = useSafeConfirm();
  const [values, setValues] = useState<Record<string, string>>({});
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const c = connection;

  useEffect(() => {
    setValues({});
    setNewSecret(null);
  }, [c?.id]);

  const events = useQuery({ queryKey: ['providers', 'events', c?.id], queryFn: () => providerEvents(c!.id), enabled: !!c });

  // The last test's technical text, for the "Technical details" fold — the toast says the plain sentence.
  const [testDetail, setTestDetail] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: () => testProviderConnection(c!.id),
    onSuccess: (r) => {
      onChanged();
      void events.refetch();
      setTestDetail(r.ok ? null : (r.detail ?? null));
      if (r.ok) toast.success('The provider answered. The connection works.');
      else toast.error(r.message ?? 'The test didn’t pass.');
    },
    onError: (e) => {
      setTestDetail(apiErrorDetail(e));
      toast.error(e instanceof ApiError ? e.message : 'The test couldn’t run.');
    },
  });
  const patch = useMutation({
    mutationFn: (body: Parameters<typeof patchProviderConnection>[1]) => patchProviderConnection(c!.id, body),
    onSuccess: () => {
      onChanged();
      setValues({});
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Couldn’t save.'),
  });
  const rotate = useMutation({
    mutationFn: () => rotateProviderSecret(c!.id),
    onSuccess: (r) => setNewSecret(r.webhookSecret),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Couldn’t make a new secret.'),
  });
  const remove = useMutation({
    mutationFn: () => deleteProviderConnection(c!.id),
    onSuccess: () => {
      toast.success('Disconnected. The work is recorded by hand again.');
      onChanged();
      onClose();
    },
  });

  if (!c) return <Drawer open={false} onOpenChange={() => undefined}>{null}</Drawer>;
  const badge = HEALTH_BADGE[c.health];
  const copy = kindLook(c.kind).copy;
  const dirty = Object.values(values).some((v) => v.trim());

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-lg" confirmDiscard={dirty}>
      <DrawerHeader>
        <DrawerTitle>{c.providerLabel}</DrawerTitle>
        <DrawerDescription>
          {copy.title} · {environmentLabel(c.environment)}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-6">
        <section aria-labelledby="pc-health" className={cn('rounded-lg border p-4', c.health === 'failing' ? 'border-alert/40 bg-alert/5' : 'border-line')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="pc-health" className="text-sm font-medium text-ink">
              How it’s doing
            </h3>
            <Badge size="sm" variant={badge.variant}>
              {badge.label}
            </Badge>
          </div>
          <p className={cn('mt-2 text-sm', c.health === 'failing' ? 'text-ink' : 'text-ink-muted')}>{healthLine(c)}</p>
          {(c.health === 'failing' || testDetail) && <TechnicalDetail detail={testDetail ?? c.lastErrorDetail} className="mt-1" />}
          {c.health === 'failing' && <p className="mt-2 text-sm text-ink-muted">{WHAT_TO_DO}</p>}
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-ink-muted">Last success</dt>
            <dd className="text-ink">{c.lastSuccessAt ? fmtDateTime(c.lastSuccessAt) : 'Not yet'}</dd>
            <dt className="text-ink-muted">Last error</dt>
            <dd className="text-ink">{c.lastErrorAt ? fmtDateTime(c.lastErrorAt) : 'None'}</dd>
            <dt className="text-ink-muted">Last test</dt>
            <dd className="text-ink">{c.lastTestAt ? `${fmtDateTime(c.lastTestAt)} — ${c.lastTestOk ? 'passed' : 'failed'}` : 'Not tested'}</dd>
          </dl>
          {canManage && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
                {test.isPending ? 'Testing…' : 'Test connection'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => patch.mutate({ active: !c.active })} loading={patch.isPending && patch.variables?.active !== undefined}>
                {c.active ? 'Pause' : 'Resume'}
              </Button>
            </div>
          )}
        </section>

        {canManage && (
          <section aria-labelledby="pc-env" className="space-y-2">
            <h3 id="pc-env" className="text-sm font-medium text-ink">
              Environment
            </h3>
            <p className="text-sm text-ink-muted">
              {c.environment === 'SANDBOX' ? 'Sandbox: nothing real is ordered, filed or paid.' : 'Live: real orders, filings and payments.'}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const toLive = c.environment === 'SANDBOX';
                const ok = await confirm({
                  title: toLive ? 'Go live?' : 'Switch back to the sandbox?',
                  description: toLive
                    ? 'From now on orders, filings and payments are real. Use live credentials, and test the connection right after.'
                    : 'Nothing real will be sent until you go live again.',
                  confirmLabel: toLive ? 'Go live' : 'Use the sandbox',
                });
                if (ok) patch.mutate({ environment: toLive ? 'PRODUCTION' : 'SANDBOX' });
              }}
            >
              {c.environment === 'SANDBOX' ? 'Go live' : 'Switch to sandbox'}
            </Button>
          </section>
        )}

        {canManage && info && (
          <section aria-labelledby="pc-creds" className="space-y-3">
            <h3 id="pc-creds" className="text-sm font-medium text-ink">
              Credentials
            </h3>
            <p className="text-xs text-ink-muted">Stored encrypted. Leave a field blank to keep what’s saved.</p>
            {info.credentialFields.map((f) => (
              <Field key={f.key} label={f.label} hint={f.secret ? (c.credentialsSet[f.key] ? 'Saved — type a new value to replace it.' : 'Not saved yet.') : f.hint}>
                {(p) => (
                  <Input
                    {...p}
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    placeholder={f.secret ? (c.credentialsSet[f.key] ? '••••••••' : '') : c.credentialValues[f.key] || ''}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
            <Button size="sm" onClick={() => patch.mutate({ credentials: values })} disabled={!dirty} loading={patch.isPending && !!patch.variables?.credentials}>
              Save credentials
            </Button>
          </section>
        )}

        {c.webhookUrl && (
          <section aria-labelledby="pc-hook" className="space-y-3">
            <h3 id="pc-hook" className="text-sm font-medium text-ink">
              Updates from the provider
            </h3>
            <p className="text-xs text-ink-muted">{info?.webhook.how}</p>
            <CopyValue label="Webhook address" value={c.webhookUrl} />
            {newSecret ? (
              <>
                <CopyValue label="New webhook secret" value={newSecret} />
                <p className="text-xs text-warning">Copy it into the provider now — it won’t be shown again. The old secret stops working.</p>
              </>
            ) : (
              c.webhookSecretSet &&
              canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  loading={rotate.isPending}
                  onClick={async () => {
                    const ok = await confirm({ title: 'Make a new webhook secret?', description: 'Updates signed with the old secret will be refused until you paste the new one into the provider.', confirmLabel: 'Make a new secret' });
                    if (ok) rotate.mutate();
                  }}
                >
                  Make a new secret
                </Button>
              )
            )}
          </section>
        )}

        <section aria-labelledby="pc-activity" className="space-y-2">
          <h3 id="pc-activity" className="text-sm font-medium text-ink">
            Recent activity
          </h3>
          {events.isError ? (
            <ErrorBanner>Couldn’t load the activity.</ErrorBanner>
          ) : events.isLoading ? (
            <SkeletonRows count={3} />
          ) : (events.data?.events ?? []).length === 0 ? (
            <EmptyState icon={Activity} title="Nothing yet" description="Tests, orders and the provider’s updates appear here." />
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {events.data!.events.map((e) => {
                const st = EVENT_STATUS[e.status];
                return (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink">{EVENT_LABEL[e.eventType] ?? 'Provider update'}</span>
                      <span className="block truncate text-xs text-ink-muted">
                        {e.direction === 'IN' ? 'From the provider' : 'Sent from here'} · {fmtDateTime(e.createdAt)}
                        {e.error && e.status === 'FAILED' ? ` · ${e.error}` : ''}
                      </span>
                    </span>
                    <Badge size="sm" variant={st.variant}>
                      {st.label}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </DrawerBody>
      {canManage && (
        <DrawerFooter>
          <Button
            variant="ghost"
            className="text-alert"
            loading={remove.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: `Disconnect ${c.providerLabel}?`,
                description: 'Nothing already recorded changes. New work goes back to being recorded by hand, and the provider’s updates will be refused.',
                confirmLabel: 'Disconnect',
                destructive: true,
              });
              if (ok) remove.mutate();
            }}
          >
            Disconnect
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </DrawerFooter>
      )}
    </Drawer>
  );
}
