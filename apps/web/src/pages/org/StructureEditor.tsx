import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { timezoneForState, zoneForPickedPlace } from '@/lib/stateTimezone';
import { AddressAutocomplete, pickedFields } from '@/components/ui/AddressAutocomplete';
import { toast } from 'sonner';
import { ExternalLink, Trash2 } from '@/components/ui/icons';
import { SITE_TYPES, SUPPORTED_TIMEZONES, type SiteType } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { inviteRegionUser, listRegions } from '@/lib/regionsApi';
import { ApproverPicker } from '@/components/ApproverPicker';
import { useTenant, useTerm } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { SITE_TYPE_LABEL, updateSite } from '@/lib/orgApi';
import type { OrgNode } from '@/lib/orgChartApi';
import {
  createRegion,
  createStructureSite,
  getSiteDetails,
  getStructureOptions,
  placeSite,
  regionIdOf,
  renameRegion,
  retireRegion,
  siteIdOf,
  type StructureOptions,
} from '@/lib/structureApi';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Field,
  Input,
  Select,
  SkeletonRows,
} from '@/components/ui';
import { ancestorsOf, type OrgIndex } from './orgChartModel';

/**
 * Editing the business structure from the Org chart's field view: add a
 * region or a site, move a store to a region (also by dragging — see
 * ChartCanvas), and a details drawer for a region, client or store. Every
 * write goes through /org/structure (lib/structure.placeSite on the server),
 * so the rule "a store's cost center sits under its region" holds however
 * the change was made.
 */

const STRUCTURE_KEYS = [['org', 'chart'], ['org', 'structure']] as const;

export function useStructureOptions(enabled = true) {
  return useQuery({ queryKey: ['org', 'structure', 'options'], queryFn: getStructureOptions, enabled, staleTime: 60_000 });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const k of STRUCTURE_KEYS) void qc.invalidateQueries({ queryKey: [...k] });
    void qc.invalidateQueries({ queryKey: ['admin', 'sites'] });
  };
}

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** The region a node sits under on the chart, if any. */
export function regionOfNode(index: OrgIndex, n: OrgNode): string | null {
  if (n.kind === 'region') return regionIdOf(n.id);
  const r = ancestorsOf(index, n.id).find((a) => a.kind === 'region');
  return r ? regionIdOf(r.id) : null;
}

/** "Every region" first, then each by name — with "no region" where it applies. */
function RegionSelect({ id, value, onChange, options, allowNone = true }: { id: string; value: string; onChange: (v: string) => void; options: StructureOptions | undefined; allowNone?: boolean }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <option value="">No region</option>}
      {(options?.regions ?? []).map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </Select>
  );
}

/* ----- Add a region -------------------------------------------------------- */

