import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { listSites } from '@/lib/orgApi';
import { listRegions } from '@/lib/regionsApi';
import { patchAdminUser, type AdminUser } from '@/lib/usersAdminApi';
import { ApproverPicker } from '@/components/ApproverPicker';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';

/**
 * Access pack — two bindings on an account that carry a named approver:
 *
 *   ScopeDialog      an INTERNAL role narrowed to sites and/or regions (a
 *                    regional Ops lead). Lists and writes clamp server-side.
 *   BreakGlassDialog the owner who may sign in with password + two-step
 *                    while company sign-in is required.
 */

const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function ScopeDialog({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const sitesQ = useQuery({ queryKey: ['org', 'sites'], queryFn: listSites });
  const regionsQ = useQuery({ queryKey: ['regions'], queryFn: listRegions });
  const [sites, setSites] = useState<Set<string>>(() => new Set(user.scopeSiteIds ?? []));
  const [regions, setRegions] = useState<Set<string>>(() => new Set(user.scopeRegionIds ?? []));
  const [filter, setFilter] = useState('');
  const [approver, setApprover] = useState('');
  const [busy, setBusy] = useState(false);
  const siteRows = useMemo(() => (sitesQ.data?.sites ?? []).filter((s) => s.isActive && (!filter.trim() || s.name.toLowerCase().includes(filter.trim().toLowerCase()))), [sitesQ.data, filter]);
  const regionRows = regionsQ.data?.regions ?? [];
  const narrowing = sites.size > 0 || regions.size > 0;
  const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    apply(n);
  };
  const save = async () => {
    setBusy(true);
    try {
      await patchAdminUser(user.id, { scopeSiteIds: [...sites], scopeRegionIds: [...regions], ...(narrowing && approver ? { approvedByUserId: approver } : {}) });
      toast.success(narrowing ? 'Scope set. Their sessions restart with the narrower reach.' : 'Scope cleared. They see the whole organization again.');
      onSaved();
    } catch (err) {
      toast.error(message(err, "Couldn't change the scope."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Where {user.associateName ?? user.email} works</DialogTitle>
          <DialogDescription>
            Narrow this internal role to sites and regions. Their lists, counts and approvals clamp to these places; nothing else is reachable. Leave everything unticked for the whole organization.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {regionRows.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">Regions</legend>
              <ul className="grid gap-1 sm:grid-cols-2">
                {regionRows.map((r) => (
                  <li key={r.id}>
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input type="checkbox" checked={regions.has(r.id)} onChange={() => toggle(regions, r.id, setRegions)} />
                      {r.name}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <fieldset>
            <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">Sites</legend>
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a site" aria-label="Find a site" className="mb-2" />
            <ul className="max-h-56 overflow-y-auto rounded-md border border-line p-2" aria-label="Sites">
              {siteRows.length === 0 && <li className="text-sm text-ink-muted">{sitesQ.isPending ? 'Loading sites…' : 'No site matches.'}</li>}
              {siteRows.map((s) => (
                <li key={s.id}>
                  <label className="flex items-center gap-2 py-1 text-sm text-ink">
                    <input type="checkbox" checked={sites.has(s.id)} onChange={() => toggle(sites, s.id, setSites)} />
                    <span className="truncate">{s.name}</span>
                    {s.clientName && <span className="truncate text-xs text-ink-muted">{s.clientName}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {narrowing && (
            <Field label="Approved by" required hint="A binding that changes what the account can reach carries a named approver who holds manage:org.">
              {() => <ApproverPicker value={approver} onChange={setApprover} disabled={busy} />}
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button loading={busy} disabled={busy || (narrowing && !approver)} onClick={() => void save()}>
            {narrowing ? `Scope to ${sites.size + regions.size} place${sites.size + regions.size === 1 ? '' : 's'}` : 'Whole organization'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BreakGlassDialog({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const turningOn = !user.breakGlass;
  const [approver, setApprover] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await patchAdminUser(user.id, { breakGlass: turningOn, ...(turningOn ? { approvedByUserId: approver } : {}) });
      toast.success(turningOn ? 'Break-glass owner. Every such sign-in is audited and alerts the security contact.' : 'No longer a break-glass owner.');
      onSaved();
    } catch (err) {
      toast.error(message(err, "Couldn't change break-glass."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{turningOn ? `Make ${user.email} a break-glass owner?` : `Remove break-glass from ${user.email}?`}</DialogTitle>
          <DialogDescription>
            {turningOn
              ? 'While staff must use company sign-in, this account may still sign in with its password and a two-step code — never a password alone. Each use is a critical audit row, an email to the security contact and a bell for every org admin. Keep this to two or three people.'
              : 'They go back to company sign-in only. Passkeys keep working.'}
          </DialogDescription>
        </DialogHeader>
        {turningOn && !user.mfaEnabled && (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-ink">This account has no two-step sign-in yet. They turn it on in their settings first; without it, break-glass is refused.</p>
        )}
        {turningOn && <ApproverPicker value={approver} onChange={setApprover} disabled={busy} />}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button loading={busy} disabled={busy || (turningOn && (!approver || !user.mfaEnabled))} variant={turningOn ? 'primary' : 'destructive'} onClick={() => void save()}>
            {turningOn ? 'Make break-glass owner' : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
