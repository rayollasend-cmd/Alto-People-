import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bus, CheckCircle2, LifeBuoy, MapPin, Phone, Siren, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { EmergencyBoardRow, EmergencyDeclareInput, EmergencySiteRef, EmergencySummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDateTime, localInputToUtcIso, utcToZonedDatetimeInput } from '@/lib/format';
import { declareEmergency, getEmergencyBoard, listEmergencies, listEmergencySites, standDownEmergency } from '@/lib/emergencyApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { ListTemplate } from '@/components/templates';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * EMERGENCY MODE — the switch and the board.
 *
 * Declare: scope, start time, the message (English, with optional Spanish
 * and Turkish renderings), and the evacuation pickup. Then the board:
 * who has checked in safe, who needs help, who asked for a van, who has
 * not answered after the escalation interval — by site, with the address
 * on file and a phone number. Stand down when it is over.
 */

const statusBadge = (r: EmergencyBoardRow) =>
  r.status === 'SAFE' ? (
    <Badge variant="success">Safe</Badge>
  ) : r.status === 'NEEDS_HELP' ? (
    <Badge variant="destructive">Needs help</Badge>
  ) : r.overdue ? (
    <Badge variant="pending">Overdue</Badge>
  ) : (
    <Badge variant="outline">No answer yet</Badge>
  );

const rideWord = (r: EmergencyBoardRow) =>
  !r.needsRide ? '' : !r.ride ? 'asked' : r.ride.status === 'REQUESTED' ? (r.ride.located ? 'waiting for a van' : 'address not on map') : r.ride.status.toLowerCase();

export function EmergencyHome() {
  // Vans exist only where the tenant runs transportation.
  const hasVans = useTenant().moduleOn('transportation');
  const { can } = useAuth();
  const canManage = can('manage:emergency');
  const [declaring, setDeclaring] = useState(false);

  const list = useQuery({ queryKey: ['emergency', 'list'], queryFn: listEmergencies, refetchInterval: 30_000 });
  const emergencies = list.data?.emergencies ?? [];
  const active = emergencies.find((e) => e.status === 'ACTIVE') ?? null;
  const past = emergencies.filter((e) => e.status !== 'ACTIVE');

  if (list.isError) return <QueryError what="emergencies" query={list} />;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Emergency mode"
        subtitle={`One switch for a storm: shifts suspended without penalty, everyone told in their language, a live check-in board${hasVans ? ', evacuation vans' : ''}.`}
        primaryAction={
          canManage && !active ? (
            <Button variant="destructive" onClick={() => setDeclaring(true)}>
              <Siren className="mr-2 h-4 w-4" aria-hidden="true" />
              Declare emergency
            </Button>
          ) : undefined
        }
    >

      {list.isLoading ? (
        <Skeleton className="h-40" />
      ) : active ? (
        <ActiveEmergency emergency={active} canManage={canManage} />
      ) : (
        <Card>
          <CardContent>
            <EmptyState
              icon={Siren}
              title="No emergency in effect"
              description="Declaring one suspends the shifts in scope, tells everyone affected in their language, and opens the check-in board here."
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>Every declaration, with who made it, the scope, and how many checked in.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {past.length === 0 ? (
            <EmptyState size="sm" title={"Nothing yet."} />
          ) : (
            <DataGrid<EmergencySummary>
              id="emergency-history"
              caption="Past emergencies"
              rows={past}
              rowKey={(e) => e.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'emergencies' }}
              columnChooser={false}
              columns={[
                { key: 'title', header: 'Emergency', accessor: (e) => e.title, sortable: true, primary: true },
                { key: 'scope', header: 'Scope', accessor: (e) => (e.allSites ? 'Every site' : e.sites.map((s) => s.name).join(', ')), sortable: true },
                { key: 'declared', header: 'Declared', accessor: (e) => e.declaredAt, sortable: true, searchable: false, cell: (e) => `${fmtDateTime(e.declaredAt)}${e.declaredBy ? ` · ${e.declaredBy}` : ''}` },
                { key: 'stood', header: 'Stood down', accessor: (e) => e.stoodDownAt ?? '', sortable: true, searchable: false, cell: (e) => (e.stoodDownAt ? `${fmtDateTime(e.stoodDownAt)}${e.stoodDownBy ? ` · ${e.stoodDownBy}` : ''}` : '—') },
                { key: 'shifts', header: 'Shifts', accessor: (e) => e.shiftsSuspended, sortable: true, searchable: false, align: 'right', cell: (e) => `${e.shiftsSuspended} suspended · ${e.shiftsRestored} restored` },
                { key: 'checkins', header: 'Checked in', accessor: (e) => e.checkIns.responded, sortable: true, searchable: false, align: 'right', cell: (e) => `${e.checkIns.responded} of ${e.checkIns.total}` },
              ]}
            />
          )}
        </CardContent>
      </Card>

      {declaring && <DeclareDialog onClose={() => setDeclaring(false)} />}
    </ListTemplate>
  );
}

