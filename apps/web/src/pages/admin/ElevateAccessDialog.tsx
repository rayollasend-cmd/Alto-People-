import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { HUMAN_ROLES, type Role } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useRoleLabel, useTenant } from '@/lib/auth';
import { roleOfferedFor } from '@/lib/modules';
import { fmtDateTime } from '@/lib/format';
import { grantAccess, listAccessGrants, revertAccessGrant } from '@/lib/approvalRequestsApi';
import type { AdminUser } from '@/lib/usersAdminApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/**
 * Temporary elevated access: a role until a date (at most 30 days), with a
 * reason. It rides as a second role the person switches into; the sweep
 * takes it back when it expires, and an administrator can end it early.
 */

const GRANTS_KEY = (userId: string) => ['admin', 'access-grants', userId] as const;
const MAX_DAYS = 30;

function localDateTimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ElevateAccessDialog({ user, onClose, onChanged }: { user: AdminUser; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const qc = useQueryClient();
  const roleLabel = useRoleLabel();
  const tenant = useTenant();
  const [role, setRole] = useState<Role | ''>('');
  const [until, setUntil] = useState(localDateTimeValue(new Date(Date.now() + 7 * 86_400_000)));
  const [reason, setReason] = useState('');

  const grants = useQuery({ queryKey: GRANTS_KEY(user.id), queryFn: () => listAccessGrants({ userId: user.id }) });
  const held = new Set<Role>([user.role, ...(user.additionalRoles ?? [])]);
  const options = HUMAN_ROLES.filter((r) => !held.has(r) && r !== 'CLIENT_PORTAL' && roleOfferedFor(r, tenant.modules));
  const untilDate = new Date(until);
  const untilOk = Number.isFinite(untilDate.getTime()) && untilDate.getTime() > Date.now() && untilDate.getTime() - Date.now() <= MAX_DAYS * 86_400_000;
  const valid = role !== '' && untilOk && reason.trim().length >= 3;

  const grant = useMutation({
    mutationFn: () => grantAccess({ userId: user.id, role: role as Role, until: untilDate.toISOString(), reason: reason.trim() }),
    onSuccess: async () => {
      toast.success(`${roleLabel(role as Role)} granted until ${fmtDateTime(untilDate.toISOString())}.`);
      setRole('');
      setReason('');
      await qc.invalidateQueries({ queryKey: GRANTS_KEY(user.id) });
      await onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not grant access.'),
  });
  const revert = useMutation({
    mutationFn: (id: string) => revertAccessGrant(id),
    onSuccess: async () => {
      toast.success('Access taken back.');
      await qc.invalidateQueries({ queryKey: GRANTS_KEY(user.id) });
      await onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not revert the grant.'),
  });

  const open = (grants.data?.grants ?? []).filter((g) => !g.revertedAt);
  const past = (grants.data?.grants ?? []).filter((g) => g.revertedAt).slice(0, 5);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Temporary access for {user.associateName ?? user.email}</DialogTitle>
          <DialogDescription>A role until a date — at most {MAX_DAYS} days — with the reason on the record. It is taken back on time, and sessions refresh when it is.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) grant.mutate();
          }}
        >
          <Field label="Role" required>
            {(p) => (
              <Select {...p} value={role} onChange={(e) => setRole(e.target.value as Role | '')}>
                <option value="">Choose a role</option>
                {options.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Until" required error={until && !untilOk ? `Between now and ${MAX_DAYS} days out.` : undefined}>
            {(p) => <Input {...p} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />}
          </Field>
          <Field label="Reason" required hint="Year-end close, covering a leave, an audit — the record keeps it.">
            {(p) => <Input {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button type="submit" disabled={!valid} loading={grant.isPending}>
              Grant until then
            </Button>
          </DialogFooter>
        </form>
        {(open.length > 0 || past.length > 0) && (
          <div className="space-y-3 border-t border-line pt-4 text-sm">
            {open.length > 0 && (
              <section aria-label="Open grants" className="space-y-1.5">
                <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">Open now</div>
                <ul className="space-y-1">
                  {open.map((g) => (
                    <li key={g.id} className="flex items-center justify-between gap-2">
                      <span>
                        <span className="font-medium text-ink">{roleLabel(g.role)}</span>
                        <span className="text-ink-muted"> · until {fmtDateTime(g.expiresAt)} · {g.reason}</span>
                      </span>
                      <Button size="xs" variant="ghost" onClick={() => revert.mutate(g.id)} disabled={revert.isPending}>
                        Take back
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {past.length > 0 && (
              <section aria-label="Past grants" className="space-y-1.5">
                <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">Taken back</div>
                <ul className="space-y-1 text-ink-muted">
                  {past.map((g) => (
                    <li key={g.id}>
                      {roleLabel(g.role)} · {g.revertedWhy ?? 'reverted'} {g.revertedAt ? fmtDateTime(g.revertedAt) : ''}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
