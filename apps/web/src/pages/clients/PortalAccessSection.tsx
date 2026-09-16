import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleAlert, ExternalLink, Store, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate } from '@/lib/format';
import {
  disablePortalUser,
  getPortalReadiness,
  invitePortalUser,
  listClientLocations,
  listPortalUsers,
  type PortalReadiness,
  type PortalUserRow,
} from '@/lib/clientsApi';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

interface Props {
  clientId: string;
}

/**
 * Portal access — who at the store can log in, the two-minute invite, and
 * the readiness checklist the store site depends on (contracted
 * headcount, a lead position, supervisor phones, photos, support
 * address, MFA policy). Rendered on the client page so the person who
 * closes the deal can provision the login without leaving it.
 */
export function PortalAccessSection({ clientId }: Props) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const canManage = can('manage:clients');
  const canPreview = can('view:executive') || can('manage:org');
  const [users, setUsers] = useState<PortalUserRow[] | null>(null);
  const [readiness, setReadiness] = useState<PortalReadiness | null>(null);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [u, r, l] = await Promise.all([
        listPortalUsers(clientId),
        getPortalReadiness(clientId),
        listClientLocations(clientId),
      ]);
      setUsers(u.users);
      setReadiness(r);
      setLocations(l.locations.map((x) => ({ id: x.id, name: x.name })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load portal access.');
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async () => {
    setBusy(true);
    try {
      const r = await invitePortalUser(clientId, { email: email.trim(), locationId: locationId || null });
      toast.success(
        r.emailFailed
          ? 'Login created, but the invite email failed — resend from Users & access.'
          : `Invite sent to ${r.email}.`,
      );
      setOpen(false);
      setEmail('');
      setLocationId('');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the invite.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async (u: PortalUserRow) => {
    if (
      !(await confirm({
        title: `Pull ${u.email}'s portal login?`,
        description: 'They are signed out immediately and can no longer open the store site.',
      }))
    ) {
      return;
    }
    try {
      await disablePortalUser(clientId, u.id);
      toast.success('Login pulled.');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not disable the login.');
    }
  };

  const ready = readiness && readiness.gaps.length === 0;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Store className="h-4 w-4 text-gold" aria-hidden="true" />
            Portal access
          </CardTitle>
          <CardDescription>
            The store manager site: who can log in, and whether the store is set up for it.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          {canPreview && (
            <Button size="sm" variant="outline" asChild>
              <Link to={`/portal?clientId=${clientId}`}>
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Preview portal
              </Link>
            </Button>
          )}
          {canManage && (
            <Button size="sm" onClick={() => setOpen(true)}>
              <UserPlus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Give a store a login
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <p className="text-sm text-alert">{error}</p>
        ) : !users || !readiness ? (
          <div className="space-y-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <>
            {/* ---- Accounts --------------------------------------------- */}
            {users.length === 0 ? (
              <p className="text-sm text-silver/70">
                No store manager has a login yet. Send one and the store sees its floor, its week, its grade, and its statements.
              </p>
            ) : (
              <ul className="divide-y divide-navy-secondary/60">
                {users.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-white">{u.email}</div>
                      <div className="text-xs text-silver/70">
                        {u.locationName ?? 'Whole client'}
                        {' · '}
                        {u.status === 'INVITED' && u.inviteExpiresAt
                          ? `invite expires ${fmtDate(u.inviteExpiresAt)}`
                          : `since ${fmtDate(u.createdAt)}`}
                      </div>
                    </div>
                    <Badge
                      variant={u.status === 'ACTIVE' ? 'success' : u.status === 'INVITED' ? 'pending' : 'destructive'}
                    >
                      {u.status === 'ACTIVE' ? 'Active' : u.status === 'INVITED' ? 'Invited' : 'Disabled'}
                    </Badge>
                    {canManage && u.status !== 'DISABLED' && (
                      <Button size="xs" variant="ghost" onClick={() => void disable(u)}>
                        Pull login
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* ---- Readiness --------------------------------------------- */}
            <div className="rounded-lg border border-navy-secondary bg-navy-secondary/20 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                {ready ? (
                  <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                ) : (
                  <CircleAlert className="h-4 w-4 text-warning" aria-hidden="true" />
                )}
                {ready ? 'The portal is ready for this client.' : 'The portal will show dashes until this is fixed'}
              </div>
              {!ready && (
                <ul className="mt-2 space-y-1 text-sm text-silver">
                  {readiness.gaps.map((g) => (
                    <li key={g} className="flex gap-2">
                      <span className="text-warning" aria-hidden="true">
                        •
                      </span>
                      {g}
                    </li>
                  ))}
                </ul>
              )}
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                <Stat label="Stores with a headcount" value={`${readiness.stores.filter((s) => s.hasTarget).length} / ${readiness.stores.length}`} ok={readiness.stores.every((s) => s.hasTarget)} />
                <Stat label="Lead positions" value={String(readiness.leadPositions)} ok={readiness.leadPositions > 0} />
                <Stat label="Supervisors with a phone" value={`${readiness.supervisors.filter((s) => s.hasPhone).length} / ${readiness.supervisors.length}`} ok={readiness.supervisors.length > 0 && readiness.supervisors.every((s) => s.hasPhone)} />
                <Stat label="Associates with a photo" value={readiness.photos.pct === null ? '—' : `${readiness.photos.pct}%`} ok={(readiness.photos.pct ?? 0) >= 80} />
                <Stat label="Support email" value={readiness.supportEmail ?? 'not set'} ok={!!readiness.supportEmail} />
                <Stat label="MFA covers portal logins" value={readiness.mfa.coversPortal ? 'Yes' : `No (policy ${readiness.mfa.policy})`} ok={readiness.mfa.coversPortal} />
              </dl>
              <p className="mt-3 text-2xs text-silver/50">
                Headcounts and lead positions are set on the scheduling page; phones and photos on the person's record; support email and MFA under Organization.
              </p>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)} confirmDiscard={() => email.trim().length > 0}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Give a store a portal login</DialogTitle>
            <DialogDescription>
              The store manager gets a magic link by email. Pick their store, or leave it on the whole client for a market or district manager.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Store manager's email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="manager@store.example"
                autoFocus
              />
            </Field>
            <Field label="Store">
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">Whole client (market manager)</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void invite()} loading={busy} disabled={!/^\S+@\S+\.\S+$/.test(email.trim())}>
              Send invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Stat({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-navy-secondary/40 py-1">
      <dt className="text-silver/70">{label}</dt>
      <dd className={cn('tabular-nums', ok ? 'text-success' : 'text-warning')}>{value}</dd>
    </div>
  );
}
