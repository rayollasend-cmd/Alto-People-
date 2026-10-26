import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bus, CalendarClock, Check, Fuel, IdCard, Plus, ShieldAlert, Siren, ThumbsDown, ThumbsUp, Trash2, Wrench } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { fmtDate, fmtDateOnlyRange, fmtDateTime, fmtMoney, fmtRelativeDayTz, fmtTimeTz, localInputToUtcIso, ymdLocal } from '@/lib/format';
import { useChargesRange } from '@/lib/transportRange';
import {
  ackSos,
  addVanService,
  createDriverShift,
  deleteDriverShift,
  getFeedbackTrend,
  getTransportCosts,
  getTransportExpiring,
  getTransportNeedsYou,
  getVanRecord,
  listDriverShifts,
  listDrivers,
  listIncidents,
  removeVanService,
  reviewIncident,
  updateDriverProfile,
  updateVanRecord,
  type DeskDriver,
  type NeedsYouItem,
  type RunMap,
  type TransportIncident,
  type TransportIncidentKind,
  type VanServiceKind,
} from '@/lib/transportApi';
import { personPhotoUrl } from '@/lib/photoUrl';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { DateField } from '@/components/ui/DateField';
import { MetricCard } from '@/components/ui/MetricCard';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { DataGrid } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';

/**
 * The Transportation Director's side of the driver and fleet pack:
 *
 *   TransportNeedsYou   everything waiting on the desk, counted — the same
 *                       number the Inbox shows
 *   SosBanner           a driver's SOS, with acknowledge
 *   DriversTab          each driver's licence, DOT card, MVR, today's shift;
 *                       the day's driver shifts to set and remove
 *   VanRecordDrawer     the fleet record: papers, VIN, odometer, service log,
 *                       pre-trip checks, incidents, out of service
 *   IncidentsSection    accidents and incidents to review
 *   FeedbackSection     riders' thumbs, by driver and by route
 *   CostsSection        cost per seat and per client against fares
 */

const cents = (n: number) => fmtMoney(n / 100);
const errMsg = (err: unknown) => (err instanceof ApiError ? err.message : String(err));

/* ===== Needs you ============================================================ */

