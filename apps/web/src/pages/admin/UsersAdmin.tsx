import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import { toast } from 'sonner';
import { ROLE_LABELS, ROLES, type Role } from '@/lib/roles';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, ymdLocal } from '@/lib/format';
import {
  forcePasswordReset,
  listAdminUsers,
  patchAdminUser,
  unlockUser,
  type AdminUser,
  type UserStatus,
} from '@/lib/usersAdminApi';
import { listClients } from '@/lib/clientsApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { SearchInput } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
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

/** Human labels for the status enum — never show ACTIVE/DISABLED raw. */
const STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: 'Active',
  INVITED: 'Invited',
  DISABLED: 'Disabled',
};
// LIVE_ASN is excluded — it's the system-integration role; the backend
// rejects assigning it via PATCH and humans don't log in as it.
const ROLE_OPTIONS: Role[] = (Object.keys(ROLES) as Role[]).filter(
  (r) => r !== 'LIVE_ASN',
);

// Roles that are pinned to a single client — show a client picker for them.
const CLIENT_PICKER_ROLES = new Set<Role>(['SHIFT_SUPERVISOR', 'CLIENT_PORTAL']);
// …and the subset that CANNOT run without a client (blocks clearing it).
const CLIENT_REQUIRED_ROLES = new Set<Role>(['SHIFT_SUPERVISOR']);

// Bulk role assignment can't collect a per-user client, so roles that
// REQUIRE a client are excluded — assign those one row at a time.
const BULK_ROLE_OPTIONS: Role[] = ROLE_OPTIONS.filter(
  (r) => !CLIENT_REQUIRED_ROLES.has(r),
);

type SortKey = 'email' | 'role' | 'status' | 'created';
type SortDir = 'asc' | 'desc';

