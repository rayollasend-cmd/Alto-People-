import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { createProviderConnection, testProviderConnection, type ProviderInfo, type ProviderKind } from '@/lib/providersApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { cn } from '@/lib/cn';
import { CopyValue, kindLook, titleInSentence } from './providerShared';

/**
 * Connect a provider for one kind, in three steps on one panel:
 *   1. which provider (what it does; whether it needs a partner agreement)
 *   2. its setup steps and credentials, sandbox or live
 *   3. saved → tested at once → the result, and for providers that sign
 *      with a shared secret, the webhook address and secret (shown once).
 */
export function ProviderSetupDrawer({
  kind,
  providers,
  onClose,
  onSaved,
}: {
  kind: ProviderKind | null;
  providers: ProviderInfo[];
  onClose: () => void;
  onSaved: (connectionId: string) => void;
}) {
  const [providerId, setProviderId] = useState<string>('');
  const [environment, setEnvironment] = useState<'SANDBOX' | 'PRODUCTION'>('SANDBOX');
  const [values, setValues] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ id: string; ok: boolean; message: string | null; secret: string | null; webhookUrl: string | null } | null>(null);

  useEffect(() => {
    if (!kind) return;
    setProviderId(providers.length === 1 ? providers[0]!.id : '');
    setEnvironment('SANDBOX');
    setValues({});
    setSettings({});
    setResult(null);
  }, [kind, providers]);

  const info = useMemo(() => providers.find((p) => p.id === providerId) ?? null, [providers, providerId]);
  const missing = info ? info.credentialFields.filter((f) => !f.optional && !values[f.key]?.trim()) : [];

  const save = useMutation({
    mutationFn: async () => {
      const made = await createProviderConnection({
        kind: kind!,
        provider: info!.id,
        environment,
        credentials: values,
        settings: Object.fromEntries(Object.entries(settings).filter(([, v]) => v.trim())),
      });
      const tested = await testProviderConnection(made.connection.id).catch(() => ({ ok: false, message: 'The test couldn’t run.' }));
      return { id: made.connection.id, ok: tested.ok, message: tested.message, secret: made.webhookSecret, webhookUrl: made.connection.webhookUrl };
    },
    onSuccess: (r) => setResult(r),
  });

  const open = kind !== null;
  const copy = kind ? kindLook(kind).copy : null;

  return (
    <Drawer open={open} onOpenChange={(o) => !o && (result ? onSaved(result.id) : onClose())} width="max-w-lg" confirmDiscard={!result && Object.values(values).some((v) => v.trim())}>
      <DrawerHeader>
        <DrawerTitle>Set up {copy ? titleInSentence(copy.title) : ''}</DrawerTitle>
        <DrawerDescription>{copy?.connected}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-5">
        {result ? (
          <div className="space-y-4">
            <div className={cn('flex items-start gap-3 rounded-lg border p-4', result.ok ? 'border-success/40 bg-success/10' : 'border-alert/40 bg-alert/10')} role="status">
              {result.ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" /> : <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-alert" aria-hidden="true" />}
              <div className="text-sm text-ink">
                <p className="font-medium">{result.ok ? `Connected to ${info?.label}.` : 'Saved, but the test didn’t pass.'}</p>
                <p className="mt-1 text-ink-muted">
                  {result.ok ? 'We reached the provider with these credentials.' : `${result.message ?? 'The provider didn’t answer.'} You can fix the credentials from Manage and test again.`}
                </p>
              </div>
            </div>
            {result.webhookUrl && (
              <div className="space-y-3 rounded-lg border border-line p-4">
                <p className="text-sm font-medium text-ink">Give the provider these, so its updates reach this workspace</p>
                <CopyValue label="Webhook address" value={result.webhookUrl} />
                {result.secret && (
                  <>
                    <CopyValue label="Webhook secret" value={result.secret} />
                    <p className="text-xs text-warning">Copy the secret now — for your security it won’t be shown again. You can make a new one later.</p>
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            {providers.length > 1 && (
              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-medium text-ink">Provider</legend>
                {providers.map((p) => (
                  <label
                    key={p.id}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors coarse:min-h-12',
                      providerId === p.id ? 'border-accent bg-accent-fill/10' : 'border-line hover:bg-surface-raised',
                    )}
                  >
                    <input type="radio" name="provider" className="mt-1 h-4 w-4" checked={providerId === p.id} onChange={() => setProviderId(p.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">{p.label}</span>
                        {p.confidence === 'partner' && (
                          <Badge size="sm" variant="outline">
                            Needs a partner agreement
                          </Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-muted">{p.what}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {info && (
              <>
                <div className="rounded-lg bg-surface-raised p-4">
                  <p className="mb-2 text-sm font-medium text-ink">Before you start</p>
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-muted">
                    {info.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                  {info.confidence === 'partner' && (
                    <p className="mt-3 text-xs text-ink-muted">This provider gives API access under a partner agreement. Test in the sandbox first; if something doesn’t match your agreement, the manual path keeps working.</p>
                  )}
                </div>
                <div>
                  <div className="mb-1.5 text-sm font-medium text-ink">Environment</div>
                  <SegmentedControl
                    ariaLabel="Environment"
                    value={environment}
                    onChange={setEnvironment}
                    options={[
                      { value: 'SANDBOX', label: 'Sandbox' },
                      { value: 'PRODUCTION', label: 'Live' },
                    ]}
                  />
                  <p className="mt-1.5 text-xs text-ink-muted">{environment === 'SANDBOX' ? 'Test credentials. Nothing real is ordered, filed or paid.' : 'Real orders, filings and payments. Use live credentials.'}</p>
                </div>
                <div className="space-y-3">
                  {info.credentialFields.map((f) => (
                    <Field key={f.key} label={f.label} required={!f.optional} hint={f.hint}>
                      {(p) => (
                        <Input
                          {...p}
                          type={f.secret ? 'password' : 'text'}
                          autoComplete="off"
                          value={values[f.key] ?? ''}
                          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        />
                      )}
                    </Field>
                  ))}
                  {info.settingFields.map((f) => (
                    <Field key={f.key} label={f.label} hint={f.hint}>
                      {(p) => <Input {...p} value={settings[f.key] ?? ''} onChange={(e) => setSettings((v) => ({ ...v, [f.key]: e.target.value }))} />}
                    </Field>
                  ))}
                </div>
              </>
            )}
            {save.isError && <ErrorBanner>{save.error instanceof ApiError ? save.error.message : 'Couldn’t save the connection.'}</ErrorBanner>}
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        {result ? (
          <Button onClick={() => onSaved(result.id)}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!info || missing.length > 0}>
              {save.isPending ? 'Connecting and testing…' : 'Connect and test'}
            </Button>
          </>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
