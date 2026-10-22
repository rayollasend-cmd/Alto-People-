import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarSearch, ChevronDown, ChevronRight, PhoneCall, PhoneOff, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth, useTerm } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { fmtRelativeDayTz, fmtShiftRangeTz } from '@/lib/format';
import { withArticle } from '@/lib/validationCopy';
import { CALL_OUT_REASONS, listCallOuts, recordCallOutFor, type CallOutItem, type CallOutReason } from '@/lib/callOutsApi';
import { assignShift, getAutoFillBatch, listShifts } from '@/lib/schedulingApi';
import type { AutoFillResponse } from '@alto-people/shared';
import { ListTemplate } from '@/components/templates';
import { Avatar } from '@/components/ui/Avatar';
import { QueryError } from '@/components/ui/QueryError';
import { Textarea } from '@/components/ui/Input';
import {
  AssociatePicker,
  type PickedAssociate,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  MetricCard,
  SegmentedControl,
  Select,
  SkeletonRows,
} from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * Call-outs: who can't make it, why, and how cover is going. Cover starts
 * the moment someone calls out — by phone, text, WhatsApp or the app — so
 * this is the watch, not a to-do list: the one thing to act on is a shift
 * still looking for cover as it gets close.
 */

const REASON_LABEL: Record<CallOutReason, string> = {
  SICK: 'Sick',
  FAMILY: 'Family',
  TRANSPORT: 'Ride or transportation',
  EMERGENCY: 'Emergency',
  BEREAVEMENT: 'Bereavement',
  JURY_DUTY: 'Jury duty',
  OTHER: 'Other',
};

const CHANNEL_LABEL: Record<CallOutItem['channel'], string> = {
  APP: 'in the app',
  WHATSAPP: 'on WhatsApp',
  SMS: 'by text',
  VOICE: 'by phone',
  STAFF: 'recorded by a lead',
};

function notice(minutes: number): string {
  if (minutes < 60) return `${minutes} min notice`;
  const h = Math.round(minutes / 60);
  return h >= 48 ? `${Math.round(h / 24)} days’ notice` : `${h} h notice`;
}

function CoverBadge({ item }: { item: CallOutItem }) {
  if (item.cover.state === 'covered') return <Badge variant="success">{item.cover.by ? `Covered by ${item.cover.by}` : 'Covered'}</Badge>;
  if (item.cover.state === 'uncovered') return <Badge variant="destructive">Started uncovered</Badge>;
  return <Badge variant="pending">Looking for cover</Badge>;
}

/**
 * The one-click fill on a shift still looking for cover: the best-ranked
 * person from the shift's own store who is free all of it — posted
 * availability covers it, no clash, no time off, and it doesn't take them
 * past 40 scheduled hours — assigned in place. Anyone less certain is the
 * shift's own page, one click away. The assign only lands if the shift is
 * still unassigned: a lead (or the bench) who filled it a moment ago wins.
 */
type Candidates = AutoFillResponse['candidates'];

