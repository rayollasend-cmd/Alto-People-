import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from '@/components/ui/icons';
import { toast } from 'sonner';
import { SITE_TYPES, SUPPORTED_TIMEZONES, type SiteType } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { fmtTimeZone } from '@/lib/format';
import { Link } from 'react-router-dom';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { ORG_UNIT_TYPE_LABEL, SITE_TYPE_LABEL, createSite, listSites, updateSite, type SiteRow, type SiteUpdateInput } from '@/lib/orgApi';
import { Badge } from '@/components/ui/Badge';
import { FilterChip } from '@/components/ui/FilterBar';
import { urlBoolean, useUrlParam, useUrlState } from '@/lib/useUrlState';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { AddressAutocomplete, pickedFields } from '@/components/ui/AddressAutocomplete';
import { zoneForPickedPlace } from '@/lib/stateTimezone';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';

/**
 * Sites (Brief 2-1b steps 6–7): every place work happens, whatever the
 * tenant calls it — the list layout of the same structure the Org chart's
 * field view draws (region → client → place). A direct employer adds a
 * property, an office or a warehouse here; a client's stores arrive through
 * the client record and are read-only here (the server refuses identity
 * edits to them). Which region and cost center a place sits in is set in
 * the Org chart, through the one placement rule.
 */
