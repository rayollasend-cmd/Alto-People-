import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { ROLE_LABELS, ROLES, type Role } from '@/lib/roles';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { ApiError } from '@/lib/api';
import {
  forcePasswordReset,
  listAdminUsers,
  patchAdminUser,
  type AdminUser,
  type UserStatus,
} from '@/lib/usersAdminApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

const STATUS_OPTIONS: UserStatus[] = ['ACTIVE', 'INVITED', 'DISABLED'];
// LIVE_ASN is excluded — it's the system-integration role; the backend
// rejects assigning it via PATCH and humans don't log in as it.
const ROLE_OPTIONS: Role[] = (Object.keys(ROLES) as Role[]).filter(
  (r) => r !== 'LIVE_ASN',
);

function statusVariant(status: UserStatus) {
  switch (status) {
    case 'ACTIVE':
      return 'success' as const;
    case 'INVITED':
      return 'pending' as const;
    case 'DISABLED':
      return 'destructive' as const;
  }
}

/**
 * HR-only user administration. Lists every account, edits role + status
 * inline, and forces a password reset (which both bumps tokenVersion
 * server-side AND emails a fresh single-use link). Self-edit is blocked
 * — HR uses /settings to change their own password.
 */
export function UsersAdmin() {
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [status, setStatus] = useState<UserStatus | ''>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAdminUsers({
        q: q.trim() || undefined,
        role: role || undefined,
        status: status || undefined,
      });
      setRows(res.users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }, [q, role, status]);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    if (!rows) return null;
    const out: Record<UserStatus, number> = { ACTIVE: 0, INVITED: 0, DISABLED: 0 };
    for (const r of rows) out[r.status]++;
    return out;
  }, [rows]);

  const onChangeRole = async (u: AdminUser, newRole: Role) => {
    if (newRole === u.role) return;
    if (
      !(await confirm({
        title: `Change ${u.email}'s role?`,
        description: `From ${ROLE_LABELS[u.role]} to ${ROLE_LABELS[newRole]}. Active sessions for this user will be revoked.`,
      }))
    ) {
      return;
    }
    setPendingId(u.id);
    try {
      await patchAdminUser(u.id, { role: newRole });
      toast.success('Role updated.');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onChangeStatus = async (u: AdminUser, newStatus: UserStatus) => {
    if (newStatus === u.status) return;
    const isDisable = newStatus === 'DISABLED';
    if (
      !(await confirm({
        title: isDisable
          ? `Disable ${u.email}?`
          : `Set ${u.email} to ${newStatus}?`,
        description: isDisable
          ? 'They will be signed out immediately and locked out until re-enabled.'
          : undefined,
        destructive: isDisable,
      }))
    ) {
      return;
    }
    setPendingId(u.id);
    try {
      await patchAdminUser(u.id, { status: newStatus });
      toast.success('Status updated.');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onForceReset = async (u: AdminUser) => {
    if (
      !(await confirm({
        title: `Force a password reset for ${u.email}?`,
        description:
          'A reset link will be emailed and every active session for this user will be revoked. Use only when the account is at risk or the user is locked out.',
        destructive: true,
      }))
    ) {
      return;
    }
    setPendingId(u.id);
    try {
      await forcePasswordReset(u.id);
      toast.success('Reset link sent.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Users & access"
        subtitle="Every account in the org. Change a role, disable a compromised account, or force a password reset."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'Users & access' }]}
      />

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <Label htmlFor="users-q">Search</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver" />
              <Input
                id="users-q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Email or name…"
                className="pl-9"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') load();
                }}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="users-role">Role</Label>
            <select
              id="users-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role | '')}
              className="h-10 rounded-md border border-navy-secondary bg-navy-secondary/50 px-3 text-sm text-white"
            >
              <option value="">All roles</option>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="users-status">Status</Label>
            <select
              id="users-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as UserStatus | '')}
              className="h-10 rounded-md border border-navy-secondary bg-navy-secondary/50 px-3 text-sm text-white"
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <Button variant="ghost" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </CardContent>
      </Card>

      {counts && (
        <div className="flex flex-wrap gap-2 text-xs text-silver">
          <Badge variant="success">{counts.ACTIVE} active</Badge>
          <Badge variant="pending">{counts.INVITED} invited</Badge>
          <Badge variant="destructive">{counts.DISABLED} disabled</Badge>
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-alert">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-sm text-silver">No users match those filters.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((u) => {
                  const isMe = me?.id === u.id;
                  const busy = pendingId === u.id;
                  return (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div className="text-white">
                          {u.associateName ?? u.email}
                          {isMe && (
                            <span className="ml-2 text-xs text-gold">(you)</span>
                          )}
                        </div>
                        {u.associateName && (
                          <div className="text-xs text-silver">{u.email}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <select
                          value={u.role}
                          onChange={(e) => onChangeRole(u, e.target.value as Role)}
                          disabled={isMe || busy}
                          className="h-8 rounded-md border border-navy-secondary bg-navy-secondary/50 px-2 text-xs text-white disabled:opacity-50"
                        >
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge variant={statusVariant(u.status)}>{u.status}</Badge>
                          <select
                            value={u.status}
                            onChange={(e) =>
                              onChangeStatus(u, e.target.value as UserStatus)
                            }
                            disabled={isMe || busy}
                            className="h-7 rounded-md border border-navy-secondary bg-navy-secondary/50 px-2 text-xs text-white disabled:opacity-50"
                            aria-label="Change status"
                          >
                            {STATUS_OPTIONS.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </div>
                      </TableCell>
                      <TableCell className="text-silver text-xs">
                        {u.clientName ?? '—'}
                      </TableCell>
                      <TableCell className="text-silver text-xs">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onForceReset(u)}
                          disabled={isMe || busy}
                          title={
                            isMe
                              ? 'Use /settings to change your own password'
                              : 'Send a fresh reset link and revoke active sessions'
                          }
                        >
                          <KeyRound className="mr-1 h-3 w-3" />
                          Force reset
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="text-xs text-silver flex items-center gap-1">
        <ShieldCheck className="h-3 w-3" />
        Every change here is recorded in the audit log.
      </div>
    </div>
  );
}
