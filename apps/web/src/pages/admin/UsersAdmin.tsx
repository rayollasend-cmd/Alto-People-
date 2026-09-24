import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock,
  KeyRound,
  Lock,
  RefreshCw,
  Repeat,
  ShieldCheck,
  Unlock,
  UserRound,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { ROLE_LABELS, ROLES, type Role } from '@/lib/roles';
import { SecondRoleDialog } from './SecondRoleDialog';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import {
  forcePasswordReset,
  listAdminUsers,
  patchAdminUser,
  unlockUser,
  type AdminUser,
  type ListUsersFilters,
  type UserStatus,
} from '@/lib/usersAdminApi';
import { listClients, listClientLocations } from '@/lib/clientsApi';
import { listRegions } from '@/lib/regionsApi';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { SupervisorShiftDialog } from './SupervisorShiftDialog';
import { ShiftLeadsCard } from '@/components/ShiftLeadsCard';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { SearchInput } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';

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

// Every role can carry a client scope, so every row gets the picker. For
// supervisors / client portal it's the hard clamp their access depends on;
// for org-wide roles (HR admin, ops, …) it's an optional home-site focus
// (decision feed, defaults) that clears to "All clients" — without the
// picker those rows were stuck read-only with no way to widen someone.
// The REQUIRED set mirrors the server's CLIENT_SCOPED_ROLES exactly
// (SHIFT_SUPERVISOR + FLOOR_SUPERVISOR) — those fail closed without a
// client, so clearing is blocked here before the server 400s.
const CLIENT_REQUIRED_ROLES = new Set<Role>(['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR']);