function CoverActions({ item, canManage, candidates, picksLoaded }: { item: CallOutItem; canManage: boolean; candidates: Candidates | undefined; picksLoaded: boolean }) {
  const qc = useQueryClient();
  const looking = item.cover.state !== 'covered';
  const top =
    (candidates ?? []).find(
      (c) => c.associateId !== item.associateId && c.noConflict && !c.onApprovedTimeOff && c.matchesAvailability && c.score >= 0.99,
    ) ?? null;
  const assign = useMutation({
    mutationFn: (pick: { associateId: string; associateName: string }) => assignShift(item.shift.id, { associateId: pick.associateId, expectUnassigned: true }),
    onSuccess: (_shift, pick) => {
      toast.success(`${pick.associateName} has the ${item.shift.position} shift. They were told.`);
      void qc.invalidateQueries({ queryKey: ['callouts'] });
      void qc.invalidateQueries({ queryKey: ['scheduling'] });
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : 'Could not assign — open the shift to pick someone.');
      if (e instanceof ApiError && e.status === 409) {
        void qc.invalidateQueries({ queryKey: ['callouts'] });
        void qc.invalidateQueries({ queryKey: ['scheduling', 'auto-fill-batch'] });
      }
    },
  });
  if (!canManage) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {looking && top && (
        <Button
          size="sm"
          onClick={() => assign.mutate(top)}
          loading={assign.isPending}
          title={`Free for all of it, no clash, ${Math.round(Math.max(top.weeklyMinutesScheduled, top.weeklyMinutesActual) / 60)} h already this week`}
        >
          <UserCheck className="h-4 w-4" aria-hidden="true" />
          Assign {top.associateName}
        </Button>
      )}
      {looking && picksLoaded && !top && <span className="text-xs text-ink-muted">Nobody at this store is free for all of it — open the shift to choose.</span>}
      <Button size="sm" variant="ghost" asChild>
        <Link to={`/scheduling?shift=${item.shift.id}`}>
          <CalendarSearch className="h-4 w-4" aria-hidden="true" />
          Open shift
        </Link>
      </Button>
    </div>
  );
}

