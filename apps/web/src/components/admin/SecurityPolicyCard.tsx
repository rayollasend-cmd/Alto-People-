import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { getSecurityPolicy, putSecurityPolicy, type SecurityPolicy } from '@/lib/identityApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui';

/**
 * Access pack — the tenant's sign-in posture beyond the IdP: where a
 * session may come from (allowlists per role class), how long it lives
 * (idle, absolute), whether two-step remembers a device, and whether the
 * break-glass path is open. Lives on the Sign-in & provisioning page.
 */

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong.');

const toLines = (xs: string[]) => xs.join('\n');
const fromLines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

export function SecurityPolicyCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['identity', 'security-policy'], queryFn: getSecurityPolicy });
  const [draft, setDraft] = useState<SecurityPolicy | null>(null);
  const [internal, setInternal] = useState('');
  const [client, setClient] = useState('');
  const [associate, setAssociate] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (q.data && !draft) {
      setDraft(q.data);
      setInternal(toLines(q.data.allowedCidrsInternal));
      setClient(toLines(q.data.allowedCidrsClient));
      setAssociate(toLines(q.data.allowedCidrsAssociate));
    }
  }, [q.data, draft]);
  if (q.isError) return <QueryError what="the security policy" query={q} />;
  if (!draft) return <SkeletonRows count={3} />;
  const d = draft;
  const set = (patch: Partial<SecurityPolicy>) => setDraft({ ...d, ...patch });
  const save = async () => {
    setSaving(true);
    try {
      const saved = await putSecurityPolicy({ ...d, allowedCidrsInternal: fromLines(internal), allowedCidrsClient: fromLines(client), allowedCidrsAssociate: fromLines(associate) });
      setDraft(saved);
      qc.setQueryData(['identity', 'security-policy'], saved);
      toast.success('Saved. It applies to every session on its next request.');
    } catch (err) {
      toast.error(message(err));
    } finally {
      setSaving(false);
    }
  };
  const num = (v: string): number | null => (v.trim() === '' ? null : Math.max(0, Number(v)) || null);
  return (
    <section aria-labelledby="security-policy-title" className="space-y-2">
      <h2 id="security-policy-title" className="text-base font-semibold text-ink">Sessions, networks and devices</h2>
      <p className="text-sm text-ink-muted">
        Where a session may come from and how long it lives. Everything here applies on the next request, not the next sign-in.
      </p>
      <Card>
        <CardContent className="space-y-5 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sign out after inactivity" hint="Minutes without a request; empty = never.">
              {(p) => <Input {...p} type="number" min={5} max={1440} value={d.sessionIdleMinutes ?? ''} onChange={(e) => set({ sessionIdleMinutes: num(e.target.value) })} placeholder="e.g. 30" />}
            </Field>
            <Field label="Maximum session length" hint="Hours after sign-in; empty = the token's own life.">
              {(p) => <Input {...p} type="number" min={1} max={720} value={d.sessionAbsoluteHours ?? ''} onChange={(e) => set({ sessionAbsoluteHours: num(e.target.value) })} placeholder="e.g. 12" />}
            </Field>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Field label="Staff networks" hint="IPv4/IPv6 addresses or CIDRs, one per line. Empty = anywhere. Your own address must be in it.">
              {(p) => <Textarea {...p} rows={3} value={internal} onChange={(e) => setInternal(e.target.value)} placeholder={'203.0.113.0/24\n2001:db8::/32'} />}
            </Field>
            <Field label="Client account networks" hint="Store and region accounts.">
              {(p) => <Textarea {...p} rows={3} value={client} onChange={(e) => setClient(e.target.value)} />}
            </Field>
            <Field label="Worker networks" hint="Rarely set: workers sign in from their phones.">
              {(p) => <Textarea {...p} rows={3} value={associate} onChange={(e) => setAssociate(e.target.value)} />}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" className="mt-1" checked={d.deviceTrustEnabled} onChange={(e) => set({ deviceTrustEnabled: e.target.checked })} />
              <span>
                Remember a device after two-step sign-in
                <span className="block text-xs text-ink-muted">A new device is asked for the code again; people forget a device from their settings.</span>
              </span>
            </label>
            <Field label="For how long" hint="Days a remembered device skips the code.">
              {(p) => <Input {...p} type="number" min={1} max={365} value={d.deviceTrustDays} disabled={!d.deviceTrustEnabled} onChange={(e) => set({ deviceTrustDays: Math.max(1, Math.min(365, Number(e.target.value) || 30)) })} />}
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-1" checked={d.breakGlassEnabled} onChange={(e) => set({ breakGlassEnabled: e.target.checked })} />
            <span className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <span>
                Break-glass sign-in stays open
                <span className="block text-xs text-ink-muted">
                  While staff must use company sign-in, the owners flagged in Users &amp; access may still sign in with password + two-step. Every use is audited and alerts the security contact. Turn this off and an identity-provider outage locks every administrator out.
                </span>
              </span>
            </span>
          </label>
          <div className="flex justify-end">
            <Button onClick={() => void save()} loading={saving}>Save policy</Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