// Bulk role assignment can't collect a per-user client, so roles that
// REQUIRE a client are excluded — assign those one row at a time.
const BULK_ROLE_OPTIONS: Role[] = ROLE_OPTIONS.filter(
  (r) => !CLIENT_REQUIRED_ROLES.has(r),
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
  const { user: me, can } = useAuth();
  const queryClient = useQueryClient();
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
  // Whose second-role dialog is open.
  const [secondRoleFor, setSecondRoleFor] = useState<AdminUser | null>(null);
  const [status, setStatus] = useState<UserStatus | ''>('');

  const [bulkBusy, setBulkBusy] = useState(false);

  // A role change to a client-scoped role for a user with no client is held
  // here until a client is picked, then applied together.
  const [draftRole, setDraftRole] = useState<Record<string, Role>>({});
  // The supervisor whose shift is being picked. Opens on its own right after
  // a supervisor gets a client — every supervisor has a shift.
  const [shiftFor, setShiftFor] = useState<AdminUser | null>(null);

  // Store pickers for CLIENT_PORTAL rows: locations load per client on
  // demand (a Walmart store manager is ONE Location under the client; a
  // market manager is the whole client). Keyed by clientId.
  const [locationsByClient, setLocationsByClient] = useState<
    Record<string, { id: string; name: string }[]>
  >({});
  const ensureLocations = useCallback(
    async (clientId: string) => {
      if (locationsByClient[clientId]) return;
      try {
        const r = await listClientLocations(clientId);
        setLocationsByClient((m) => ({
          ...m,
          [clientId]: r.locations.map((l) => ({ id: l.id, name: l.name })),
        }));
      } catch {
        // The picker falls back to "whole client" with a retry on next open.
      }
    },
    [locationsByClient],
  );

  // Regions for the command-center picker (CLIENT_PORTAL rows). Loaded once
  // on first use; a region account has no client and no store.
  const [regions, setRegions] = useState<{ id: string; name: string }[] | null>(null);
  const ensureRegions = useCallback(async () => {
    if (regions) return;
    try {
      const r = await listRegions();
      setRegions(r.regions.map((x) => ({ id: x.id, name: x.name })));
    } catch {
      setRegions([]);
    }
  }, [regions]);
  const onAssignRegion = async (u: AdminUser, newRegionId: string) => {
    if (newRegionId === (u.regionId ?? '')) return;
    setPendingId(u.id);
    try {
      await patchAdminUser(u.id, { regionId: newRegionId || null });
      toast.success(newRegionId ? 'Region assigned — this is now a command-center account.' : 'Region cleared.');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onAssignLocation = async (u: AdminUser, newLocationId: string) => {
    if (newLocationId === (u.locationId ?? '')) return;
    setPendingId(u.id);
    try {
      await patchAdminUser(u.id, { locationId: newLocationId || null });
      toast.success(newLocationId ? 'Store assigned.' : 'Now sees the whole client.');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setPendingId(null);
    }
  };

  const loadClientsQuery = useQuery({
    queryKey: ['UsersAdmin', 'clients'],
    queryFn: () => listClients({ status: 'ACTIVE' }),
  });
  const clientsError = loadClientsQuery.isError;
  const clients: { id: string; name: string }[] = loadClientsQuery.data ? loadClientsQuery.data.clients.map((c) => ({ id: c.id, name: c.name })) : [];
  const loadClients = async () => {
    await loadClientsQuery.refetch();
  };


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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }, [appliedQ, role, status]);

  useEffect(() => {
    load();
  }, [load]);

  // Past the cap, "Load all" fetches the rest. The server list endpoint has
  // a hard 500-row cap and accepts NO limit/cursor/offset parameter
  // (apps/api/src/routes/users.ts — take: 500), so a bigger page can't be
  // requested. Instead we fan out one capped request per value of the
  // finest unpinned filter — role (LIVE_ASN included: system accounts show
  // in the unfiltered list), or status when a role filter is active — and
  // merge de-duped. A slice that itself hits the cap leaves rows.length
  // short of total, so the "Showing N of M" header stays honest.
  const [loadingAll, setLoadingAll] = useState(false);
  const canLoadAll = !role || !status;
  const loadAll = useCallback(async () => {
    const term = appliedQ.trim() || undefined;
    const slices: ListUsersFilters[] = !role
      ? (Object.keys(ROLES) as Role[]).map((r) => ({
          q: term,
          role: r,
          status: status || undefined,
        }))
      : STATUS_OPTIONS.map((s) => ({ q: term, role, status: s }));
    setLoadingAll(true);
    try {
      const results = await Promise.allSettled(
        slices.map((f) => listAdminUsers(f)),
      );
      const byId = new Map<string, AdminUser>();
      let failed = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') {
          for (const u of r.value.users) byId.set(u.id, u);
        } else {
          failed++;
        }
      }
      if (failed > 0) {
        toast.error(`${failed} of ${slices.length} pages failed to load — the list may be short. Try again.`);
      }
      // Match the server's newest-first default order.
      const merged = [...byId.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      setRows(merged);
    } finally {
      setLoadingAll(false);
    }
  }, [appliedQ, role, status]);

  /** Apply a single-row mutation across the selection, then summarize. */
  const runBulk = async (
    selectedIds: string[],
    clear: () => void,
    label: string,
    fn: (id: string) => Promise<void>,
  ) => {
    const ids = selectedIds.filter((id) => id !== me?.id);
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
      clear();
      await load();
    } finally {
      setBulkBusy(false);
    }
  };

  const onBulkRole = async (ids: string[], clear: () => void, newRole: Role) => {
    const n = ids.length;
    if (
      !(await confirm({
        title: `Set role to ${ROLE_LABELS[newRole]} for ${n} user${n === 1 ? '' : 's'}?`,
        description: 'Active sessions for these users will be revoked.',
      }))
    ) {
      return;
    }
    await runBulk(ids, clear, 'Set role', (id) => patchAdminUser(id, { role: newRole }));
  };

  const onBulkStatus = async (ids: string[], clear: () => void, newStatus: UserStatus) => {
    const n = ids.length;
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
    await runBulk(ids, clear, 'Set status', (id) => patchAdminUser(id, { status: newStatus }));
  };

  const onBulkForceReset = async (ids: string[], clear: () => void) => {
    const n = ids.length;
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
    await runBulk(ids, clear, 'Force reset', (id) => forcePasswordReset(id));
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
      // A supervisor at a client is assigned their shift next — and a
      // floor supervisor, the shift supervisor in charge of them.
      if ((newRole === 'SHIFT_SUPERVISOR' || newRole === 'FLOOR_SUPERVISOR') && u.clientId) {
        setShiftFor({ ...u, role: newRole, shiftWindows: [], leadUserId: null, leadName: null });
      }
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
      // A new client means new stores — their shift (and, for a floor
      // supervisor, their shift supervisor) is picked next.
      if ((effRole === 'SHIFT_SUPERVISOR' || effRole === 'FLOOR_SUPERVISOR') && newClientId) {
        const client = clients.find((c) => c.id === newClientId);
        setShiftFor({
          ...u,
          role: effRole,
          clientId: newClientId,
          clientName: client?.name ?? null,
          shiftWindows: [],
          leadUserId: null,
          leadName: null,
        });
      }
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

  // Every control the hand-built table had, as a cell. The grid adds the
  // rest: sort on any column, a column chooser, an export of what is on
  // screen, and a card per account on phones instead of a table that
  // hides its own columns.
  const columns: GridColumn<AdminUser>[] = [
    {
      key: 'user',
      header: 'User',
      accessor: (u) => u.associateName ?? u.email,
      csv: (u) => u.email,
      sortable: true,
      primary: true,
      cell: (u) => {
        const isMe = me?.id === u.id;
        return (
          <>
            <div className="text-white">
              {u.associateName ?? u.email}
              {isMe && <span className="ml-2 text-xs text-gold">(you)</span>}
            </div>
            {u.associateName && <div className="text-xs text-silver">{u.email}</div>}
          </>
        );
      },
    },
    {
      key: 'role',
      header: 'Role',
      accessor: (u) => ROLE_LABELS[u.role],
      sortable: true,
      cardMeta: true,
      cell: (u) => {
        const isMe = me?.id === u.id;
        const busy = pendingId === u.id;
        return (
          <>
            <Select
              size="sm"
              aria-label="Change role"
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
            {/* One person, two jobs — the supervisor who also drives. A
                second hat on this account, not a second account. */}
            {!isMe && u.role !== 'CLIENT_PORTAL' && !draftRole[u.id] && (
              <button
                type="button"
                onClick={() => setSecondRoleFor(u)}
                disabled={busy}
                className="mt-1 flex w-full items-center gap-1 rounded-md border border-navy-secondary px-2 py-1 text-left text-xs2 text-silver/80 hover:border-silver/40 hover:text-white"
                title="Other roles this account can switch into"
              >
                <Repeat className="h-3 w-3 shrink-0 text-gold" aria-hidden="true" />
                {u.additionalRoles && u.additionalRoles.length > 0 ? (
                  <span className="truncate">
                    also {u.additionalRoles.map((r) => ROLE_LABELS[r]).join(', ')}
                  </span>
                ) : (
                  <span className="truncate text-silver/50">also works as…</span>
                )}
              </button>
            )}
            {u.activeRole && u.activeRole !== u.role && (
              <div className="mt-1 text-xs2 text-gold">working as {ROLE_LABELS[u.activeRole]} now</div>
            )}
          </>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (u) => STATUS_LABELS[u.status],
      sortable: true,
      cell: (u) => {
        const isMe = me?.id === u.id;
        const busy = pendingId === u.id;
        return (
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(u.status)}>{STATUS_LABELS[u.status]}</Badge>
            {u.lockedUntil && (
              <Badge
                variant="destructive"
                withDot={false}
                title={`Too many failed sign-in attempts — locked until ${fmtDateTime(u.lockedUntil)}`}
              >
                <Lock className="h-3 w-3" aria-hidden="true" />
                Locked
              </Badge>
            )}
            <Select
              size="sm"
              value={u.status}
              onChange={(e) => onChangeStatus(u, e.target.value as UserStatus)}
              disabled={isMe || busy}
              aria-label="Change status"
            >
              {STATUS_OPTIONS.map((st) => (
                <option key={st} value={st}>
                  {STATUS_LABELS[st]}
                </option>
              ))}
            </Select>
          </div>
        );
      },
    },
    {
      key: 'client',
      header: 'Client',
      accessor: (u) => u.clientName,
      sortable: true,
      className: 'text-silver text-xs',
      cell: (u) => {
        const isMe = me?.id === u.id;
        const busy = pendingId === u.id;
        return (
          <>
            {clientsError ? (
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
                <option value="">
                  {CLIENT_REQUIRED_ROLES.has(draftRole[u.id] ?? u.role) ? '— select client —' : 'All clients'}
                </option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
            {(u.role === 'SHIFT_SUPERVISOR' || u.role === 'FLOOR_SUPERVISOR') &&
              !draftRole[u.id] &&
              u.clientId && (
                <button
                  type="button"
                  onClick={() => setShiftFor(u)}
                  disabled={busy}
                  aria-label={`Assign shift for ${u.associateName ?? u.email}`}
                  title={
                    u.role === 'FLOOR_SUPERVISOR'
                      ? 'The shift this floor supervisor works, and the shift supervisor in charge of them.'
                      : 'The shifts this supervisor leads — where their pages open and who hears about a shift first. They still see the whole store.'
                  }
                  className="mt-1 flex w-full flex-col gap-0.5 rounded-md border border-navy-secondary px-2 py-1 text-left text-xs hover:border-silver/40"
                >
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3 w-3 shrink-0 text-silver" aria-hidden="true" />
                    {u.shiftWindows && u.shiftWindows.length > 0 ? (
                      <span className="truncate text-white">{u.shiftWindows.map((w) => w.label).join(', ')}</span>
                    ) : (
                      <Badge variant="pending" size="sm">No shift</Badge>
                    )}
                  </span>
                  {u.role === 'FLOOR_SUPERVISOR' && (
                    <span className="flex items-center gap-1.5">
                      <UserRound className="h-3 w-3 shrink-0 text-silver" aria-hidden="true" />
                      {u.leadName ? (
                        <span className="truncate text-silver">Reports to {u.leadName}</span>
                      ) : (
                        <Badge variant="pending" size="sm">No shift supervisor</Badge>
                      )}
                    </span>
                  )}
                </button>
              )}
            {(draftRole[u.id] ?? u.role) === 'CLIENT_PORTAL' && (
              <Select
                size="sm"
                className="mt-1"
                value={u.regionId ?? ''}
                onFocus={() => void ensureRegions()}
                onChange={(e) => onAssignRegion(u, e.target.value)}
                disabled={isMe || busy}
                aria-label="Assign region"
                title="A region account is the command center for every store in the region; it replaces the client and store scope."
              >
                <option value="">{u.regionId ? '— no region —' : 'Region (command center)…'}</option>
                {(regions ?? (u.regionId && u.regionName ? [{ id: u.regionId, name: u.regionName }] : [])).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            )}
            {(draftRole[u.id] ?? u.role) === 'CLIENT_PORTAL' && u.clientId && (
              <Select
                size="sm"
                className="mt-1"
                value={u.locationId ?? ''}
                onFocus={() => void ensureLocations(u.clientId!)}
                onChange={(e) => onAssignLocation(u, e.target.value)}
                disabled={isMe || busy}
                aria-label="Assign store"
                title="A store manager sees one store; leave on 'Whole client' for a market or district manager."
              >
                <option value="">Whole client</option>
                {(locationsByClient[u.clientId] ?? (u.locationId && u.locationName ? [{ id: u.locationId, name: u.locationName }] : [])).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </>
        );
      },
    },
    {
      key: 'created',
      header: 'Created',
      accessor: (u) => u.createdAt,
      csv: (u) => u.createdAt.slice(0, 10),
      sortable: true,
      searchable: false,
      cardMeta: true,
      className: 'text-silver text-xs whitespace-nowrap',
      cell: (u) => fmtDate(u.createdAt),
    },
    {
      key: 'actions',
      header: 'Actions',
      accessor: () => null,
      searchable: false,
      csv: () => '',
      align: 'right',
      cell: (u) => {
        const isMe = me?.id === u.id;
        const busy = pendingId === u.id;
        return (
          <>
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
              title={isMe ? 'Use /settings to change your own password' : 'Send a fresh reset link and revoke active sessions'}
            >
              <KeyRound className="mr-1 h-3 w-3" />
              Force reset
            </Button>
          </>
        );
      },
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Users & access"
        subtitle="Every account in the org. Change a role, disable a compromised account, or force a password reset."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'Users & access' }]}
      />

      {/* Shifts nobody leads / supervisors with no shift — only when any. */}
      <ShiftLeadsCard hideWhenClear onChanged={() => void load()} />

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
        </CardContent>
      </Card>

      {counts && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-silver">
          <Badge variant="success">{counts.ACTIVE} active</Badge>
          <Badge variant="pending">{counts.INVITED} invited</Badge>
          <Badge variant="destructive">{counts.DISABLED} disabled</Badge>
          {rows !== null && total !== null && total > rows.length && (
            <>
              <span className="tabular-nums">
                Showing {rows.length} of {total}
                {canLoadAll ? '.' : ' — narrow the search to see the rest.'}
              </span>
              {canLoadAll && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadAll()}
                  disabled={loading || loadingAll}
                  loading={loadingAll}
                >
                  Load all {total}
                </Button>
              )}
            </>
          )}
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
          <DataGrid<AdminUser>
            id="users-admin"
            caption="User accounts"
            rows={rows}
            columns={columns}
            rowKey={(u) => u.id}
            loading={loading && rows === null}
            search={false}
            urlState={false}
            exportCsv={{ filename: 'users' }}
            total={total ?? undefined}
            empty={{
              icon: Users,
              title: q || role || status ? 'No users match those filters' : 'No users yet',
              description:
                q || role || status
                  ? 'Loosen the search or filters to see more accounts.'
                  : 'Accounts appear here as people are invited.',
              action:
                q || role || status ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setQ('');
                      setRole('');
                      setStatus('');
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined,
            }}
            selectable={{
              // HR can't bulk-edit their own account — same rule as the
              // per-row controls.
              disabled: (u) => u.id === me?.id,
              actions: (ids, clear) => (
                <>
                  <Select
                    size="sm"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) void onBulkRole(ids, clear, e.target.value as Role);
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
                      if (e.target.value) void onBulkStatus(ids, clear, e.target.value as UserStatus);
                    }}
                    disabled={bulkBusy}
                    aria-label="Set status for selected users"
                  >
                    <option value="">Set status…</option>
                    {STATUS_OPTIONS.map((st) => (
                      <option key={st} value={st}>
                        {STATUS_LABELS[st]}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void onBulkForceReset(ids, clear)}
                    disabled={bulkBusy}
                  >
                    <KeyRound className="mr-1 h-3 w-3" />
                    Force reset
                  </Button>
                </>
              ),
            }}
          />
        </CardContent>
      </Card>

      {secondRoleFor && (

        <SecondRoleDialog

          user={secondRoleFor}

          open

          onOpenChange={(o) => !o && setSecondRoleFor(null)}

          onSaved={() => void load()}

        />

      )}

      {shiftFor && (
        <SupervisorShiftDialog
          user={shiftFor}
          open
          onOpenChange={(o) => !o && setShiftFor(null)}
          onSaved={() => {
            void load();
            void queryClient.invalidateQueries({ queryKey: ['shift-windows', 'gaps'] });
          }}
          readOnly={!can('manage:org')}
        />
      )}

      <div className="text-xs text-silver flex items-center gap-1">
        <ShieldCheck className="h-3 w-3" />
        Every change here is recorded in the audit log.
      </div>
    </div>
  );
}
