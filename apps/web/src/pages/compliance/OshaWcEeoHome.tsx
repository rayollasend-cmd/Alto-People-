import { useEffect, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { listClients, listClientLocations } from '@/lib/clientsApi';
import type { ClientListItem, LocationSummary } from '@alto-people/shared';
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
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { fmtDate } from '@/lib/format';
import { toast } from 'sonner';

type Tab = 'osha' | 'wc' | 'eeo';

export function OshaWcEeoHome() {
  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [clientId, setClientId] = useState('');
  const [tab, setTab] = useState<Tab>('osha');

  useEffect(() => {
    // Fetch once on mount — keying this on clientId made every dropdown
    // selection re-fire listClients() for no reason.
    listClients()
      .then((r) => {
        setClients(r.clients);
        if (r.clients.length > 0) setClientId((prev) => prev || r.clients[0].id);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="OSHA · WC · EEO-1"
        subtitle="OSHA injury log, Workers' Comp class codes, and EEO-1 race/gender/category reporting."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'OSHA · WC · EEO' }]}
      />
      <Card>
        <CardContent className="p-4 flex items-center gap-3">
          <span className="text-[11px] uppercase tracking-wider text-silver">Client</span>
          <Select
            size="sm"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            {clients.length === 0 && <option value="">—</option>}
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </CardContent>
      </Card>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="osha">OSHA log</TabsTrigger>
          <TabsTrigger value="wc">WC class codes</TabsTrigger>
          <TabsTrigger value="eeo">EEO-1 report</TabsTrigger>
        </TabsList>
        <TabsContent value="osha">
          {clientId && <OshaTab clientId={clientId} />}
        </TabsContent>
        <TabsContent value="wc"><WcTab /></TabsContent>
        <TabsContent value="eeo">
          {clientId && <EeoTab clientId={clientId} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============ CSV export helper ============

// Client-side CSV from already-loaded data — same Blob/anchor pattern as
// AnalyticsHome's downloadCsv, plus RFC-4180 quoting for safety.
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ============ OSHA ============

const SEVERITY_COLOR: Record<OshaSeverity, 'default' | 'pending' | 'destructive'> = {
  FIRST_AID: 'default',
  MEDICAL_TREATMENT: 'pending',
  RESTRICTED_DUTY: 'pending',
  DAYS_AWAY: 'destructive',
  FATAL: 'destructive',
};

function OshaTab({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<OshaIncident[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<OshaIncident | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof get300A>> | null>(null);
  // Bumped after create/edit so both the incident list AND the 300A
  // summary refetch (status/days/recordable edits move the 300A numbers).
  const [reloadTick, setReloadTick] = useState(0);

  const refresh = () => setReloadTick((t) => t + 1);
  useEffect(() => {
    setRows(null);
    listOshaIncidents(clientId)
      .then((r) => setRows(r.incidents))
      .catch((err) => {
        setRows([]);
        toast.error(
          err instanceof ApiError ? err.message : 'Could not load incidents.',
        );
      });
    get300A(clientId, year)
      .then(setSummary)
      .catch(() => {
        // Summary is decorative — the incident list above is what HR
        // acts on. Drop to em-dashes silently rather than double-toast.
        setSummary(null);
      });
  }, [clientId, year, reloadTick]);

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
        <CardContent className="p-4">
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
            </div>
            <div className="flex items-end gap-3">
              <div>
                <Label>Year</Label>
                <Input
                  className="mt-1 w-24"
                  type="number"
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value) || year)}
                />
              </div>
              <Button variant="secondary" onClick={download300aCsv} disabled={!summary}>
                <Download className="mr-2 h-4 w-4" /> Download CSV
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> Report incident
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No OSHA incidents"
              description="Workplace injuries get logged here for the OSHA 300 / 300A annual filings."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Occurred</TableHead>
                  <TableHead>Associate</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead className="hidden md:table-cell">Body part</TableHead>
                  <TableHead className="hidden md:table-cell">Days away</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((i) => (
                  // cursor-pointer + onClick: TableRow promotes this to a
                  // keyboard-accessible row (tabIndex, role, Enter/Space).
                  <TableRow key={i.id} className="cursor-pointer" onClick={() => setEditing(i)}>
                    <TableCell>{fmtDate(i.occurredAt)}</TableCell>
                    <TableCell>
                      {i.associateName ?? '—'}
                      <div className="text-[11px] text-silver/70 md:hidden">
                        {i.bodyPart ?? '—'}{i.daysAway ? ` · ${i.daysAway}d away` : ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={SEVERITY_COLOR[i.severity]}>{i.severity}</Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{i.bodyPart ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">{i.daysAway}</TableCell>
                    <TableCell>
                      <Badge variant={i.status === 'RESOLVED' ? 'success' : 'pending'}>
                        {i.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewIncidentDrawer
          clientId={clientId}
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-silver">{label}</div>
      <div className="mt-0.5 text-white font-medium">{value}</div>
    </div>
  );
}

function NewIncidentDrawer({
  clientId,
  onClose,
  onSaved,
}: {
  clientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  // Default to "now" in LOCAL wall-clock time — incidents are almost always
  // logged right after they happen, and datetime-local wants no timezone.
  const [occurredAt, setOccurredAt] = useState(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  });
  const [location, setLocation] = useState('');
  // Client's site list for the Location select; null while loading, [] when
  // the client has none (falls back to free text).
  const [locations, setLocations] = useState<LocationSummary[] | null>(null);
  const [description, setDescription] = useState('');
  const [bodyPart, setBodyPart] = useState('');
  const [severity, setSeverity] = useState<OshaSeverity>('FIRST_AID');
  const [daysAway, setDaysAway] = useState('0');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listClientLocations(clientId)
      .then((r) => {
        if (!cancelled) setLocations(r.locations);
      })
      .catch(() => {
        if (!cancelled) setLocations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const onSubmit = async () => {
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
        <div>
          <Label>Associate (optional)</Label>
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
                  {s}
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
          <Stat label="Associate" value={incident.associateName ?? '—'} />
          <Stat label="Client" value={incident.clientName} />
          <Stat label="Location" value={incident.location ?? '—'} />
          <Stat label="Body part" value={incident.bodyPart ?? '—'} />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-silver">Severity</div>
          <div className="mt-1">
            <Badge variant={SEVERITY_COLOR[incident.severity]}>{incident.severity}</Badge>
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-silver">Description</div>
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
                {s}
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
          <div className="mt-1 text-[11px] text-silver/70">
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
  const [rows, setRows] = useState<WcClassCode[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listWcClassCodes()
      .then((r) => setRows(r.codes))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New code
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No WC class codes"
              description="Add NCCI / state-specific class codes and rates per $100 of payroll."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="hidden md:table-cell">Rate / $100</TableHead>
                  <TableHead className="hidden lg:table-cell">Effective</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.stateCode ?? 'FED'}</TableCell>
                    <TableCell className="font-mono">
                      {c.code}
                      <div className="text-[11px] text-silver/70 md:hidden">${c.ratePer100} / $100</div>
                      <div className="text-[11px] text-silver/70 lg:hidden">
                        {c.effectiveFrom}{c.effectiveTo ? ` – ${c.effectiveTo}` : ''}
                      </div>
                    </TableCell>
                    <TableCell>{c.description}</TableCell>
                    <TableCell className="hidden md:table-cell">${c.ratePer100}</TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {c.effectiveFrom}
                      {c.effectiveTo ? ` – ${c.effectiveTo}` : ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

function EeoTab({ clientId }: { clientId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getEeoReport>> | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    setData(null);
    getEeoReport(clientId)
      .then(setData)
      .catch(() => setData(null));
  }, [clientId, reloadTick]);

  const downloadEeoCsv = () => {
    if (!data) return;
    downloadCsv(`eeo1-report-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Category', 'Race', 'Gender', 'Count'],
      ...data.buckets.map((b) => [b.category, b.race, b.gender, b.count]),
    ]);
  };

  if (data === null) {
    return <Card><CardContent className="p-6"><SkeletonRows count={5} /></CardContent></Card>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-wider text-silver">
              Active associates with EEO records
            </div>
            <div className="mt-1 text-2xl text-white font-medium">{data.total}</div>
          </div>
          <Button
            variant="secondary"
            onClick={downloadEeoCsv}
            disabled={data.buckets.length === 0}
          >
            <Download className="mr-2 h-4 w-4" /> Download CSV
          </Button>
        </CardContent>
      </Card>
      <EeoCapturePanel onSaved={() => setReloadTick((t) => t + 1)} />
      <Card>
        <CardContent className="p-0">
          {data.buckets.length === 0 ? (
            <EmptyState
              title="No EEO data yet"
              description="Record self-identification per associate with the panel above; counts roll up here by category × race × gender."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="hidden md:table-cell">Race</TableHead>
                  <TableHead>Gender</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.buckets.map((b, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      {b.category}
                      <div className="text-[11px] text-silver/70 md:hidden">{b.race}</div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{b.race}</TableCell>
                    <TableCell>{b.gender}</TableCell>
                    <TableCell className="text-right">{b.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** "Declined to disclose" reads better than the raw enum in a form. */
function eeoOptionLabel(value: string): string {
  return value === 'NOT_DISCLOSED' ? 'Declined to disclose' : value;
}

function EeoCapturePanel({ onSaved }: { onSaved: () => void }) {
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  const [category, setCategory] = useState<EeoCategory | ''>('');
  const [race, setRace] = useState<EeoRace | ''>('');
  const [gender, setGender] = useState<EeoGender | ''>('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!assoc) {
      toast.error('Pick an associate first.');
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
      <CardContent className="p-4 space-y-3">
        <div className="text-xs uppercase tracking-wider text-silver">
          Record EEO self-identification
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label>Associate</Label>
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
                  {c}
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
                  {eeoOptionLabel(r)}
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
                  {eeoOptionLabel(g)}
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