export function SitesAdmin() {
  const { can } = useAuth();
  const { moduleOn } = useTenant();
  const term = useTerm();
  const canManage = can('manage:org');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SiteRow | null>(null);
  // The region and whether closed sites show live in the URL (?region=, ?inactive=1).
  const [region, setRegion] = useUrlParam<string>('region', '');
  const [showInactive, setShowInactive] = useUrlState<boolean>('inactive', false, urlBoolean);
  const query = useQuery({ queryKey: ['org', 'sites'], queryFn: listSites });
  const all = useMemo(() => (query.data?.sites ?? []).filter((s): s is SiteRow => !!s && typeof s.id === 'string'), [query.data]);
  // Grouped the way the business runs: region, then client, then name.
  const regions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of all) if (r.regionId && r.regionName) m.set(r.regionId, r.regionName);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);
  // Active by default: ten closed "The Grand Hotel" rows led the list (F500 G4).
  const inactiveCount = useMemo(() => all.filter((r) => !r.isActive).length, [all]);
  const rows = useMemo(
    () =>
      all
        .filter((r) => showInactive || r.isActive)
        .filter((r) => !region || (region === 'none' ? !r.regionId : r.regionId === region))
        .sort(
          (a, b) =>
            (a.regionName ?? '\uffff').localeCompare(b.regionName ?? '\uffff') ||
            (a.clientName ?? '').localeCompare(b.clientName ?? '') ||
            a.name.localeCompare(b.name),
        ),
    [all, region, showInactive],
  );
  const sitesNoun = term('sites');
  const siteNoun = term('site');
  const clientNoun = term('label.client');

  const columns: GridColumn<SiteRow>[] = [
    {
      key: 'name',
      header: 'Name',
      accessor: (r) => r.name,
      sortable: true,
      primary: true,
      cell: (r) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-ink">{r.name}</span>
          {r.clientId && moduleOn('clientPortal') && (
            <Badge variant="outline" size="sm" withDot={false} title={`Comes from the ${clientNoun.toLowerCase()} record; edit it there`}>
              {clientNoun}-owned
            </Badge>
          )}
          {!r.isActive && (
            <Badge variant="default" size="sm" withDot={false}>
              Inactive
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'type', header: 'Type', accessor: (r) => SITE_TYPE_LABEL[r.type] ?? r.type, sortable: true, cardMeta: true, className: 'text-xs' },
    { key: 'timezone', header: 'Time zone', accessor: (r) => r.timezone, cell: (r) => fmtTimeZone(r.timezone), className: 'text-xs text-silver' },
    { key: 'state', header: 'State', accessor: (r) => r.state ?? '—', sortable: true, className: 'text-xs' },
    { key: 'region', header: 'Region', accessor: (r) => r.regionName ?? '—', sortable: true, cardMeta: true, className: 'text-xs' },
    ...(moduleOn('clientPortal') ? [{ key: 'client', header: clientNoun, accessor: (r: SiteRow) => r.clientName ?? '—', sortable: true, cardMeta: true, className: 'text-xs' } satisfies GridColumn<SiteRow>] : []),
    {
      key: 'unit',
      header: 'Cost center',
      // A pin to the region's own unit is "no cost center", not a cost center named after the region.
      accessor: (r) => (r.orgUnitType && r.orgUnitType !== 'REGION' ? (r.orgUnitName ?? '') : ''),
      sortable: true,
      cell: (r) =>
        r.orgUnitName && r.orgUnitType !== 'REGION' ? (
          <span className="text-xs">
            {r.orgUnitName}
            {r.orgUnitType ? <span className="text-ink-muted"> · {ORG_UNIT_TYPE_LABEL[r.orgUnitType]}</span> : null}
          </span>
        ) : (
          <span className="text-xs text-ink-muted">—</span>
        ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={sitesNoun}
        subtitle={`Every place work happens: its time zone and its state for tax and overtime. Regions and cost centers are set in the Org chart.`}
        actions={[{ label: `Add ${siteNoun.toLowerCase()}`, icon: Plus, primary: true, onSelect: () => setAdding(true), hidden: !canManage }]}
        related={[{ label: 'Arrange regions in the Org chart', to: '/org/chart?view=field' }]}
      />
      {query.isError ? <QueryError what={sitesNoun.toLowerCase()} query={query} /> : null}
      <DataGrid<SiteRow>
        id="sites"
        caption={sitesNoun}
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={query.isPending}
        urlKey="sites"
        filters={
          <>
            <Select aria-label="Region" size="sm" className="w-full sm:w-48" value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">Every region</option>
              {regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
              <option value="none">No region</option>
            </Select>
            {inactiveCount > 0 && (
              <FilterChip active={showInactive} onClick={() => setShowInactive(!showInactive)} count={inactiveCount}>
                Include inactive
              </FilterChip>
            )}
          </>
        }
        filterKeys={['region', 'inactive']}
        exportCsv={{ filename: 'sites' }}
        search={{ placeholder: `Search ${sitesNoun.toLowerCase()}` }}
        empty={
          // Only closed places on file: say so, never "No stores yet" over ten inactive ones.
          all.length > 0 && !showInactive && inactiveCount === all.length
            ? {
                icon: Building2,
                title: `No active ${sitesNoun.toLowerCase()}`,
                description: `${inactiveCount} inactive ${inactiveCount === 1 ? siteNoun.toLowerCase() : sitesNoun.toLowerCase()} on file.`,
                action: (
                  <Button size="sm" variant="outline" onClick={() => setShowInactive(true)}>
                    Show inactive
                  </Button>
                ),
              }
            : { icon: Building2, title: `No ${sitesNoun.toLowerCase()} yet`, description: `Add the first ${siteNoun.toLowerCase()} to schedule shifts and pin people to it.` }
        }
        onRowClick={(r) => setEditing(r)}
        rowActionLabel={(r) => `Edit ${r.name}`}
      />
      {adding && <SiteDialog onClose={() => setAdding(false)} />}
      {editing && (editing.clientId || !canManage ? <SiteReadOnly site={editing} onClose={() => setEditing(null)} /> : <SiteDialog site={editing} onClose={() => setEditing(null)} />)}
    </div>
  );
}

/** Add a site, or edit one: the same fields, prefilled, and only what changed is sent. */
function SiteDialog({ site, onClose }: { site?: SiteRow; onClose: () => void }) {
  const { moduleOn } = useTenant();
  const qc = useQueryClient();
  const term = useTerm();
  const siteNoun = term('site');
  const [name, setName] = useState(site?.name ?? '');
  // A workforce provider's places are stores; a direct employer's are properties.
  const [type, setType] = useState<SiteType>(site?.type ?? (moduleOn('clientPortal') ? 'STORE' : 'PROPERTY'));
  const [timezone, setTimezone] = useState<string>(site?.timezone ?? 'America/New_York');
  const [isActive, setIsActive] = useState(site?.isActive ?? true);
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState(site?.state ?? '');
  const [zip, setZip] = useState('');
  // A picked address brings its point (the clock-in geofence starts there).
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const stateValue = state.trim().toUpperCase() || null;
  /** Edit: the fields whose value differs from the row. Nothing changed → empty. */
  const changes = (): SiteUpdateInput => {
    if (!site) return {};
    const out: SiteUpdateInput = {};
    if (name.trim() !== site.name) out.name = name.trim();
    if (type !== site.type) out.type = type;
    if (timezone !== site.timezone) out.timezone = timezone;
    if (stateValue !== site.state) out.state = stateValue;
    if (isActive !== site.isActive) out.isActive = isActive;
    return out;
  };
  const dirty = () => (site ? Object.keys(changes()).length > 0 : name !== '' || line1 !== '' || city !== '');
  const save = useMutation({
    mutationFn: () =>
      site
        ? updateSite(site.id, changes())
        : createSite({
            name: name.trim(),
            type,
            timezone,
            addressLine1: line1.trim() || null,
            addressLine2: line2.trim() || null,
            city: city.trim() || null,
            state: stateValue,
            zip: zip.trim() || null,
            ...(point ? { latitude: point.lat, longitude: point.lng } : {}),
          }),
    onSuccess: async () => {
      toast.success(site ? `${siteNoun} saved.` : `${siteNoun} added.`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['org', 'sites'] }), qc.invalidateQueries({ queryKey: ['org', 'units'] })]);
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not ${site ? 'save' : 'add'} the ${siteNoun.toLowerCase()}.`),
  });
  const valid = name.trim().length > 0 && (state.trim() === '' || /^[A-Za-z]{2}$/.test(state.trim())) && (!site || dirty());
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()} confirmDiscard={dirty}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{site ? `Edit ${site.name}` : `Add a ${siteNoun.toLowerCase()}`}</DialogTitle>
          <DialogDescription>Where the work happens. The time zone sets the workday; the state sets the tax and overtime rules.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              {(p) => (
                <Select {...p} value={type} onChange={(e) => setType(e.target.value as SiteType)}>
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
                <Select {...p} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {SUPPORTED_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {fmtTimeZone(tz)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {site && (
            <p className="text-xs text-ink-muted">
              {site.regionName ? `In ${site.regionName}` : 'In no region'}
              {site.orgUnitName && site.orgUnitType !== 'REGION' ? ` · costed to ${site.orgUnitName}` : ''}.{' '}
              <Link to="/org/chart?view=field" className="text-accent underline-offset-2 hover:underline">
                Change in the Org chart
              </Link>
            </p>
          )}
          {site ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="State" hint="Two letters.">
                {(p) => <Input {...p} value={state} onChange={(e) => setState(e.target.value)} maxLength={2} />}
              </Field>
              <Field label="Status" hint="Inactive keeps the history and takes it off the pickers.">
                {(p) => (
                  <div className="flex min-h-11 items-center gap-2 text-sm text-ink">
                    <input {...p} type="checkbox" className="h-4 w-4" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                    <span aria-hidden="true">{isActive ? 'Active' : 'Inactive'}</span>
                  </div>
                )}
              </Field>
            </div>
          ) : (
            <>
              <Field label="Address line 1" hint={point ? 'Placed on the map from this address; the time zone follows it.' : undefined}>
                {(p) => (
                  <AddressAutocomplete
                    {...p}
                    value={line1}
                    onChange={setLine1}
                    onPick={(s) => {
                      const f = pickedFields(s);
                      setLine1(f.line1);
                      if (f.line2) setLine2(f.line2);
                      setCity(f.city);
                      setState(f.state);
                      setZip(f.zip);
                      setTimezone((tz) => zoneForPickedPlace(s, { state, timezone: tz }));
                      setPoint({ lat: s.lat, lng: s.lng });
                    }}
                  />
                )}
              </Field>
              <Field label="Address line 2">{(p) => <Input {...p} value={line2} onChange={(e) => setLine2(e.target.value)} />}</Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="City">{(p) => <Input {...p} value={city} onChange={(e) => setCity(e.target.value)} />}</Field>
                <Field label="State" hint="Two letters.">
                  {(p) => <Input {...p} value={state} onChange={(e) => setState(e.target.value)} maxLength={2} />}
                </Field>
                <Field label="ZIP">{(p) => <Input {...p} value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" />}</Field>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          {site && moduleOn('robotics') && (
            <Button asChild variant="ghost" className="mr-auto">
              <Link to={`/robots/sites/${site.id}/zones`}>Safety zones</Link>
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid || save.isPending}>
            {site ? 'Save changes' : `Add ${siteNoun.toLowerCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A client's store (or any place, for someone who can't edit): what it is, and where to change it. */
function SiteReadOnly({ site, onClose }: { site: SiteRow; onClose: () => void }) {
  const term = useTerm();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{site.name}</DialogTitle>
          <DialogDescription>
            {site.clientName
              ? `This ${term('label.store').toLowerCase()} belongs to ${site.clientName}: its name, address and hours change on the ${term('label.client').toLowerCase()}’s page.`
              : `Ask someone who manages the organization to change this ${term('site').toLowerCase()}.`}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">Type</dt>
          <dd className="text-ink">{SITE_TYPE_LABEL[site.type] ?? site.type}</dd>
          <dt className="text-ink-muted">Time zone</dt>
          <dd className="text-ink">{fmtTimeZone(site.timezone)}</dd>
          <dt className="text-ink-muted">Region</dt>
          <dd className="text-ink">{site.regionName ?? 'None'}</dd>
          <dt className="text-ink-muted">Cost center</dt>
          <dd className="text-ink">{site.orgUnitName && site.orgUnitType !== 'REGION' ? site.orgUnitName : 'None'}</dd>
        </dl>
        <DialogFooter>
          <Button asChild variant="ghost">
            <Link to="/org/chart?view=field">Place it in the Org chart</Link>
          </Button>
          {site.clientId && (
            <Button asChild>
              <Link to={`/clients/${site.clientId}`}>Edit in {site.clientName}</Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