export function AddRegionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const term = useTerm();
  const refresh = useRefresh();
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName('');
  }, [open]);
  const save = useMutation({
    mutationFn: () => createRegion(name.trim()),
    onSuccess: (r) => {
      toast.success(`${r.region.name} added. Drag ${term('label.stores').toLowerCase()} onto it, or use “Move to region”.`);
      refresh();
      onClose();
    },
    onError: (err) => toast.error(errMsg(err, 'Could not add the region.')),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a region</DialogTitle>
          <DialogDescription>A region groups places for reporting, region accounts and scope.</DialogDescription>
        </DialogHeader>
        <Field label="Name" required>
          {(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Florida Panhandle" />}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={name.trim().length < 2}>
            Add region
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- Add a site ------------------------------------------------------------ */

const browserTz = (() => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return (SUPPORTED_TIMEZONES as readonly string[]).includes(tz) ? tz : SUPPORTED_TIMEZONES[0];
  } catch {
    return SUPPORTED_TIMEZONES[0];
  }
})();

export function AddSiteDialog({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults: { clientId?: string | null; regionId?: string | null } }) {
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  const options = useStructureOptions(open);
  const refresh = useRefresh();
  const directEmployer = options.data?.businessModel === 'DIRECT_EMPLOYER';
  const blank = () => ({
    name: '',
    type: '' as SiteType | '',
    clientId: defaults.clientId ?? '',
    regionId: defaults.regionId ?? '',
    timezone: browserTz as string,
    addressLine1: '',
    city: '',
    state: '',
    zip: '',
    /** The point a picked address came with. */
    point: null as { lat: number; lng: number } | null,
  });
  const [f, setF] = useState(blank);
  useEffect(() => {
    if (open) setF(blank());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaults.clientId, defaults.regionId]);
  const save = useMutation({
    mutationFn: () =>
      createStructureSite({
        name: f.name.trim(),
        type: f.type || undefined,
        clientId: f.clientId || null,
        regionId: f.regionId || null,
        timezone: f.timezone,
        addressLine1: f.addressLine1.trim() || null,
        city: f.city.trim() || null,
        state: f.state.trim() ? f.state.trim().toUpperCase() : null,
        zip: f.zip.trim() || null,
        ...(f.point ? { latitude: f.point.lat, longitude: f.point.lng } : {}),
      }),
    onSuccess: (r) => {
      toast.success(`${r.site.name} added.`);
      refresh();
      onClose();
    },
    onError: (err) => toast.error(errMsg(err, 'Could not add the site.')),
  });
  const placeWord = term('label.store').toLowerCase();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a {placeWord}</DialogTitle>
          <DialogDescription>
            {hasClients
              ? `A ${placeWord} for a ${term('label.client').toLowerCase()}, or a place of your own (an office or warehouse).`
              : `A ${placeWord} of your own.`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            {(p) => <Input {...p} value={f.name} maxLength={160} onChange={(e) => setF({ ...f, name: e.target.value })} />}
          </Field>
          {hasClients && (
            <Field label={term('label.client')}>
              {(p) => (
                <Select {...p} value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}>
                  <option value="">None — a place of our own</option>
                  {(options.data?.clients ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Region">{(p) => <RegionSelect id={p.id} value={f.regionId} onChange={(v) => setF({ ...f, regionId: v })} options={options.data} />}</Field>
          <Field label="Type">
            {(p) => (
              <Select {...p} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as SiteType | '' })}>
                <option value="">{directEmployer ? 'Property' : 'Store'} (default)</option>
                {SITE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {SITE_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Time zone">
            {(p) => (
              <Select {...p} value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
                {SUPPORTED_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Street address" className="sm:col-span-2" hint={f.point ? 'Placed on the map from this address; the time zone follows it.' : undefined}>
            {(p) => (
              <AddressAutocomplete
                {...p}
                value={f.addressLine1}
                maxLength={200}
                onChange={(v) => setF((cur) => ({ ...cur, addressLine1: v }))}
                onPick={(s) => {
                  // No line 2 here: a unit rides on the street line.
                  const picked = pickedFields(s, { line2: false });
                  setF((cur) => ({
                    ...cur,
                    addressLine1: picked.line1,
                    city: picked.city,
                    state: picked.state,
                    zip: picked.zip,
                    timezone: zoneForPickedPlace(s, cur),
                    point: { lat: s.lat, lng: s.lng },
                  }));
                }}
              />
            )}
          </Field>
          <Field label="City">{(p) => <Input {...p} value={f.city} maxLength={120} onChange={(e) => setF({ ...f, city: e.target.value })} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="State">
              {(p) => (
                <Input
                  {...p}
                  value={f.state}
                  maxLength={2}
                  // The state sets the clock: a Florida store is on Eastern
                  // time whatever the HR desk's browser says. Still editable above.
                  onChange={(e) => {
                    const state = e.target.value.toUpperCase();
                    setF({ ...f, state, timezone: timezoneForState(state) ?? f.timezone });
                  }}
                  placeholder="FL"
                />
              )}
            </Field>
            <Field label="ZIP">{(p) => <Input {...p} value={f.zip} maxLength={20} onChange={(e) => setF({ ...f, zip: e.target.value })} />}</Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.name.trim()}>
            Add {placeWord}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- Move a store to a region --------------------------------------------- */

/** One call both the drag and the dialog use, with the same words afterwards. */
export function useMoveStore() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ siteId, regionId }: { siteId: string; regionId: string | null; name: string; regionName: string | null }) => placeSite(siteId, { regionId }),
    onSuccess: (r, v) => {
      toast.success(
        `${v.name} is now ${v.regionName ? `in ${v.regionName}` : 'in no region'}.${r.costCenterCleared ? ' Its cost center sat outside that region, so it was cleared — pick one under the region.' : ''}`,
      );
      refresh();
    },
    onError: (err) => toast.error(errMsg(err, 'Could not move it.')),
  });
}

export function MoveToRegionDialog({ store, currentRegionId, onClose }: { store: OrgNode | null; currentRegionId: string | null; onClose: () => void }) {
  const options = useStructureOptions(!!store);
  const move = useMoveStore();
  const [regionId, setRegionId] = useState('');
  useEffect(() => {
    if (store) setRegionId(currentRegionId ?? '');
  }, [store, currentRegionId]);
  const siteId = store ? siteIdOf(store.id) : null;
  return (
    <Dialog open={!!store} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {store?.name} to a region</DialogTitle>
          <DialogDescription>Region accounts, scope and reports follow the region. Its crew and shifts don’t move.</DialogDescription>
        </DialogHeader>
        <Field label="Region">{(p) => <RegionSelect id={p.id} value={regionId} onChange={setRegionId} options={options.data} />}</Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={move.isPending}
            disabled={!siteId || regionId === (currentRegionId ?? '')}
            onClick={() =>
              move.mutate(
                { siteId: siteId!, regionId: regionId || null, name: store!.name, regionName: options.data?.regions.find((r) => r.id === regionId)?.name ?? null },
                { onSuccess: onClose },
              )
            }
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- Details ------------------------------------------------------------- */

export function StructureDrawer({ node, index, onClose, onAddSite }: { node: OrgNode | null; index: OrgIndex; onClose: () => void; onAddSite: (defaults: { clientId?: string | null; regionId?: string | null }) => void }) {
  return (
    <Drawer open={!!node} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      {node?.kind === 'region' && <RegionDetails node={node} index={index} onClose={onClose} onAddSite={onAddSite} />}
      {node?.kind === 'client' && <ClientDetails node={node} index={index} onClose={onClose} onAddSite={onAddSite} />}
      {node?.kind === 'store' && <StoreDetails node={node} onClose={onClose} />}
    </Drawer>
  );
}

function RegionDetails({ node, index, onClose, onAddSite }: { node: OrgNode; index: OrgIndex; onClose: () => void; onAddSite: (d: { regionId?: string | null }) => void }) {
  const term = useTerm();
  const confirm = useConfirm();
  const refresh = useRefresh();
  const regionId = regionIdOf(node.id)!;
  const [name, setName] = useState(node.name);
  const stores = [...index.byId.values()].filter((n) => n.kind === 'store' && regionOfNode(index, n) === regionId).length;
  const rename = useMutation({
    mutationFn: () => renameRegion(regionId, name.trim()),
    onSuccess: () => {
      toast.success('Region renamed.');
      refresh();
    },
    onError: (err) => toast.error(errMsg(err, 'Could not rename the region.')),
  });
  const retire = useMutation({
    mutationFn: () => retireRegion(regionId),
    onSuccess: () => {
      toast.success(`${node.name} retired. Its ${term('label.stores').toLowerCase()} are now in no region.`);
      refresh();
      onClose();
    },
    onError: (err) => toast.error(errMsg(err, 'Could not retire the region.')),
  });
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{node.name}</DrawerTitle>
        <DrawerDescription>
          Region · {stores} {stores === 1 ? term('label.store').toLowerCase() : term('label.stores').toLowerCase()} · {index.teamSize.get(node.id) ?? 0} people
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <Field label="Name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}</Field>
        <Button size="sm" variant="outline" onClick={() => onAddSite({ regionId })}>
          Add a {term('label.store').toLowerCase()} here
        </Button>
        <CommandCenter regionId={regionId} regionName={node.name} stores={stores} />
      </DrawerBody>
      <DrawerFooter className="justify-between">
        <Button
          variant="ghost"
          className="text-alert"
          loading={retire.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: `Retire ${node.name}?`,
              description: `Its ${term('label.stores').toLowerCase()} stay, in no region; region accounts lose it.`,
              confirmLabel: 'Retire region',
              destructive: true,
            });
            if (ok) retire.mutate();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Retire region
        </Button>
        <Button onClick={() => rename.mutate()} loading={rename.isPending} disabled={name.trim().length < 2 || name.trim() === node.name}>
          Save
        </Button>
      </DrawerFooter>
    </>
  );
}

/**
 * The region's command center: the market managers who run it (CLIENT_PORTAL
 * accounts bound to the region) and an invite for one more. Only where the
 * tenant has the client portal — a direct employer has no market accounts.
 */
function CommandCenter({ regionId, regionName, stores }: { regionId: string; regionName: string; stores: number }) {
  const term = useTerm();
  const hasPortal = useTenant().moduleOn('clientPortal');
  const qc = useQueryClient();
  const regions = useQuery({ queryKey: ['regions'], queryFn: listRegions, enabled: hasPortal });
  const accounts = regions.data?.regions.find((r) => r.id === regionId)?.accounts ?? [];
  const [inviting, setInviting] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [approver, setApprover] = useState('');
  const invite = useMutation({
    mutationFn: () => inviteRegionUser(regionId, { email: email.trim(), name: name.trim() || undefined, approvedByUserId: approver }),
    onSuccess: (r) => {
      toast.success(r.emailFailed ? 'Login created, but the note failed to send — resend from Users & access.' : `Command-center note sent to ${r.email}.`);
      setInviting(false);
      setName('');
      setEmail('');
      setApprover('');
      void qc.invalidateQueries({ queryKey: ['regions'] });
    },
    onError: (err) => toast.error(errMsg(err, 'Could not send the invite.')),
  });
  if (!hasPortal) return null;
  const valid = /^\S+@\S+\.\S+$/.test(email.trim()) && approver.length > 0;
  return (
    <section className="space-y-2 border-t border-line pt-4" aria-labelledby="cc-title">
      <div className="flex items-center justify-between gap-2">
        <h3 id="cc-title" className="text-sm font-medium text-ink">
          Command center
        </h3>
        <Button asChild size="sm" variant="ghost">
          <Link to={`/region?regionId=${regionId}`}>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            Preview
          </Link>
        </Button>
      </div>
      <p className="text-xs text-ink-muted">
        Market managers see every {term('label.store').toLowerCase()} in {regionName}
        {stores === 0 ? ` — move ${term('label.stores').toLowerCase()} here first, or their center opens empty.` : '.'}
      </p>
      {accounts.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-ink">{a.email}</span>
              <Badge size="sm" variant={a.status === 'ACTIVE' ? 'success' : 'pending'}>
                {a.status === 'ACTIVE' ? 'Active' : a.status === 'INVITED' ? 'Invited' : 'Disabled'}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-muted">Nobody runs this command center yet — invite the market manager.</p>
      )}
      {inviting ? (
        <div className="space-y-3 rounded-md border border-line p-3">
          <Field label="Name" hint="How the note addresses them.">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Lee" />}
          </Field>
          <Field label="Email">{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="manager@market.example" />}</Field>
          <ApproverPicker value={approver} onChange={setApprover} disabled={invite.isPending} hint="Region scope is every store in the region. Name who approved it; it goes in the audit log." />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setInviting(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => invite.mutate()} loading={invite.isPending} disabled={!valid}>
              Send invite
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setInviting(true)}>
          Invite a market manager
        </Button>
      )}
    </section>
  );
}

function ClientDetails({ node, index, onClose, onAddSite }: { node: OrgNode; index: OrgIndex; onClose: () => void; onAddSite: (d: { clientId?: string | null; regionId?: string | null }) => void }) {
  const term = useTerm();
  const stores = (index.children.get(node.id) ?? []).filter((c) => c.kind === 'store');
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{node.name}</DrawerTitle>
        <DrawerDescription>
          {term('label.client')} · {stores.length} {stores.length === 1 ? term('label.store').toLowerCase() : term('label.stores').toLowerCase()} here
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <p className="text-sm text-ink-muted">
          A {term('label.client').toLowerCase()}’s name, contacts and contract live on its own page. Here you place its {term('label.stores').toLowerCase()}.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to={`/clients/${node.clientId}`} onClick={onClose}>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Open {node.name}
            </Link>
          </Button>
          <Button size="sm" variant="outline" onClick={() => onAddSite({ clientId: node.clientId, regionId: regionOfNode(index, node) })}>
            Add a {term('label.store').toLowerCase()}
          </Button>
        </div>
      </DrawerBody>
    </>
  );
}

function StoreDetails({ node, onClose }: { node: OrgNode; onClose: () => void }) {
  const term = useTerm();
  const refresh = useRefresh();
  const siteId = siteIdOf(node.id)!;
  const options = useStructureOptions();
  const details = useQuery({ queryKey: ['org', 'structure', 'site', siteId], queryFn: () => getSiteDetails(siteId) });
  const site = details.data?.site;
  const [f, setF] = useState({ name: '', timezone: '', type: 'STORE' as SiteType, isActive: true, addressLine1: '', city: '', state: '', zip: '', regionId: '', orgUnitId: '' });
  // A picked address brings its point (the clock-in geofence and the vans' map read it).
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (!site) return;
    setPoint(null);
    setF({
      name: site.name,
      timezone: site.timezone,
      type: site.type,
      isActive: site.isActive,
      addressLine1: site.addressLine1 ?? '',
      city: site.city ?? '',
      state: site.state ?? '',
      zip: site.zip ?? '',
      regionId: site.regionId ?? '',
      orgUnitId: site.costCenter?.id ?? '',
    });
  }, [site]);
  const clientOwned = !!site?.clientId;
  // A store in a region may only be costed to a cost center under that region.
  const costCenters = useMemo(
    () => (options.data?.costCenters ?? []).filter((c) => !f.regionId || c.regionId === f.regionId),
    [options.data, f.regionId],
  );
  const chosen = options.data?.costCenters.find((c) => c.id === f.orgUnitId);

  const save = useMutation({
    mutationFn: async () => {
      let cleared = false;
      if (!clientOwned) {
        await updateSite(siteId, {
          name: f.name.trim(),
          timezone: f.timezone,
          type: f.type,
          isActive: f.isActive,
          addressLine1: f.addressLine1.trim() || null,
          city: f.city.trim() || null,
          state: f.state.trim() ? f.state.trim().toUpperCase() : null,
          zip: f.zip.trim() || null,
          ...(point ? { latitude: point.lat, longitude: point.lng } : {}),
        });
      }
      const regionChanged = f.regionId !== (site?.regionId ?? '');
      const ccChanged = f.orgUnitId !== (site?.costCenter?.id ?? '');
      if (regionChanged) {
        const r = await placeSite(siteId, { regionId: f.regionId || null });
        cleared = r.costCenterCleared;
      }
      if (ccChanged && (f.orgUnitId || !regionChanged)) await placeSite(siteId, { orgUnitId: f.orgUnitId || null });
      return cleared;
    },
    onSuccess: (cleared) => {
      toast.success(cleared ? 'Saved. Its cost center sat outside the new region, so it was cleared.' : 'Saved.');
      refresh();
      void details.refetch();
      onClose();
    },
    onError: (err) => toast.error(errMsg(err, 'Could not save.')),
  });

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{node.name}</DrawerTitle>
        <DrawerDescription>
          {site?.clientName ? `${site.clientName} · ` : ''}
          {term('label.store')}
          {site && !site.isActive ? ' · inactive' : ''}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-5">
        {!site ? (
          <SkeletonRows count={5} />
        ) : (
          <>
            <section className="space-y-3" aria-labelledby="place-where">
              <h3 id="place-where" className="text-sm font-medium text-ink">
                Where it sits
              </h3>
              <Field label="Region">{(p) => <RegionSelect id={p.id} value={f.regionId} onChange={(v) => setF({ ...f, regionId: v, orgUnitId: '' })} options={options.data} />}</Field>
              <Field label="Cost center" hint={f.regionId ? 'Only cost centers under this region can be chosen.' : undefined}>
                {(p) => (
                  <Select {...p} value={f.orgUnitId} onChange={(e) => setF({ ...f, orgUnitId: e.target.value })}>
                    <option value="">None</option>
                    {costCenters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.glCode ? ` · GL ${c.glCode}` : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {chosen?.glCode && <p className="text-xs text-ink-muted">Labor here posts to ledger code {chosen.glCode}.</p>}
            </section>

            <section className="space-y-3" aria-labelledby="place-what">
              <h3 id="place-what" className="text-sm font-medium text-ink">
                The {term('label.store').toLowerCase()}
              </h3>
              {clientOwned ? (
                <div className="space-y-2 rounded-md border border-line p-3 text-sm">
                  <div className="text-ink">{site.name}</div>
                  <div className="text-ink-muted">{[site.addressLine1, site.city, site.state, site.zip].filter(Boolean).join(', ') || 'No address on file'}</div>
                  <div className="text-ink-muted">{site.timezone.replace(/_/g, ' ')}</div>
                  <p className="text-xs text-ink-muted">
                    This {term('label.store').toLowerCase()} belongs to {site.clientName}: its name, address and hours change on the {term('label.client').toLowerCase()}’s page.
                  </p>
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/clients/${site.clientId}`} onClick={onClose}>
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      Edit in {site.clientName}
                    </Link>
                  </Button>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Name" required className="sm:col-span-2">
                    {(p) => <Input {...p} value={f.name} maxLength={160} onChange={(e) => setF({ ...f, name: e.target.value })} />}
                  </Field>
                  <Field label="Type">
                    {(p) => (
                      <Select {...p} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as SiteType })}>
                        {SITE_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {SITE_TYPE_LABEL[t]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Time zone">
                    {(p) => (
                      <Select {...p} value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
                        {SUPPORTED_TIMEZONES.map((tz) => (
                          <option key={tz} value={tz}>
                            {tz.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Street address" className="sm:col-span-2" hint={point ? 'Placed on the map from this address; the time zone follows it.' : undefined}>
                    {(p) => (
                      <AddressAutocomplete
                        {...p}
                        value={f.addressLine1}
                        maxLength={200}
                        onChange={(v) => setF((cur) => ({ ...cur, addressLine1: v }))}
                        onPick={(s) => {
                          // No line 2 here: a unit rides on the street line.
                          const picked = pickedFields(s, { line2: false });
                          setF((cur) => ({ ...cur, addressLine1: picked.line1, city: picked.city, state: picked.state, zip: picked.zip, timezone: zoneForPickedPlace(s, cur) }));
                          setPoint({ lat: s.lat, lng: s.lng });
                        }}
                      />
                    )}
                  </Field>
                  <Field label="City">{(p) => <Input {...p} value={f.city} maxLength={120} onChange={(e) => setF({ ...f, city: e.target.value })} />}</Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="State">{(p) => <Input {...p} value={f.state} maxLength={2} onChange={(e) => setF({ ...f, state: e.target.value.toUpperCase() })} />}</Field>
                    <Field label="ZIP">{(p) => <Input {...p} value={f.zip} maxLength={20} onChange={(e) => setF({ ...f, zip: e.target.value })} />}</Field>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2 coarse:min-h-11">
                    <input type="checkbox" className="h-4 w-4 coarse:h-6 coarse:w-6" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
                    Active
                    {!f.isActive && <Badge size="sm" variant="outline">Hidden from scheduling</Badge>}
                  </label>
                </div>
              )}
            </section>
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!site || (!clientOwned && !f.name.trim())}>
          Save
        </Button>
      </DrawerFooter>
    </>
  );
}

/** The store's current region, for the move dialog's starting value. */
export function storeRegion(index: OrgIndex, store: OrgNode | null): string | null {
  return store ? regionOfNode(index, store) : null;
}
