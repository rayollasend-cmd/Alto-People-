import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  CalendarCheck,
  ClipboardList,
  Store,
  Trophy,
  Waypoints,
} from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ClockStrip } from '@/components/ClockStrip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input, Textarea } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * THE RELAY — the one shared operating picture. Identical in every
 * building: the First-Paycheck Promise lanes (every new hire's run
 * through the three departments to a perfect first check), the batons
 * (every cross-department queue with its holder, age, and status), and
 * the Monday pack that writes itself.
 *
 * Console voice (matches AdminDashboard / ExecutiveDashboard): English,
 * uppercase micro-labels, one gold hero.
 */

type Desk = 'HR' | 'FINANCE' | 'WORKFORCE';
type StageKey =
  | 'approved'
  | 'scheduled'
  | 'fieldglass'
  | 'firstShift'
  | 'hoursApproved'
  | 'paycheck';

interface LaneStage {
  key: StageKey;
  desk: Desk;
  done: boolean;
  at: string | null;
  dueAt: string | null;
  overdue: boolean;
}

interface Lane {
  associateId: string;
  name: string;
  clientName: string | null;
  approvedAt: string;
  stages: LaneStage[];
  currentStage: StageKey | null;
  stalled: boolean;
  completed: boolean;
  cohortId: string | null;
}

interface CohortSummary {
  id: string;
  name: string;
  clientName: string | null;
  targetHeadcount: number;
  landByDate: string;
  daysLeft: number;
  members: number;
  completed: number;
  inFlight: number;
  stalled: number;
}

interface ClientRequestRow {
  id: string;
  clientId: string;
  clientName: string;
  kind: 'STAFFING' | 'FEEDBACK' | 'ISSUE';
  desk: Desk;
  subject: string;
  body: string;
  status: 'RECEIVED' | 'IN_PROGRESS';
  createdAt: string;
}

interface Baton {
  key: string;
  label: string;
  desk: Desk;
  count: number;
  oldestAt: string | null;
  dueOn: string | null;
  status: 'quiet' | 'atRisk' | 'overdue';
  link: string;
}

interface AgendaItem {
  severity: 'red' | 'amber' | 'info';
  desk: Desk | null;
  text: string;
  link: string;
}

interface RelayBoardData {
  generatedAt: string;
  promise: {
    keptPct: number | null;
    completed: number;
    medianDays: number | null;
    windowDays: number;
  };
  lanes: Lane[];
  cohorts: CohortSummary[];
  recentKept: Array<{ associateId: string; name: string; days: number; kept: boolean }>;
  batons: Baton[];
  agenda: AgendaItem[];
}

const STAGE_LABELS: Record<StageKey, string> = {
  approved: 'Approved',
  scheduled: 'Scheduled',
  fieldglass: 'Fieldglass',
  firstShift: 'First shift',
  hoursApproved: 'Hours approved',
  paycheck: 'First paycheck',
};

const DESK_LABELS: Record<Desk, string> = {
  HR: 'HR',
  FINANCE: 'Finance',
  WORKFORCE: 'Workforce',
};

const DESK_CHIP: Record<Desk, string> = {
  HR: 'bg-steel/20 text-silver',
  FINANCE: 'bg-gold/15 text-gold',
  WORKFORCE: 'bg-success/15 text-success',
};

const REQ_KIND_LABEL: Record<ClientRequestRow['kind'], string> = {
  STAFFING: 'Staffing',
  FEEDBACK: 'Feedback',
  ISSUE: 'Issue',
};

/** The staff side of the client loop: the queue of asks the customer is
 *  literally watching in their portal. Resolve = the reply they read. */