function CallOutRow({ item, canManage, highlight, candidates, picksLoaded }: { item: CallOutItem; canManage: boolean; highlight: boolean; candidates?: Candidates; picksLoaded?: boolean }) {
  const [open, setOpen] = useState(false);
  const when = `${fmtRelativeDayTz(item.shift.startsAt, item.shift.timezone, Date.now())} · ${fmtShiftRangeTz(item.shift.startsAt, item.shift.endsAt, item.shift.timezone)}`;
  return (
    <li id={`callout-${item.id}`} className={cn('py-3 first:pt-0 last:pb-0 transition-colors', highlight && 'rounded-md bg-gold/10 ring-2 ring-gold/60')}>
      <div className="flex flex-wrap items-start gap-3">
        <Avatar src={item.photoUrl} name={item.name} size="sm" />
        {/* On a phone the details take the row and "Cover steps" wraps beneath them. */}
        <div className="min-w-0 flex-1 basis-[calc(100%-3.5rem)] sm:basis-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-ink">{item.name}</span>
            <span className="text-xs text-ink-muted">
              {REASON_LABEL[item.reason]} · {CHANNEL_LABEL[item.channel]}
            </span>
          </div>
          <div className="mt-0.5 text-sm text-ink-muted">
            {item.shift.position}
            {item.shift.place ? ` at ${item.shift.place}` : ''} · <span className="tabular-nums">{when}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <CoverBadge item={item} />
            {item.late ? <Badge variant="pending">Late call-out · {notice(item.minutesBeforeStart)}</Badge> : <span className="text-xs text-ink-muted">{notice(item.minutesBeforeStart)}</span>}
            {item.excused && <span className="text-xs text-ink-muted">{item.excusedWhy ?? 'Excused by policy'}</span>}
            {item.hasRecording && <span className="text-xs text-ink-muted">Left a voice message</span>}
          </div>
          {item.note && <p className="mt-1.5 text-sm text-ink">“{item.note}”</p>}
          <CoverActions item={item} canManage={canManage} candidates={candidates} picksLoaded={!!picksLoaded} />
        </div>
        {item.cover.steps.length > 0 && (
          <Button size="sm" variant="ghost" className="ml-11 sm:ml-0" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} how cover is going for ${item.name}`}>
            {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
            Cover steps
          </Button>
        )}
      </div>
      {open && (
        <ol className="ml-11 mt-2 space-y-1 border-l border-line pl-3 text-sm">
          {item.cover.steps.map((s) => (
            <li key={s.key} className="text-ink-muted">
              <span className="font-medium text-ink">{s.key === 'post' ? 'Posted' : s.key === 'bench' ? 'The bench' : 'The agent'}:</span> {s.detail}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function RecordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const term = useTerm();
  const qc = useQueryClient();
  const [person, setPerson] = useState<PickedAssociate | null>(null);
  const [shiftId, setShiftId] = useState('');
  const [reason, setReason] = useState<CallOutReason>('SICK');
  const [note, setNote] = useState('');
  const range = useMemo(() => {
    const from = new Date();
    const to = new Date(Date.now() + 3 * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, []);
  const shifts = useQuery({
    queryKey: ['callouts', 'shifts-for', person?.id, range.from, range.to],
    queryFn: () => listShifts({ status: 'ASSIGNED', from: range.from, to: range.to }),
    enabled: open && !!person,
  });
  const theirs = (shifts.data?.shifts ?? []).filter((s) => s.assignedAssociateId === person?.id && new Date(s.startsAt).getTime() > Date.now());
  const save = useMutation({
    mutationFn: () => recordCallOutFor({ associateId: person!.id, shiftId, reason, note: note.trim() || undefined }),
    onSuccess: () => {
      toast.success(`${person!.name} is called out. Cover has started.`);
      void qc.invalidateQueries({ queryKey: ['callouts'] });
      onOpenChange(false);
      setPerson(null);
      setShiftId('');
      setNote('');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the call-out.'),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a call-out</DialogTitle>
          <DialogDescription>For {withArticle(term('worker').toLowerCase())} who called you directly. Cover starts as soon as you save, and they get a confirmation.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label={`Which ${term('worker').toLowerCase()}`} required>
            {(p) => <AssociatePicker id={p.id} value={person} onChange={(v) => { setPerson(v); setShiftId(''); }} />}
          </Field>
          {person && (
            <Field label="Which shift" required hint={shifts.isLoading ? 'Looking up their next shifts…' : theirs.length === 0 ? 'No assigned shift for them in the next three days.' : undefined}>
              {(p) => (
                <Select {...p} value={shiftId} onChange={(e) => setShiftId(e.target.value)} disabled={theirs.length === 0}>
                  <option value="">Pick a shift</option>
                  {theirs.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.position} · {fmtRelativeDayTz(s.startsAt, s.timezone ?? null, Date.now())} {fmtShiftRangeTz(s.startsAt, s.endsAt, s.timezone ?? null)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Reason">
            {(p) => (
              <Select {...p} value={reason} onChange={(e) => setReason(e.target.value as CallOutReason)}>
                {CALL_OUT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REASON_LABEL[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Note (optional)">{(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!person || !shiftId} loading={save.isPending}>
            Record and start cover
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CallOutsDesk() {
  const { can } = useAuth();
  const canManage = can('manage:scheduling');
  const [range, setRange] = useState<'today' | 'week'>('today');
  const [recording, setRecording] = useState(false);
  const list = useQuery({ queryKey: ['callouts', range], queryFn: () => listCallOuts(range), refetchInterval: 60_000 });
  const d = list.data;

  // ?callout=<id> (a notification's link): ring that call-out and bring it
  // into view — widening to the week when it isn't today or tomorrow.
  const [params, setParams] = useSearchParams();
  const linked = params.get('callout');
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (!linked || !d) return;
    const found = d.items.some((i) => i.id === linked);
    if (!found && range === 'today') {
      setRange('week');
      return;
    }
    const next = new URLSearchParams(params);
    next.delete('callout');
    setParams(next, { replace: true });
    if (!found) {
      toast.error('That call-out isn’t in this week any more.');
      return;
    }
    setHighlight(linked);
    requestAnimationFrame(() => document.getElementById(`callout-${linked}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }));
    // params changes identity every render; consuming `linked` ends the cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, d, range]);
  useEffect(() => {
    if (!highlight) return;
    const t = window.setTimeout(() => setHighlight(null), 2500);
    return () => window.clearTimeout(t);
  }, [highlight]);
  const looking = (d?.items ?? []).filter((i) => i.cover.state !== 'covered');
  const covered = (d?.items ?? []).filter((i) => i.cover.state === 'covered');
  // One request ranks every shift still looking for cover (not one per row).
  const lookingShiftIds = useMemo(() => [...new Set(looking.map((i) => i.shift.id))].slice(0, 25).sort(), [looking]);
  const picks = useQuery({
    queryKey: ['scheduling', 'auto-fill-batch', lookingShiftIds],
    queryFn: () => getAutoFillBatch(lookingShiftIds),
    enabled: canManage && lookingShiftIds.length > 0,
    staleTime: 60_000,
    retry: false,
  });

  return (
    <ListTemplate
      title="Call-outs"
      subtitle="When someone can’t make their shift — by phone, text, WhatsApp or the app — cover starts on its own. Here’s how it’s going."
      breadcrumbs={[{ label: 'Time & scheduling' }, { label: 'Call-outs' }]}
      primaryAction={
        canManage ? (
          <Button onClick={() => setRecording(true)}>
            <PhoneCall className="h-4 w-4" aria-hidden="true" />
            Record a call-out
          </Button>
        ) : undefined
      }
      filters={
        <SegmentedControl
          ariaLabel="Which days"
          value={range}
          onChange={setRange}
          options={[
            { value: 'today', label: 'Today and tomorrow' },
            { value: 'week', label: 'This week' },
          ]}
        />
      }
    >
      {list.isError ? (
        <QueryError what="call-outs" query={list} />
      ) : list.isLoading || !d ? (
        <Card>
          <CardContent className="p-4">
            <SkeletonRows count={4} />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Called out" value={d.total} hint={range === 'today' ? 'Shifts today and tomorrow' : 'Shifts this week'} />
            <MetricCard label="Looking for cover" value={d.looking} hint={d.looking ? 'The bench and the agent are on it' : 'Nothing open'} />
            <MetricCard label="Covered" value={d.covered} hint={d.total ? `${Math.round((d.covered / d.total) * 100)}% of call-outs` : '—'} />
            <MetricCard label="Late call-outs" value={d.late} hint="Under 2 hours’ notice" />
          </div>
          {d.truncated && <p className="text-xs text-ink-muted">Showing the first 500 call-outs — narrow to today to see the rest.</p>}
          {d.total === 0 ? (
            <Card>
              <CardContent className="p-0">
                <EmptyState
                  icon={PhoneOff}
                  title={range === 'today' ? 'No call-outs today or tomorrow' : 'No call-outs this week'}
                  description={`When someone calls out, it lands here with the reason, and cover starts at once — the bench is asked, then the agent proposes a fill.`}
                />
              </CardContent>
            </Card>
          ) : (
            <>
              {looking.length > 0 && (
                <section aria-labelledby="co-looking">
                  <h2 id="co-looking" className="mb-2 text-sm font-medium text-ink">
                    Still looking for cover · {looking.length}
                  </h2>
                  <Card>
                    <CardContent className="p-4">
                      <ul className="divide-y divide-line">{looking.map((i) => <CallOutRow key={i.id} item={i} canManage={canManage} highlight={highlight === i.id} candidates={picks.data?.byShift[i.shift.id]} picksLoaded={picks.isSuccess} />)}</ul>
                    </CardContent>
                  </Card>
                </section>
              )}
              {covered.length > 0 && (
                <section aria-labelledby="co-covered">
                  <h2 id="co-covered" className={cn('mb-2 text-sm font-medium text-ink')}>
                    Covered · {covered.length}
                  </h2>
                  <Card>
                    <CardContent className="p-4">
                      <ul className="divide-y divide-line">{covered.map((i) => <CallOutRow key={i.id} item={i} canManage={canManage} highlight={highlight === i.id} />)}</ul>
                    </CardContent>
                  </Card>
                </section>
              )}
            </>
          )}
        </div>
      )}
      <RecordDialog open={recording} onOpenChange={setRecording} />
    </ListTemplate>
  );
}
