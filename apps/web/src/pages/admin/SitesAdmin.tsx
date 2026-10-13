import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { SITE_TYPES, SUPPORTED_TIMEZONES, type SiteType } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { ORG_UNIT_TYPE_LABEL, SITE_TYPE_LABEL, createSite, listOrgUnits, listSites, unitDepth, type OrgUnitRow, type SiteRow } from '@/lib/orgApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';

/**
 * Sites (Brief 2-1b steps 6–7): every place work happens, whatever the
 * tenant calls it. A direct employer adds a property, an office or a
 * warehouse here with no customer anywhere; a staffing tenant's stores
 * still arrive through the customer record and appear here read-only.
 */
export function SitesAdmin() {
  const { can } = useAuth();
  const { moduleOn } = useTenant();
  const term = useTerm();
  const canManage = can('manage:org');
  const [adding, setAdding] = useState(false);
  const query = useQuery({ queryKey: ['org', 'sites'], queryFn: listSites });
  const rows = useMemo(() => (query.data?.sites ?? []).filter((s): s is SiteRow => !!s && typeof s.id === 'string'), [query.data]);
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
          <span className="text-white">{r.name}</span>
          {!r.isActive && (
            <Badge variant="default" size="sm" withDot={false}>
              inactive
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'type', header: 'Type', accessor: (r) => SITE_TYPE_LABEL[r.type] ?? r.type, sortable: true, cardMeta: true, className: 'text-xs' },
    { key: 'timezone', header: 'Time zone', accessor: (r) => r.timezone, className: 'text-xs text-silver' },
    { key: 'state', header: 'State', accessor: (r) => r.state ?? '—', sortable: true, className: 'text-xs' },
    {
      key: 'unit',
      header: 'Unit',
      accessor: (r) => r.orgUnitName ?? '—',
      sortable: true,
      cell: (r) =>
        r.orgUnitName ? (
          <span className="text-xs">
            {r.orgUnitName}
            {r.orgUnitType ? <span className="text-silver"> · {ORG_UNIT_TYPE_LABEL[r.orgUnitType]}</span> : null}
          </span>
        ) : (
          <span className="text-xs text-silver">—</span>
        ),
    },
    ...(moduleOn('clientPortal') ? [{ key: 'client', header: clientNoun, accessor: (r: SiteRow) => r.clientName ?? '—', className: 'text-xs' } satisfies GridColumn<SiteRow>] : []),
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={sitesNoun}
        subtitle={`Every place work happens: its time zone, its state for tax and overtime, and the unit of the organizational tree it belongs to.`}
        breadcrumbs={[{ label: 'Admin' }, { label: 'Organization profile', to: '/admin/organization' }, { label: sitesNoun }]}
        primaryAction={
          canManage ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Add {siteNoun.toLowerCase()}
            </Button>
          ) : undefined
        }
      />
      {query.isError ? <QueryError what={sitesNoun.toLowerCase()} query={query} /> : null}
      <DataGrid<SiteRow>
        id="sites"
        caption={sitesNoun}
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={query.isPending}
        urlState={false}
        exportCsv={false}
        search={{ placeholder: `Search ${sitesNoun.toLowerCase()}` }}
        empty={{ icon: Building2, title: `No ${sitesNoun.toLowerCase()} yet`, description: `Add the first ${siteNoun.toLowerCase()} to schedule shifts and pin people to it.` }}
      />
      {adding && <SiteDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function SiteDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const term = useTerm();
  const siteNoun = term('site');
  const units = useQuery({ queryKey: ['org', 'units'], queryFn: listOrgUnits });
  const unitRows = useMemo(() => (units.data?.units ?? []).filter((u): u is OrgUnitRow => !!u && typeof u.id === 'string'), [units.data]);
  const [name, setName] = useState('');
  const [type, setType] = useState<SiteType>('PROPERTY');
  const [timezone, setTimezone] = useState<string>('America/New_York');
  const [orgUnitId, setOrgUnitId] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const dirty = () => name !== '' || line1 !== '' || city !== '' || orgUnitId !== '';
  const save = useMutation({
    mutationFn: () =>
      createSite({
        name: name.trim(),
        type,
        timezone,
        orgUnitId: orgUnitId || null,
        addressLine1: line1.trim() || null,
        addressLine2: line2.trim() || null,
        city: city.trim() || null,
        state: state.trim().toUpperCase() || null,
        zip: zip.trim() || null,
      }),
    onSuccess: async () => {
      toast.success(`${siteNoun} added.`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['org', 'sites'] }), qc.invalidateQueries({ queryKey: ['org', 'units'] })]);
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not add the ${siteNoun.toLowerCase()}.`),
  });
  const valid = name.trim().length > 0 && (state.trim() === '' || /^[A-Za-z]{2}$/.test(state.trim()));
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()} confirmDiscard={dirty}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a {siteNoun.toLowerCase()}</DialogTitle>
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
                      {tz}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Unit" hint="Where it sits in the organizational tree. Blank leaves it unpinned.">
            {(p) => (
              <Select {...p} value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)} disabled={units.isPending}>
                <option value="">— not pinned —</option>
                {unitRows.map((u) => (
                  <option key={u.id} value={u.id}>
                    {' '.repeat(unitDepth(u.path) * 3)}
                    {u.name} ({ORG_UNIT_TYPE_LABEL[u.type]})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Address line 1">{(p) => <Input {...p} value={line1} onChange={(e) => setLine1(e.target.value)} />}</Field>
          <Field label="Address line 2">{(p) => <Input {...p} value={line2} onChange={(e) => setLine2(e.target.value)} />}</Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="City">{(p) => <Input {...p} value={city} onChange={(e) => setCity(e.target.value)} />}</Field>
            <Field label="State" hint="Two letters.">
              {(p) => <Input {...p} value={state} onChange={(e) => setState(e.target.value)} maxLength={2} />}
            </Field>
            <Field label="ZIP">{(p) => <Input {...p} value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" />}</Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid || save.isPending}>
            Add {siteNoun.toLowerCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