export function TransportNeedsYou() {
  const q = useQuery({ queryKey: ['transport', 'needs-you'], queryFn: getTransportNeedsYou, refetchInterval: 30_000 });
  const [, setParams] = useSearchParams();
  if (q.isError) return <QueryError what="what needs you" query={q} />;
  if (!q.data?.items || q.data.total === 0) return null;
  const go = (i: NeedsYouItem) => {
    const tab = new URL(i.path, 'http://x').searchParams.get('tab');
    setParams(tab ? { tab } : {});
  };
  return (
    <section aria-label="Needs you" className="rounded-lg border border-navy-secondary bg-navy">
      <SectionTitle className="mb-0 px-4 pt-3" title={`Needs you · ${q.data.total}`} />
      <ul className="grid grid-cols-1 gap-px p-2 sm:grid-cols-2 lg:grid-cols-4">
        {q.data.items.map((i) => (
          <li key={i.key}>
            <button
              type="button"
              onClick={() => go(i)}
              aria-label={`${i.label}: ${i.count}`}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-navy-secondary/40 coarse:min-h-11"
            >
              <span
                className={cn('h-2 w-2 shrink-0 rounded-full', i.tone === 'alert' ? 'bg-alert' : i.tone === 'warning' ? 'bg-warning' : 'bg-info')}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{i.label}</span>
              <span className={cn('text-sm font-semibold tabular-nums', i.tone === 'alert' ? 'text-alert' : 'text-ink')}>{i.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ===== SOS ================================================================= */

export function SosBanner({ runs, manage }: { runs: RunMap[]; manage: boolean }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const loud = runs.filter((r) => r.safety?.sosAt && !r.safety.sosAckAt);
  const quiet = runs.filter((r) => r.safety?.escalatedAt && !(r.safety.sosAt && !r.safety.sosAckAt));
  if (loud.length === 0 && quiet.length === 0) return null;
  const ack = async (r: RunMap) => {
    setBusy(r.runId);
    try {
      await ackSos(r.runId);
      toast.success(`${r.driver.name} hears you’re on it`);
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mb-4 space-y-2">
      {loud.map((r) => (
        <div key={r.runId} role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-alert/60 bg-alert/10 px-4 py-3">
          <Siren className="h-5 w-5 shrink-0 text-alert" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-alert">
              SOS — {r.driver.name} in {r.van.name}
            </div>
            <div className="text-xs text-silver">
              {r.safety?.sosAt ? fmtDateTime(r.safety.sosAt) : ''}
              {r.safety?.sosNote ? ` · “${r.safety.sosNote}”` : ''}
              {r.position ? ` · ${r.position.lat.toFixed(5)}, ${r.position.lng.toFixed(5)}` : ''}
            </div>
          </div>
          {r.position && (
            <Button size="sm" variant="secondary" asChild>
              <a href={`https://www.google.com/maps?q=${r.position.lat},${r.position.lng}`} target="_blank" rel="noreferrer">
                Open in Maps
              </a>
            </Button>
          )}
          {manage && (
            <Button size="sm" variant="destructive" onClick={() => void ack(r)} loading={busy === r.runId} disabled={busy !== null}>
              <Check className="h-3.5 w-3.5" />
              Acknowledge
            </Button>
          )}
        </div>
      ))}
      {quiet.map((r) => (
        <div key={r.runId} role="status" className="flex items-center gap-3 rounded-lg border border-warning/50 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          {r.driver.name} hasn’t answered “everything OK?” — {r.van.name} sat still or went off its way. Call them.
        </div>
      ))}
    </div>
  );
}

/* ===== Drivers ============================================================== */

function CredentialChip({ d, onAdd }: { d: DeskDriver; onAdd?: () => void }) {
  const lapsed = d.credentials.problems.some((p) => p.expired);
  const tracked = !!d.profile.licenceExpiresAt || d.profile.dotMedicalRequired;
  // Transport walk 2: a missing licence is the thing to fix, not a dead
  // badge — the chip is the way in. Once any driver has a record, a driver
  // without one is refused at dispatch.
  if (!tracked) {
    return onAdd ? (
      <Button size="xs" variant="outline" onClick={onAdd} aria-label={`Add ${d.name}'s license`}>
        <IdCard className="h-3 w-3" />
        Add license
      </Button>
    ) : (
      <Badge size="sm" variant="pending">No license on file</Badge>
    );
  }
  if (lapsed) return <Badge size="sm" variant="destructive">License lapsed</Badge>;
  if (!d.credentials.ok) return <Badge size="sm" variant="pending">Missing a document</Badge>;
  if (d.credentials.dueSoon.length > 0) return <Badge size="sm" variant="pending">Renew soon</Badge>;
  return <Badge size="sm" variant="success">Current</Badge>;
}

export function DriversTab({ manage }: { manage: boolean }) {
  const drivers = useQuery({ queryKey: ['transport', 'drivers'], queryFn: listDrivers, refetchInterval: 60_000 });
  const [date, setDate] = useState(() => ymdLocal());
  const shifts = useQuery({ queryKey: ['transport', 'driver-shifts', date], queryFn: () => listDriverShifts(date, date) });
  const [editing, setEditing] = useState<DeskDriver | null>(null);
  const [adding, setAdding] = useState(false);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const remove = async (id: string, name: string) => {
    if (!(await confirm({ title: `Remove ${name}’s shift?`, description: 'They hear it was taken off the schedule.', confirmLabel: 'Remove shift', destructive: true }))) return;
    try {
      await deleteDriverShift(id);
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <div className="space-y-5">
      <section aria-label="Driver shifts" className="space-y-2">
        <SectionTitle
          title="Driver shifts"
          icon={CalendarClock}
          trailing={
            <div className="flex items-center gap-2">
              <DateField size="sm" aria-label="Day" value={date} clearable={false} onChange={(v) => v && setDate(v)} />
              {manage && (
                <Button size="sm" onClick={() => setAdding(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  Schedule a driver
                </Button>
              )}
            </div>
          }
        />
        {shifts.isError ? (
          <QueryError what="the driver shifts" query={shifts} />
        ) : shifts.isLoading ? (
          <Skeleton className="h-20" />
        ) : (shifts.data?.shifts.length ?? 0) === 0 ? (
          <p className="rounded-lg border border-navy-secondary px-4 py-3 text-sm text-silver">
            No driver shifts this day — every active driver can be dispatched. Once a day has driver shifts, only drivers on shift are offered.
          </p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60 rounded-lg border border-navy-secondary">
            {shifts.data!.shifts.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-36 shrink-0 text-sm tabular-nums text-ink">
                  {fmtTimeTz(s.startsAt, tz)}–{fmtTimeTz(s.endsAt, tz)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{s.driver?.name ?? 'Unassigned'}</span>
                {s.notes && <span className="hidden truncate text-xs text-silver sm:block">{s.notes}</span>}
                {manage && (
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove ${s.driver?.name ?? ''} shift`} onClick={() => void remove(s.id, s.driver?.name ?? 'this')}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Drivers" className="space-y-2">
        <SectionTitle title={drivers.data ? `Drivers · ${drivers.data.drivers.length}` : 'Drivers'} icon={IdCard} />
        {drivers.isError ? (
          <QueryError what="the drivers" query={drivers} />
        ) : drivers.isLoading ? (
          <Skeleton className="h-40" />
        ) : (drivers.data?.drivers.length ?? 0) === 0 ? (
          <EmptyState icon={Bus} title="No drivers yet" description="Drivers are people with the Driver role — invite them from Users." />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {drivers.data!.drivers.map((d) => (
              <Card key={d.userId}>
                <CardContent>
                  <div className="flex items-start gap-3">
                    <Avatar src={personPhotoUrl({ photoUrl: d.photoUrl, userId: d.userId })} name={d.name} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-ink">{d.name}</span>
                        <CredentialChip d={d} onAdd={manage ? () => setEditing(d) : undefined} />
                        {!d.drivesByTrade && <Badge size="sm" variant="outline">Drives in a pinch</Badge>}
                      </div>
                      <div className="mt-0.5 text-xs text-silver">
                        {d.van ? `${d.van.name}${d.van.plate ? ` · ${d.van.plate}` : ''}${d.van.outOfService ? ' (out of service)' : ''}` : 'No van'}
                        {d.today.length > 0 ? ` · on shift ${d.today.map((s) => `${fmtTimeTz(s.startsAt, tz)}–${fmtTimeTz(s.endsAt, tz)}`).join(', ')}` : ''}
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <dt className="text-silver">License</dt>
                        <dd className="text-ink">
                          {d.profile.licenceClass ? `Class ${d.profile.licenceClass} · ` : ''}
                          {d.profile.licenceState ? `${d.profile.licenceState} · ` : ''}
                          {d.profile.licenceExpiresAt ? `to ${fmtDate(d.profile.licenceExpiresAt)}` : '—'}
                        </dd>
                        {d.profile.dotMedicalRequired && (
                          <>
                            <dt className="text-silver">DOT medical card</dt>
                            <dd className="text-ink">{d.profile.dotMedicalExpiresAt ? `to ${fmtDate(d.profile.dotMedicalExpiresAt)}` : 'Not on file'}</dd>
                          </>
                        )}
                        <dt className="text-silver">MVR checked</dt>
                        <dd className="text-ink">{d.profile.mvrCheckedAt ? fmtDate(d.profile.mvrCheckedAt) : '—'}</dd>
                        <dt className="text-silver">Safety training</dt>
                        <dd className="text-ink">
                          {d.profile.trainingExpiresAt
                            ? `to ${fmtDate(d.profile.trainingExpiresAt)}`
                            : d.profile.trainingCompletedAt
                              ? `done ${fmtDate(d.profile.trainingCompletedAt)}`
                              : '—'}
                        </dd>
                      </dl>
                      {!d.associateId && (
                        <p className="mt-2 text-xs text-warning">No person record — can’t be scheduled, clocked or paid. Link the login to a person in Users.</p>
                      )}
                    </div>
                    {manage && (
                      <Button size="xs" variant="ghost" onClick={() => setEditing(d)}>
                        Edit
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        <p className="text-xs text-silver">
          A lapsed license or DOT card refuses dispatch and drops the driver from Plan runs. Dates also land on the person’s credentials, so the expirations desk sees them.
        </p>
      </section>
      {editing && <DriverProfileDialog driver={editing} onClose={() => setEditing(null)} />}
      {adding && <DriverShiftDialog date={date} drivers={drivers.data?.drivers ?? []} onClose={() => setAdding(false)} />}
    </div>
  );
}

function DriverProfileDialog({ driver, onClose }: { driver: DeskDriver; onClose: () => void }) {
  const queryClient = useQueryClient();
  const p0 = driver.profile;
  const [f, setF] = useState({
    licenceNumber: p0.licenceNumber ?? '',
    licenceState: p0.licenceState ?? '',
    licenceClass: p0.licenceClass ?? '',
    licenceExpiresAt: p0.licenceExpiresAt ?? '',
    dotMedicalRequired: p0.dotMedicalRequired,
    dotMedicalExpiresAt: p0.dotMedicalExpiresAt ?? '',
    mvrCheckedAt: p0.mvrCheckedAt ?? '',
    trainingCompletedAt: p0.trainingCompletedAt ?? '',
    trainingExpiresAt: p0.trainingExpiresAt ?? '',
    notes: p0.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await updateDriverProfile(driver.userId, {
        licenceNumber: f.licenceNumber.trim() || null,
        licenceState: f.licenceState.trim() ? f.licenceState.trim().toUpperCase() : null,
        licenceClass: f.licenceClass.trim() || null,
        licenceExpiresAt: f.licenceExpiresAt || null,
        dotMedicalRequired: f.dotMedicalRequired,
        dotMedicalExpiresAt: f.dotMedicalExpiresAt || null,
        mvrCheckedAt: f.mvrCheckedAt || null,
        trainingCompletedAt: f.trainingCompletedAt || null,
        trainingExpiresAt: f.trainingExpiresAt || null,
        notes: f.notes.trim() || null,
      });
      toast.success(`${driver.name}’s record saved`);
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
      onClose();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{driver.name}</DialogTitle>
          <DialogDescription>License, DOT medical card, safety training and the last MVR pull. A lapsed license, card or training refuses dispatch; an MVR older than a year is flagged.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="License number">{(p) => <Input {...p} value={f.licenceNumber} maxLength={40} onChange={(e) => setF({ ...f, licenceNumber: e.target.value })} />}</Field>
          <Field label="State">{(p) => <Input {...p} value={f.licenceState} maxLength={2} onChange={(e) => setF({ ...f, licenceState: e.target.value.toUpperCase() })} placeholder="FL" />}</Field>
          <Field label="Class">{(p) => <Input {...p} value={f.licenceClass} maxLength={10} onChange={(e) => setF({ ...f, licenceClass: e.target.value })} placeholder="E" />}</Field>
          <Field label="License expires">{(p) => <Input {...p} type="date" value={f.licenceExpiresAt} onChange={(e) => setF({ ...f, licenceExpiresAt: e.target.value })} />}</Field>
          <label className="col-span-2 flex items-center gap-2 text-sm text-ink coarse:min-h-11">
            <input type="checkbox" className="h-4 w-4 coarse:h-6 coarse:w-6" checked={f.dotMedicalRequired} onChange={(e) => setF({ ...f, dotMedicalRequired: e.target.checked })} />
            Needs a DOT medical card (vans seating 9–15 for pay, or as the state requires)
          </label>
          {f.dotMedicalRequired && (
            <Field label="DOT card expires">{(p) => <Input {...p} type="date" value={f.dotMedicalExpiresAt} onChange={(e) => setF({ ...f, dotMedicalExpiresAt: e.target.value })} />}</Field>
          )}
          <Field label="MVR checked">{(p) => <Input {...p} type="date" value={f.mvrCheckedAt} onChange={(e) => setF({ ...f, mvrCheckedAt: e.target.value })} />}</Field>
          <Field label="Safety training done">{(p) => <Input {...p} type="date" value={f.trainingCompletedAt} onChange={(e) => setF({ ...f, trainingCompletedAt: e.target.value })} />}</Field>
          <Field label="Training renews by" hint="Leave blank if your fleet doesn't track it.">{(p) => <Input {...p} type="date" value={f.trainingExpiresAt} onChange={(e) => setF({ ...f, trainingExpiresAt: e.target.value })} />}</Field>
          <Field label="Notes" className="col-span-2">{(p) => <Input {...p} value={f.notes} maxLength={500} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DriverShiftDialog({ date, drivers, onClose }: { date: string; drivers: DeskDriver[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const schedulable = drivers.filter((d) => d.associateId);
  const [driverUserId, setDriverUserId] = useState(schedulable[0]?.userId ?? '');
  const [start, setStart] = useState('05:00');
  const [end, setEnd] = useState('13:00');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const startsAt = localInputToUtcIso(`${date}T${start}`);
      const endDay = end <= start ? new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : date;
      const endsAt = localInputToUtcIso(`${endDay}T${end}`);
      await createDriverShift({ driverUserId, startsAt, endsAt, notes: notes.trim() || null });
      toast.success('Shift set — the driver was told');
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
      onClose();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule a driver · {fmtDate(date)}</DialogTitle>
          <DialogDescription>Hours of service apply: the day’s cap and the rest between shifts. Drivers clock in from their runs and are paid hourly.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Driver" className="col-span-2" required>
            {(p) => (
              <Select {...p} value={driverUserId} onChange={(e) => setDriverUserId(e.target.value)}>
                {schedulable.map((d) => (
                  <option key={d.userId} value={d.userId}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Starts" required>{(p) => <Input {...p} type="time" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label="Ends" required>{(p) => <Input {...p} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
          <Field label="Notes" className="col-span-2">{(p) => <Input {...p} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />}</Field>
        </div>
        {schedulable.length < drivers.length && (
          <p className="text-xs text-silver">Drivers without a person record aren’t listed — they can’t be scheduled or paid until linked.</p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={busy || !driverUserId}>
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== The fleet record ===================================================== */

const SERVICE_LABEL: Record<VanServiceKind, string> = {
  FUEL: 'Fuel',
  OIL_CHANGE: 'Oil change',
  TIRES: 'Tires',
  BRAKES: 'Brakes',
  INSPECTION: 'State inspection',
  REPAIR: 'Repair',
  CLEANING: 'Cleaning',
  OTHER: 'Other',
};

/**
 * A receipt photo as a thumbnail that opens full size in a new tab — the
 * driver's fuel receipt on the fleet card and in the van's service log.
 * `url` is the API path (/transport/photos/…); the browser reads it under /api.
 */
export function ReceiptThumb({ url, label = 'Fuel receipt', size = 'md' }: { url: string; label?: string; size?: 'sm' | 'md' }) {
  return (
    <a
      href={`/api${url}`}
      target="_blank"
      rel="noreferrer"
      className="block shrink-0 overflow-hidden rounded border border-navy-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      aria-label={`${label} — open full size`}
      title={`${label} — open full size`}
    >
      <img src={`/api${url}`} alt={label} loading="lazy" className={cn('object-cover', size === 'sm' ? 'h-8 w-8' : 'h-10 w-10')} />
    </a>
  );
}

export function VanRecordDrawer({ vanId, manage, onClose }: { vanId: string; manage: boolean; onClose: () => void }) {
  const q = useQuery({ queryKey: ['transport', 'van-record', vanId], queryFn: () => getVanRecord(vanId) });
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<{ vin: string; registrationExpiresAt: string; insuranceExpiresAt: string; inspectionDueAt: string; odometerMiles: string } | null>(null);
  const [svc, setSvc] = useState<{ kind: VanServiceKind; occurredAt: string; cost: string; odometer: string; vendor: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['transport'] });
  const r = q.data?.record;
  const saveRecord = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await updateVanRecord(vanId, {
        vin: edit.vin.trim() || null,
        registrationExpiresAt: edit.registrationExpiresAt || null,
        insuranceExpiresAt: edit.insuranceExpiresAt || null,
        inspectionDueAt: edit.inspectionDueAt || null,
        odometerMiles: edit.odometerMiles ? Math.round(Number(edit.odometerMiles)) : null,
      });
      setEdit(null);
      await refresh();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const toggleService = async () => {
    if (!r) return;
    try {
      if (r.outOfService) {
        await updateVanRecord(vanId, { outOfService: null });
        toast.success(`${r.name} is back in service`);
      } else {
        const reason = await prompt({ title: `Take ${r.name} out of service?`, description: 'Plan runs skips it and dispatch refuses it until you put it back. Planned runs on it are flagged.', reasonLabel: 'Why', reasonPlaceholder: 'Brakes — at Beach Auto until Thursday', confirmLabel: 'Take out of service', destructive: true });
        if (!reason) return;
        await updateVanRecord(vanId, { outOfService: { reason } });
        toast.success(`${r.name} is out of service`);
      }
      await refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const saveService = async () => {
    if (!svc) return;
    setBusy(true);
    try {
      await addVanService(vanId, {
        kind: svc.kind,
        occurredAt: svc.occurredAt,
        costCents: Math.round(Number(svc.cost || 0) * 100),
        odometerMiles: svc.odometer ? Math.round(Number(svc.odometer)) : null,
        vendor: svc.vendor.trim() || null,
      });
      setSvc(null);
      await refresh();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const removeEntry = async (id: string) => {
    if (!(await confirm({ title: 'Remove this entry?', confirmLabel: 'Remove', destructive: true }))) return;
    try {
      await removeVanService(vanId, id);
      await refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      <DrawerHeader>
        <DrawerTitle>{r ? `${r.name}${r.plate ? ` · ${r.plate}` : ''}` : 'Van'}</DrawerTitle>
        <DrawerDescription>The fleet record — papers, odometer, the service log, every pre-trip check and incident.</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-5">
        {q.isError ? (
          <QueryError what="the van’s record" query={q} />
        ) : !r ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            {r.outOfService && (
              <p role="status" className="rounded-lg border border-alert/40 bg-alert/10 px-3.5 py-2.5 text-sm text-alert">
                Out of service since {fmtDateTime(r.outOfService.since)}
                {r.outOfService.reason ? ` — ${r.outOfService.reason}` : ''}
              </p>
            )}
            <section aria-label="Papers" className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-ink">Papers & odometer</h3>
                {manage && !edit && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      setEdit({
                        vin: r.vin ?? '',
                        registrationExpiresAt: r.registrationExpiresAt ?? '',
                        insuranceExpiresAt: r.insuranceExpiresAt ?? '',
                        inspectionDueAt: r.inspectionDueAt ?? '',
                        odometerMiles: r.odometerMiles !== null ? String(r.odometerMiles) : '',
                      })
                    }
                  >
                    Edit
                  </Button>
                )}
              </div>
              {edit ? (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="VIN" className="col-span-2">{(p) => <Input {...p} value={edit.vin} maxLength={17} onChange={(e) => setEdit({ ...edit, vin: e.target.value.toUpperCase() })} />}</Field>
                  <Field label="Registration expires">{(p) => <Input {...p} type="date" value={edit.registrationExpiresAt} onChange={(e) => setEdit({ ...edit, registrationExpiresAt: e.target.value })} />}</Field>
                  <Field label="Insurance expires">{(p) => <Input {...p} type="date" value={edit.insuranceExpiresAt} onChange={(e) => setEdit({ ...edit, insuranceExpiresAt: e.target.value })} />}</Field>
                  <Field label="Inspection due">{(p) => <Input {...p} type="date" value={edit.inspectionDueAt} onChange={(e) => setEdit({ ...edit, inspectionDueAt: e.target.value })} />}</Field>
                  <Field label="Odometer (miles)">{(p) => <Input {...p} type="number" min={0} value={edit.odometerMiles} onChange={(e) => setEdit({ ...edit, odometerMiles: e.target.value })} />}</Field>
                  <div className="col-span-2 flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => void saveRecord()} loading={busy} disabled={busy}>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-silver">VIN</dt>
                  <dd className="font-mono text-ink">{r.vin ?? '—'}</dd>
                  {r.documents.map((d) => (
                    <div key={d.label} className="contents">
                      <dt className="text-silver">{d.label}</dt>
                      <dd className={cn(d.expired ? 'text-alert' : d.dueSoon ? 'text-warning' : 'text-ink')}>
                        {d.expiresAt ? fmtDate(d.expiresAt) : '—'}
                        {d.expired ? ' · lapsed' : d.dueSoon ? ' · due soon' : ''}
                      </dd>
                    </div>
                  ))}
                  <dt className="text-silver">Odometer</dt>
                  <dd className="tabular-nums text-ink">{r.odometerMiles !== null ? `${r.odometerMiles.toLocaleString()} mi` : '—'}</dd>
                </dl>
              )}
              {manage && (
                <Button size="sm" variant={r.outOfService ? 'primary' : 'secondary'} onClick={() => void toggleService()}>
                  {r.outOfService ? 'Back in service' : 'Take out of service'}
                </Button>
              )}
            </section>

            <section aria-label="Service log" className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-ink">Service log</h3>
                {manage && !svc && (
                  <Button size="xs" variant="ghost" onClick={() => setSvc({ kind: 'FUEL', occurredAt: ymdLocal(), cost: '', odometer: '', vendor: '' })}>
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </Button>
                )}
              </div>
              {svc && (
                <div className="grid grid-cols-2 gap-3 rounded-lg border border-navy-secondary p-3">
                  <Field label="What">
                    {(p) => (
                      <Select {...p} value={svc.kind} onChange={(e) => setSvc({ ...svc, kind: e.target.value as VanServiceKind })}>
                        {(Object.keys(SERVICE_LABEL) as VanServiceKind[]).map((k) => (
                          <option key={k} value={k}>
                            {SERVICE_LABEL[k]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Date">{(p) => <Input {...p} type="date" value={svc.occurredAt} onChange={(e) => setSvc({ ...svc, occurredAt: e.target.value })} />}</Field>
                  <Field label="Cost ($)">{(p) => <Input {...p} type="number" min={0} step="0.01" value={svc.cost} onChange={(e) => setSvc({ ...svc, cost: e.target.value })} />}</Field>
                  <Field label="Odometer">{(p) => <Input {...p} type="number" min={0} value={svc.odometer} onChange={(e) => setSvc({ ...svc, odometer: e.target.value })} />}</Field>
                  <Field label="Vendor" className="col-span-2">{(p) => <Input {...p} value={svc.vendor} maxLength={120} onChange={(e) => setSvc({ ...svc, vendor: e.target.value })} />}</Field>
                  <div className="col-span-2 flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setSvc(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => void saveService()} loading={busy} disabled={busy || !svc.occurredAt}>
                      Save
                    </Button>
                  </div>
                </div>
              )}
              {q.data!.serviceLog.length === 0 ? (
                <EmptyState icon={Fuel} title="No service logged" description="Fuel and maintenance logged here feed cost per seat." />
              ) : (
                <ul className="divide-y divide-navy-secondary/60">
                  {q.data!.serviceLog.map((e) => (
                    <li key={e.id} className="flex items-center gap-3 py-2 text-sm">
                      {e.kind === 'FUEL' ? <Fuel className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" /> : <Wrench className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />}
                      <span className="min-w-0 flex-1 truncate text-ink">
                        {SERVICE_LABEL[e.kind]}
                        {e.vendor ? <span className="text-silver"> · {e.vendor}</span> : null}
                        {e.notes ? <span className="text-silver"> · {e.notes}</span> : null}
                      </span>
                      {e.photoUrl && <ReceiptThumb url={e.photoUrl} label={e.kind === 'FUEL' ? 'Fuel receipt' : 'Receipt'} size="sm" />}
                      <span className="shrink-0 text-xs text-silver">{e.occurredAt ? fmtDate(e.occurredAt) : ''}</span>
                      <span className="w-20 shrink-0 text-right tabular-nums text-ink">{cents(e.costCents)}</span>
                      {manage && (
                        <Button size="icon-sm" variant="ghost" aria-label="Remove entry" onClick={() => void removeEntry(e.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Pre-trip checks" className="space-y-2">
              <h3 className="text-sm font-medium text-ink">Pre-trip checks</h3>
              {q.data!.checks.length === 0 ? (
                <EmptyState icon={Check} title="No pre-trip checks" description="Drivers walk around the van before each run; every check lands here." />
              ) : (
                <ul className="divide-y divide-navy-secondary/60">
                  {q.data!.checks.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                      <Badge size="sm" variant={c.passed ? 'success' : 'destructive'}>
                        {c.passed ? 'Passed' : 'Failed'}
                      </Badge>
                      <span className="text-ink">{c.driver}</span>
                      <span className="text-xs text-silver">{fmtDateTime(c.at)}</span>
                      {c.odometerMiles !== null && <span className="text-xs tabular-nums text-silver">{c.odometerMiles.toLocaleString()} mi</span>}
                      {c.failed.length > 0 && (
                        <span className="w-full text-xs text-warning">{c.items.filter((i) => !i.ok).map((i) => i.label + (i.note ? ` (${i.note})` : '')).join(', ')}</span>
                      )}
                      {c.photoUrl && (
                        <a className="text-xs text-gold underline-offset-2 hover:underline" href={`/api${c.photoUrl}`} target="_blank" rel="noreferrer">
                          Photo
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {q.data!.incidents.length > 0 && (
              <section aria-label="Incidents" className="space-y-2">
                <h3 className="text-sm font-medium text-ink">Incidents</h3>
                <ul className="space-y-2">
                  {q.data!.incidents.map((i) => (
                    <li key={i.id} className="rounded-md border border-navy-secondary p-2.5 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge size="sm" variant={i.injuries ? 'destructive' : 'pending'}>
                          {INCIDENT_LABEL[i.kind]}
                        </Badge>
                        <span className="text-xs text-silver">{fmtDateTime(i.occurredAt)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-ink">{i.description}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </DrawerBody>
    </Drawer>
  );
}

/* ===== Incidents ============================================================== */

const INCIDENT_LABEL: Record<TransportIncidentKind, string> = {
  COLLISION: 'Collision',
  INJURY: 'Injury',
  BREAKDOWN: 'Breakdown',
  NEAR_MISS: 'Near miss',
  PROPERTY_DAMAGE: 'Property damage',
  OTHER: 'Other',
};

export function IncidentsSection({ manage }: { manage: boolean }) {
  const [view, setView] = useState<'OPEN' | 'REVIEWED'>('OPEN');
  const q = useQuery({ queryKey: ['transport', 'incidents', view], queryFn: () => listIncidents({ status: view }) });
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const review = async (i: TransportIncident) => {
    const note = await prompt({ title: 'Mark this incident reviewed', description: 'Note what was done — the insurer, the OSHA log, the van.', reasonLabel: 'What was done', reasonPlaceholder: 'Insurer notified, claim 4471; van at Beach Auto.', confirmLabel: 'Reviewed' });
    if (!note) return;
    try {
      await reviewIncident(i.id, { status: 'REVIEWED', reviewNote: note });
      toast.success('Reviewed');
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <section aria-label="Incidents" className="space-y-3">
      <SectionTitle
        title="Incidents"
        icon={AlertTriangle}
        trailing={
          <SegmentedControl
            ariaLabel="Incidents"
            value={view}
            onChange={setView}
            options={[
              { value: 'OPEN', label: 'To review' },
              { value: 'REVIEWED', label: 'Reviewed' },
            ]}
          />
        }
      />
      {q.isError ? (
        <QueryError what="the incidents" query={q} />
      ) : q.isLoading ? (
        <Skeleton className="h-24" />
      ) : (q.data?.incidents.length ?? 0) === 0 ? (
        <EmptyState icon={Check} title={view === 'OPEN' ? 'All incidents reviewed' : 'Nothing reviewed so far'} description="Drivers and the desk file incidents from a run; an injury also opens an OSHA incident." />
      ) : (
        <div className="space-y-3">
          {q.data!.incidents.map((i) => (
            <Card key={i.id} className={cn(i.injuries && i.status === 'OPEN' && 'border-alert/50')}>
              <CardContent>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={i.injuries ? 'destructive' : 'pending'} withDot={false}>
                    {INCIDENT_LABEL[i.kind]}
                  </Badge>
                  {i.injuries && <Badge size="sm" variant="destructive">Someone hurt</Badge>}
                  {i.vanParked && <Badge size="sm" variant="outline">Van parked</Badge>}
                  <span className="text-sm font-medium text-ink">{i.reportedBy.name}</span>
                  <span className="text-xs text-silver">
                    {fmtDateTime(i.occurredAt)}
                    {i.van ? ` · ${i.van.name}` : ''}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{i.description}</p>
                <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  {i.policeReportNumber && (
                    <div>
                      <dt className="inline text-silver">Police report </dt>
                      <dd className="inline text-ink">{i.policeReportNumber}</dd>
                    </div>
                  )}
                  {i.parties.map((p, n) => (
                    <div key={n}>
                      <dt className="inline text-silver">Other party </dt>
                      <dd className="inline text-ink">{[p.name, p.plate, p.insurer, p.phone].filter(Boolean).join(' · ')}</dd>
                    </div>
                  ))}
                  {i.oshaIncidentIds.length > 0 && (
                    <div>
                      <dt className="inline text-silver">OSHA log </dt>
                      <dd className="inline text-ink">{i.oshaIncidentIds.length} incident{i.oshaIncidentIds.length === 1 ? '' : 's'} opened</dd>
                    </div>
                  )}
                  {i.point && (
                    <div>
                      <dt className="inline text-silver">Where </dt>
                      <dd className="inline">
                        <a className="text-gold underline-offset-2 hover:underline" href={`https://www.google.com/maps?q=${i.point.lat},${i.point.lng}`} target="_blank" rel="noreferrer">
                          On the map
                        </a>
                      </dd>
                    </div>
                  )}
                </dl>
                {i.photos.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {i.photos.map((url, n) => (
                      <a key={url} href={`/api${url}`} target="_blank" rel="noreferrer" className="text-xs text-gold underline-offset-2 hover:underline">
                        Photo {n + 1}
                      </a>
                    ))}
                  </div>
                )}
                {i.reviewNote && <p className="mt-2 border-l-2 border-success/50 pl-2 text-sm text-silver">{i.reviewNote}</p>}
                {manage && i.status === 'OPEN' && (
                  <div className="mt-3">
                    <Button size="sm" onClick={() => void review(i)}>
                      Mark reviewed
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

/* ===== Riders' feedback ======================================================= */

function last(days: number): { from: string; to: string } {
  const to = ymdLocal();
  return { from: new Date(Date.parse(`${to}T12:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10), to };
}

const REASON_LABEL: Record<string, string> = {
  GREAT: 'Great driver',
  LATE: 'Late',
  DRIVING: 'Driving',
  VEHICLE: 'Van',
  CONDUCT: 'Conduct',
  ROUTE: 'Route',
  OTHER: 'Other',
};

export function FeedbackSection() {
  const [days, setDays] = useState<30 | 90>(30);
  const { from, to } = last(days);
  const q = useQuery({ queryKey: ['transport', 'feedback', from, to], queryFn: () => getFeedbackTrend(from, to) });
  const topReasons = (r: Record<string, number>) =>
    Object.entries(r)
      .filter(([k]) => k !== 'GREAT')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k, n]) => `${REASON_LABEL[k] ?? k} ${n}`)
      .join(' · ');
  return (
    <section aria-label="Rider feedback" className="space-y-3">
      <SectionTitle
        title="Rider feedback"
        icon={ThumbsUp}
        trailing={
          <SegmentedControl
            ariaLabel="Period"
            value={days}
            onChange={setDays}
            options={[
              { value: 30, label: 'Last 30 days' },
              { value: 90, label: 'Last 90 days' },
            ]}
          />
        }
      />
      {q.isError ? (
        <QueryError what="rider feedback" query={q} />
      ) : !q.data ? (
        <Skeleton className="h-24" />
      ) : q.data.total.up + q.data.total.down === 0 ? (
        <EmptyState icon={ThumbsUp} title="No ratings in this period" description="Riders are asked after each finished ride. Nothing here is shown to riders or drivers." />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <MetricCard label="Thumbs up" value={q.data.total.score === null ? '—' : `${q.data.total.score}%`} />
            <MetricCard label="Up" value={q.data.total.up} />
            <MetricCard label="Down" value={q.data.total.down} accent={q.data.total.down > 0} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-medium text-ink">By driver — lowest first</h3>
              <ul className="divide-y divide-navy-secondary/60 rounded-lg border border-navy-secondary">
                {q.data.byDriver.map((d) => (
                  <li key={d.userId} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-ink">{d.name}</span>
                    <span className="hidden truncate text-xs text-silver sm:block">{topReasons(d.reasons)}</span>
                    <span className="inline-flex items-center gap-1 tabular-nums text-silver">
                      <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" /> {d.up}
                      <ThumbsDown className="ml-2 h-3.5 w-3.5" aria-hidden="true" /> {d.down}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-medium text-ink">By route — lowest first</h3>
              <ul className="divide-y divide-navy-secondary/60 rounded-lg border border-navy-secondary">
                {q.data.byRoute.map((r) => (
                  <li key={`${r.locationId}-${r.direction}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-ink">
                      {r.direction === 'TO_WORK' ? 'To' : 'From'} {r.store}
                    </span>
                    <span className="hidden truncate text-xs text-silver sm:block">{topReasons(r.reasons)}</span>
                    <span className="tabular-nums text-ink">{r.score === null ? '—' : `${r.score}%`}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {q.data.notes.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium text-ink">What riders wrote</h3>
              <ul className="space-y-1.5">
                {q.data.notes.slice(0, 10).map((n, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    {n.thumbsUp ? <ThumbsUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" /> : <ThumbsDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />}
                    <span className="text-ink">
                      “{n.note}” <span className="text-xs text-silver">— {n.store}{n.driver ? `, ${n.driver}` : ''} · {fmtRelativeDayTz(n.at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ===== Cost per seat ========================================================== */

export function CostsSection() {
  // Transport walk 13: the same range as the charges table above, from the URL.
  // One range for the tab: it is picked once, above the charges — a second
  // pair of date boxes here set the very same dates.
  const { from, to } = useChargesRange();
  const q = useQuery({ queryKey: ['transport', 'costs', from, to], queryFn: () => getTransportCosts(from, to) });
  const t = q.data?.totals;
  return (
    <section aria-label="Cost per seat" className="space-y-3">
      <SectionTitle title="Cost per seat, by client" description={`${fmtDateOnlyRange(from, to)} · the dates chosen above`} />
      {q.isError ? (
        <QueryError what="the costs" query={q} />
      ) : !q.data ? (
        <Skeleton className="h-32" />
      ) : q.data.rows.length === 0 ? (
        <EmptyState icon={Bus} title="No finished runs in these dates" />
      ) : (
        <>
          {t && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetricCard label="Seats" value={t.seats} />
              <MetricCard label="Fares" value={cents(t.faresCents)} />
              <MetricCard label="Cost" value={cents(t.costCents)} hint={`${cents(t.driverCents)} drivers · ${cents(t.fuelCents)} fuel · ${cents(t.maintenanceCents)} upkeep`} />
              <MetricCard label="Cost per seat" value={t.costPerSeatCents === null ? '—' : cents(t.costPerSeatCents)} accent={t.netCents < 0} />
            </div>
          )}
          <div className="overflow-x-auto">
            <DataGrid<(typeof q.data.rows)[number]>
              id="transport-costs"
              caption="Cost per seat by client"
              rows={q.data.rows}
              rowKey={(r) => r.clientId ?? 'none'}
              urlState={false}
              exportCsv={{ filename: `transport-costs-${from}-to-${to}` }}
              columns={[
                { key: 'client', header: 'Client', accessor: (r) => r.client, sortable: true, primary: true },
                { key: 'seats', header: 'Seats', accessor: (r) => r.seats, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                { key: 'runs', header: 'Runs', accessor: (r) => r.runs, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
                { key: 'fares', header: 'Fares', accessor: (r) => r.faresCents, csv: (r) => cents(r.faresCents), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => cents(r.faresCents) },
                { key: 'cost', header: 'Cost', accessor: (r) => r.costCents, csv: (r) => cents(r.costCents), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => cents(r.costCents) },
                { key: 'perSeat', header: 'Cost / seat', accessor: (r) => r.costPerSeatCents ?? 0, csv: (r) => (r.costPerSeatCents === null ? '' : cents(r.costPerSeatCents)), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (r) => (r.costPerSeatCents === null ? '—' : cents(r.costPerSeatCents)) },
                { key: 'net', header: 'Net', accessor: (r) => r.netCents, csv: (r) => cents(r.netCents), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => <span className={r.netCents < 0 ? 'text-warning' : 'text-success'}>{cents(r.netCents)}</span> },
              ]}
            />
          </div>
          <p className="text-xs text-silver">{q.data.note} A client’s share of a run is the share of its seats that client’s riders filled.</p>
        </>
      )}
    </section>
  );
}

/* ===== The expirations desk ===================================================== */

/** Van papers and driver credentials, for the expirations page. */
export function TransportExpiringSection({ days }: { days: number }) {
  const q = useQuery({ queryKey: ['transport', 'expiring', days], queryFn: () => getTransportExpiring(days), retry: false });
  if (q.isError || !q.data?.items || q.data.items.length === 0) return null;
  return (
    <Card>
      <CardContent>
        <SectionTitle title={`Vans and drivers · ${q.data.items.length}`} icon={Bus} />
        <ul className="mt-2 divide-y divide-navy-secondary/60">
          {q.data.items.map((i) => (
            <li key={`${i.kind}-${i.id}-${i.document}`} className="flex items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">
                {i.name} <span className="text-silver">· {i.document}</span>
              </span>
              <span className={cn('shrink-0 tabular-nums', i.daysUntilExpiry < 0 ? 'text-alert' : i.daysUntilExpiry <= 30 ? 'text-warning' : 'text-silver')}>
                {fmtDate(i.expiresAt)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-silver">Kept in Transportation — the fleet record and each driver’s record.</p>
      </CardContent>
    </Card>
  );
}
