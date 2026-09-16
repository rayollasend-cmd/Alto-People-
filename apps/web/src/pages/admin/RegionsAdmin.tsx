import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Map, Plus, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import {
  createRegion,
  deleteRegion,
  inviteRegionUser,
  listRegions,
  updateRegion,
  type RegionRow,
  type RegionStore,
} from '@/lib/regionsApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Regions — the command-center tier above the store. A region is a name
 * and the stores in it (stores may sit under different clients). A
 * portal account bound to a region (Users & access → Region) sees every
 * store here at a glance and can open each store's own site.
 */
export function RegionsAdmin() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const canManage = can('manage:org');
  const canPreview = can('view:executive') || can('manage:org');
  const [regions, setRegions] = useState<RegionRow[] | null>(null);
  const [unassigned, setUnassigned] = useState<RegionStore[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RegionRow | 'new' | null>(null);
  const [inviting, setInviting] = useState<RegionRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await listRegions();
      setRegions(r.regions);
      setUnassigned(r.unassigned);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load regions.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (r: RegionRow) => {
    if (
      !(await confirm({
        title: `Retire ${r.name}?`,
        description: `${r.stores.length} stores become unassigned and ${r.accounts.length} region accounts lose their command center until they are reassigned.`,
      }))
    ) {
      return;
    }
    try {
      await deleteRegion(r.id);
      toast.success('Region retired.');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not retire the region.');
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Regions"
        subtitle="The command-center tier: a region is the stores a Manager, Business Operations Support runs. Invite the market manager from their region; they get the command-center note, not the store one."
        primaryAction={
          canManage ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              New region
            </Button>
          ) : undefined
        }
      />
      {error ? (
        <ErrorBanner>{error}</ErrorBanner>
      ) : !regions ? (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : regions.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-silver/70">
            No regions yet. Create one and assign the stores that roll up to it.
          </CardContent>
        </Card>
      ) : (
        regions.map((r) => (
          <Card key={r.id}>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Map className="h-4 w-4 text-gold" aria-hidden="true" />
                  {r.name}
                </CardTitle>
                <CardDescription>
                  {r.stores.length} {r.stores.length === 1 ? 'store' : 'stores'} · {r.accounts.length}{' '}
                  {r.accounts.length === 1 ? 'account' : 'accounts'}
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                {canPreview && (
                  <Button size="sm" variant="outline" asChild>
                    <Link to={`/region?regionId=${r.id}`}>
                      <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      Open command center
                    </Link>
                  </Button>
                )}
                {canManage && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setInviting(r)}>
                      <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      Invite market manager
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>
                      Edit stores
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(r)} aria-label={`Retire ${r.name}`}>
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {r.stores.length === 0 ? (
                <p className="text-sm text-silver/60">No stores assigned yet.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {r.stores.map((s) => (
                    <li key={s.id}>
                      <Badge variant="outline">
                        {s.name}
                        {s.clientName !== s.name && <span className="ml-1 text-silver/50">· {s.clientName}</span>}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
              {r.accounts.length > 0 && (
                <p className="mt-3 text-xs text-silver/60">
                  Accounts: {r.accounts.map((a) => `${a.email}${a.status === 'ACTIVE' ? '' : ` (${a.status.toLowerCase()})`}`).join(', ')}
                </p>
              )}
            </CardContent>
          </Card>
        ))
      )}

      {inviting && (
        <InviteDialog
          region={inviting}
          onClose={() => setInviting(null)}
          onSent={() => {
            setInviting(null);
            void load();
          }}
        />
      )}

      {editing && (
        <RegionDialog
          region={editing === 'new' ? null : editing}
          unassigned={unassigned}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * The market manager's onboarding: a name and an email. They are not an
 * associate — no paperwork, no start date — so nothing else is asked.
 * The note they get is the command-center one, distinct from the store
 * manager's.
 */
function InviteDialog({ region, onClose, onSent }: { region: RegionRow; onClose: () => void; onSent: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\S+@\S+\.\S+$/.test(email.trim());
  const sendInvite = async () => {
    setBusy(true);
    try {
      const r = await inviteRegionUser(region.id, { email: email.trim(), name: name.trim() || undefined });
      toast.success(
        r.emailFailed ? 'Login created, but the note failed to send — resend from Users & access.' : `Command-center note sent to ${r.email}.`,
      );
      onSent();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the invite.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} confirmDiscard={() => name.trim().length > 0 || email.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite the market manager for {region.name}</DialogTitle>
          <DialogDescription>
            They get a note by email, addressed by name, with one link that opens the command center for every store in {region.name}.
            {region.stores.length === 0 ? ' Assign stores first, or the center opens empty.' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Name" hint="How the note addresses them. Nothing else is asked of them.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Lee" autoFocus />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="manager@market.example" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void sendInvite()} loading={busy} disabled={!valid}>
            Send invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RegionDialog({
  region,
  unassigned,
  onClose,
  onSaved,
}: {
  region: RegionRow | null;
  unassigned: RegionStore[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(region?.name ?? '');
  const [picked, setPicked] = useState<Set<string>>(new Set(region?.stores.map((s) => s.id) ?? []));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => {
    const mine = region?.stores ?? [];
    const all = [...mine, ...unassigned.filter((u) => !mine.some((m) => m.id === u.id))];
    const needle = q.trim().toLowerCase();
    return all
      .filter((s) => !needle || `${s.name} ${s.clientName}`.toLowerCase().includes(needle))
      .sort((a, b) => a.clientName.localeCompare(b.clientName) || a.name.localeCompare(b.name));
  }, [region, unassigned, q]);
  const dirty = () => name !== (region?.name ?? '') || picked.size !== (region?.stores.length ?? 0);

  const save = async () => {
    setBusy(true);
    try {
      const locationIds = [...picked];
      if (region) await updateRegion(region.id, { name: name.trim(), locationIds });
      else await createRegion({ name: name.trim(), locationIds });
      toast.success(region ? 'Region updated.' : 'Region created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the region.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !busy && !o && onClose()} confirmDiscard={dirty}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{region ? `Edit ${region.name}` : 'New region'}</DialogTitle>
          <DialogDescription>Name the region and tick the stores that roll up to it. A store belongs to one region.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Region name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Florida Panhandle" autoFocus />
          </Field>
          <Field label="Stores">
            <div>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a store…" />
            <ul className="mt-2 max-h-64 divide-y divide-navy-secondary/60 overflow-y-auto rounded-md border border-navy-secondary">
              {options.length === 0 ? (
                <li className="p-3 text-xs text-silver/60">No unassigned stores match.</li>
              ) : (
                options.map((s) => (
                  <li key={s.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-navy-secondary/30">
                      <input
                        type="checkbox"
                        checked={picked.has(s.id)}
                        onChange={(e) =>
                          setPicked((p) => {
                            const n = new Set(p);
                            if (e.target.checked) n.add(s.id);
                            else n.delete(s.id);
                            return n;
                          })
                        }
                        className="h-4 w-4 accent-[rgb(var(--color-gold))]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-white">{s.name}</span>
                        {s.clientName !== s.name && <span className="block truncate text-2xs text-silver/60">{s.clientName}</span>}
                      </span>
                    </label>
                  </li>
                ))
              )}
            </ul>
            <p className="mt-1 text-2xs text-silver/50">{picked.size} selected</p>
            </div>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={name.trim().length < 2}>
            {region ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