function ActiveEmergency({ emergency, canManage }: { emergency: EmergencySummary; canManage: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const board = useQuery({
    queryKey: ['emergency', 'board', emergency.id],
    queryFn: () => getEmergencyBoard(emergency.id),
    refetchInterval: 15_000,
  });
  const standDown = useMutation({
    mutationFn: () => standDownEmergency(emergency.id),
    onSuccess: async () => {
      toast.success('Stood down. Shifts from the next one on are back on the schedule.');
      await qc.invalidateQueries({ queryKey: ['emergency'] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not stand down.'),
  });

  const rows = board.data?.rows ?? [];
  const counts = board.data?.emergency.checkIns ?? emergency.checkIns;
  const escalation = board.data?.escalation ?? [];
  const escalateAt = board.data?.escalateAt ? new Date(board.data.escalateAt) : null;
  const lapsed = escalateAt ? escalateAt.getTime() <= Date.now() : false;

  return (
    <div className="space-y-4">
      <Card className="border-alert/60">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Siren className="h-5 w-5 text-alert" aria-hidden="true" />
                {emergency.title}
                <Badge variant="destructive">In effect</Badge>
              </CardTitle>
              <CardDescription>
                Declared {fmtDateTime(emergency.declaredAt)}
                {emergency.declaredBy ? ` by ${emergency.declaredBy}` : ''} · Scope:{' '}
                {emergency.allSites ? 'every site' : emergency.sites.map((s) => s.name).join(', ')} · {emergency.shiftsSuspended} shifts
                suspended · {emergency.associatesNotified} associates told
                {emergency.pickupAt ? ` · vans around ${fmtDateTime(emergency.pickupAt)}${emergency.destination ? ` to ${emergency.destination.name}` : ''}` : ''}
                {emergency.texts && !emergency.texts.available && (
                  <span className="block text-warning">Texts are not connected — people were told in the app, by email and by push only.</span>
                )}
              </CardDescription>
            </div>
            {canManage && (
              <Button
                variant="outline"
                loading={standDown.isPending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Stand down "${emergency.title}"?`,
                      description: 'Shifts from the next one on go back on the schedule and everyone in scope is told, in their language. Shifts that already started stay suspended.',
                    })
                  ) {
                    standDown.mutate();
                  }
                }}
              >
                Stand down
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Checked in" value={`${counts.responded} / ${counts.total}`} hint="Responded of everyone in scope" />
            <MetricCard label="Safe" value={String(counts.safe)} hint="Tapped I'm safe" />
            <MetricCard label="Need help" value={String(counts.needsHelp)} hint="Tapped I need help" accent={counts.needsHelp > 0} />
            <MetricCard label="Van seats" value={String(counts.needsRide)} hint="Asked for evacuation transport" />
          </div>
        </CardContent>
      </Card>

      {board.isError ? (
        <QueryError what="the check-in board" query={board} />
      ) : (
        <>
          <Card className={escalation.length > 0 ? 'border-warning/60' : undefined}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
                Escalation
              </CardTitle>
              <CardDescription>
                Anyone who tapped "I need help", and anyone with no answer{' '}
                {escalateAt ? (lapsed ? `${emergency.escalationMinutes} minutes after the declaration (lapsed ${fmtDateTime(escalateAt)})` : `after ${fmtDateTime(escalateAt)}`) : ''}.
                Call them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {board.isLoading ? (
                <Skeleton className="h-24" />
              ) : escalation.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-silver">
                  <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                  {lapsed ? 'Everyone has answered and nobody needs help.' : 'Nobody needs help yet. The no-answer list fills once the interval lapses.'}
                </p>
              ) : (
                <ul className="divide-y divide-navy-secondary">
                  {escalation.map((r) => (
                    <li key={r.associateId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="flex items-center gap-2">
                        {r.status === 'NEEDS_HELP' ? <LifeBuoy className="h-4 w-4 text-alert" aria-hidden="true" /> : <Users className="h-4 w-4 text-warning" aria-hidden="true" />}
                        <span className="text-white">{r.name}</span>
                        <span className="text-silver">{r.siteName}</span>
                        {statusBadge(r)}
                        {r.note && <span className="text-silver">“{r.note}”</span>}
                      </span>
                      <span className="flex items-center gap-3 text-silver">
                        {r.address && (
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                            {r.address}
                          </span>
                        )}
                        {r.phone ? (
                          <a href={`tel:${r.phone}`} className="flex items-center gap-1 text-gold hover:underline">
                            <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                            {r.phone}
                          </a>
                        ) : (
                          <span>no phone on file</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Check-in board</CardTitle>
              <CardDescription>
                {(board.data?.bySite ?? []).map((s) => `${s.siteName}: ${s.responded}/${s.total} answered${s.needsHelp ? `, ${s.needsHelp} need help` : ''}`).join(' · ') ||
                  'Everyone in scope, by site, with the address on file.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {board.isLoading ? (
                <Skeleton className="h-64" />
              ) : rows.length === 0 ? (
                <EmptyState icon={Users} title="Nobody in scope" description="No associate has an open assignment or an upcoming shift at the sites declared." />
              ) : (
                <DataGrid<EmergencyBoardRow>
                  id="emergency-board"
                  caption="Emergency check-in board"
                  rows={rows}
                  rowKey={(r) => r.associateId}
                  urlState={false}
                  exportCsv={{ filename: `emergency-${emergency.title.replace(/\W+/g, '-').toLowerCase()}` }}
                  columnChooser={false}
                  columns={[
                    { key: 'name', header: 'Associate', accessor: (r) => r.name, sortable: true, primary: true },
                    { key: 'site', header: 'Site', accessor: (r) => r.siteName, sortable: true, cardMeta: true },
                    { key: 'status', header: 'Status', accessor: (r) => r.status ?? (r.overdue ? 'OVERDUE' : 'NONE'), sortable: true, searchable: false, cardMeta: true, cell: statusBadge },
                    { key: 'responded', header: 'Answered', accessor: (r) => r.respondedAt ?? '', sortable: true, searchable: false, className: 'text-silver', cell: (r) => (r.respondedAt ? fmtDateTime(r.respondedAt) : '—') },
                    {
                      key: 'ride',
                      header: 'Van',
                      accessor: (r) => rideWord(r),
                      sortable: true,
                      searchable: false,
                      cell: (r) =>
                        r.needsRide ? (
                          <span className="flex items-center gap-1">
                            <Bus className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
                            {rideWord(r)}
                          </span>
                        ) : (
                          <span className="text-silver">—</span>
                        ),
                    },
                    { key: 'address', header: 'Address on file', accessor: (r) => r.address ?? '', sortable: false, className: 'text-silver', cell: (r) => r.address ?? <span className="text-alert">none</span> },
                    { key: 'phone', header: 'Phone', accessor: (r) => r.phone ?? '', sortable: false, cell: (r) => (r.phone ? <a href={`tel:${r.phone}`} className="text-gold hover:underline">{r.phone}</a> : '—') },
                    { key: 'note', header: 'Note', accessor: (r) => r.note ?? '', sortable: false, className: 'text-silver' },
                  ]}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function DeclareDialog({ onClose }: { onClose: () => void }) {
  // Vans exist only where the tenant runs transportation.
  const hasVans = useTenant().moduleOn('transportation');
  const qc = useQueryClient();
  const sites = useQuery({ queryKey: ['emergency', 'sites'], queryFn: listEmergencySites });
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [messageEs, setMessageEs] = useState('');
  const [messageTr, setMessageTr] = useState('');
  const [allSites, setAllSites] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [startsAt, setStartsAt] = useState(() => utcToZonedDatetimeInput(new Date()));
  const [withVans, setWithVans] = useState(false);
  const [pickupAt, setPickupAt] = useState(() => utcToZonedDatetimeInput(new Date(Date.now() + 2 * 3_600_000)));
  const [destinationId, setDestinationId] = useState('');
  const [escalation, setEscalation] = useState('60');

  const byClient = useMemo(() => {
    const m = new Map<string, EmergencySiteRef[]>();
    for (const s of sites.data?.sites ?? []) {
      const list = m.get(s.clientName) ?? [];
      list.push(s);
      m.set(s.clientName, list);
    }
    return [...m.entries()];
  }, [sites.data]);

  const declare = useMutation({
    mutationFn: (body: EmergencyDeclareInput) => declareEmergency(body),
    onSuccess: async (e) => {
      // Texts are said as they happened: none claimed when no provider is connected.
      const texts = e.texts
        ? !e.texts.available
          ? ' No texts went out — texting isn’t connected.'
          : ` ${e.texts.sent ?? 0} texted${e.texts.notSent ? `, ${e.texts.notSent} not` : ''}.`
        : '';
      toast.success(`Declared. ${e.shiftsSuspended} shifts suspended, ${e.associatesNotified} associates told.${texts}`);
      await qc.invalidateQueries({ queryKey: ['emergency'] });
      onClose();
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not declare.'),
  });

  const valid = title.trim().length >= 2 && message.trim().length >= 2 && (allSites || picked.size > 0) && startsAt.length > 0;
  const dirty = title.length > 0 || message.length > 0;

  return (
    <Dialog open onOpenChange={(o) => !o && !declare.isPending && onClose()} confirmDiscard={() => dirty}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Declare an emergency</DialogTitle>
          <DialogDescription>
            Shifts in scope that end after the start time are suspended with no attendance penalty. Everyone in scope gets the message
            in their language by bell, email, push, and text, and is asked to tap "I'm safe". Supervisors and store managers are told too.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="What is happening" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Hurricane Delta — stay home" autoFocus maxLength={120} />
          </Field>
          <Field label="Message to associates (English)" required hint="Sent as written. Say what to do and when you will update them.">
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} maxLength={2000} />
          </Field>
          <details className="rounded-md border border-navy-secondary px-3 py-2">
            <summary className="cursor-pointer text-sm text-silver">Spanish and Turkish renderings (optional — English is sent when empty)</summary>
            <div className="mt-2 space-y-2">
              <Field label="Español">
                <Textarea value={messageEs} onChange={(e) => setMessageEs(e.target.value)} rows={3} maxLength={2000} />
              </Field>
              <Field label="Türkçe">
                <Textarea value={messageTr} onChange={(e) => setMessageTr(e.target.value)} rows={3} maxLength={2000} />
              </Field>
            </div>
          </details>

          <Field label="Scope" required>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="scope" checked={allSites} onChange={() => setAllSites(true)} /> Every site
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="scope" checked={!allSites} onChange={() => setAllSites(false)} /> Selected sites
              </label>
              {!allSites && (
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-navy-secondary p-2">
                  {sites.isLoading ? (
                    <Skeleton className="h-12" />
                  ) : (
                    byClient.map(([clientName, list]) => (
                      <div key={clientName}>
                        <div className="text-xs font-medium uppercase tracking-wide text-silver">{clientName}</div>
                        {list.map((s) => (
                          <label key={s.id} className="flex items-center gap-2 py-0.5 text-sm">
                            <input
                              type="checkbox"
                              checked={picked.has(s.id)}
                              onChange={(e) => {
                                const next = new Set(picked);
                                if (e.target.checked) next.add(s.id);
                                else next.delete(s.id);
                                setPicked(next);
                              }}
                            />
                            {s.name}
                          </label>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </Field>

          <Field label="Shifts suspended from" required hint="Shifts that end after this are suspended; ones already over are left alone.">
            <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="text-base" />
          </Field>
          <Field label="Escalate after (minutes)" hint="Anyone with no answer after this long goes on the call list.">
            <Input type="number" min={5} max={1440} value={escalation} onChange={(e) => setEscalation(e.target.value)} />
          </Field>

          {hasVans && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withVans} onChange={(e) => setWithVans(e.target.checked)} /> Offer evacuation vans
          </label>
          )}
          {hasVans && withVans && (
            <div className="space-y-2 rounded-md border border-navy-secondary p-3">
              <Field label="Vans leave around" hint="Riders who ask for a seat are booked for this time from their address on file; dispatch plans the runs on the Transportation page.">
                <Input type="datetime-local" value={pickupAt} onChange={(e) => setPickupAt(e.target.value)} className="text-base" />
              </Field>
              <Field label="Take them to" hint="Leave as 'their own store' unless there is one shelter.">
                <Select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                  <option value="">Their own store</option>
                  {(sites.data?.sites ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.clientName} — {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={declare.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={declare.isPending}
            disabled={!valid}
            onClick={() =>
              declare.mutate({
                title: title.trim(),
                message: message.trim(),
                messageEs: messageEs.trim() || undefined,
                messageTr: messageTr.trim() || undefined,
                allSites,
                locationIds: allSites ? [] : [...picked],
                startsAt: localInputToUtcIso(startsAt),
                pickupAt: withVans ? localInputToUtcIso(pickupAt) : null,
                destinationLocationId: withVans && destinationId ? destinationId : null,
                escalationMinutes: Math.min(1440, Math.max(5, Number(escalation) || 60)),
              })
            }
          >
            Declare
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
