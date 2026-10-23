import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Globe, KeyRound, Plus, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import {
  addDomain,
  createConnection,
  createSamlConnection,
  updateSamlConnection,
  getIdentity,
  issueScimToken,
  releaseDomain,
  revokeScimToken,
  updateConnection,
  verifyDomain,
  type IdentityConnectionRow,
} from '@/lib/identityApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { SecurityPolicyCard } from '@/components/admin/SecurityPolicyCard';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { DirectoryGroups } from './DirectoryGroups';
import { TwoStepSection } from './TwoStepSection';

/**
 * Brief 2-3 step 2 — Sign-in: the organization's own identity provider
 * (OIDC: Okta, Entra, Google…), the email domains that lead people to it
 * from the login page, and the SCIM tokens its directory provisions with.
 * Secrets are write-only: a client secret is sealed on save and never shown
 * again; a SCIM token is shown once.
 */

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong.');

function copy(text: string) {
  void navigator.clipboard.writeText(text);
  toast.success('Copied.');
}

function ConnectionDrawer({ existing, onClose, onSaved }: { existing: IdentityConnectionRow | null; onClose: () => void; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [buttonLabel, setButtonLabel] = useState(existing?.buttonLabel ?? '');
  const [issuerUrl, setIssuerUrl] = useState(existing?.issuerUrl ?? '');
  const [clientId, setClientId] = useState(existing?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [jitPolicy, setJitPolicy] = useState<'NONE' | 'INVITED_ONLY'>(existing?.jitPolicy ?? 'INVITED_ONLY');
  const [ssoRequiredForStaff, setSsoRequired] = useState(existing?.ssoRequiredForStaff ?? false);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const body = { displayName: displayName.trim(), buttonLabel: buttonLabel.trim() || null, issuerUrl: issuerUrl.trim(), clientId: clientId.trim(), jitPolicy, ssoRequiredForStaff, enabled };
      if (existing) await updateConnection(existing.id, { ...body, ...(clientSecret ? { clientSecret } : {}) });
      else await createConnection({ ...body, clientSecret });
      toast.success('Saved.');
      onSaved();
    } catch (err) {
      toast.error(message(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{existing ? existing.displayName : 'New sign-in'}</DrawerTitle>
        <DrawerDescription>
          Register Alto People in your identity provider with the redirect address <code className="text-white">{`${window.location.origin}/api/auth/oidc/callback`}</code>.
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <Field label="Name" required>{(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} placeholder="Okta" />}</Field>
        <Field label="Button" hint="What the login page’s button says.">{(p) => <Input {...p} value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} maxLength={80} placeholder="Continue with Okta" />}</Field>
        <Field label="Issuer URL" required hint="https only; its /.well-known/openid-configuration must answer.">{(p) => <Input {...p} value={issuerUrl} onChange={(e) => setIssuerUrl(e.target.value)} placeholder="https://acme.okta.com" />}</Field>
        <Field label="Client ID" required>{(p) => <Input {...p} value={clientId} onChange={(e) => setClientId(e.target.value)} />}</Field>
        <Field label={existing ? 'New client secret' : 'Client secret'} required={!existing} hint={existing ? 'Leave empty to keep the current one; it is never shown.' : 'Sealed on save and never shown again.'}>
          {(p) => <Input {...p} type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />}
        </Field>
        <Field label="Invited people" hint="Sign-in never creates accounts; an invite or your directory (SCIM) does.">
          {(p) => (
            <Select {...p} value={jitPolicy} onChange={(e) => setJitPolicy(e.target.value as 'NONE' | 'INVITED_ONLY')}>
              <option value="INVITED_ONLY">Activate an invited account on its first sign-in</option>
              <option value="NONE">Only accounts already active may sign in</option>
            </Select>
          )}
        </Field>
        <label className="flex items-start gap-2 text-sm text-white">
          <input type="checkbox" className="mt-1" checked={ssoRequiredForStaff} onChange={(e) => setSsoRequired(e.target.checked)} />
          <span>
            Staff must use this sign-in
            <span className="block text-xs text-silver">Passwords stop working for everyone but associates; passkeys keep working.</span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-white">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          On
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={saving || !displayName.trim() || !issuerUrl.trim() || !clientId.trim() || (!existing && !clientSecret)} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function SamlDrawer({ existing, onClose, onSaved }: { existing: IdentityConnectionRow | null; onClose: () => void; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [buttonLabel, setButtonLabel] = useState(existing?.buttonLabel ?? '');
  const [ssoUrl, setSsoUrl] = useState(existing?.issuerUrl ?? '');
  const [idpEntityId, setIdpEntityId] = useState(existing?.clientId ?? '');
  const [idpCert, setIdpCert] = useState('');
  const [allowIdpInitiated, setAllowIdp] = useState(existing?.allowIdpInitiated ?? false);
  const [ssoRequiredForStaff, setSsoRequired] = useState(existing?.ssoRequiredForStaff ?? false);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const body = { displayName: displayName.trim(), buttonLabel: buttonLabel.trim() || null, ssoUrl: ssoUrl.trim(), idpEntityId: idpEntityId.trim(), allowIdpInitiated, ssoRequiredForStaff, enabled, jitPolicy: 'INVITED_ONLY' as const };
      if (existing) await updateSamlConnection(existing.id, { ...body, ...(idpCert.trim() ? { idpCert: idpCert.trim() } : {}) });
      else await createSamlConnection({ ...body, idpCert: idpCert.trim() });
      toast.success('Saved.');
      onSaved();
    } catch (err) {
      toast.error(message(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{existing ? existing.displayName : 'New SAML sign-in'}</DrawerTitle>
        <DrawerDescription>
          {existing?.acsUrl ? (
            <>
              In your identity provider: single sign-on URL <code className="break-all text-white">{existing.acsUrl}</code>, audience (entity id) <code className="break-all text-white">{existing.spEntityId}</code>. Metadata:{' '}
              <a className="underline" href={existing.metadataUrl} target="_blank" rel="noreferrer">download</a>.
            </>
          ) : (
            'Save first; the sign-on URL and audience to enter in your identity provider appear here.'
          )}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <Field label="Name" required>{(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} placeholder="Okta" />}</Field>
        <Field label="Button">{(p) => <Input {...p} value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} maxLength={80} placeholder="Continue with Okta" />}</Field>
        <Field label="Identity provider sign-on URL" required>{(p) => <Input {...p} value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} placeholder="https://acme.okta.com/app/…/sso/saml" />}</Field>
        <Field label="Identity provider issuer (entity id)" required>{(p) => <Input {...p} value={idpEntityId} onChange={(e) => setIdpEntityId(e.target.value)} placeholder="http://www.okta.com/exk…" />}</Field>
        <Field label={existing ? 'New signing certificate' : 'Signing certificate (PEM)'} required={!existing} hint={existing ? 'Leave empty to keep the current one.' : undefined}>
          {(p) => <Textarea {...p} rows={6} value={idpCert} onChange={(e) => setIdpCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />}
        </Field>
        <label className="flex items-center gap-2 text-sm text-white">
          <input type="checkbox" checked={allowIdpInitiated} onChange={(e) => setAllowIdp(e.target.checked)} />
          Allow sign-in started from the identity provider’s dashboard (less safe)
        </label>
        <label className="flex items-center gap-2 text-sm text-white">
          <input type="checkbox" checked={ssoRequiredForStaff} onChange={(e) => setSsoRequired(e.target.checked)} />
          Required for staff (associates keep passwords)
        </label>
        <label className="flex items-center gap-2 text-sm text-white">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          On
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={saving || !displayName.trim() || !ssoUrl.trim() || !idpEntityId.trim() || (!existing && !idpCert.trim())} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

export function SignInSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['identity'], queryFn: () => getIdentity() });
  const [editing, setEditing] = useState<IdentityConnectionRow | 'new' | 'new-saml' | null>(null);
  // "Add identity provider" asks which kind first: one button, not "+ SAML" beside "+ New sign-in".
  const [choosing, setChoosing] = useState(false);
  const [domain, setDomain] = useState('');
  const [tokenName, setTokenName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['identity'] });
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
      refresh();
    } catch (err) {
      toast.error(message(err));
    }
  };

  const d = q.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sign-in"
        subtitle="How people sign in: two-step, your organization’s own identity provider and the domains that lead to it, sessions, and directory provisioning."
        actions={[{ label: 'Add identity provider', icon: Plus, primary: true, onSelect: () => setChoosing(true) }]}
        related={[{ label: 'Users & access', to: '/admin/users' }]}
      />
      {q.isError ? (
        <QueryError what="sign-in settings" query={q} />
      ) : !d ? (
        <SkeletonRows count={4} />
      ) : (
        <>
          <section aria-labelledby="conn-title" className="space-y-2">
            <h2 id="conn-title" className="text-base font-semibold text-white">Identity providers</h2>
            <Card>
              <CardContent className="p-0">
                {d.connections.length === 0 ? (
                  <p className="p-6 text-sm text-silver">None yet: everyone signs in with a password or a passkey.</p>
                ) : (
                  <ul className="divide-y divide-navy-secondary">
                    {d.connections.map((c) => (
                      <li key={c.id}>
                        <button type="button" onClick={() => setEditing(c)} className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left text-sm hover:bg-navy-secondary/30">
                          <ShieldCheck className="h-4 w-4 text-silver" aria-hidden="true" />
                          <span className="font-medium text-white">{c.displayName}</span>
                          {c.kind === 'SAML' && <Badge variant="default" size="sm">SAML</Badge>}
                          <span className="text-xs text-silver">{c.issuerUrl}</span>
                          <Badge variant={c.enabled ? 'success' : 'default'} size="sm">{c.enabled ? 'On' : 'Off'}</Badge>
                          {c.ssoRequiredForStaff && <Badge variant="accent" size="sm">Required for staff</Badge>}
                          <span className="ml-auto text-xs text-silver">{c.linkedPeople} linked</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>

          <TwoStepSection />

          {/* Access pack: sessions, networks, devices and the break-glass switch. */}
          <SecurityPolicyCard />

          <section aria-labelledby="dom-title" className="space-y-2">
            <h2 id="dom-title" className="text-base font-semibold text-white">Email domains</h2>
            <p className="text-sm text-silver">
              People who type an address at a verified domain on the login page see your sign-in. Prove the domain with a DNS TXT record; shared domains (gmail.com…) use the link
              <code className="mx-1 text-white">/login/&lt;your slug&gt;</code>instead.
            </p>
            <Card>
              <CardContent className="space-y-3">
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() => addDomain(domain), 'Added. Publish the TXT record, then verify.').then(() => setDomain(''));
                  }}
                >
                  <Field label="Domain">{(p) => <Input {...p} className="w-64" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" />}</Field>
                  <Button type="submit" size="sm" disabled={domain.trim().length < 3}>
                    <Globe className="mr-1.5 h-3.5 w-3.5" /> Add
                  </Button>
                </form>
                {d.domains.map((dm) => (
                  <div key={dm.id} className="rounded-md border border-navy-secondary p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-white">{dm.domain}</span>
                      <Badge variant={dm.verified ? 'success' : 'pending'} size="sm">{dm.verified ? 'Verified' : 'Not verified'}</Badge>
                      <div className="ml-auto flex gap-2">
                        {!dm.verified && (
                          <Button size="sm" variant="outline" onClick={() => void run(async () => { const r = await verifyDomain(dm.id); if (!r.verified) throw new ApiError(400, 'not_found', 'The TXT record was not found yet; DNS can take a while.'); }, 'Verified.')}>
                            Verify now
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="text-silver hover:text-alert" onClick={() => void run(() => releaseDomain(dm.id), 'Released.')}>
                          Release
                        </Button>
                      </div>
                    </div>
                    {!dm.verified && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-silver">
                        TXT record on {dm.domain}:
                        <code className="break-all text-white">{dm.txtRecord}</code>
                        <Button size="sm" variant="ghost" onClick={() => copy(dm.txtRecord)} aria-label="Copy the TXT record">
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>

          <section aria-labelledby="scim-title" className="scroll-mt-20 space-y-2" id="directory">
            <h2 id="scim-title" className="text-base font-semibold text-white">Directory provisioning (SCIM)</h2>
            <p className="text-sm text-silver">
              Your directory creates, updates and deactivates accounts at <code className="text-white">{`${window.location.origin}/api/scim/v2`}</code> with a token from here. Deactivation signs the person out everywhere within a minute.
            </p>
            <Card>
              <CardContent className="space-y-3">
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      const r = await issueScimToken(tokenName.trim());
                      setIssued(r.token);
                      setTokenName('');
                    });
                  }}
                >
                  <Field label="Token name">{(p) => <Input {...p} className="w-64" value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="Okta provisioning" />}</Field>
                  <Button type="submit" size="sm" disabled={tokenName.trim().length < 2}>
                    <KeyRound className="mr-1.5 h-3.5 w-3.5" /> Issue token
                  </Button>
                </form>
                {issued && (
                  <div className="rounded-md border border-warning/40 p-3 text-sm">
                    <p className="text-warning">Copy this token now; it is not shown again.</p>
                    <div className="mt-2 flex items-start gap-2">
                      <code className="flex-1 break-all text-xs text-white">{issued}</code>
                      <Button size="sm" variant="outline" onClick={() => copy(issued)} aria-label="Copy the SCIM token">
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
                <ul className="divide-y divide-navy-secondary text-sm">
                  {d.scimTokens.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                      <span className="text-white">{t.name}</span>
                      <span className="font-mono text-xs text-silver">…{t.last4}</span>
                      <span className="text-xs text-silver">{t.lastUsedAt ? `used ${fmtDate(t.lastUsedAt)}` : 'never used'}</span>
                      {t.revokedAt ? (
                        <Badge variant="default" size="sm">Revoked</Badge>
                      ) : (
                        <Button size="sm" variant="ghost" className="ml-auto text-silver hover:text-alert" onClick={() => void run(() => revokeScimToken(t.id), 'Revoked.')}>
                          Revoke
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
            <DirectoryGroups />
          </section>

        </>
      )}
      {choosing && (
        <Dialog open onOpenChange={(o) => !o && setChoosing(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add identity provider</DialogTitle>
              <DialogDescription>Which way does your identity provider speak? Okta, Entra ID and Google do both; use what your IT team set up.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['new', 'OpenID Connect (OIDC)', 'An issuer URL, a client ID and a secret.'],
                  ['new-saml', 'SAML', 'A sign-on URL, an issuer and a signing certificate.'],
                ] as const
              ).map(([kind, label, hint]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    setChoosing(false);
                    setEditing(kind);
                  }}
                  className="rounded-md border border-line p-3 text-left hover:border-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                >
                  <span className="block text-sm font-medium text-ink">{label}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">{hint}</span>
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
      {editing && (editing === 'new-saml' || (editing !== 'new' && editing.kind === 'SAML')) ? (
        <SamlDrawer existing={editing === 'new-saml' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
      ) : editing ? (
        <ConnectionDrawer existing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
      ) : null}
    </div>
  );
}
