import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, CheckCircle2, ClipboardCheck, MapPin, OctagonX, Play, ShieldCheck, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import {
  FLEET_PROVIDERS,
  OSHA_SEVERITIES,
  OSHA_SEVERITY_LABELS,
  ROBOT_EVENT_LABELS,
  ROBOT_INCIDENT_LABELS,
  type ChecklistAnswer,
  type OshaSeverity,
  type RobotChecklistTemplateSummary,
  type RobotDetail,
  type RobotIncidentKind,
  type RobotProfileInput,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtDateTime, fmtShiftTz } from '@/lib/format';
import { listClientLocations, listClients } from '@/lib/clientsApi';
import { listAdminUsers } from '@/lib/usersAdminApi';
import { zoneNameAt } from '@/lib/robotZones';
import {
  addMaintenance,
  completeChecklist,
  getRobot,
  getRobotIncident,
  listChecklistRuns,
  listChecklistTemplates,
  listMaintenance,
  listRobotEvents,
  listRobotIncidents,
  listRobotSamples,
  listSafetyZones,
  reportRobotIncident,
  resumeRobot,
  saveCommissioning,
  signOffCommissioning,
  startRobotShift,
  stopRobot,
  updateRobotProfile,
} from '@/lib/robotsApi';
import { RecordTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { BatteryMeter, RobotStatusBadge, sampleLine } from './robotUi';

const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/**
 * Brief 3-1 — one robot's record (design system §4.3: the Record template).
 * The header names it and carries the emergency stop; the tabs hold its
 * live status, profile, commissioning, checklists, incidents, events and
 * maintenance. `?tab=` is the open tab.
 */
export function RobotRecord() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const canManage = can('manage:org');
  const canFloor = can('manage:scheduling');
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') ?? 'live';
  const openTab = (key: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  const q = useQuery({ queryKey: ['robots', 'detail', id], queryFn: () => getRobot(id), enabled: !!id, refetchInterval: 60_000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['robots'] });

  const stop = useMutation({
    mutationFn: (note: string | undefined) => stopRobot(id, note),
    onSuccess: () => {
      toast.success('Emergency stop sent. The robot is suspended until it is resumed.');
      void invalidate();
    },
    onError: (e) => toast.error(err(e, 'Could not stop the robot.')),
  });
  const resume = useMutation({
    mutationFn: () => resumeRobot(id),
    onSuccess: () => {
      toast.success('The robot is active again.');
      void invalidate();
    },
    onError: (e) => toast.error(err(e, 'Could not resume the robot.')),
  });

  if (q.isError) return <QueryError what="this robot" query={q} className="mx-auto max-w-3xl" />;
  if (q.isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-4" aria-busy="true" aria-label="Loading the robot">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-6 w-96" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  const r = q.data;
  const stopped = r.status === 'SUSPENDED';

  const tabs = [
    { key: 'live', label: 'Live status', content: <LiveTab robot={r} canFloor={canFloor} /> },
    { key: 'profile', label: 'Profile', content: <ProfileTab robot={r} canManage={canManage} /> },
    { key: 'commissioning', label: 'Commissioning', count: r.commissionings.length, content: <CommissioningTab robot={r} canManage={canManage} /> },
    { key: 'checklists', label: 'Checklists', content: <ChecklistsTab robot={r} canFloor={canFloor} canManage={canManage} /> },
    { key: 'incidents', label: 'Incidents', count: r.openIncidents, content: <IncidentsTab robot={r} canFloor={canFloor} /> },
    { key: 'events', label: 'Events', content: <EventsTab robot={r} /> },
    { key: 'maintenance', label: 'Maintenance', content: <MaintenanceTab robot={r} canManage={canManage} /> },
  ];

  return (
    <RecordTemplate
      identity={
        <span className="grid h-10 w-10 place-items-center rounded-full bg-accent/15 text-accent">
          <Bot className="h-5 w-5" aria-hidden="true" />
        </span>
      }
      title={r.name}
      subtitle={[r.profile ? `${r.profile.manufacturer} ${r.profile.model}` : null, r.profile?.serial, r.site?.name ?? 'Not placed', r.owner ? `Owner ${r.owner.name}` : null].filter(Boolean).join(' · ')}
      status={
        <span className="flex items-center gap-2">
          <RobotStatusBadge status={r.latest?.status} size="default" />
          {stopped && (
            <Badge variant="destructive" size="default">
              Emergency stop
            </Badge>
          )}
        </span>
      }
      actions={
        canFloor ? (
          stopped ? (
            <Button variant="secondary" onClick={() => resume.mutate()} loading={resume.isPending}>
              <Play className="h-4 w-4" />
              Resume
            </Button>
          ) : (
            <Button
              variant="destructive"
              loading={stop.isPending}
              onClick={async () => {
                const ok = await confirm({ title: `Stop ${r.name}?`, description: 'The fleet halts the robot at once and nothing can schedule it until a crew lead resumes it. The stop is logged.', confirmLabel: 'Emergency stop', destructive: true });
                if (ok) stop.mutate(undefined);
              }}
            >
              <OctagonX className="h-4 w-4" />
              Emergency stop
            </Button>
          )
        ) : undefined
      }
      tabs={tabs}
      activeTab={tabs.some((t) => t.key === activeTab) ? activeTab : 'live'}
      onTabChange={openTab}
    />
  );
}

/* ------------------------------------------------------------ Live tab -- */

function LiveTab({ robot, canFloor }: { robot: RobotDetail; canFloor: boolean }) {
  const qc = useQueryClient();
  const samples = useQuery({ queryKey: ['robots', 'samples', robot.id, 24], queryFn: () => listRobotSamples(robot.id, 24), refetchInterval: 60_000 });
  const start = useMutation({
    mutationFn: (shiftId: string) => startRobotShift(robot.id, shiftId),
    onSuccess: (r) => {
      toast.success('Shift started. The gate passed: checklist, commissioning and zones.');
      for (const w of r.warnings ?? []) toast.warning(w);
      void qc.invalidateQueries({ queryKey: ['robots'] });
    },
    onError: (e) => toast.error(err(e, 'The shift could not start.')),
  });
  const latest = robot.latest;
  // Where it is, in the site's words: the zone the point falls in, with the
  // raw map units in the tooltip.
  const zonesQuery = useQuery({
    queryKey: ['robots', 'zones', robot.site?.id ?? ''],
    queryFn: () => listSafetyZones(robot.site!.id),
    enabled: !!robot.site,
    staleTime: 60_000,
  });
  const hasPoint = latest?.x !== null && latest?.x !== undefined && latest?.y !== null && latest?.y !== undefined;
  const zoneName = hasPoint ? zoneNameAt(zonesQuery.data?.zones ?? [], latest!.x, latest!.y) : null;
  const rows = samples.data?.samples ?? [];
  const lows = rows.filter((s) => (s.batteryPct ?? 100) < 20).length;
  const errors = rows.filter((s) => s.status === 'ERROR').length;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Fact label="Right now" value={<RobotStatusBadge status={latest?.status} size="default" />} sub={latest ? sampleLine(latest) : 'The fleet has not reported yet.'} />
        <Fact label="Battery" value={<BatteryMeter pct={latest?.batteryPct} />} sub={latest ? `as of ${fmtDateTime(latest.at)}` : '—'} />
        <Fact
          label="Position"
          value={
            hasPoint ? (
              <span title={`${latest!.x}, ${latest!.y} on the ${robot.site?.name ?? 'site'} map`}>{zoneName ?? 'Outside every zone'}</span>
            ) : (
              '—'
            )
          }
          sub={robot.site ? (hasPoint ? `${robot.site.name} · ${latest!.x}, ${latest!.y} map units` : robot.site.name) : 'Not placed at a site'}
        />
        <Fact label="Last 24 hours" value={`${rows.length} readings`} sub={`${errors} error${errors === 1 ? '' : 's'} · ${lows} low-battery reading${lows === 1 ? '' : 's'}`} />
      </div>

      <section className="space-y-2">
        <SectionTitle title="Upcoming shifts" description="A robot's shift starts only after its checklist, a signed commissioning at the site, and outside any zone guests occupy." />
        {robot.upcomingShifts.length === 0 ? (
          <p className="text-sm text-ink-muted">The schedule has no shift for it. Put it on one from Scheduling or the roster.</p>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Position</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Checklist</TableHead>
                    {canFloor && <TableHead className="text-right">Start</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {robot.upcomingShifts.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="whitespace-nowrap">{fmtShiftTz(s.startsAt, s.timezone)}</TableCell>
                      <TableCell>{s.position}</TableCell>
                      <TableCell>{s.locationName ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={s.checklistDone ? 'success' : 'pending'} size="sm">
                          {s.checklistDone ? 'Done' : 'Due'}
                        </Badge>
                      </TableCell>
                      {canFloor && (
                        <TableCell className="text-right">
                          <Button size="xs" variant="outline" onClick={() => start.mutate(s.id)} loading={start.isPending}>
                            <Play className="h-3.5 w-3.5" />
                            Start shift
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <details className="group">
        <summary className="cursor-pointer text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">Details · the last 24 hours of readings</summary>
        <div className="mt-2 max-h-96 overflow-auto rounded-lg border border-line">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>At</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Battery</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Position</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...rows].reverse().slice(0, 300).map((s) => (
                <TableRow key={s.at}>
                  <TableCell className="whitespace-nowrap">{fmtDateTime(s.at)}</TableCell>
                  <TableCell>
                    <RobotStatusBadge status={s.status} />
                  </TableCell>
                  <TableCell>{s.batteryPct ?? '—'}%</TableCell>
                  <TableCell>{s.currentTask ?? (s.errorCode ? `error ${s.errorCode}` : '—')}</TableCell>
                  <TableCell>{s.x !== null ? `${s.x}, ${s.y}` : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

/* --------------------------------------------------------- Profile tab -- */

function ProfileTab({ robot, canManage }: { robot: RobotDetail; canManage: boolean }) {
  const qc = useQueryClient();
  const p = robot.profile;
  const [form, setForm] = useState<RobotProfileInput>({
    manufacturer: p?.manufacturer ?? '',
    model: p?.model ?? '',
    serial: p?.serial ?? '',
    firmware: p?.firmware ?? '',
    ownership: p?.ownership ?? 'OWNED',
    leaseEndsOn: p?.leaseEndsOn ?? null,
    connectorProvider: p?.connectorProvider ?? 'SIMULATED',
    connectorExternalId: p?.connectorExternalId ?? '',
    certifications: p?.certifications ?? [],
    notes: p?.notes ?? '',
  });
  const set = <K extends keyof RobotProfileInput>(k: K, v: RobotProfileInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({
    mutationFn: () =>
      updateRobotProfile(robot.id, {
        ...form,
        firmware: form.firmware || null,
        connectorExternalId: form.connectorExternalId || null,
        leaseEndsOn: form.ownership === 'LEASED' ? form.leaseEndsOn || null : null,
        notes: form.notes || null,
      }),
    onSuccess: () => {
      toast.success('Profile saved.');
      void qc.invalidateQueries({ queryKey: ['robots'] });
    },
    onError: (e) => toast.error(err(e, 'Could not save the profile.')),
  });
  const valid = form.manufacturer.trim() && form.model.trim() && form.serial.trim();
  return (
    <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
      <Card>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Manufacturer" required>{(fp) => <Input {...fp} value={form.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} disabled={!canManage} />}</Field>
            <Field label="Model" required>{(fp) => <Input {...fp} value={form.model} onChange={(e) => set('model', e.target.value)} disabled={!canManage} />}</Field>
            <Field label="Serial" required>{(fp) => <Input {...fp} value={form.serial} onChange={(e) => set('serial', e.target.value)} disabled={!canManage} />}</Field>
            <Field label="Firmware">{(fp) => <Input {...fp} value={form.firmware ?? ''} onChange={(e) => set('firmware', e.target.value)} disabled={!canManage} />}</Field>
            <Field label="Ownership">
              {(fp) => (
                <Select {...fp} value={form.ownership} onChange={(e) => set('ownership', e.target.value as 'OWNED' | 'LEASED')} disabled={!canManage}>
                  <option value="OWNED">Owned</option>
                  <option value="LEASED">Leased</option>
                </Select>
              )}
            </Field>
            {form.ownership === 'LEASED' && (
              <Field label="Lease ends">{(fp) => <Input {...fp} type="date" value={form.leaseEndsOn ?? ''} onChange={(e) => set('leaseEndsOn', e.target.value || null)} disabled={!canManage} />}</Field>
            )}
            <Field label="Fleet connector" hint="The environment decides which fleet answers; a robot on another provider is read through the simulated fleet.">
              {(fp) => (
                <Select {...fp} value={form.connectorProvider} onChange={(e) => set('connectorProvider', e.target.value as RobotProfileInput['connectorProvider'])} disabled={!canManage}>
                  {FLEET_PROVIDERS.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Id on the fleet" hint="What the manufacturer's software calls this robot.">{(fp) => <Input {...fp} value={form.connectorExternalId ?? ''} onChange={(e) => set('connectorExternalId', e.target.value)} disabled={!canManage} />}</Field>
          </div>
          <Field label="Notes">{(fp) => <Textarea {...fp} rows={3} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} disabled={!canManage} />}</Field>
          {canManage && (
            <div className="flex justify-end">
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>
                Save profile
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3">
          <SectionTitle title="Certifications" />
          {(form.certifications ?? []).length === 0 && <p className="text-sm text-ink-muted">None on file.</p>}
          <ul className="space-y-2">
            {(form.certifications ?? []).map((c, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-ink">{c.name}</span>
                  <span className="block text-xs2 text-ink-muted">{c.expiresOn ? `Expires ${fmtDate(c.expiresOn)}` : c.issuedOn ? `Issued ${fmtDate(c.issuedOn)}` : 'No dates'}</span>
                </span>
                {canManage && (
                  <Button size="xs" variant="ghost" onClick={() => set('certifications', (form.certifications ?? []).filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {canManage && <CertificationAdder onAdd={(c) => set('certifications', [...(form.certifications ?? []), c])} />}
          <p className="text-xs2 text-ink-muted">Capabilities: {robot.capabilities.length ? robot.capabilities.join(', ') : 'none'} (set on the roster).</p>
        </CardContent>
      </Card>
    </div>
  );
}

function CertificationAdder({ onAdd }: { onAdd: (c: { name: string; issuedOn: string | null; expiresOn: string | null }) => void }) {
  const [name, setName] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Add a certification" className="min-w-40 flex-1">{(fp) => <Input {...fp} value={name} onChange={(e) => setName(e.target.value)} placeholder="UL 3300 safety" />}</Field>
      <Field label="Expires" className="w-40">{(fp) => <Input {...fp} type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />}</Field>
      <Button
        size="sm"
        variant="outline"
        disabled={!name.trim()}
        onClick={() => {
          onAdd({ name: name.trim(), issuedOn: null, expiresOn: expiresOn || null });
          setName('');
          setExpiresOn('');
        }}
      >
        Add
      </Button>
    </div>
  );
}

/* --------------------------------------------------- Commissioning tab -- */

function CommissioningTab({ robot, canManage }: { robot: RobotDetail; canManage: boolean }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const clients = useQuery({ queryKey: ['robots', 'clients'], queryFn: () => listClients({ status: 'ACTIVE' }), enabled: canManage });
  const [clientId, setClientId] = useState('');
  const sites = useQuery({ queryKey: ['robots', 'sites', clientId], queryFn: () => listClientLocations(clientId), enabled: canManage && !!clientId });
  const users = useQuery({ queryKey: ['robots', 'leads'], queryFn: () => listAdminUsers(), enabled: canManage });
  const [locationId, setLocationId] = useState(robot.site?.id ?? '');
  const [mapUrl, setMapUrl] = useState('');
  const [mapNotes, setMapNotes] = useState('');
  const [stations, setStations] = useState('');
  const [leadId, setLeadId] = useState('');
  const save = useMutation({
    mutationFn: () =>
      saveCommissioning(robot.id, {
        locationId,
        mapUrl: mapUrl.trim() || null,
        mapNotes: mapNotes.trim() || null,
        chargingStations: stations
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [label, x, y] = l.split(',').map((s) => s.trim());
            return { label: label ?? 'Dock', x: Number(x) || 0, y: Number(y) || 0 };
          }),
        safetyLeadUserId: leadId || null,
      }),
    onSuccess: () => {
      toast.success('Commissioning saved. The safety lead signs it off.');
      void qc.invalidateQueries({ queryKey: ['robots'] });
    },
    onError: (e) => toast.error(err(e, 'Could not save the commissioning.')),
  });
  const sign = useMutation({
    mutationFn: (loc: string) => signOffCommissioning(robot.id, loc),
    onSuccess: () => {
      toast.success('Signed off. The robot may start shifts at this site.');
      void qc.invalidateQueries({ queryKey: ['robots'] });
    },
    onError: (e) => toast.error(err(e, 'Only the named safety lead signs off.')),
  });
  return (
    <div className="space-y-5">
      {robot.commissionings.length === 0 ? (
        <EmptyState icon={MapPin} title="Not commissioned anywhere" description="A robot starts a shift only at a site where its commissioning is signed off by the named safety lead." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {robot.commissionings.map((c) => (
            <Card key={c.id}>
              <CardContent className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-ink">{c.locationName}</div>
                    <div className="text-xs text-ink-muted">
                      {c.chargingStations.length} charging station{c.chargingStations.length === 1 ? '' : 's'} · lead {c.safetyLead?.name ?? 'not named'}
                    </div>
                  </div>
                  <Badge variant={c.signedOffAt ? 'success' : 'pending'}>{c.signedOffAt ? `Signed ${fmtDate(c.signedOffAt)}` : 'Awaiting sign-off'}</Badge>
                </div>
                {c.mapUrl && (
                  <a href={c.mapUrl} target="_blank" rel="noreferrer" className="text-sm text-gold underline underline-offset-2">
                    Site map
                  </a>
                )}
                {c.mapNotes && <p className="text-sm text-ink-muted">{c.mapNotes}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="xs" variant="ghost">
                    <Link to={`/robots/sites/${c.locationId}/zones`}>Safety zones →</Link>
                  </Button>
                  {!c.signedOffAt && c.safetyLead && user?.id === c.safetyLead.id && (
                    <Button size="xs" onClick={() => sign.mutate(c.locationId)} loading={sign.isPending}>
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Sign off as safety lead
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {canManage && (
        <Card>
          <CardContent className="space-y-4">
            <SectionTitle title="Commission at a site" description="Saving again clears the sign-off: a changed map or lead needs a fresh signature." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Client">
                {(fp) => (
                  <Select {...fp} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                    <option value="">Choose a client</option>
                    {(clients.data?.clients ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Site" required>
                {(fp) => (
                  <Select {...fp} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    <option value="">Choose a site</option>
                    {(sites.data?.locations ?? []).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Safety lead" hint="Only this person can sign the commissioning off.">
                {(fp) => (
                  <Select {...fp} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                    <option value="">Name a lead</option>
                    {(users.data?.users ?? []).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.email}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Map link">{(fp) => <Input {...fp} value={mapUrl} onChange={(e) => setMapUrl(e.target.value)} placeholder="https://…" />}</Field>
            </div>
            <Field label="Charging stations" hint="One per line: label, x, y in the map's units.">{(fp) => <Textarea {...fp} rows={3} value={stations} onChange={(e) => setStations(e.target.value)} placeholder={'Dock A, 2, 2\nDock B, 40, 2'} />}</Field>
            <Field label="Map notes">{(fp) => <Textarea {...fp} rows={2} value={mapNotes} onChange={(e) => setMapNotes(e.target.value)} />}</Field>
            <div className="flex justify-end">
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!locationId}>
                Save commissioning
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------ Checklists tab -- */

function ChecklistsTab({ robot, canFloor, canManage }: { robot: RobotDetail; canFloor: boolean; canManage: boolean }) {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['robots', 'checklistRuns', robot.id], queryFn: () => listChecklistRuns(robot.id) });
  const templates = useQuery({ queryKey: ['robots', 'checklistTemplates', robot.site?.id ?? null], queryFn: () => listChecklistTemplates(robot.site?.id ?? null) });
  const [templateId, setTemplateId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [answers, setAnswers] = useState<Record<string, ChecklistAnswer>>({});
  const template: RobotChecklistTemplateSummary | undefined = templates.data?.templates.find((t) => t.id === templateId) ?? templates.data?.templates[0];
  useEffect(() => {
    if (!templateId && template) setTemplateId(template.id);
  }, [template, templateId]);
  const complete = useMutation({
    mutationFn: () =>
      completeChecklist(robot.id, {
        templateId: template!.id,
        shiftId: shiftId || null,
        answers: template!.items.map((i) => ({ key: i.key, ok: answers[i.key]?.ok ?? false, note: answers[i.key]?.note ?? null })),
      }),
    onSuccess: (run) => {
      toast.success(run.allPassed ? 'Checklist complete: all clear.' : 'Checklist recorded: a required item failed, so the shift cannot start.');
      setAnswers({});
      void qc.invalidateQueries({ queryKey: ['robots'] });
    },
    onError: (e) => toast.error(err(e, 'Could not record the checklist.')),
  });
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <div className="space-y-3">
        <SectionTitle title="Pre-shift checklist" description="The crew lead completes it before each shift. Required items must pass." />
        {templates.isPending ? (
          <Skeleton className="h-40" />
        ) : !template ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No checklist template"
            description={canManage ? 'Create one for this site or for every site.' : 'Ask an administrator to create a template.'}
            action={
              canManage ? (
                <Button asChild variant="secondary" size="sm">
                  <Link to="/robots/checklists">Open checklists</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Card>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Template">
                  {(fp) => (
                    <Select {...fp} value={template.id} onChange={(e) => setTemplateId(e.target.value)}>
                      {(templates.data?.templates ?? []).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.locationId ? '' : ' (every site)'}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="For the shift">
                  {(fp) => (
                    <Select {...fp} value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
                      <option value="">Next 12 hours (any shift)</option>
                      {robot.upcomingShifts.map((s) => (
                        <option key={s.id} value={s.id}>
                          {fmtShiftTz(s.startsAt, s.timezone)} · {s.position}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              <ul className="divide-y divide-line rounded-md border border-line">
                {template.items.map((i) => (
                  <li key={i.key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <label className="flex flex-1 items-center gap-2 text-sm text-ink">
                      <input type="checkbox" className="h-6 w-6 accent-gold" checked={answers[i.key]?.ok ?? false} onChange={(e) => setAnswers((a) => ({ ...a, [i.key]: { key: i.key, ok: e.target.checked, note: a[i.key]?.note ?? null } }))} disabled={!canFloor} />
                      {i.label}
                      {i.required && <span className="text-xs2 text-ink-muted">required</span>}
                    </label>
                    <Input className="h-8 w-48 text-xs" placeholder="Note" value={answers[i.key]?.note ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [i.key]: { key: i.key, ok: a[i.key]?.ok ?? false, note: e.target.value } }))} disabled={!canFloor} aria-label={`Note for ${i.label}`} />
                  </li>
                ))}
              </ul>
              {canFloor && (
                <div className="flex justify-end">
                  <Button onClick={() => complete.mutate()} loading={complete.isPending}>
                    <CheckCircle2 className="h-4 w-4" />
                    Record checklist
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
      <div className="space-y-3">
        <SectionTitle title="Completed" />
        {runs.isPending ? (
          <Skeleton className="h-40" />
        ) : (runs.data?.runs.length ?? 0) === 0 ? (
          <p className="text-sm text-ink-muted">The crew lead has not recorded a checklist for this robot.</p>
        ) : (
          <ul className="space-y-2">
            {runs.data!.runs.map((run) => (
              <li key={run.id} className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-ink">{run.templateName}</span>
                  <span className="block text-xs2 text-ink-muted">
                    {fmtDateTime(run.completedAt)} · {run.completedBy.name}
                    {run.shiftId ? ' · for a shift' : ''}
                  </span>
                </span>
                <Badge variant={run.allPassed ? 'success' : 'destructive'} size="sm">
                  {run.allPassed ? 'All clear' : 'Failed'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- Incidents tab -- */

function IncidentsTab({ robot, canFloor }: { robot: RobotDetail; canFloor: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['robots', 'incidents', robot.id], queryFn: () => listRobotIncidents(robot.id) });
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['robots', 'incident', openId], queryFn: () => getRobotIncident(openId!), enabled: !!openId });
  const [kind, setKind] = useState<RobotIncidentKind>('NEAR_MISS');
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [description, setDescription] = useState('');
  // An injury carries the OSHA severity from the report: first aid is the floor, not the only answer.
  const [severity, setSeverity] = useState<OshaSeverity>('FIRST_AID');
  const report = useMutation({
    mutationFn: () => reportRobotIncident(robot.id, { kind, occurredAt: new Date(occurredAt).toISOString(), description: description.trim(), oshaSeverity: kind === 'INJURY' ? severity : undefined }),
    onSuccess: (i) => {
      toast.success(`Reported. ${i.sampleCount} readings and ${i.peopleOnShift.length} people on shift attached as evidence.`);
      setDescription('');
      void qc.invalidateQueries({ queryKey: ['robots'] });
    },
    onError: (e) => toast.error(err(e, 'Could not report the incident.')),
  });
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <div className="space-y-3">
        <SectionTitle title="Reported" description="Each report keeps the robot's readings and events for the hour before it, and who was on shift, for five years." />
        {list.isPending ? (
          <Skeleton className="h-40" />
        ) : (list.data?.incidents.length ?? 0) === 0 ? (
          <EmptyState icon={AlertTriangle} title="No incidents" description="Nothing reported for this robot." />
        ) : (
          <ul className="space-y-2">
            {list.data!.incidents.map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => setOpenId(openId === i.id ? null : i.id)} className="w-full rounded-md border border-line bg-surface px-3 py-2 text-left text-sm hover:border-gold/40">
                  <span className="flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{i.description}</span>
                      <span className="block text-xs2 text-ink-muted">
                        {fmtDateTime(i.occurredAt)} · {i.locationName ?? 'site unknown'} · {i.sampleCount} readings · {i.peopleOnShift.length} on shift
                        {i.oshaIncidentId ? ' · in the OSHA log' : ''}
                      </span>
                    </span>
                    <Badge variant={i.kind === 'NEAR_MISS' ? 'pending' : 'destructive'} size="sm">
                      {ROBOT_INCIDENT_LABELS[i.kind]}
                    </Badge>
                  </span>
                </button>
                {openId === i.id && detail.data && (
                  <div className="mt-1 rounded-md border border-line px-3 py-2 text-xs text-ink-muted">
                    <div className="mb-1 text-ink">People on shift: {detail.data.peopleOnShift.map((p) => p.name).join(', ') || 'none recorded'}</div>
                    <div className="max-h-48 overflow-auto">
                      {detail.data.samples.map((s) => (
                        <div key={s.at} className="flex gap-3 tabular-nums">
                          <span className="w-40 shrink-0">{fmtDateTime(s.at)}</span>
                          <span className="w-20 shrink-0">{s.status}</span>
                          <span className="w-12 shrink-0">{s.batteryPct ?? '—'}%</span>
                          <span className="truncate">{s.currentTask ?? s.errorCode ?? ''}</span>
                        </div>
                      ))}
                      {detail.data.samples.length === 0 && <div>No readings in that hour.</div>}
                    </div>
                    <div className="mt-1">
                      {detail.data.evidencePurgedAt
                        ? `Evidence removed ${fmtDate(detail.data.evidencePurgedAt)} after its five-year retention; the report stays.`
                        : `Evidence kept until ${fmtDate(detail.data.retainUntil)}.`}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {canFloor && (
        <Card>
          <CardContent className="space-y-3">
            <SectionTitle title="Report an incident or near miss" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Kind">
                {(fp) => (
                  <Select {...fp} value={kind} onChange={(e) => setKind(e.target.value as RobotIncidentKind)}>
                    {(Object.keys(ROBOT_INCIDENT_LABELS) as RobotIncidentKind[]).map((k) => (
                      <option key={k} value={k}>
                        {ROBOT_INCIDENT_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="When">{(fp) => <Input {...fp} type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />}</Field>
            </div>
            {kind === 'INJURY' && (
              <Field label="Severity" hint="Anything above first aid is OSHA-recordable.">
                {(fp) => (
                  <Select {...fp} value={severity} onChange={(e) => setSeverity(e.target.value as OshaSeverity)}>
                    {OSHA_SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {OSHA_SEVERITY_LABELS[s]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label="What happened" required>{(fp) => <Textarea {...fp} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
            <p className="text-xs2 text-ink-muted">An injury or property damage at a client site also opens a row in the OSHA log.</p>
            <div className="flex justify-end">
              <Button onClick={() => report.mutate()} loading={report.isPending} disabled={!description.trim()}>
                Report
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- Events tab -- */

function EventsTab({ robot }: { robot: RobotDetail }) {
  const q = useQuery({ queryKey: ['robots', 'events', robot.id], queryFn: () => listRobotEvents(robot.id) });
  const events = q.data?.events ?? robot.recentEvents;
  if (q.isPending && robot.recentEvents.length === 0) return <Skeleton className="h-40" />;
  if (events.length === 0) return <EmptyState icon={OctagonX} title="No events" description="Emergency stops, resumes, errors, shift starts, checklists and maintenance land here." />;
  return (
    <ul className="space-y-1.5">
      {events.map((e) => (
        <li key={e.id} className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 text-sm">
          <Badge variant={e.kind === 'E_STOP' || e.kind === 'ERROR' ? 'destructive' : e.kind === 'RESUME' || e.kind === 'SHIFT_STARTED' || e.kind === 'COMMISSIONED' ? 'success' : 'outline'} size="sm">
            {ROBOT_EVENT_LABELS[e.kind]}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-ink">{e.note ?? ''}</span>
          <span className="shrink-0 text-xs2 text-ink-muted">
            {fmtDateTime(e.at)}
            {e.by ? ` · ${e.by.name}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------- Maintenance tab -- */

function MaintenanceTab({ robot, canManage }: { robot: RobotDetail; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['robots', 'maintenance', robot.id], queryFn: () => listMaintenance(robot.id) });
  const [performedOn, setPerformedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState('');
  const [description, setDescription] = useState('');
  const [nextDueOn, setNextDueOn] = useState('');
  const add = useMutation({
    mutationFn: () => addMaintenance(robot.id, { performedOn, kind: kind.trim(), description: description.trim(), nextDueOn: nextDueOn || null }),
    onSuccess: () => {
      toast.success('Maintenance logged.');
      setKind('');
      setDescription('');
      setNextDueOn('');
      void qc.invalidateQueries({ queryKey: ['robots'] });
    },
    onError: (e) => toast.error(err(e, 'Could not log the maintenance.')),
  });
  const rows = q.data?.maintenance ?? [];
  const nextDue = rows.map((m) => m.nextDueOn).filter((d): d is string => !!d).sort()[0];
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <div className="space-y-3">
        <SectionTitle title="History" description={nextDue ? `Next due ${fmtDate(nextDue)}.` : undefined} />
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : rows.length === 0 ? (
          <EmptyState icon={Wrench} title="No maintenance yet" />
        ) : (
          <ul className="space-y-2">
            {rows.map((m) => (
              <li key={m.id} className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-ink">{m.kind}</span>
                  <span className="text-xs2 text-ink-muted">{fmtDate(m.performedOn)}</span>
                </div>
                <p className="text-ink-muted">{m.description}</p>
                <p className="text-xs2 text-ink-muted">
                  {m.performedBy ? `By ${m.performedBy}` : ''}
                  {m.nextDueOn ? ` · next ${fmtDate(m.nextDueOn)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      {canManage && (
        <Card>
          <CardContent className="space-y-3">
            <SectionTitle title="Log maintenance" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Performed on" required>{(fp) => <Input {...fp} type="date" value={performedOn} onChange={(e) => setPerformedOn(e.target.value)} />}</Field>
              <Field label="Kind" required>{(fp) => <Input {...fp} value={kind} onChange={(e) => setKind(e.target.value)} placeholder="Firmware update, wheel service…" />}</Field>
              <Field label="Next due">{(fp) => <Input {...fp} type="date" value={nextDueOn} onChange={(e) => setNextDueOn(e.target.value)} />}</Field>
            </div>
            <Field label="What was done" required>{(fp) => <Textarea {...fp} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
            <div className="flex justify-end">
              <Button onClick={() => add.mutate()} loading={add.isPending} disabled={!kind.trim() || !description.trim()}>
                Log
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