function ClientRequestsSection({
  rows,
  canWork,
  onChanged,
}: {
  rows: ClientRequestRow[];
  canWork: boolean;
  onChanged: () => void;
}) {
  const [resolving, setResolving] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const patch = async (id: string, body: { status: string; resolution?: string }) => {
    setBusy(true);
    try {
      await apiFetch(`/client-requests/${id}`, { method: 'PATCH', body });
      setResolving(null);
      setReply('');
      onChanged();
      if (body.status === 'RESOLVED') toast.success('Resolved — the client sees your reply.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="client-requests">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
          <Store className="h-4 w-4 text-gold" aria-hidden="true" />
          Client requests
        </h2>
        <span className="text-2xs text-silver/60">
          the customer is watching this move in their portal
        </span>
      </div>
      {rows.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-sm text-success">
            No open client requests. Silence means green.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-navy-secondary/60">
              {rows.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-white">{r.clientName}</span>
                    <Badge variant={r.kind === 'ISSUE' ? 'destructive' : 'outline'}>
                      {REQ_KIND_LABEL[r.kind]}
                    </Badge>
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider',
                        DESK_CHIP[r.desk],
                      )}
                    >
                      {DESK_LABELS[r.desk]}
                    </span>
                    {r.status === 'IN_PROGRESS' && (
                      <Badge variant="accent">In progress</Badge>
                    )}
                    <span className="ml-auto text-2xs tabular-nums text-silver/50">
                      {fmtDate(r.createdAt)}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-white">{r.subject}</div>
                  <p className="mt-0.5 text-xs text-silver/70">{r.body}</p>
                  {canWork && (
                    <div className="mt-2">
                      {resolving === r.id ? (
                        <div className="space-y-2">
                          <Textarea
                            value={reply}
                            onChange={(e) => setReply(e.target.value)}
                            placeholder="The reply the client will read in their portal…"
                            rows={2}
                            maxLength={2000}
                          />
                          <div className="flex gap-2">
                            <Button
                              size="xs"
                              loading={busy}
                              disabled={!reply.trim()}
                              onClick={() =>
                                void patch(r.id, {
                                  status: 'RESOLVED',
                                  resolution: reply.trim(),
                                })
                              }
                            >
                              Send &amp; resolve
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setResolving(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          {r.status === 'RECEIVED' && (
                            <Button
                              size="xs"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void patch(r.id, { status: 'IN_PROGRESS' })}
                            >
                              Start
                            </Button>
                          )}
                          <Button
                            size="xs"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => {
                              setResolving(r.id);
                              setReply('');
                            }}
                          >
                            Resolve
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** "New wave" — name, headcount, landing date. */
function NewCohortButton({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [landBy, setLandBy] = useState('');
  const [busy, setBusy] = useState(false);
  const valid =
    name.trim().length >= 3 &&
    Number(target) >= 1 &&
    /^\d{4}-\d{2}-\d{2}$/.test(landBy);

  const create = async () => {
    setBusy(true);
    try {
      await apiFetch('/cohorts', {
        method: 'POST',
        body: {
          name: name.trim(),
          targetHeadcount: Number(target),
          landByDate: landBy,
        },
      });
      setOpen(false);
      setName('');
      setTarget('');
      setLandBy('');
      onCreated();
      toast.success('Wave created — assign lanes to it below.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the wave.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        New wave
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New wave</DialogTitle>
            <DialogDescription>
              A hiring push with a headcount and a landing date — its lanes group
              under one banner with a readiness bar.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Name — e.g. "Peak season — Walmart DC"'
              maxLength={120}
            />
            <Input
              type="number"
              min={1}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Target headcount"
            />
            <Input
              type="date"
              value={landBy}
              onChange={(e) => setLandBy(e.target.value)}
              aria-label="Land by date"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void create()} loading={busy} disabled={!valid}>
              Create wave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RelayBoard() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['relay', 'board'],
    queryFn: () => apiFetch<RelayBoardData>('/relay/board'),
    refetchInterval: 120_000,
  });
  const requestsQuery = useQuery({
    queryKey: ['relay', 'client-requests'],
    queryFn: () => apiFetch<{ requests: ClientRequestRow[] }>('/client-requests'),
    refetchInterval: 120_000,
  });
  const data = query.data;
  const canWorkRequests = can('manage:scheduling');
  const canManageCohorts = can('manage:recruiting');
  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['relay'] });
  };

  if (query.isError) {
    return (
      <div className="space-y-4">
        <PageHeader title="The relay" subtitle="The one board the company runs on." />
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
          Could not load the relay board.
        </ErrorBanner>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-28" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <PageHeader
          title="The relay"
          subtitle="Every handoff between HR, Workforce, and Finance — one shared picture, with names on it."
        />
        <ClockStrip className="mt-1" />
      </div>

      {/* ---- The promise hero ------------------------------------------ */}
      <Card className="relative overflow-hidden border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent animate-enter">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]"
        />
        <CardContent className="relative p-5">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
            <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
            The first-paycheck promise
          </span>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <div>
              <span className="font-display text-5xl leading-none text-gold-bright tabular-nums">
                {data.promise.keptPct !== null ? `${data.promise.keptPct}%` : '—'}
              </span>
              <span className="ml-2 text-sm text-silver">kept</span>
            </div>
            <div className="text-sm text-silver tabular-nums">
              {data.promise.completed} first paycheck
              {data.promise.completed === 1 ? '' : 's'} delivered
              {data.promise.medianDays !== null && (
                <> · median {data.promise.medianDays} days approval-to-pay</>
              )}
              <span className="text-silver/50"> · last {data.promise.windowDays} days</span>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-silver/60">
            A promise is kept when the first check lands within 21 days of the first
            shift worked — never late, never short.
          </p>
        </CardContent>
      </Card>

      {/* ---- The Monday pack ------------------------------------------- */}
      <Card className="animate-enter" style={enterStagger(1)}>
        <CardContent className="p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <ClipboardList className="h-4 w-4 text-gold" aria-hidden="true" />
              The Monday pack
            </h2>
            <span className="text-2xs text-silver/60">
              writes itself — ranked by what's bleeding
            </span>
          </div>
          {data.agenda.length === 0 ? (
            <p className="mt-3 text-sm text-success">
              Nothing on the agenda. Silence means green.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data.agenda.map((a, i) => (
                <li key={`${a.text}-${i}`} className="flex items-start gap-2.5 text-sm">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                      a.severity === 'red'
                        ? 'bg-alert'
                        : a.severity === 'amber'
                          ? 'bg-warning'
                          : 'bg-success/70',
                    )}
                  />
                  <span className="min-w-0 flex-1 text-silver">
                    {a.desk && (
                      <span
                        className={cn(
                          'mr-1.5 rounded-full px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider',
                          DESK_CHIP[a.desk],
                        )}
                      >
                        {DESK_LABELS[a.desk]}
                      </span>
                    )}
                    {a.text}{' '}
                    {a.link !== '/relay' && (
                      <Link
                        to={a.link}
                        className="whitespace-nowrap text-gold underline underline-offset-2 hover:text-gold-bright"
                      >
                        open
                        <ArrowRight
                          className="ml-0.5 inline h-3 w-3"
                          aria-hidden="true"
                        />
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ---- Client requests: the customer is waiting ------------------- */}
      <ClientRequestsSection
        rows={requestsQuery.data?.requests ?? []}
        canWork={canWorkRequests}
        onChanged={refreshAll}
      />

      {/* ---- Cohorts: waves against the clock --------------------------- */}
      {(data.cohorts.length > 0 || canManageCohorts) && (
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-white">Waves</h2>
            {canManageCohorts && <NewCohortButton onCreated={refreshAll} />}
          </div>
          {data.cohorts.length === 0 ? (
            <p className="text-xs text-silver/50">
              No waves defined. A cohort groups a hiring push — "40 heads by Nov 1"
              — so three buildings staff it against the same clock.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {data.cohorts.map((c) => {
                const pct = Math.min(
                  100,
                  Math.round((c.completed / Math.max(1, c.targetHeadcount)) * 100),
                );
                const hot = c.stalled > 0 || (c.daysLeft <= 7 && c.completed < c.targetHeadcount);
                return (
                  <Card
                    key={c.id}
                    className={cn('border-l-2', hot ? 'border-l-alert' : 'border-l-gold/40')}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-white">
                          {c.name}
                          {c.clientName && (
                            <span className="font-normal text-silver/60"> · {c.clientName}</span>
                          )}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 text-xs tabular-nums',
                            c.daysLeft <= 7 ? 'text-alert' : 'text-silver/60',
                          )}
                        >
                          {c.daysLeft >= 0
                            ? `${c.daysLeft}d to landing`
                            : `${-c.daysLeft}d past landing`}
                        </span>
                      </div>
                      <div className="mt-2 flex items-baseline gap-2 text-sm tabular-nums">
                        <span className="font-display text-2xl leading-none text-gold-bright">
                          {c.completed}
                        </span>
                        <span className="text-silver/60">/ {c.targetHeadcount} ready</span>
                        <span className="text-silver/40">
                          · {c.inFlight} in flight
                          {c.stalled > 0 && (
                            <span className="text-alert"> · {c.stalled} stalled</span>
                          )}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-navy-secondary/50">
                        <div
                          className={cn('h-full rounded-full', hot ? 'bg-alert/80' : 'bg-gold/70')}
                          style={{ width: `${Math.max(3, pct)}%` }}
                        />
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ---- The lanes -------------------------------------------------- */}
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
            <Waypoints className="h-4 w-4 text-gold" aria-hidden="true" />
            Lanes in flight
          </h2>
          <span
            className={cn(
              'text-xs tabular-nums',
              data.lanes.some((l) => l.stalled) ? 'text-alert' : 'text-success',
            )}
          >
            {data.lanes.filter((l) => l.stalled).length > 0
              ? `${data.lanes.filter((l) => l.stalled).length} stalled`
              : data.lanes.length > 0
                ? 'all flowing'
                : 'no lanes open'}
          </span>
        </div>
        {data.lanes.length === 0 ? (
          <Card>
            <CardContent className="p-5 text-sm text-silver">
              No first-paycheck lanes in flight — every recent hire has been paid.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {data.lanes.map((lane, i) => {
              const current = lane.stages.find((s) => s.key === lane.currentStage);
              return (
                <Card
                  key={lane.associateId}
                  className={cn(
                    'animate-enter border-l-2',
                    lane.stalled ? 'border-l-alert' : 'border-l-gold/40',
                  )}
                  style={enterStagger(i, 30, 8)}
                >
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <Avatar
                          src={`/api/associates/${lane.associateId}/photo`}
                          name={lane.name}
                          email=""
                          size="sm"
                        />
                        <div className="min-w-0">
                          <Link
                            to={`/people?associateId=${lane.associateId}&return=${encodeURIComponent('/relay')}`}
                            className="block truncate text-sm font-medium text-white hover:text-gold-bright"
                          >
                            {lane.name}
                          </Link>
                          <div className="truncate text-xs text-silver/60">
                            {lane.clientName ?? '—'} · approved {fmtDate(lane.approvedAt)}
                          </div>
                        </div>
                      </div>
                      {current && (
                        <div className="shrink-0 text-right text-xs">
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 font-medium uppercase tracking-wider text-2xs',
                              DESK_CHIP[current.desk],
                            )}
                          >
                            {DESK_LABELS[current.desk]}
                          </span>
                          <div
                            className={cn(
                              'mt-1 tabular-nums',
                              lane.stalled ? 'font-medium text-alert' : 'text-silver/60',
                            )}
                          >
                            {STAGE_LABELS[current.key]}
                            {current.dueAt &&
                              (lane.stalled
                                ? ` · due ${fmtDate(current.dueAt)}`
                                : ` · by ${fmtDate(current.dueAt)}`)}
                          </div>
                        </div>
                      )}
                    </div>
                    {/* The six segments — done gold, current pulsing, rest dim. */}
                    <div className="mt-3 flex gap-1" aria-hidden="true">
                      {lane.stages.map((s) => (
                        <div
                          key={s.key}
                          title={`${STAGE_LABELS[s.key]} — ${DESK_LABELS[s.desk]}`}
                          className={cn(
                            'h-1.5 flex-1 rounded-full',
                            s.done
                              ? 'bg-gold/80'
                              : s.key === lane.currentStage
                                ? s.overdue
                                  ? 'bg-alert animate-pulse motion-reduce:animate-none'
                                  : 'bg-warning/70 animate-pulse motion-reduce:animate-none'
                                : 'bg-navy-secondary',
                          )}
                        />
                      ))}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-2xs text-silver/40">
                      <span>Approved</span>
                      {canManageCohorts && data.cohorts.length > 0 ? (
                        <Select
                          size="sm"
                          aria-label={`Wave for ${lane.name}`}
                          className="w-auto"
                          value={lane.cohortId ?? ''}
                          onChange={(e) => {
                            void apiFetch('/cohorts/assign', {
                              method: 'POST',
                              body: {
                                associateId: lane.associateId,
                                cohortId: e.target.value || null,
                              },
                            })
                              .then(() => refreshAll())
                              .catch(() => toast.error('Could not move the lane.'));
                          }}
                        >
                          <option value="">No wave</option>
                          {data.cohorts.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        lane.cohortId && (
                          <span className="text-gold/70">
                            {data.cohorts.find((c) => c.id === lane.cohortId)?.name ?? ''}
                          </span>
                        )
                      )}
                      <span>First paycheck</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
        {data.recentKept.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-silver/60">
            <CalendarCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />
            Recently kept:
            {data.recentKept.map((k) => (
              <span key={k.associateId} className="tabular-nums">
                {k.name} ({k.days}d{k.kept ? '' : ' · late'})
              </span>
            ))}
          </p>
        )}
      </div>

      {/* ---- The batons -------------------------------------------------- */}
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium text-white">Batons</h2>
          <span className="text-2xs text-silver/60">
            quiet until at risk · loud when late
          </span>
        </div>
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-navy-secondary/60">
              {data.batons.map((b) => (
                <li key={b.key} id={b.key}>
                  <Link
                    to={b.link}
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-navy-secondary/30"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        b.status === 'overdue'
                          ? 'bg-alert'
                          : b.status === 'atRisk'
                            ? 'bg-warning'
                            : 'bg-success/70',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-white">
                      {b.label}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider',
                        DESK_CHIP[b.desk],
                      )}
                    >
                      {DESK_LABELS[b.desk]}
                    </span>
                    <span
                      className={cn(
                        'w-8 text-right text-sm font-semibold tabular-nums',
                        b.count === 0
                          ? 'text-success'
                          : b.status === 'overdue'
                            ? 'text-alert'
                            : b.status === 'atRisk'
                              ? 'text-warning'
                              : 'text-white',
                      )}
                    >
                      {b.count}
                    </span>
                    <span className="hidden w-40 text-right text-xs tabular-nums text-silver/50 sm:block">
                      {b.count === 0
                        ? 'clear'
                        : b.dueOn
                          ? `due ${fmtDate(`${b.dueOn}T12:00:00Z`)}`
                          : b.oldestAt
                            ? `oldest ${fmtDate(b.oldestAt)}`
                            : ''}
                    </span>
                    <ArrowRight
                      className="h-3.5 w-3.5 shrink-0 text-silver/40"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
