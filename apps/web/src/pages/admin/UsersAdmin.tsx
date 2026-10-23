import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { KeyRound, Lock, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES, type Role } from '@/lib/roles';
import { useAuth, useTenant, useTerm, useRoleLabel } from '@/lib/auth';
import { roleOfferedFor } from '@/lib/modules';
import { useConfirm } from '@/lib/confirm';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtRelativeDate } from '@/lib/format';
import { personPhotoUrl } from '@/lib/photoUrl';
import { useUrlParam, useUrlWriter } from '@/lib/useUrlState';
import { forcePasswordReset, listAdminUsers, patchAdminUser, deactivateUsers, type AdminUser, type ListUsersFilters, type UserStatus } from '@/lib/usersAdminApi';
import { listClients } from '@/lib/clientsApi';
import { getShiftCoverageGaps } from '@/lib/shiftWindowsApi';
import { useDeskItem } from '@/components/templates';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { FilterBar, FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { DeactivateDialog } from './AccessReport';
import { UserDrawer } from './UserDrawer';
import { InviteUserDialog } from './InviteUserDialog';
import { BULK_ROLE_OPTIONS, ROLE_OPTIONS, STATUS_LABELS, STATUS_OPTIONS, STATUS_VIEWS, scopeText, statusVariant, statusesFor, type StatusView } from './userAccess';

const FILTER_KEYS = ['q', 'role', 'status'] as const;

/**
 * Users & access (F500 G4): every account that can sign in, read first.
 *
 * A row is one line — who, their role, their status, their reach, when they
 * were last active, two-step, created — and opening it (the drawer, kept in
 * the URL as ?user=) is where anything changes. The list opens on the
 * accounts that can or soon will sign in (active + invited); the status
 * chips count each status and switch to it. "Invite user" adds an account.
 *
 * The access report moved to Access certifications, the access-review home
 * (?view=report still lands there). Shifts without a lead are Store leads'
 * work; one line points there when there are any.
 */
export function UsersAdmin() {
  const { search } = useLocation();
  // The old access-report deep link lands on its new home.
  if (new URLSearchParams(search).get('view') === 'report') return <Navigate to="/admin/access-certifications?tab=report" replace />;
  return <UsersAdminPage />;
}

function UsersAdminPage() {
  const roleLabel = useRoleLabel();
  const { user: me, can } = useAuth();
  const canManage = can('manage:org');
  const tenant = useTenant();
  const termOf = useTerm();
  const storeWord = termOf('label.store').toLowerCase();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  // View state in the URL: search, role, status view, and the open account.
  const [q, setQ] = useUrlParam<string>('q', '');
  const [role, setRole] = useUrlParam<Role | ''>('role', '', ['', ...(Object.keys(ROLES) as Role[])]);
  const [statusView, setStatusView] = useUrlParam<StatusView>('status', 'open', STATUS_VIEWS);
  const write = useUrlWriter();
  const clearFilters = () => write((p) => FILTER_KEYS.forEach((k) => p.delete(k)));
  const drawer = useDeskItem('user');
  const [inviting, setInviting] = useState(false);
  const [gridBar, setGridBar] = useState<HTMLDivElement | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeactivate, setBulkDeactivate] = useState<{ ids: string[]; clear: () => void } | null>(null);

  // The box types freely; the list follows a beat later (one request, not one per key).
  const [qInput, setQInput] = useState(q);
  useEffect(() => setQInput(q), [q]);
  useEffect(() => {
    if (qInput === q) return;
    const t = setTimeout(() => setQ(qInput.trim()), 250);
    return () => clearTimeout(t);
  }, [qInput, q, setQ]);

  const clientsQuery = useQuery({ queryKey: ['UsersAdmin', 'clients'], queryFn: () => listClients({ status: 'ACTIVE' }) });
  const clients = useMemo(() => (clientsQuery.data?.clients ?? []).map((c) => ({ id: c.id, name: c.name })), [clientsQuery.data]);

  // The filters are part of the key: one cache entry per combination.
  const listFilters: ListUsersFilters = { q: q || undefined, role: role || undefined, status: statusesFor(statusView) };
  const listQuery = useQuery({ queryKey: ['UsersAdmin', 'rows', listFilters], queryFn: () => listAdminUsers(listFilters) });
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  useEffect(() => {
    if (listQuery.data) setRows(listQuery.data.users);
  }, [listQuery.data]);
  const total = listQuery.data?.total ?? null;
  const counts = listQuery.data?.counts ?? null;
  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['UsersAdmin'] });
  }, [queryClient]);

  // Shifts nobody leads are Store leads' work (G2); here, one line at most.
  const gaps = useQuery({ queryKey: ['shift-windows', 'gaps'], queryFn: () => getShiftCoverageGaps(), staleTime: 60_000, retry: false, enabled: canManage });
  const unled = (gaps.data?.clients ?? []).reduce((n, c) => n + c.uncovered.length, 0);

  // Past the 500 cap, "Load all" fans out one capped request per role.
  const [loadingAll, setLoadingAll] = useState(false);
  const loadAll = useCallback(async () => {
    setLoadingAll(true);
    try {
      const slices: ListUsersFilters[] = role
        ? STATUS_OPTIONS.filter((s) => !statusesFor(statusView) || statusesFor(statusView)!.includes(s)).map((s) => ({ q: q || undefined, role, status: s }))
        : (Object.keys(ROLES) as Role[]).map((r) => ({ q: q || undefined, role: r, status: statusesFor(statusView) }));
      const results = await Promise.allSettled(slices.map((f) => listAdminUsers(f)));
      const byId = new Map<string, AdminUser>();
      let failed = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') for (const u of r.value.users) byId.set(u.id, u);
        else failed++;
      }
      if (failed > 0) toast.error(`${failed} of ${slices.length} pages failed to load; the list may be short. Try again.`);
      setRows([...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } finally {
      setLoadingAll(false);
    }
  }, [q, role, statusView]);

  /** Apply a single-account change across the selection, then summarize. */
  const runBulk = async (selectedIds: string[], clear: () => void, label: string, fn: (id: string) => Promise<unknown>) => {
    const ids = selectedIds.filter((id) => id !== me?.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => fn(id)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      if (failed === 0) toast.success(`${label}: ${ok} ${ok === 1 ? 'account' : 'accounts'} updated.`);
      else toast.error(`${label}: ${ok} succeeded, ${failed} failed.`);
      clear();
      await reload();
    } finally {
      setBulkBusy(false);
    }
  };
  const onBulkRole = async (ids: string[], clear: () => void, next: Role) => {
    const n = ids.length;
    if (!(await confirm({ title: `Set the role to ${roleLabel(next)} for ${n} ${n === 1 ? 'account' : 'accounts'}?`, description: 'Their active sessions are signed out.' }))) return;
    await runBulk(ids, clear, 'Set role', (id) => patchAdminUser(id, { role: next }));
  };
  const onBulkStatus = async (ids: string[], clear: () => void, next: UserStatus) => {
    if (next === 'DISABLED') {
      // The reversible way: a reason, one audit row per account, 30 days to undo.
      const targets = ids.filter((id) => id !== me?.id);
      if (targets.length > 0) setBulkDeactivate({ ids: targets, clear });
      return;
    }
    const n = ids.length;
    if (!(await confirm({ title: `Set ${n} ${n === 1 ? 'account' : 'accounts'} to ${STATUS_LABELS[next].toLowerCase()}?` }))) return;
    await runBulk(ids, clear, 'Set status', (id) => patchAdminUser(id, { status: next }));
  };
  const onBulkForceReset = async (ids: string[], clear: () => void) => {
    const n = ids.length;
    if (!(await confirm({ title: `Force a password reset for ${n} ${n === 1 ? 'account' : 'accounts'}?`, description: 'A reset link is emailed and every active session is signed out.', destructive: true }))) return;
    await runBulk(ids, clear, 'Force reset', (id) => forcePasswordReset(id));
  };

  const columns: GridColumn<AdminUser>[] = [
    {
      key: 'user',
      header: 'User',
      accessor: (u) => u.associateName ?? u.email,
      csv: (u) => u.email,
      sortable: true,
      primary: true,
      cell: (u) => (
        <div className="flex min-w-0 items-center gap-2">
          <Avatar src={personPhotoUrl({ photoUrl: u.photoUrl, associateId: u.associateId, userId: u.id })} name={u.associateName} email={u.email} size="sm" />
          <div className="min-w-0">
            <div className="truncate text-ink">
              {u.associateName ?? u.email}
              {me?.id === u.id && <span className="ml-2 text-xs text-accent">(you)</span>}
            </div>
            {u.associateName && <div className="truncate text-xs text-ink-muted">{u.email}</div>}
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      // A held invite shows the role it waits for.
      accessor: (u) => roleLabel(u.pendingAccess?.invite && u.pendingAccess.role ? u.pendingAccess.role : u.role),
      sortable: true,
      cardMeta: true,
      cell: (u) => {
        const shown = u.pendingAccess?.invite && u.pendingAccess.role ? u.pendingAccess.role : u.role;
        const extra = u.additionalRoles ?? [];
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-ink">{roleLabel(shown)}</span>
            {extra.length > 0 && (
              <Badge variant="default" size="sm" withDot={false} title={`Also works as ${extra.map((r) => roleLabel(r)).join(', ')}`}>
                +{extra.length}
              </Badge>
            )}
            {/* A staff login with no person record cannot clock in, be scheduled
                or be paid: say so in the row; the drawer sets it up. */}
            {!u.associateId && u.role !== 'ASSOCIATE' && u.role !== 'CLIENT_PORTAL' && (
              <Badge variant="pending" size="sm" withDot={false} title="Their clock, schedule and pay won't work until a person record exists. Open the account to set it up.">
                No person record
              </Badge>
            )}
            {u.pendingAccess && !u.pendingAccess.invite && (
              <Badge variant="pending" size="sm" withDot={false} title="Waits for a second administrator">
                {u.pendingAccess.role ? `→ ${roleLabel(u.pendingAccess.role)}` : 'Change waiting'}
              </Badge>
            )}
          </span>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (u) => (u.pendingAccess?.invite ? 'Waiting for approval' : STATUS_LABELS[u.status]),
      sortable: true,
      cell: (u) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {u.pendingAccess?.invite ? <Badge variant="pending">Waiting for approval</Badge> : <Badge variant={statusVariant(u.status)}>{STATUS_LABELS[u.status]}</Badge>}
          {u.lockedUntil && (
            <Badge variant="destructive" size="sm" withDot={false} title="Too many wrong passwords">
              <Lock className="h-3 w-3" aria-hidden="true" /> Locked
            </Badge>
          )}
          {u.purgeAfter && u.deactivatedAt && (
            <Badge variant="pending" size="sm" withDot={false} title={u.deactivationReason ?? undefined}>
              Deletes {fmtDate(u.purgeAfter)}
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'scope',
      header: 'Scope',
      accessor: (u) => scopeText(u, storeWord),
      sortable: true,
      className: 'min-w-[9rem] text-ink-muted',
    },
    {
      key: 'lastSeen',
      header: 'Last active',
      accessor: (u) => u.lastSeenAt ?? '',
      csv: (u) => (u.lastSeenAt ? u.lastSeenAt.slice(0, 10) : 'never'),
      sortable: true,
      searchable: false,
      className: 'whitespace-nowrap tabular-nums text-ink-muted',
      cell: (u) => (u.lastSeenAt ? fmtRelativeDate(u.lastSeenAt) : <span className="text-ink-muted/70">Never</span>),
    },
    {
      key: 'mfa',
      header: 'Two-step',
      accessor: (u) => (u.mfaEnabled ? 'On' : 'Off'),
      sortable: true,
      searchable: false,
      cell: (u) => (u.mfaEnabled ? <Badge variant="success" size="sm">On</Badge> : <span className="text-ink-muted">Off</span>),
    },
    {
      key: 'created',
      header: 'Created',
      accessor: (u) => u.createdAt,
      csv: (u) => u.createdAt.slice(0, 10),
      sortable: true,
      searchable: false,
      // Off by default so seven columns fit beside the Settings rail at 1440
      // with nothing clipped; Columns brings it back, the CSV and the drawer carry it.
      defaultHidden: true,
      className: 'whitespace-nowrap text-ink-muted',
      cell: (u) => fmtDate(u.createdAt),
    },
  ];

  const openUser = rows?.find((u) => u.id === drawer.openId) ?? null;
  const activeFilters = (q ? 1 : 0) + (role ? 1 : 0) + (statusView !== 'open' ? 1 : 0);
  const capped = rows !== null && total !== null && total > rows.length;
  const chip = (view: StatusView, label: string, count: number | undefined, pressed: boolean) => (
    <FilterChip key={view} active={pressed} count={count} onClick={() => setStatusView(statusView === view ? 'open' : view)}>
      {label}
    </FilterChip>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Users & access"
        subtitle="Every account that can sign in: its role, its reach and how it signs in. Open one to change it."
        actions={[{ label: 'Invite user', icon: UserPlus, primary: true, onSelect: () => setInviting(true), hidden: !canManage }]}
        related={[
          { label: 'Roles & permissions', to: '/admin/roles' },
          { label: 'Access review', to: '/admin/access-certifications' },
        ]}
      />

      {unled > 0 && (
        <p className="text-sm text-ink-muted" data-testid="shift-leads-line">
          {unled === 1 ? '1 shift has no lead.' : `${unled} shifts have no lead.`}{' '}
          <Link to="/scheduling/supervisors" className="text-accent underline-offset-2 hover:underline">
            Assign them in {termOf('label.store')} leads
          </Link>
        </p>
      )}

      {listQuery.isError && !rows ? (
        <QueryError what="the accounts" query={listQuery} />
      ) : (
        <Card>
          <CardContent className="space-y-0 p-0">
            <FilterBar
              className="rounded-b-none border-x-0 border-t-0"
              search={<SearchInput aria-label="Search accounts" placeholder="Name or email" value={qInput} onChange={(e) => setQInput(e.target.value)} wrapperClassName="w-full" />}
              urlKey={['role', 'status']}
              // The grid's count, Columns and Export sit in this tray's row, inside the card.
              actions={<div ref={setGridBar} className="ml-auto flex items-center gap-2" />}
              onClearFilters={clearFilters}
            >
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Status">
                {chip('ACTIVE', 'Active', counts?.ACTIVE, statusView === 'open' || statusView === 'ACTIVE')}
                {chip('INVITED', 'Invited', counts?.INVITED, statusView === 'open' || statusView === 'INVITED')}
                {chip('DISABLED', 'Disabled', counts?.DISABLED, statusView === 'DISABLED')}
                {chip('all', 'All', counts ? counts.ACTIVE + counts.INVITED + counts.DISABLED : undefined, statusView === 'all')}
              </div>
              <Select size="sm" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role | '')} className="w-48">
                <option value="">All roles</option>
                {ROLE_OPTIONS.filter((r) => roleOfferedFor(r, tenant.modules)).map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </Select>
            </FilterBar>
            <DataGrid<AdminUser>
              id="users-admin"
              caption="User accounts"
              noun={{ one: 'account', many: 'accounts' }}
              rows={rows}
              columns={columns}
              rowKey={(u) => u.id}
              loading={listQuery.isPending && rows === null}
              search={false}
              urlState={false}
              toolbar={{ into: gridBar }}
              exportCsv={{ filename: 'users' }}
              total={total ?? undefined}
              activeFilters={activeFilters}
              onClearFilters={clearFilters}
              onRowClick={(u) => drawer.open(u.id)}
              rowActionLabel={(u) => `Open ${u.associateName ?? u.email}`}
              rowClassName={(u) => (u.id === drawer.openId ? 'bg-surface-raised/60' : undefined)}
              empty={{
                icon: Users,
                title: 'No accounts yet',
                description: 'Invite someone on staff, or hire through Onboarding.',
                action: canManage ? (
                  <Button size="sm" onClick={() => setInviting(true)}>
                    Invite user
                  </Button>
                ) : undefined,
              }}
              footnote={
                capped ? (
                  <span className="flex flex-wrap items-center gap-2">
                    Showing the newest {rows!.length} of {total}.
                    <Button variant="ghost" size="sm" onClick={() => void loadAll()} loading={loadingAll} disabled={loadingAll}>
                      Load all {total}
                    </Button>
                  </span>
                ) : undefined
              }
              selectable={
                canManage
                  ? {
                      disabled: (u) => u.id === me?.id,
                      actions: (ids, clear) => (
                        <>
                          <Select size="sm" value="" onChange={(e) => e.target.value && void onBulkRole(ids, clear, e.target.value as Role)} disabled={bulkBusy} aria-label="Set role for selected users">
                            <option value="">Set role…</option>
                            {BULK_ROLE_OPTIONS.filter((r) => roleOfferedFor(r, tenant.modules)).map((r) => (
                              <option key={r} value={r}>
                                {roleLabel(r)}
                              </option>
                            ))}
                          </Select>
                          <Select size="sm" value="" onChange={(e) => e.target.value && void onBulkStatus(ids, clear, e.target.value as UserStatus)} disabled={bulkBusy} aria-label="Set status for selected users">
                            <option value="">Set status…</option>
                            {STATUS_OPTIONS.map((st) => (
                              <option key={st} value={st}>
                                {STATUS_LABELS[st]}
                              </option>
                            ))}
                          </Select>
                          <Button variant="ghost" size="sm" onClick={() => void onBulkForceReset(ids, clear)} disabled={bulkBusy}>
                            <KeyRound className="mr-1 h-3 w-3" aria-hidden="true" /> Force reset
                          </Button>
                        </>
                      ),
                    }
                  : undefined
              }
            />
          </CardContent>
        </Card>
      )}

      {openUser && (
        <UserDrawer
          key={openUser.id}
          user={openUser}
          clients={clients}
          clientsError={clientsQuery.isError}
          onRetryClients={() => void clientsQuery.refetch()}
          onClose={drawer.close}
          onChanged={reload}
        />
      )}

      {inviting && (
        <InviteUserDialog
          clients={clients}
          onClose={() => setInviting(false)}
          onInvited={(id) => {
            setInviting(false);
            void reload();
            if (id) drawer.open(id);
          }}
        />
      )}

      {bulkDeactivate && (
        <DeactivateDialog
          count={bulkDeactivate.ids.length}
          onClose={() => setBulkDeactivate(null)}
          onConfirm={async (reason) => {
            try {
              const res = await deactivateUsers(bulkDeactivate.ids, reason);
              const k = res.deactivated.length;
              if (res.skipped.length === 0) toast.success(`${k} ${k === 1 ? 'account' : 'accounts'} deactivated. Reversible for 30 days.`);
              else toast.error(`${k} deactivated, ${res.skipped.length} skipped: ${res.skipped.map((x) => x.reason).join(' ')}`);
              bulkDeactivate.clear();
              setBulkDeactivate(null);
              await reload();
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Could not deactivate.');
            }
          }}
        />
      )}
    </div>
  );
}
