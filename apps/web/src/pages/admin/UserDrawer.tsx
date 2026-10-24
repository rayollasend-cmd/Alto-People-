import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, KeyRound, Lock, MapPin, Repeat, ShieldAlert, ShieldCheck, Unlock, UserRound } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { Role } from '@/lib/roles';
import { useAuth, useRoleLabel, useTenant, useTerm } from '@/lib/auth';
import { roleOfferedFor } from '@/lib/modules';
import { useConfirm } from '@/lib/confirm';
import { errorText } from '@/lib/errorText';
import { fmtDate, fmtDateTime, fmtRelativeDate } from '@/lib/format';
import { personPhotoUrl } from '@/lib/photoUrl';
import { isPending } from '@/lib/approvalRequestsApi';
import {
  deactivateUsers,
  forcePasswordReset,
  patchAdminUser,
  reactivateUser,
  unlockUser,
  type AdminUser,
} from '@/lib/usersAdminApi';
import { listClientLocations } from '@/lib/clientsApi';
import { listRegions } from '@/lib/regionsApi';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { ApproverPicker } from '@/components/ApproverPicker';
import { BreakGlassDialog, ScopeDialog } from '@/components/admin/AccessBindingDialogs';
import { SecondRoleDialog } from './SecondRoleDialog';
import { ElevateAccessDialog } from './ElevateAccessDialog';
import { PersonRecordDialog } from './PersonRecordDialog';
import { SupervisorShiftDialog } from './SupervisorShiftDialog';
import { DeactivateDialog } from './AccessReport';
import { BOUNDED_ROLES, CLIENT_REQUIRED_ROLES, ROLE_OPTIONS, STATUS_LABELS, scopeText, statusVariant } from './userAccess';

/**
 * One account, opened from Users & access (F500 G4): what it can do, how it
 * signs in, and — last, apart — how it is turned off. The list is read-only;
 * every change to an account happens here, so a row is one line again.
 *
 *   Access     role, the other roles it switches into, temporary access,
 *              its client / store / region, or its site-and-region scope
 *   Security   two-step, last active, a lock, a forced reset, break-glass
 *   Danger     deactivate (reversible for 30 days) or bring it back
 *
 * Changes need manage:org; a reader (the chairman holds view:hr-admin
 * only) sees the same drawer with nothing to press.
 */
