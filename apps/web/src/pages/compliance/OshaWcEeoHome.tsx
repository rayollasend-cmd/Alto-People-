import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { listClientLocations } from '@/lib/clientsApi';
import { useClients } from '@/lib/useClients';
import { OSHA_RATE_MIN_HOURS, oshaRateMeaningful, type LocationSummary } from '@alto-people/shared';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import {
  createOshaIncident,
  createWcClassCode,
  EEO_CATEGORIES,
  EEO_GENDERS,
  EEO_RACES,
  get300A,
  getEeoReport,
  listOshaIncidents,
  listWcClassCodes,
  updateAssociateEeo,
  updateOshaIncident,
  type EeoCategory,
  type EeoGender,
  type EeoRace,
  type OshaIncident,
  type OshaSeverity,
  type OshaStatus,
  type WcClassCode,
} from '@/lib/oshaWcEeoApi';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  Select,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { Label } from '@/components/ui/Label';
import { fmtDate, fmtMoney, fmtMonthShortYear, parseYmd, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { toast } from 'sonner';
import { ListTemplate } from '@/components/templates';
import { TaxYearSelect } from '@/components/ui/TaxYearSelect';
import { useUrlParam } from '@/lib/useUrlState';
import { useStoreScope } from '@/lib/storeScope';
import { statusTone } from '@/lib/status';
import { useTerm } from '@/lib/auth';
import { pickOne } from '@/lib/validationCopy';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { getEeoApplicantReport } from '@/lib/complianceApi';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';

type Tab = 'osha' | 'wc' | 'eeo';
const TABS: readonly Tab[] = ['osha', 'wc', 'eeo'];

/**
 * The client this page reads: a ?client= link wins, then the top bar's
 * client scope, and otherwise every client. It used to open on the first
 * client in the list ("Alto HR — Internal Hires": "No OSHA incidents")
 * while the scorecard that links here counted two open recordables at
 * another client. '' = all clients.
 */
export function useSafetyClient(): [string, (id: string) => void] {
  const [fromUrl, setFromUrl] = useUrlParam<string>('client', '');
  const scope = useStoreScope();
  const clientId = fromUrl || (scope.enabled ? scope.clientId : '');
  const setClient = (id: string) => {
    setFromUrl(id);
    // Keep the top bar in step, as the I-9 tab does.
    if (scope.enabled) scope.setClientId(id);
  };
  return [clientId, setClient];
}

export function OshaWcEeoHome() {
  // Shared react-query cache — fetched at most once per 5 minutes app-wide.
  const { clients } = useClients();
  const [clientId, setClientId] = useSafetyClient();
  const [tab, setTab] = useUrlParam<Tab>('tab', 'osha', TABS, { history: 'push' });

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Safety & EEO reporting"
        subtitle="The OSHA injury log and Form 300A summary, Workers' Comp class codes, and the EEO-1 report."
        filters={
          clients.length > 0 && tab !== 'wc' ? (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="safety-client" className="text-xs2 uppercase tracking-wider text-silver">
                Client
              </label>
              <Select
                id="safety-client"
                size="sm"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="w-full sm:w-auto"
              >
                <option value="">All clients</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : undefined
        }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="osha">OSHA log</TabsTrigger>
          <TabsTrigger value="wc">WC class codes</TabsTrigger>
          <TabsTrigger value="eeo">EEO-1 report</TabsTrigger>
        </TabsList>
        <TabsContent value="osha">
          <OshaTab clientId={clientId} clients={clients} />
        </TabsContent>
        <TabsContent value="wc"><WcTab /></TabsContent>
        <TabsContent value="eeo">
          <ApplicantSelfIdCard />
          <EeoTab clientId={clientId} />
        </TabsContent>
      </Tabs>
    </ListTemplate>
  );
}

// ============ OSHA ============

const SEVERITY_COLOR: Record<OshaSeverity, 'default' | 'pending' | 'destructive'> = {
  FIRST_AID: 'default',
  MEDICAL_TREATMENT: 'pending',
  RESTRICTED_DUTY: 'pending',
  DAYS_AWAY: 'destructive',
  FATAL: 'destructive',
};

const SEVERITY_LABELS: Record<OshaSeverity, string> = {
  FIRST_AID: 'First aid',
  MEDICAL_TREATMENT: 'Medical treatment',
  RESTRICTED_DUTY: 'Restricted duty',
  DAYS_AWAY: 'Days away',
  FATAL: 'Fatal',
};

// Domain-only codes the shared vocabulary doesn't carry: REPORTED awaits
// review (amber); ESCALATED demands attention (red). INVESTIGATING / RESOLVED
// come from the shared status vocabulary.
const OSHA_STATUS_TONES = { REPORTED: 'pending', ESCALATED: 'destructive' } as const;

const OSHA_STATUS_LABELS: Record<OshaStatus, string> = {
  REPORTED: 'Reported',
  INVESTIGATING: 'Investigating',
  RESOLVED: 'Resolved',
  ESCALATED: 'Escalated',
};

function OshaTab({ clientId, clients }: { clientId: string; clients: Array<{ id: string; name: string }> }) {
  // The tenant's word for a person ("Associate", "Employee", "Team member").
  const term = useTerm();
  const person = term('worker');
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<OshaIncident | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());

  const incidentsQuery = useQuery({
    queryKey: ['compliance', 'osha', clientId],
    queryFn: () => listOshaIncidents(clientId),
  });
  const rows: OshaIncident[] | null = incidentsQuery.data?.incidents ?? null;
  const rowsError = incidentsQuery.error
    ? incidentsQuery.error instanceof ApiError
      ? incidentsQuery.error.message
      : 'Could not load incidents.'
    : null;
  // Summary is decorative — the incident list above is what HR acts on.
  // A failed read drops to em-dashes silently rather than double-toasting.
  const summaryQuery = useQuery({
    queryKey: ['compliance', 'osha-300a', clientId, year],
    queryFn: () => get300A(clientId, year),
  });
  const summary: Awaited<ReturnType<typeof get300A>> | null = summaryQuery.isError
    ? null
    : (summaryQuery.data ?? null);
  // After create/edit both the incident list AND the 300A summary re-read
  // (status/days/recordable edits move the 300A numbers).
  const refresh = () => {
    void incidentsQuery.refetch();
    void summaryQuery.refetch();
  };

  const download300aCsv = () => {
    if (!summary) return;
    downloadCsv(`osha-300a-${year}.csv`, [
      ['Metric', 'Value'],
      ['Year', year],
      ['Total cases', summary.totalCases],
      ['Fatalities', summary.fatalities],
      ['Days-away cases', summary.daysAwayCases],
      ['Restricted-duty cases', summary.restrictedCases],
      ['Other recordable', summary.otherRecordable],
      ['Days away total', summary.totalDaysAway],
      ['Days restricted total', summary.totalDaysRestricted],
    ]);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-wider text-silver">Form 300A summary</div>
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-7 gap-3 text-sm">
                <Stat label="Total cases" value={summary?.totalCases ?? '—'} />
                <Stat label="Fatalities" value={summary?.fatalities ?? '—'} />
                <Stat label="Days-away cases" value={summary?.daysAwayCases ?? '—'} />
                <Stat label="Restricted-duty cases" value={summary?.restrictedCases ?? '—'} />
                <Stat label="Other recordable" value={summary?.otherRecordable ?? '—'} />
                <Stat label="Days away total" value={summary?.totalDaysAway ?? '—'} />
                <Stat label="Days restricted total" value={summary?.totalDaysRestricted ?? '—'} />
              </div>
              {summary && (summary.hoursWorked ?? 0) > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 md:grid-cols-7">
                  <Stat label="Hours worked" value={(summary.hoursWorked ?? 0).toLocaleString('en-US')} />
                  {oshaRateMeaningful(summary.hoursWorked) ? (
                    <>
                      <Stat label="Injury rate (TRIR)" value={summary.trir ?? '—'} />
                      <Stat label="Days away/restricted (DART)" value={summary.dart ?? '—'} />
                    </>
                  ) : (
                    // A rate on a few thousand hours is noise (one case reads
                    // as a TRIR in the hundreds), so it waits for the hours.
                    <div className="col-span-2">
                      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">Injury rates</div>
                      <div className="mt-0.5 text-sm text-silver">
                        Shown after {OSHA_RATE_MIN_HOURS.toLocaleString('en-US')} hours worked
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-end gap-3">
              <div>
                <Label>Year</Label>
                <div className="mt-1">
                  <TaxYearSelect value={year} onChange={setYear} label="Year" span={5} />
                </div>
              </div>
              <Button variant="secondary" onClick={download300aCsv} disabled={!summary}>
                <Download className="mr-2 h-4 w-4" /> Export CSV
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      {rows && rows.length > 0 && <OshaCharts rows={rows} />}
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> Report incident
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rowsError ? (
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {rowsError}
              </ErrorBanner>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No OSHA incidents"
              description="Workplace injuries get logged here for the OSHA 300 / 300A annual filings."
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="osha-incidents"
              caption="OSHA incidents"
              rows={rows}
              rowKey={(i) => i.id}
              search={{ placeholder: `${person}, body part…` }}
              urlState={false}
              exportCsv={{ filename: 'osha-incidents' }}
              onRowClick={(i) => setEditing(i)}
              rowActionLabel={(i) => `Open incident for ${i.associateName ?? person.toLowerCase()} on ${fmtDate(i.occurredAt)}`}
              columns={[
                { key: 'occurred', header: 'Occurred', accessor: (i) => i.occurredAt, sortable: true, searchable: false, cardMeta: true, cell: (i) => fmtDate(i.occurredAt) },
                { key: 'associate', header: person, accessor: (i) => i.associateName, sortable: true, primary: true, cell: (i) => i.associateName ?? '—' },
                // Every client in view: say which one each incident is at.
                ...(clientId || clients.length < 2 ? [] : [{ key: 'client', header: 'Client', accessor: (i: OshaIncident) => i.clientName, sortable: true, cardMeta: true, className: 'text-silver' }]),
                { key: 'severity', header: 'Severity', accessor: (i) => SEVERITY_LABELS[i.severity], sortable: true, cardMeta: true, cell: (i) => <Badge variant={SEVERITY_COLOR[i.severity]}>{SEVERITY_LABELS[i.severity]}</Badge> },
                { key: 'bodyPart', header: 'Body part', accessor: (i) => i.bodyPart, sortable: true, cell: (i) => i.bodyPart ?? '—' },
                { key: 'daysAway', header: 'Days away', accessor: (i) => i.daysAway, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
                { key: 'status', header: 'Status', accessor: (i) => OSHA_STATUS_LABELS[i.status], sortable: true, cell: (i) => <Badge variant={statusTone(i.status, { overrides: OSHA_STATUS_TONES })}>{OSHA_STATUS_LABELS[i.status]}</Badge> },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewIncidentDrawer
          clientId={clientId}
          clients={clients}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {editing && (
        <EditIncidentDrawer
          incident={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

const SEVERITY_ORDER: OshaSeverity[] = ['FIRST_AID', 'MEDICAL_TREATMENT', 'RESTRICTED_DUTY', 'DAYS_AWAY', 'FATAL'];
const SEVERITY_FILL: Record<OshaSeverity, string> = {
  FIRST_AID: PALETTE.other,
  MEDICAL_TREATMENT: PALETTE.series[1],
  RESTRICTED_DUTY: PALETTE.warn,
  DAYS_AWAY: PALETTE.bad,
  FATAL: PALETTE.series[4],
};

/** The last twelve months of incidents by kind, and the body parts hurt most — from the log below. */
function OshaCharts({ rows }: { rows: OshaIncident[] }) {
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    // Mid-month, so the label can't slip into the month before in another timezone.
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: fmtMonthShortYear(new Date(d.getFullYear(), d.getMonth(), 15)) };
  });
  const byMonth = months.map((m) => {
    const row: Record<string, string | number> = { month: m.label };
    for (const sev of SEVERITY_ORDER) row[sev] = 0;
    return row;
  });
  const monthIndex = new Map(months.map((m, i) => [m.key, i]));
  const parts = new Map<string, number>();
  let inWindow = 0;
  for (const r of rows) {
    const d = new Date(r.occurredAt);
    const i = monthIndex.get(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    if (i === undefined) continue;
    inWindow += 1;
    byMonth[i]![r.severity] = Number(byMonth[i]![r.severity]) + 1;
    const part = (r.bodyPart ?? '').trim();
    const key = part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : 'Not recorded';
    parts.set(key, (parts.get(key) ?? 0) + 1);
  }
  if (inWindow === 0) return null;
  const partRows = [...parts.entries()].map(([part, count]) => ({ part, count })).sort((a, b) => b.count - a.count);
  const topParts = partRows.slice(0, 8);
  const used = SEVERITY_ORDER.filter((sev) => byMonth.some((m) => Number(m[sev]) > 0));
  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <div className="min-w-0 xl:col-span-3">
        <ChartFrame
          title="Incidents, month by month"
          description="The last 12 months, by how serious each one was."
          summary={`${inWindow} incident${inWindow === 1 ? '' : 's'} in the last 12 months.`}
          csvName="osha-incidents-by-month"
          height={240}
          columns={[{ key: 'month', label: 'Month' }, ...used.map((sev) => ({ key: sev, label: SEVERITY_LABELS[sev], numeric: true }))]}
          rows={byMonth}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byMonth} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={PALETTE.grid} vertical={false} />
              <XAxis dataKey="month" tick={TICK} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} width="auto" />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {used.map((sev) => (
                <Bar key={sev} dataKey={sev} name={SEVERITY_LABELS[sev]} stackId="sev" fill={SEVERITY_FILL[sev]} maxBarSize={26} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      </div>
      <div className="min-w-0 xl:col-span-2">
        <ChartFrame
          title="By body part"
          description={partRows.length > topParts.length ? `The ${topParts.length} most often hurt — the table has all ${partRows.length}.` : 'The last 12 months.'}
          summary={`${topParts[0]!.part} is hurt most often: ${topParts[0]!.count}.`}
          csvName="osha-incidents-by-body-part"
          height={Math.max(160, topParts.length * 28 + 24)}
          columns={[
            { key: 'part', label: 'Body part' },
            { key: 'count', label: 'Incidents', numeric: true },
          ]}
          rows={partRows}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topParts} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={PALETTE.grid} horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="part" width={100} tick={TICK} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
              <Bar dataKey="count" name="Incidents" fill={PALETTE.series[0]} radius={[0, 3, 3, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
        {label}
      </div>
      <div className="mt-0.5 text-white font-medium tabular-nums">{value}</div>
    </div>
  );
}

function NewIncidentDrawer({
  clientId: scopedClientId,
  clients,
  onClose,
  onSaved,
}: {
  /** '' = the page shows every client: the drawer asks which one. */
  clientId: string;
  clients: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const term = useTerm();
  const [clientId, setClientId] = useState(scopedClientId || (clients.length === 1 ? clients[0]!.id : ''));
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  // Default to "now" in LOCAL wall-clock time — incidents are almost always
  // logged right after they happen, and datetime-local wants no timezone.
  const [occurredAt, setOccurredAt] = useState(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  });
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [bodyPart, setBodyPart] = useState('');
  const [severity, setSeverity] = useState<OshaSeverity>('FIRST_AID');
  const [daysAway, setDaysAway] = useState('0');
  const [saving, setSaving] = useState(false);

  // Client's site list for the Location select; null while loading, [] when
  // the client has none (falls back to free text).
  const locationsQuery = useQuery({
    queryKey: ['clients', clientId, 'locations'],
    queryFn: () => listClientLocations(clientId),
    enabled: !!clientId,
  });
  const locations: LocationSummary[] | null = locationsQuery.isError
    ? []
    : (locationsQuery.data?.locations ?? null);

  const onSubmit = async () => {
    if (!clientId) {
      toast.error('Pick the client it happened at.');
      return;
    }
    if (!description.trim()) {
      toast.error('Description required.');
      return;
    }
    if (!occurredAt) {
      toast.error('Occurred-at datetime required.');
      return;
    }
    setSaving(true);
    try {
      await createOshaIncident({
        clientId,
        associateId: assoc?.id ?? null,
        occurredAt: new Date(occurredAt).toISOString(),
        location: location.trim() || null,
        description: description.trim(),
        bodyPart: bodyPart.trim() || null,
        severity,
        daysAway: Number(daysAway) || 0,
      });
      toast.success('Incident logged.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>Report OSHA incident</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!scopedClientId && (
          <div>
            <Label htmlFor="osha-client">Client</Label>
            <Select
              id="osha-client"
              className="mt-1"
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setLocation('');
              }}
            >
              <option value="">Pick a client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div>
          <Label>{term('worker')} (optional)</Label>
          <div className="mt-1">
            <AssociatePicker value={assoc} onChange={setAssoc} />
          </div>
        </div>
        <div>
          <Label>Occurred at</Label>
          <Input
            className="mt-1"
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="osha-location">Location</Label>
          {locations && locations.length > 0 ? (
            <Select
              id="osha-location"
              className="mt-1"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            >
              <option value="">—</option>
              {locations.map((l) => (
                <option key={l.id} value={l.name}>
                  {l.name}
                </option>
              ))}
            </Select>
          ) : (
            // Client has no sites on file (or the lookup failed) — free text.
            <Input
              id="osha-location"
              className="mt-1"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          )}
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <Label>Body part affected</Label>
          <Input className="mt-1" value={bodyPart} onChange={(e) => setBodyPart(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="osha-severity">Severity</Label>
          <Select
            id="osha-severity"
            className="mt-1"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as OshaSeverity)}
          >
            {(['FIRST_AID', 'MEDICAL_TREATMENT', 'RESTRICTED_DUTY', 'DAYS_AWAY', 'FATAL'] as const).map(
              (s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ),
            )}
          </Select>
        </div>
        <div>
          <Label>Days away from work</Label>
          <Input
            className="mt-1"
            type="number"
            min="0"
            value={daysAway}
            onChange={(e) => setDaysAway(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Log incident'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

const OSHA_STATUSES: OshaStatus[] = ['REPORTED', 'INVESTIGATING', 'RESOLVED', 'ESCALATED'];

function EditIncidentDrawer({
  incident,
  onClose,
  onSaved,
}: {
  incident: OshaIncident;
  onClose: () => void;
  onSaved: () => void;
}) {
  const term = useTerm();
  const [status, setStatus] = useState<OshaStatus>(incident.status);
  const [resolutionNote, setResolutionNote] = useState(incident.resolutionNote ?? '');
  const [daysAway, setDaysAway] = useState(String(incident.daysAway));
  const [daysRestricted, setDaysRestricted] = useState(String(incident.daysRestricted));
  const [isRecordable, setIsRecordable] = useState(incident.isRecordable);
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    const away = Number(daysAway);
    const restricted = Number(daysRestricted);
    if (!Number.isInteger(away) || away < 0) {
      toast.error('Days away must be a non-negative whole number.');
      return;
    }
    if (!Number.isInteger(restricted) || restricted < 0) {
      toast.error('Days restricted must be a non-negative whole number.');
      return;
    }
    setSaving(true);
    try {
      await updateOshaIncident(incident.id, {
        status,
        resolutionNote: resolutionNote.trim() || null,
        daysAway: away,
        daysRestricted: restricted,
        isRecordable,
      });
      toast.success('Incident updated.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>OSHA incident</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Occurred" value={fmtDate(incident.occurredAt)} />
          <Stat label="Reported" value={fmtDate(incident.reportedAt)} />
          <Stat label={term('worker')} value={incident.associateName ?? '—'} />
          <Stat label="Client" value={incident.clientName} />
          <Stat label="Location" value={incident.location ?? '—'} />
          <Stat label="Body part" value={incident.bodyPart ?? '—'} />
        </div>
        <div>
          <div className="text-xs2 uppercase tracking-wider text-silver">Severity</div>
          <div className="mt-1">
            <Badge variant={SEVERITY_COLOR[incident.severity]}>
              {SEVERITY_LABELS[incident.severity]}
            </Badge>
          </div>
        </div>
        <div>
          <div className="text-xs2 uppercase tracking-wider text-silver">Description</div>
          <div className="mt-1 text-sm text-white whitespace-pre-wrap">{incident.description}</div>
        </div>
        <div>
          <Label htmlFor="osha-edit-status">Status</Label>
          <Select
            id="osha-edit-status"
            className="mt-1"
            value={status}
            onChange={(e) => setStatus(e.target.value as OshaStatus)}
          >
            {OSHA_STATUSES.map((s) => (
              <option key={s} value={s}>
                {OSHA_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Resolution note</Label>
          <Textarea
            className="mt-1"
            value={resolutionNote}
            onChange={(e) => setResolutionNote(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Days away</Label>
            <Input
              className="mt-1"
              type="number"
              min="0"
              step="1"
              value={daysAway}
              onChange={(e) => setDaysAway(e.target.value)}
            />
          </div>
          <div>
            <Label>Days restricted</Label>
            <Input
              className="mt-1"
              type="number"
              min="0"
              step="1"
              value={daysRestricted}
              onChange={(e) => setDaysRestricted(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm text-white">
            <input
              type="checkbox"
              checked={isRecordable}
              onChange={(e) => setIsRecordable(e.target.checked)}
            />
            OSHA recordable
          </label>
          <div className="mt-1 text-xs2 text-silver/70">
            First-aid-only cases are not recordable — 29 CFR 1904.7
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// ============ Workers' Comp ============

function WcTab() {
  const [showNew, setShowNew] = useState(false);

  const codesQuery = useQuery({ queryKey: ['compliance', 'wc-codes'], queryFn: () => listWcClassCodes() });
  const rows: WcClassCode[] | null = codesQuery.data?.codes ?? null;
  const error = codesQuery.error
    ? codesQuery.error instanceof ApiError
      ? codesQuery.error.message
      : 'Could not load class codes.'
    : null;
  const refresh = () => void codesQuery.refetch();

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New code
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {error}
              </ErrorBanner>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No WC class codes"
              description="Add NCCI / state-specific class codes and rates per $100 of payroll."
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="wc-class-codes"
              caption="Workers' compensation class codes"
              rows={rows}
              rowKey={(c) => c.id}
              search={{ placeholder: 'Code, description…' }}
              urlState={false}
              exportCsv={{ filename: 'wc-class-codes' }}
              columns={[
                { key: 'state', header: 'State', accessor: (c) => c.stateCode ?? 'FED', sortable: true, cardMeta: true },
                { key: 'code', header: 'Code', accessor: (c) => c.code, sortable: true, primary: true, className: 'font-mono' },
                { key: 'description', header: 'Description', accessor: (c) => c.description, sortable: true, cardMeta: true },
                { key: 'rate', header: 'Rate / $100', accessor: (c) => Number(c.ratePer100), csv: (c) => fmtMoney(c.ratePer100, { precise: true }), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (c) => fmtMoney(c.ratePer100, { precise: true }) },
                {
                  key: 'effective',
                  header: 'Effective',
                  accessor: (c) => c.effectiveFrom,
                  csv: (c) => `${fmtDate(parseYmd(c.effectiveFrom))}${c.effectiveTo ? ` – ${fmtDate(parseYmd(c.effectiveTo))}` : ''}`,
                  sortable: true,
                  searchable: false,
                  cell: (c) => `${fmtDate(parseYmd(c.effectiveFrom))}${c.effectiveTo ? ` – ${fmtDate(parseYmd(c.effectiveTo))}` : ''}`,
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {showNew && <NewWcDrawer onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refresh(); }} />}
    </div>
  );
}

function NewWcDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [stateCode, setStateCode] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [ratePer100, setRate] = useState('');
  const [effectiveFrom, setFrom] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!code.trim() || !description.trim() || !effectiveFrom) {
      toast.error('Code, description, and effective-from required.');
      return;
    }
    // Don't silently book $0.0000 when the rate is blank or garbage
    // (the old `Number(ratePer100) || 0` did exactly that).
    const rate = Number(ratePer100);
    if (!ratePer100.trim() || !Number.isFinite(rate) || rate <= 0) {
      toast.error('Rate per $100 must be a positive number.');
      return;
    }
    setSaving(true);
    try {
      await createWcClassCode({
        stateCode: stateCode.trim().toUpperCase() || null,
        code: code.trim(),
        description: description.trim(),
        ratePer100: rate,
        effectiveFrom,
      });
      toast.success('Code added.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New WC class code</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>State (2 letters; blank = federal)</Label>
          <Input
            className="mt-1"
            value={stateCode}
            onChange={(e) => setStateCode(e.target.value.slice(0, 2).toUpperCase())}
            placeholder="CA"
          />
        </div>
        <div>
          <Label>Code</Label>
          <Input
            className="mt-1 font-mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="8810"
          />
        </div>
        <div>
          <Label>Description</Label>
          <Input
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Clerical office employees"
          />
        </div>
        <div>
          <Label>Rate per $100 of payroll</Label>
          <Input
            className="mt-1"
            type="number"
            step="0.0001"
            value={ratePer100}
            onChange={(e) => setRate(e.target.value)}
          />
        </div>
        <div>
          <Label>Effective from</Label>
          {/* type="date" yields the YYYY-MM-DD the API validates against. */}
          <Input
            className="mt-1"
            type="date"
            value={effectiveFrom}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// ============ EEO-1 ============

const EEO_CATEGORY_LABELS: Record<string, string> = {
  EXEC_SR_OFFICIALS: 'Executive/senior officials',
  FIRST_MID_OFFICIALS: 'First/mid-level officials',
  PROFESSIONALS: 'Professionals',
  TECHNICIANS: 'Technicians',
  SALES_WORKERS: 'Sales workers',
  ADMIN_SUPPORT: 'Administrative support',
  CRAFT_WORKERS: 'Craft workers',
  OPERATIVES: 'Operatives',
  LABORERS_HELPERS: 'Laborers & helpers',
  SERVICE_WORKERS: 'Service workers',
};

const EEO_RACE_LABELS: Record<string, string> = {
  HISPANIC_LATINO: 'Hispanic or Latino',
  WHITE: 'White',
  BLACK_AFRICAN_AMERICAN: 'Black or African American',
  NATIVE_HAWAIIAN_PACIFIC_ISLANDER: 'Native Hawaiian or Pacific Islander',
  ASIAN: 'Asian',
  AMERICAN_INDIAN_ALASKA_NATIVE: 'American Indian or Alaska Native',
  TWO_OR_MORE: 'Two or more races',
  NOT_DISCLOSED: 'Declined to disclose',
};

const EEO_GENDER_LABELS: Record<string, string> = {
  MALE: 'Male',
  FEMALE: 'Female',
  NON_BINARY: 'Non-binary',
  NOT_DISCLOSED: 'Declined to disclose',
};

function EeoTab({ clientId }: { clientId: string }) {
  const term = useTerm();
  const reportQuery = useQuery({
    queryKey: ['compliance', 'eeo', clientId],
    queryFn: () => getEeoReport(clientId),
  });
  const data: Awaited<ReturnType<typeof getEeoReport>> | null = reportQuery.data ?? null;
  const error = reportQuery.error
    ? reportQuery.error instanceof ApiError
      ? reportQuery.error.message
      : 'Could not load the EEO report.'
    : null;

  const downloadEeoCsv = () => {
    if (!data) return;
    downloadCsv(`eeo1-report-${ymdLocal()}.csv`, [
      ['Category', 'Race', 'Gender', 'Count'],
      ...data.buckets.map((b) => [
        EEO_CATEGORY_LABELS[b.category] ?? b.category,
        EEO_RACE_LABELS[b.race] ?? b.race,
        EEO_GENDER_LABELS[b.gender] ?? b.gender,
        b.count,
      ]),
    ]);
  };

  if (error) {
    return (
      <Card>
        <CardContent>
          <ErrorBanner
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void reportQuery.refetch()}
              >
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        </CardContent>
      </Card>
    );
  }

  if (data === null) {
    return <Card><CardContent><SkeletonRows count={5} /></CardContent></Card>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-wider text-silver">
              {term('workers')} counted
            </div>
            <div className="mt-1 text-2xl text-white font-medium">{data.total}</div>
          </div>
          <Button
            variant="secondary"
            onClick={downloadEeoCsv}
            disabled={data.buckets.length === 0}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        </CardContent>
      </Card>
      <EeoCapturePanel onSaved={() => void reportQuery.refetch()} />
      <Card>
        <CardContent className="p-0">
          {data.buckets.length === 0 ? (
            <EmptyState
              title="No EEO data yet"
              description={`Record self-identification per ${term('worker').toLowerCase()} with the panel above; counts roll up here by category × race × gender.`}
            />
          ) : (
            <DataGrid<(typeof data.buckets)[number]>
              id="eeo-buckets"
              caption="EEO-1 counts"
              rows={data.buckets}
              rowKey={(b) => `${b.category}|${b.race}|${b.gender}`}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'eeo-counts' }}
              columnChooser={false}
              columns={[
                { key: 'category', header: 'Category', accessor: (b) => EEO_CATEGORY_LABELS[b.category] ?? b.category, sortable: true, primary: true },
                { key: 'race', header: 'Race', accessor: (b) => EEO_RACE_LABELS[b.race] ?? b.race, sortable: true, cardMeta: true },
                { key: 'gender', header: 'Gender', accessor: (b) => EEO_GENDER_LABELS[b.gender] ?? b.gender, sortable: true, cardMeta: true },
                { key: 'count', header: 'Count', accessor: (b) => b.count, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EeoCapturePanel({ onSaved }: { onSaved: () => void }) {
  const term = useTerm();
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  const [category, setCategory] = useState<EeoCategory | ''>('');
  const [race, setRace] = useState<EeoRace | ''>('');
  const [gender, setGender] = useState<EeoGender | ''>('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!assoc) {
      toast.error(pickOne(term));
      return;
    }
    if (!category && !race && !gender) {
      toast.error('Select at least one field to record.');
      return;
    }
    setSaving(true);
    try {
      await updateAssociateEeo(assoc.id, {
        category: category || null,
        race: race || null,
        gender: gender || null,
        selfDeclared: true,
      });
      toast.success('EEO record saved.');
      setAssoc(null);
      setCategory('');
      setRace('');
      setGender('');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-silver">
          Record EEO self-identification
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label>{term('worker')}</Label>
            <div className="mt-1">
              <AssociatePicker value={assoc} onChange={setAssoc} />
            </div>
          </div>
          <div>
            <Label htmlFor="eeo-category">Job category</Label>
            <Select
              id="eeo-category"
              className="mt-1"
              value={category}
              onChange={(e) => setCategory(e.target.value as EeoCategory | '')}
            >
              <option value="">—</option>
              {EEO_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {EEO_CATEGORY_LABELS[c] ?? c}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="eeo-race">Race / ethnicity</Label>
            <Select
              id="eeo-race"
              className="mt-1"
              value={race}
              onChange={(e) => setRace(e.target.value as EeoRace | '')}
            >
              <option value="">—</option>
              {EEO_RACES.map((r) => (
                <option key={r} value={r}>
                  {EEO_RACE_LABELS[r] ?? r}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="eeo-gender">Gender</Label>
            <Select
              id="eeo-gender"
              className="mt-1"
              value={gender}
              onChange={(e) => setGender(e.target.value as EeoGender | '')}
            >
              <option value="">—</option>
              {EEO_GENDERS.map((g) => (
                <option key={g} value={g}>
                  {EEO_GENDER_LABELS[g] ?? g}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={onSubmit} disabled={saving}>
            {saving ? 'Saving…' : 'Save record'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ============ Applicant self-identification (aggregate) ============

const APPLICANT_LABELS: Record<string, string> = {
  FEMALE: 'Women',
  MALE: 'Men',
  NONBINARY: 'Nonbinary',
  HISPANIC_OR_LATINO: 'Hispanic or Latino',
  WHITE: 'White',
  BLACK_OR_AFRICAN_AMERICAN: 'Black or African American',
  NATIVE_HAWAIIAN_OR_PACIFIC_ISLANDER: 'Native Hawaiian or Pacific Islander',
  ASIAN: 'Asian',
  AMERICAN_INDIAN_OR_ALASKA_NATIVE: 'American Indian or Alaska Native',
  TWO_OR_MORE_RACES: 'Two or more races',
  PROTECTED: 'Protected veteran',
  NOT_PROTECTED: 'Not a protected veteran',
  YES: 'Disability',
  NO: 'No disability',
  DECLINE: 'Preferred not to say',
  NO_ANSWER: 'Left blank',
};

/**
 * What applicants and new hires chose to tell us on the voluntary form
 * (audit 2026-10-21 #14) — counts only, last 12 months. Any group under
 * five reads "<5", so no one can be picked out.
 */
function ApplicantSelfIdCard() {
  const q = useQuery({ queryKey: ['compliance', 'eeo', 'applicants'], queryFn: () => getEeoApplicantReport() });
  const r = q.data;
  const groups: Array<[string, Record<string, number | '<5'>]> = r
    ? [
        ['Gender', r.gender],
        ['Race or ethnicity', r.ethnicity],
        ['Veteran status', r.veteranStatus],
        ['Disability', r.disabilityStatus],
      ]
    : [];
  return (
    <Card className="mb-4">
      <CardContent className="space-y-3">
        <div>
          <div className="text-sm font-medium text-ink">Applicant self-identification (aggregate)</div>
          <p className="text-xs text-ink-muted">
            Voluntary answers from applicants and new hires, kept apart from their applications. Counts only; any group under five reads “&lt;5”.
          </p>
        </div>
        {q.isError ? (
          <ErrorBanner>{q.error instanceof ApiError ? q.error.message : 'Could not load the applicant report.'}</ErrorBanner>
        ) : !r ? (
          <SkeletonRows count={2} />
        ) : (
          <>
            <div className="flex flex-wrap gap-4 text-sm text-ink">
              <span>
                <span className="tabular-nums">{r.applicants}</span> <span className="text-ink-muted">applicants {fmtDate(r.from)} to {fmtDate(r.to)}</span>
              </span>
              <span>
                <span className="tabular-nums">{r.responses}</span> <span className="text-ink-muted">answered</span>
              </span>
              <span>
                <span className="tabular-nums">{r.declined}</span> <span className="text-ink-muted">declined the form</span>
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {groups.map(([title, counts]) => (
                <div key={title}>
                  <div className="mb-1 text-xs uppercase tracking-wider text-ink-muted">{title}</div>
                  {Object.keys(counts).length === 0 ? (
                    <div className="text-xs text-ink-muted">—</div>
                  ) : (
                    <ul className="space-y-0.5 text-sm">
                      {Object.entries(counts).map(([k, v]) => (
                        <li key={k} className="flex justify-between gap-2">
                          <span className="text-ink-muted">{APPLICANT_LABELS[k] ?? k}</span>
                          <span className="tabular-nums text-ink">{v}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
