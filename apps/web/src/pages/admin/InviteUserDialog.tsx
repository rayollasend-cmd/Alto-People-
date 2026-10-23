import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Role } from '@/lib/roles';
import { useRoleLabel, useTenant, useTerm } from '@/lib/auth';
import { roleOfferedFor } from '@/lib/modules';
import { errorText } from '@/lib/errorText';
import { inviteUser } from '@/lib/usersAdminApi';
import { invitePortalUser, listClientLocations } from '@/lib/clientsApi';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { CLIENT_REQUIRED_ROLES, ROLE_OPTIONS } from './userAccess';

const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const WHOLE_CLIENT = '__whole__';

/**
 * Users & access → Invite user (F500 G4). One form, three doors, picked by
 * the role:
 *   - a staff role → an account and an invite link (POST /admin/users/invite);
 *     where Settings › Approval rules asks for a second person, it waits
 *     for one and the email goes out on approval;
 *   - a client login → the client's own portal invite (a store, or the
 *     whole client for a market manager);
 *   - an associate → Onboarding, which sends the paperwork with the invite.
 */
export function InviteUserDialog({
  clients,
  onClose,
  onInvited,
}: {
  clients: Array<{ id: string; name: string }>;
  onClose: () => void;
  onInvited: (userId: string | null) => void;
}) {
  const roleLabel = useRoleLabel();
  const tenant = useTenant();
  const term = useTerm();
  const storeWord = term('label.store');
  const [role, setRole] = useState<Role | ''>('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [store, setStore] = useState('');
  const [busy, setBusy] = useState(false);
  const portal = role === 'CLIENT_PORTAL';
  const associate = role === 'ASSOCIATE';
  const needsClient = portal || (role !== '' && CLIENT_REQUIRED_ROLES.has(role));
  const stores = useQuery({
    queryKey: ['client-locations', clientId],
    queryFn: () => listClientLocations(clientId),
    enabled: portal && !!clientId,
  });
  const emailOk = EMAIL.test(email.trim());
  const ready = !!role && !associate && emailOk && (!needsClient || !!clientId) && (!portal || !!store);
  const dirty = !!(email || name || role);

  const submit = async () => {
    if (!ready || !role) return;
    setBusy(true);
    try {
      if (portal) {
        const r = await invitePortalUser(clientId, {
          email: email.trim(),
          name: name.trim() || undefined,
          locationId: store === WHOLE_CLIENT ? null : store,
          ...(store === WHOLE_CLIENT ? { wholeClient: true } : {}),
        });
        if (r.emailFailed) toast.error(`Account made, but the email failed: ${r.emailFailed}`);
        else toast.success(`Invite sent to ${email.trim()}.`);
        onInvited((r as { id?: string }).id ?? null);
        return;
      }
      const r = await inviteUser({ email: email.trim(), name: name.trim() || undefined, role, clientId: clientId || null });
      if (r.pending) toast.success('Sent for approval. The invite email goes out when a second administrator approves it.');
      else if (r.emailFailed) toast.error(`Account made, but the email failed: ${r.emailFailed}`);
      else toast.success(`Invite sent to ${r.user.email}.`);
      onInvited(r.user.id);
    } catch (err) {
      toast.error(errorText(err, "Couldn't send the invite."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} confirmDiscard={() => dirty}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite user</DialogTitle>
          <DialogDescription>They get an email with a link to set their password. Pick the role first: it decides what else is needed.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Role" required>
            {(p) => (
              <Select
                {...p}
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as Role | '');
                  setStore('');
                }}
              >
                <option value="">Choose a role</option>
                {ROLE_OPTIONS.filter((r) => roleOfferedFor(r, tenant.modules)).map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {associate ? (
            <div className="rounded-md border border-line p-3 text-sm text-ink-muted">
              Associates are invited from Onboarding, which sends their paperwork with the invite.{' '}
              <Link to="/onboarding?new=invite" className="text-accent underline underline-offset-2" onClick={onClose}>
                Invite from Onboarding
              </Link>
            </div>
          ) : (
            <>
              <Field label="Email" required error={email && !emailOk ? 'Enter an address like pat@example.com.' : undefined}>
                {(p) => <Input {...p} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} placeholder="pat@example.com" />}
              </Field>
              <Field label="Name" hint="How the email greets them. Optional.">
                {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Pat Rivera" />}
              </Field>
              {role !== '' && (
                <Field
                  label="Client"
                  required={needsClient}
                  hint={portal ? 'The client this login belongs to.' : needsClient ? 'This role works at one client.' : 'Optional: a home client for their defaults.'}
                >
                  {(p) => (
                    <Select
                      {...p}
                      value={clientId}
                      onChange={(e) => {
                        setClientId(e.target.value);
                        setStore('');
                      }}
                    >
                      <option value="">{needsClient ? 'Select a client' : 'All clients'}</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              {portal && clientId && (
                <Field label={storeWord} required hint={`A ${storeWord.toLowerCase()} manager sees one ${storeWord.toLowerCase()}; a market manager sees the whole client.`}>
                  {(p) => (
                    <Select {...p} value={store} onChange={(e) => setStore(e.target.value)} disabled={stores.isPending}>
                      <option value="">{stores.isPending ? `Finding ${storeWord.toLowerCase()}s` : `Select a ${storeWord.toLowerCase()}`}</option>
                      {(stores.data?.locations ?? []).map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                      <option value={WHOLE_CLIENT}>The whole client (market manager)</option>
                    </Select>
                  )}
                </Field>
              )}
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {!associate && (
              <Button type="submit" loading={busy} disabled={!ready || busy}>
                Send invite
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