function SortHeader({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey | null;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  const Icon = active ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className="inline-flex items-center gap-1 hover:text-white transition-colors"
      aria-label={`Sort by ${label.toLowerCase()}${
        active ? (sortDir === 'asc' ? ', descending' : ', ascending') : ''
      }`}
    >
      {label}
      <Icon
        className={`h-3 w-3 ${active ? 'text-gold' : 'text-silver/50'}`}
        aria-hidden="true"
      />
    </button>
  );
}

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
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const [q, setQ] = useState('');
  // PERF: debounced mirror of `q`. The list used to refetch on every
  // keystroke ("christopher" = 11 requests) with no out-of-order guard,
  // so a slow early response could clobber the final result.
  const [appliedQ, setAppliedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setAppliedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const [role, setRole] = useState<Role | ''>('');
  const [status, setStatus] = useState<UserStatus | ''>('');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [clientsError, setClientsError] = useState(false);
  // A role change to a client-scoped role for a user with no client is held
  // here until a client is picked, then applied together.
  const [draftRole, setDraftRole] = useState<Record<string, Role>>({});

  const loadClients = useCallback(async () => {
    setClientsError(false);
    try {
      const r = await listClients({ status: 'ACTIVE' });
      setClients(r.clients.map((c) => ({ id: c.id, name: c.name })));
    } catch {
      // Surfaced as an inline retry affordance where the picker renders.
      setClientsError(true);
    }
  }, []);

  useEffect(() => {
    void loadClients();
  }, [loadClients]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAdminUsers({
        q: appliedQ.trim() || undefined,
        role: role || undefined,
        status: status || undefined,
      });
      setRows(res.users);
      setTotal(res.total);
      // Drop selections that no longer exist in the refreshed page.
      setSelected((prev) => {
        const next = new Set<string>();
        for (const u of res.users) if (prev.has(u.id)) next.add(u.id);
        return next;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }, [appliedQ, role, status]);

  useEffect(() => {
    load();
  }, [load]);

  const sorted = useMemo(() => {
    if (!rows || !sortKey) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'email':
          cmp = a.email.localeCompare(b.email);
          break;
        case 'role':
          cmp = ROLE_LABELS[a.role].localeCompare(ROLE_LABELS[b.role]);
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
        case 'created':
          // ISO timestamps sort correctly as strings.
          cmp = a.createdAt.localeCompare(b.createdAt);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const onSort = (k: SortKey) => {
    if (sortKey === k) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(k);
      setSortDir('asc');
    }
  };

  // Everything selectable on the current page (self excluded — HR can't
  // bulk-edit their own account, same rule as the per-row controls).
  const selectableIds = useMemo(
    () => (rows ?? []).filter((u) => u.id !== me?.id).map((u) => u.id),
    [rows, me?.id],
  );
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  };

  /** Apply a single-row mutation across the selection, then summarize. */
  const runBulk = async (label: string, fn: (id: string) => Promise<void>) => {
    const ids = [...selected].filter((id) => id !== me?.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => fn(id)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      if (failed === 0) {
        toast.success(`${label}: ${ok} user${ok === 1 ? '' : 's'} updated.`);
      } else {
        toast.error(`${label}: ${ok} succeeded, ${failed} failed.`);
      }
      setSelected(new Set());
      await load();
    } finally {
      setBulkBusy(false);
    }
  };

  const onBulkRole = async (newRole: Role) => {
    const n = selected.size;
    if (
      !(await confirm({
        title: `Set role to ${ROLE_LABELS[newRole]} for ${n} user${n === 1 ? '' : 's'}?`,
        description: 'Active sessions for these users will be revoked.',
      }))
    ) {
      return;
    }
    await runBulk('Set role', (id) => patchAdminUser(id, { role: newRole }));
  };

  const onBulkStatus = async (newStatus: UserStatus) => {
    const n = selected.size;
    const isDisable = newStatus === 'DISABLED';
    if (
      !(await confirm({
        title: `Set ${n} user${n === 1 ? '' : 's'} to ${STATUS_LABELS[newStatus].toLowerCase()}?`,
        description: isDisable
          ? 'They will be signed out immediately and locked out until re-enabled.'
          : undefined,
        destructive: isDisable,
      }))
    ) {
      return;
    }
    await runBulk('Set status', (id) => patchAdminUser(id, { status: newStatus }));
  };

  const onBulkForceReset = async () => {
    const n = selected.size;
    if (
      !(await confirm({
        title: `Force a password reset for ${n} user${n === 1 ? '' : 's'}?`,
        description:
          'A reset link will be emailed and every active session for these users will be revoked.',
        destructive: true,
      }))
    ) {
      return;
    }
    await runBulk('Force reset', (id) => forcePasswordReset(id));
  };

  const exportCsv = () => {
    const data = sorted ?? rows;
    if (!data || data.length === 0) return;
    downloadCsv(`users-${ymdLocal()}.csv`, [
      ['Email', 'Name', 'Role', 'Status', 'Client', 'Created'],
      ...data.map((u) => [
        u.email,
        u.associateName ?? '',
        ROLE_LABELS[u.role],
        STATUS_LABELS[u.status],
        u.clientName ?? '',
        u.createdAt.slice(0, 10),
      ]),
    ]);
  };

  const counts = useMemo(() => {
    if (!rows) return null;
    const out: Record<UserStatus, number> = { ACTIVE: 0, INVITED: 0, DISABLED: 0 };
    for (const r of rows) out[r.status]++;
    return out;
  }, [rows]);

  const onChangeRole = async (u: AdminUser, newRole: Role) => {
    if (newRole === (draftRole[u.id] ?? u.role)) return;
    // Client-scoped role but no client yet → don't persist until a client is
    // chosen. Reveal the picker (it renders whenever the effective role is
    // client-scoped) and apply role + client together via onAssignClient.
    if (CLIENT_REQUIRED_ROLES.has(newRole) && !u.clientId) {
      setDraftRole((d) => ({ ...d, [u.id]: newRole }));
      toast.message(`Pick a client to finish assigning ${ROLE_LABELS[newRole]}.`);
      return;
    }
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
      setDraftRole((d) => {
        const next = { ...d };
        delete next[u.id];
        return next;
      });
      toast.success('Role updated.');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onAssignClient = async (u: AdminUser, newClientId: string) => {
    const pendingRole = draftRole[u.id];
    const effRole = pendingRole ?? u.role;
    if (!newClientId && CLIENT_REQUIRED_ROLES.has(effRole)) {
      toast.error(`${ROLE_LABELS[effRole]} must have a client.`);
      return;
    }
    if (newClientId === (u.clientId ?? '') && !pendingRole) return;
    setPendingId(u.id);
    try {
      await patchAdminUser(u.id, {
        clientId: newClientId || null,
        ...(pendingRole ? { role: pendingRole } : {}),
      });
      setDraftRole((d) => {
        const next = { ...d };
        delete next[u.id];
        return next;
      });
      toast.success(pendingRole ? 'Role and client assigned.' : 'Client updated.');
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
          : `Set ${u.email} to ${STATUS_LABELS[newStatus].toLowerCase()}?`,
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

  const onUnlock = async (u: AdminUser) => {
    setPendingId(u.id);
    try {
      await unlockUser(u.id);
      toast.success('Account unlocked.');
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
          <Field label="Search" className="flex-1 w-full sm:min-w-[200px]">
            {(p) => (
              <SearchInput
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Email or name…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') load();
                }}
                {...p}
              />
            )}
          </Field>
          <Field label="Role">
            {(p) => (
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value as Role | '')}
                {...p}
              >
                <option value="">All roles</option>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Status">
            {(p) => (
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value as UserStatus | '')}
                {...p}
              >
                <option value="">All statuses</option>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button variant="ghost" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            variant="ghost"
            onClick={exportCsv}
            disabled={!rows || rows.length === 0}
            title="Download the currently filtered rows as CSV"
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </CardContent>
      </Card>

      {counts && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-silver">
          <Badge variant="success">{counts.ACTIVE} active</Badge>
          <Badge variant="pending">{counts.INVITED} invited</Badge>
          <Badge variant="destructive">{counts.DISABLED} disabled</Badge>
          {rows !== null && total !== null && total > rows.length && (
            <span className="tabular-nums">
              Showing {rows.length} of {total} — narrow the filters to see the rest.
            </span>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-navy-secondary bg-navy-secondary/30 px-3 py-2">
          <span className="text-xs text-silver tabular-nums">
            {selected.size} selected
          </span>
          <Select
            size="sm"
            value=""
            onChange={(e) => {
              if (e.target.value) void onBulkRole(e.target.value as Role);
            }}
            disabled={bulkBusy}
            aria-label="Set role for selected users"
          >
            <option value="">Set role…</option>
            {BULK_ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
          <Select
            size="sm"
            value=""
            onChange={(e) => {
              if (e.target.value) void onBulkStatus(e.target.value as UserStatus);
            }}
            disabled={bulkBusy}
            aria-label="Set status for selected users"
          >
            <option value="">Set status…</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onBulkForceReset()}
            disabled={bulkBusy}
          >
            <KeyRound className="mr-1 h-3 w-3" />
            Force reset
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set())}
            disabled={bulkBusy}
          >
            Clear selection
          </Button>
        </div>
      )}

      {error && (
        <div className="space-y-3">
          <ErrorBanner>{error}</ErrorBanner>
          <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
            Retry
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            // Skeleton matches the real row shape (name+email, role pill,
            // status pill, client text, date, action stack) so when the
            // data lands there's no layout shift. Six placeholders keep
            // the table looking populated above the fold.
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 py-2 border-b border-navy-secondary/50 last:border-b-0"
                >
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-2/5" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                  <Skeleton className="h-7 w-24 hidden sm:block" />
                  <Skeleton className="h-7 w-16 hidden md:block" />
                  <Skeleton className="h-3 w-24 hidden lg:block" />
                  <Skeleton className="h-7 w-20" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-sm text-silver">No users match those filters.</div>
          ) : (
            <Table caption="User accounts">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={selectableIds.length === 0}
                      aria-label="Select all users on this page"
                    />
                  </TableHead>
                  <TableHead>
                    <SortHeader
                      label="User"
                      k="email"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead>
                    <SortHeader
                      label="Role"
                      k="role"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead>
                    <SortHeader
                      label="Status"
                      k="status"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="hidden md:table-cell">Client</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    <SortHeader
                      label="Created"
                      k="created"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(sorted ?? rows).map((u) => {
                  const isMe = me?.id === u.id;
                  const busy = pendingId === u.id;
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="w-8">
                        <input
                          type="checkbox"
                          checked={selected.has(u.id)}
                          onChange={() => toggleRow(u.id)}
                          disabled={isMe}
                          title={isMe ? 'You can’t bulk-edit your own account' : undefined}
                          aria-label={`Select ${u.email}`}
                        />
                      </TableCell>
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
                        <div className="text-xs2 text-silver/70 md:hidden">
                          {u.clientName ?? '—'}
                        </div>
                        <div className="text-xs2 text-silver/70 lg:hidden">
                          {fmtDate(u.createdAt)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          size="sm"
                          value={draftRole[u.id] ?? u.role}
                          onChange={(e) => onChangeRole(u, e.target.value as Role)}
                          disabled={isMe || busy}
                        >
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge variant={statusVariant(u.status)}>
                            {STATUS_LABELS[u.status]}
                          </Badge>
                          {u.lockedUntil && (
                            <Badge
                              variant="destructive"
                              withDot={false}
                              title={`Too many failed sign-in attempts — locked until ${new Date(u.lockedUntil).toLocaleTimeString()}`}
                            >
                              <Lock className="h-3 w-3" aria-hidden="true" />
                              Locked
                            </Badge>
                          )}
                          <Select
                            size="sm"
                            value={u.status}
                            onChange={(e) =>
                              onChangeStatus(u, e.target.value as UserStatus)
                            }
                            disabled={isMe || busy}
                            aria-label="Change status"
                          >
                            {STATUS_OPTIONS.map((s) => (
                              <option key={s} value={s}>
                                {STATUS_LABELS[s]}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </TableCell>
                      <TableCell className="text-silver text-xs hidden md:table-cell">
                        {CLIENT_PICKER_ROLES.has(draftRole[u.id] ?? u.role) ? (
                          clientsError ? (
                            <button
                              type="button"
                              onClick={() => void loadClients()}
                              className="text-alert underline underline-offset-2 hover:text-white"
                            >
                              Couldn't load clients — retry
                            </button>
                          ) : (
                            <Select
                              size="sm"
                              value={u.clientId ?? ''}
                              onChange={(e) => onAssignClient(u, e.target.value)}
                              disabled={isMe || busy}
                              aria-label="Assign client"
                            >
                              <option value="">— select client —</option>
                              {clients.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </Select>
                          )
                        ) : (
                          (u.clientName ?? '—')
                        )}
                      </TableCell>
                      <TableCell className="text-silver text-xs hidden lg:table-cell">
                        {fmtDate(u.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        {u.lockedUntil && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void onUnlock(u)}
                            disabled={busy}
                            title="Clear the failed-attempt lock so this user can sign in with their password again"
                          >
                            <Unlock className="mr-1 h-3 w-3" />
                            Unlock
                          </Button>
                        )}
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