export function UserDrawer({
  user: u,
  clients,
  clientsError,
  onRetryClients,
  onClose,
  onChanged,
}: {
  user: AdminUser;
  clients: Array<{ id: string; name: string }>;
  clientsError: boolean;
  onRetryClients: () => void;
  onClose: () => void;
  onChanged: () => Promise<unknown> | void;
}) {
  const roleLabel = useRoleLabel();
  const { user: me, can } = useAuth();
  const tenant = useTenant();
  const termOf = useTerm();
  const storeWord = termOf('label.store').toLowerCase();
  const confirm = useConfirm();
  const canManage = can('manage:org');
  const isMe = me?.id === u.id;
  const readOnly = isMe || !canManage;
  const [busy, setBusy] = useState(false);
  // A client-scoped role picked for an account with no client waits here for its client.
  const [draftRole, setDraftRole] = useState<Role | null>(null);
  const [dialog, setDialog] = useState<null | 'second-role' | 'elevate' | 'scope' | 'break-glass' | 'shift' | 'deactivate' | 'person-record'>(null);
  const [regionApproval, setRegionApproval] = useState<{ regionId: string; regionName: string } | null>(null);
  const [locations, setLocations] = useState<Array<{ id: string; name: string }> | null>(null);
  const [regions, setRegions] = useState<Array<{ id: string; name: string }> | null>(null);
  const effRole = draftRole ?? u.role;
  const heldInvite = !!u.pendingAccess?.invite;

  const run = async (fn: () => Promise<unknown>, ok: string | ((r: unknown) => string), failed: string) => {
    setBusy(true);
    try {
      const r = await fn();
      toast.success(typeof ok === 'function' ? ok(r) : ok);
      await onChanged();
      return true;
    } catch (err) {
      toast.error(errorText(err, failed));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const ensureLocations = useCallback(async () => {
    if (locations || !u.clientId) return;
    try {
      const r = await listClientLocations(u.clientId);
      setLocations(r.locations.map((l) => ({ id: l.id, name: l.name })));
    } catch {
      // The picker keeps "whole client" and the current store; it retries on next focus.
    }
  }, [locations, u.clientId]);
  const ensureRegions = useCallback(async () => {
    if (regions) return;
    try {
      const r = await listRegions();
      setRegions(r.regions.map((x) => ({ id: x.id, name: x.name })));
    } catch {
      setRegions([]);
    }
  }, [regions]);

  const onChangeRole = async (next: Role) => {
    if (next === effRole) return;
    if (CLIENT_REQUIRED_ROLES.has(next) && !u.clientId) {
      setDraftRole(next);
      toast.message(`Pick a client to finish assigning ${roleLabel(next)}.`);
      return;
    }
    if (!(await confirm({ title: `Change ${u.email}'s role?`, description: `From ${roleLabel(u.role)} to ${roleLabel(next)}. Active sessions for this account are signed out.` }))) return;
    const done = await run(
      () => patchAdminUser(u.id, { role: next }),
      (r) => (isPending(r) ? 'Sent for approval. The role changes when a second administrator approves it.' : 'Role changed.'),
      "Couldn't change the role.",
    );
    if (done) {
      setDraftRole(null);
      if ((next === 'SHIFT_SUPERVISOR' || next === 'FLOOR_SUPERVISOR') && u.clientId) setDialog('shift');
    }
  };

  const onAssignClient = async (clientId: string) => {
    if (!clientId && CLIENT_REQUIRED_ROLES.has(effRole)) {
      toast.error(`${roleLabel(effRole)} must have a client.`);
      return;
    }
    if (clientId === (u.clientId ?? '') && !draftRole) return;
    const done = await run(
      () => patchAdminUser(u.id, { clientId: clientId || null, ...(draftRole ? { role: draftRole } : {}) }),
      draftRole ? 'Role and client assigned.' : 'Client changed.',
      "Couldn't change the client.",
    );
    if (done) {
      setDraftRole(null);
      setLocations(null);
      if ((effRole === 'SHIFT_SUPERVISOR' || effRole === 'FLOOR_SUPERVISOR') && clientId) setDialog('shift');
    }
  };

  const onAssignRegion = async (regionId: string, approvedByUserId?: string) => {
    if (regionId === (u.regionId ?? '')) return;
    // Brief 1A-4: putting an account on a region needs a named approver.
    if (regionId && !approvedByUserId) {
      setRegionApproval({ regionId, regionName: (regions ?? []).find((r) => r.id === regionId)?.name ?? 'this region' });
      return;
    }
    await run(
      () => patchAdminUser(u.id, { regionId: regionId || null, ...(approvedByUserId ? { approvedByUserId } : {}) }),
      regionId ? 'Region assigned: this is now a command-center account.' : 'Region cleared.',
      "Couldn't change the region.",
    );
  };

  const onAssignLocation = (locationId: string) => {
    if (locationId === (u.locationId ?? '')) return;
    void run(() => patchAdminUser(u.id, { locationId: locationId || null }), locationId ? `${termOf('label.store')} assigned.` : 'Now sees the whole client.', "Couldn't change the location.");
  };

  const onForceReset = async () => {
    if (!(await confirm({ title: `Force a password reset for ${u.email}?`, description: 'A reset link is emailed and every active session for this account is signed out. Use it when the account is at risk or the person is locked out.', destructive: true }))) return;
    await run(() => forcePasswordReset(u.id), 'Reset link sent.', "Couldn't require a password reset.");
  };

  const onReactivate = async () => {
    if (!(await confirm({ title: `Reactivate ${u.email}?`, description: 'The account comes back exactly as it was. The deletion is cancelled.' }))) return;
    await run(() => reactivateUser(u.id), (r) => ((r as { status?: string })?.status === 'INVITED' ? 'Reactivated. They never set a password, so the invite stands.' : 'Reactivated.'), "Couldn't reactivate the account.");
  };

  const onEnable = async () => {
    if (!(await confirm({ title: `Turn ${u.email} back on?`, description: 'They can sign in again with their password or your sign-in.' }))) return;
    await run(() => patchAdminUser(u.id, { status: 'ACTIVE' }), 'Account is on again.', "Couldn't change the account status.");
  };

  const name = u.associateName ?? u.email;
  const places = (u.scopeSiteIds?.length ?? 0) + (u.scopeRegionIds?.length ?? 0);
  const isSupervisor = effRole === 'SHIFT_SUPERVISOR' || effRole === 'FLOOR_SUPERVISOR';
  const offeredRoles = ROLE_OPTIONS.filter((r) => roleOfferedFor(r, tenant.modules));

  return (
    <>
      <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-lg">
        <DrawerHeader>
          <div className="flex items-center gap-3">
            <Avatar src={personPhotoUrl({ photoUrl: u.photoUrl, associateId: u.associateId, userId: u.id })} name={u.associateName} email={u.email} size="md" />
            <div className="min-w-0">
              <DrawerTitle className="truncate">
                {name}
                {isMe && <span className="ml-2 text-xs font-normal text-accent">(you)</span>}
              </DrawerTitle>
              <DrawerDescription className="truncate">{u.associateName ? `${u.email} · created ${fmtDate(u.createdAt)}` : `Created ${fmtDate(u.createdAt)}`}</DrawerDescription>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={heldInvite ? 'pending' : statusVariant(u.status)}>{heldInvite ? 'Invite waiting for approval' : STATUS_LABELS[u.status]}</Badge>
            {u.lockedUntil && (
              <Badge variant="destructive" withDot={false}>
                <Lock className="h-3 w-3" aria-hidden="true" /> Locked
              </Badge>
            )}
            {u.purgeAfter && u.deactivatedAt && (
              <Badge variant="pending" withDot={false}>
                Deletes {fmtDate(u.purgeAfter)}
              </Badge>
            )}
          </div>
        </DrawerHeader>
        <DrawerBody className="space-y-6">
          {isMe && (
            <p className="rounded-md border border-line p-3 text-sm text-ink-muted">
              This is your account. Change your own password and two-step sign-in in{' '}
              <Link to="/settings" className="text-accent underline underline-offset-2">
                Settings
              </Link>
              ; another administrator changes your role.
            </p>
          )}
          {u.pendingAccess && (
            <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-ink" role="status">
              {u.pendingAccess.invite
                ? `This invite waits for a second administrator${u.pendingAccess.role ? ` to approve ${roleLabel(u.pendingAccess.role)}` : ''}. The email goes out when it is approved.`
                : `A change to ${u.pendingAccess.role ? roleLabel(u.pendingAccess.role) : 'more access'} waits for a second administrator.`}{' '}
              <Link to={`/approvals?tab=requests&approval=${u.pendingAccess.approvalId}`} className="text-accent underline underline-offset-2">
                See the request
              </Link>
            </p>
          )}

          {/* A staff login with no person record cannot clock in, be scheduled or
              be paid. One tap creates the record (or links the one already in
              People under this email). */}
          {!u.associateId && u.role !== 'ASSOCIATE' && u.role !== 'CLIENT_PORTAL' && canManage && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/[0.06] p-3 text-sm">
              <span className="text-ink">No person record: their clock, schedule and pay won't work until one exists.</span>
              <Button size="sm" variant="secondary" onClick={() => setDialog('person-record')} disabled={busy}>
                Set it up
              </Button>
            </div>
          )}

          <section aria-labelledby="user-access" className="space-y-3">
            <h3 id="user-access" className="text-sm font-semibold text-ink">
              Access
            </h3>
            <Field label="Role">
              {(p) => (
                <Select {...p} value={effRole} onChange={(e) => void onChangeRole(e.target.value as Role)} disabled={readOnly || busy || heldInvite}>
                  {offeredRoles.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {u.activeRole && u.activeRole !== u.role && <p className="text-xs text-accent">Working as {roleLabel(u.activeRole)} now.</p>}
            {u.role !== 'CLIENT_PORTAL' && !draftRole && !heldInvite && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setDialog('second-role')} disabled={readOnly || busy} title="Other roles this account can switch into">
                  <Repeat className="h-3.5 w-3.5" aria-hidden="true" />
                  {u.additionalRoles?.length ? `Also works as ${u.additionalRoles.map((r) => roleLabel(r)).join(', ')}` : 'Also works as…'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDialog('elevate')} disabled={readOnly || busy} title="A role until a date, taken back on time">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Temporary access…
                </Button>
              </div>
            )}

            <Field label="Client" hint={CLIENT_REQUIRED_ROLES.has(effRole) ? 'This role works at one client.' : effRole === 'CLIENT_PORTAL' ? undefined : 'Optional: a home client for this account’s defaults. “All clients” keeps the whole organization.'}>
              {(p) =>
                clientsError ? (
                  <Button variant="ghost" size="sm" onClick={onRetryClients}>
                    Couldn't load clients. Retry
                  </Button>
                ) : (
                  <Select {...p} value={u.clientId ?? ''} onChange={(e) => void onAssignClient(e.target.value)} disabled={readOnly || busy}>
                    <option value="">{CLIENT_REQUIRED_ROLES.has(effRole) ? 'Select a client' : 'All clients'}</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )
              }
            </Field>

            {isSupervisor && !draftRole && u.clientId && (
              <button
                type="button"
                onClick={() => setDialog('shift')}
                disabled={busy}
                className="flex w-full flex-col gap-1 rounded-md border border-line px-3 py-2 text-left text-sm hover:border-ink-muted/40"
                aria-label={`Assign shift for ${name}`}
              >
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                  {u.shiftWindows && u.shiftWindows.length > 0 ? <span className="text-ink">{u.shiftWindows.map((w) => w.label).join(', ')}</span> : <Badge variant="pending" size="sm">No shift</Badge>}
                </span>
                {effRole === 'FLOOR_SUPERVISOR' && (
                  <span className="flex items-center gap-1.5">
                    <UserRound className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                    {u.leadName ? <span className="text-ink-muted">Reports to {u.leadName}</span> : <Badge variant="pending" size="sm">No shift supervisor</Badge>}
                  </span>
                )}
              </button>
            )}

            {effRole === 'CLIENT_PORTAL' && (
              <Field label="Region" hint="A region account is the command center for every store in the region; it replaces the client and store.">
                {(p) => (
                  <Select {...p} value={u.regionId ?? ''} onFocus={() => void ensureRegions()} onChange={(e) => void onAssignRegion(e.target.value)} disabled={readOnly || busy}>
                    <option value="">{u.regionId ? 'No region' : 'No region (a client login)'}</option>
                    {(regions ?? (u.regionId && u.regionName ? [{ id: u.regionId, name: u.regionName }] : [])).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {effRole === 'CLIENT_PORTAL' && u.clientId && (
              <Field label={termOf('label.store')} hint={`A ${storeWord} manager sees one ${storeWord}; leave "Whole client" for a market or district manager.`}>
                {(p) => (
                  <Select {...p} value={u.locationId ?? ''} onFocus={() => void ensureLocations()} onChange={(e) => onAssignLocation(e.target.value)} disabled={readOnly || busy}>
                    <option value="">Whole client</option>
                    {(locations ?? (u.locationId && u.locationName ? [{ id: u.locationId, name: u.locationName }] : [])).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}

            {!BOUNDED_ROLES.has(effRole) && canManage && !isMe && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
                <span>
                  <span className="block text-ink">Sites and regions</span>
                  <span className="block text-xs text-ink-muted">{places > 0 ? `Narrowed to ${scopeText(u, storeWord)}.` : 'The whole organization.'}</span>
                </span>
                <Button variant="outline" size="sm" onClick={() => setDialog('scope')} disabled={busy}>
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" /> {places > 0 ? 'Change' : 'Narrow'}
                </Button>
              </div>
            )}
          </section>

          <section aria-labelledby="user-security" className="space-y-3">
            <h3 id="user-security" className="text-sm font-semibold text-ink">
              Security
            </h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-ink-muted">Two-step sign-in</dt>
                <dd className="mt-0.5 text-ink">{u.mfaEnabled ? 'On' : 'Off'}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">Last active</dt>
                <dd className="mt-0.5 text-ink">{u.lastSeenAt ? fmtRelativeDate(u.lastSeenAt) : 'Never'}</dd>
              </div>
            </dl>
            {u.lockedUntil && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-negative/40 px-3 py-2 text-sm">
                <span className="text-ink">Locked after too many wrong passwords, until {fmtDateTime(u.lockedUntil)}.</span>
                <Button variant="outline" size="sm" onClick={() => void run(() => unlockUser(u.id), 'Account unlocked.', "Couldn't unlock the account.")} disabled={busy || !canManage}>
                  <Unlock className="h-3.5 w-3.5" aria-hidden="true" /> Unlock
                </Button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void onForceReset()} disabled={readOnly || busy} title={isMe ? 'Change your own password in Settings' : 'Send a fresh reset link and sign out every session'}>
                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> Force password reset
              </Button>
              {canManage && !isMe && effRole !== 'ASSOCIATE' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDialog('break-glass')}
                  disabled={busy}
                  title={u.breakGlass ? 'A break-glass owner: password + two-step works while company sign-in is required' : 'Make a break-glass owner for identity-provider outages'}
                >
                  <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" /> {u.breakGlass ? 'Break-glass is on' : 'Make break-glass owner'}
                </Button>
              )}
            </div>
          </section>

          {canManage && !isMe && (
            <section aria-labelledby="user-danger" className="space-y-3 rounded-md border border-negative/40 p-3">
              <h3 id="user-danger" className="text-sm font-semibold text-negative">
                Turn off
              </h3>
              {u.purgeAfter && u.deactivatedAt ? (
                <>
                  <p className="text-sm text-ink-muted">
                    Deactivated {fmtDate(u.deactivatedAt)}
                    {u.deactivationReason ? `: ${u.deactivationReason}` : ''}. Deleted on {fmtDate(u.purgeAfter)} unless it comes back.
                  </p>
                  <Button variant="outline" size="sm" onClick={() => void onReactivate()} disabled={busy}>
                    Reactivate
                  </Button>
                </>
              ) : u.status === 'DISABLED' ? (
                <>
                  <p className="text-sm text-ink-muted">This account can't sign in.</p>
                  <Button variant="outline" size="sm" onClick={() => void onEnable()} disabled={busy || heldInvite}>
                    Turn back on
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-ink-muted">Signs them out at once. Reversible for 30 days, then the account is deleted.</p>
                  <Button variant="destructive" size="sm" onClick={() => setDialog('deactivate')} disabled={busy}>
                    Deactivate account
                  </Button>
                </>
              )}
            </section>
          )}

          <p className="flex items-center gap-1 text-xs text-ink-muted">
            <ShieldCheck className="h-3 w-3" aria-hidden="true" /> Every change here is recorded in the audit log.
          </p>
        </DrawerBody>
      </Drawer>

      {dialog === 'second-role' && <SecondRoleDialog user={u} open onOpenChange={(o) => !o && setDialog(null)} onSaved={() => void onChanged()} />}
      {dialog === 'person-record' && <PersonRecordDialog user={u} open onOpenChange={(o) => !o && setDialog(null)} onSaved={() => void onChanged()} />}
      {dialog === 'elevate' && <ElevateAccessDialog user={u} onClose={() => setDialog(null)} onChanged={async () => { await onChanged(); }} />}
      {dialog === 'scope' && (
        <ScopeDialog
          user={u}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void onChanged();
          }}
        />
      )}
      {dialog === 'break-glass' && (
        <BreakGlassDialog
          user={u}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void onChanged();
          }}
        />
      )}
      {dialog === 'shift' && (
        <SupervisorShiftDialog
          user={{ ...u, role: effRole }}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          onSaved={() => void onChanged()}
          readOnly={!canManage}
        />
      )}
      {dialog === 'deactivate' && (
        <DeactivateDialog
          count={1}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            const res = await deactivateUsers([u.id], reason);
            if (res.skipped.length) toast.error(res.skipped.map((x) => x.reason).join(' '));
            else toast.success('Account deactivated. Reversible for 30 days.');
            setDialog(null);
            await onChanged();
          }}
        />
      )}
      {regionApproval && (
        <RegionApprovalDialog
          regionName={regionApproval.regionName}
          email={u.email}
          onClose={() => setRegionApproval(null)}
          onConfirm={async (approverId) => {
            const { regionId } = regionApproval;
            setRegionApproval(null);
            await onAssignRegion(regionId, approverId);
          }}
        />
      )}
    </>
  );
}

/**
 * Brief 1A-4: Region scope is the widest a portal account gets — every
 * store in the region — so the binding carries a named approver who holds
 * manage:org, recorded on the account and in the audit log.
 */
function RegionApprovalDialog({
  regionName,
  email,
  onClose,
  onConfirm,
}: {
  regionName: string;
  email: string;
  onClose: () => void;
  onConfirm: (approverUserId: string) => Promise<void>;
}) {
  const [approver, setApprover] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Put {email} on {regionName}?
          </DialogTitle>
          <DialogDescription>A region account is the command center for every store in {regionName}; it replaces the client and store scope. Name who approved it.</DialogDescription>
        </DialogHeader>
        <ApproverPicker value={approver} onChange={setApprover} disabled={busy} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!approver || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(approver);
              } finally {
                setBusy(false);
              }
            }}
          >
            Assign region
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
