import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bus,
  ChevronLeft,
  ChevronRight,
  Download,
  Check,
  Home,
  MapPin,
  MessageSquare,
  Phone,
  Plus,
  Send,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { downloadCsv } from '@/lib/csv';
import { STUCK_RUN_MINUTES, fmtDateTime, fmtMinutes, fmtMoney, fmtRelativeDayTz, fmtTimeTz, localInputToUtcIso, utcToZonedDatetimeInput, ymdLocal } from '@/lib/format';
import { workweekStart } from '@/lib/workweek';
import {
  cancelRide,
  cancelRun,
  closeRunFromDispatch,
  createRun,
  createStop,
  createVan,
  getFleet,
  getLiveBoard,
  getTransportBoard,
  getTransportCharges,
  getTransportSettings,
  listStops,
  listTransportIssues,
  reofferRide,
  saveTransportSettings,
  searchRides,
  updateRun,
  updateStop,
  updateTransportIssue,
  updateVan,
  waiveRide,
  type Ride,
  type RideDirection,
  type RideRun,
  type RideStatus,
  type RunMap,
  type TransportBoard,
  type TransportIssue,
  type TransportStop,
  type Van,
} from '@/lib/transportApi';
import { onLiveEvent } from '@/lib/liveEvents';
import { messageRun, planDay, routeRides } from '@/lib/transportDispatchApi';
import { rideAlert, useNewKeys } from '@/lib/rideAlerts';
import { SoundToggle } from '@/components/transport/SoundToggle';
import { LazyLiveMap, type MapMarker } from '@/components/transport/LazyLiveMap';
import { PageHeader } from '@/components/ui/PageHeader';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';

/**
 * The Transportation Director's command center.
 *
 *   Today     the day's numbers; the bookings waiting on a van, grouped by
 *             way / store / time, picked and dispatched onto a run (van,
 *             driver, departure, pickups in order); the runs themselves —
 *             edit or call off a run that hasn't left, cancel a ride
 *   Rides     every booking, searchable — cancel, waive a charge
 *   Issues    what riders and drivers reported — work it, resolve it
 *   Vans / Stops   the fleet and the housing complexes / pickup stops
 *   Charges   who owes what for a date range, what payroll already took
 *   Settings  the fare, the no-show fee, the booking cutoff
 *
 * view:transport reads everything here; manage:transport acts.
 */

const TABS = ['today', 'live', 'rides', 'issues', 'vans', 'stops', 'charges', 'settings'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  today: 'Today',
  live: 'Live map',
  rides: 'Rides',
  issues: 'Issues',
  vans: 'Fleet',
  stops: 'Stops',
  charges: 'Charges',
  settings: 'Fares',
};

const STATUS_LABEL: Record<RideStatus, string> = {
  REQUESTED: 'Needs a van',
  SCHEDULED: 'On a van',
  BOARDED: 'On board',
  COMPLETED: 'Done',
  NO_SHOW: 'No-show',
  CANCELLED: 'Cancelled',
};

const ISSUE_LABEL: Record<string, string> = {
  LATE_VAN: 'Late van',
  MISSED_PICKUP: 'Missed pickup',
  CHARGE_DISPUTE: 'Charge dispute',
  SAFETY: 'Safety',
  VEHICLE: 'Vehicle',
  CONDUCT: 'Conduct',
  OTHER: 'Other',
};

const cents = (n: number) => fmtMoney(n / 100);
const errMsg = (err: unknown) => (err instanceof ApiError ? err.message : String(err));

function statusVariant(s: RideStatus): 'accent' | 'success' | 'pending' | 'destructive' | 'default' {
  return s === 'REQUESTED'
    ? 'pending'
    : s === 'SCHEDULED'
      ? 'accent'
      : s === 'BOARDED' || s === 'COMPLETED'
        ? 'success'
        : s === 'NO_SHOW'
          ? 'destructive'
          : 'default';
}

function homeEnd(r: Ride): string {
  return r.pickup.kind === 'stop' ? r.pickup.name : r.pickup.address;
}

function shiftDay(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/**
 * The pick box — how a run gets built, in all three places it happens: the
 * riders on Today's board, the proposals in Plan runs, a week's worth in
 * Rides. A 16px native checkbox is a mouse target, and this page is run off
 * an iPad, where iPad width lands on the desktop breakpoints but the finger
 * doesn't shrink to match. A native checkbox ignores padding, so on a coarse
 * pointer the box itself grows to 24px and a wrapping label carries the rest
 * of the reach out to ~44px; the desktop keeps the 16px box and the tight
 * rows a dispatcher reads twenty at a time.
 */
function PickBox({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="inline-flex shrink-0 items-center justify-center coarse:p-2.5">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-gold coarse:h-6 coarse:w-6"
      />
    </label>
  );
}

export function TransportHome() {
  const { can } = useAuth();
  const manage = can('manage:transport');
  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'today';
  const setTab = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === 'today') next.delete('tab');
    else next.set('tab', v);
    setParams(next, { replace: true });
  };
  const [date, setDate] = useState(() => ymdLocal());
  const board = useQuery({
    queryKey: ['transport', 'board', date],
    queryFn: () => getTransportBoard(date),
    refetchInterval: 30_000,
  });
  const openIssues = board.data?.kpis.openIssues ?? 0;

  return (
    <div>
      <PageHeader
        title="Transportation"
        topbarTitle="Transportation"
        subtitle="The Alto vans — bookings, dispatch, drivers, and everything that comes up."
        secondaryActions={<SoundToggle onLabel="Sounds on — tap to mute" offLabel="Sounds off — tap to turn on" />}
        primaryAction={
          tab === 'today' ? (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label="Previous day" onClick={() => setDate(shiftDay(date, -1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Input
                type="date"
                aria-label="Day"
                value={date}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                className="w-40"
              />
              <Button variant="ghost" size="icon-sm" aria-label="Next day" onClick={() => setDate(shiftDay(date, 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              {date !== ymdLocal() && (
                <Button variant="secondary" size="sm" onClick={() => setDate(ymdLocal())}>
                  Today
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          {TABS.map((k) => (
            <TabsTrigger key={k} value={k}>
              {TAB_LABEL[k]}
              {k === 'issues' && openIssues > 0 && (
                <span className="ml-1.5 rounded-full bg-warning/20 px-1.5 text-xs font-semibold text-warning">{openIssues}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="today">
          {board.isLoading ? (
            <Skeleton className="h-64" />
          ) : board.isError ? (
            <QueryError what="today's board" query={board} />
          ) : board.data ? (
            <TodayBoard board={board.data} manage={manage} />
          ) : null}
        </TabsContent>
        <TabsContent value="live">
          <LiveTab />
        </TabsContent>
        <TabsContent value="rides">
          <RidesTab manage={manage} />
        </TabsContent>
        <TabsContent value="issues">
          <IssuesTab manage={manage} />
        </TabsContent>
        <TabsContent value="vans">
          <FleetTab manage={manage} drivers={board.data?.drivers ?? []} />
        </TabsContent>
        <TabsContent value="stops">
          <StopsTab manage={manage} />
        </TabsContent>
        <TabsContent value="charges">
          <ChargesTab />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab manage={manage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ===== Today ================================================================ */

function useRideActions() {
  const prompt = usePrompt();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['transport'] });
  return {
    cancel: async (r: Ride) => {
      const reason = await prompt({
        title: `Cancel ${r.rider.name}'s ride?`,
        description: 'They hear it right away, with your reason. No charge.',
        reasonLabel: 'Reason',
        reasonPlaceholder: 'No van available at that hour',
        confirmLabel: 'Cancel ride',
        destructive: true,
      });
      if (!reason) return;
      try {
        await cancelRide(r.id, reason);
        toast.success('Ride cancelled — the rider was told');
        await refresh();
      } catch (err) {
        toast.error(errMsg(err));
      }
    },
    waive: async (r: Ride) => {
      const reason = await prompt({
        title: `Waive ${cents(r.owedCents)} for ${r.rider.name}?`,
        description: 'It won’t come out of their pay. They hear about it.',
        reasonLabel: 'Reason',
        reasonPlaceholder: 'The van was late',
        confirmLabel: 'Waive',
      });
      if (!reason) return;
      try {
        await waiveRide(r.id, reason);
        toast.success('Charge waived');
        await refresh();
      } catch (err) {
        toast.error(errMsg(err));
      }
    },
  };
}

interface RideGroup {
  key: string;
  direction: RideDirection;
  storeName: string;
  tz: string;
  at: string;
  rides: Ride[];
}

function groupWaiting(rides: Ride[]): RideGroup[] {
  const groups = new Map<string, RideGroup>();
  for (const r of rides) {
    // Half-hour buckets: a 7:00 and a 7:15 arrival land in one group.
    const bucket = Math.floor(new Date(r.targetAt).getTime() / 1_800_000);
    const key = `${r.direction}|${r.store.id}|${bucket}`;
    const g = groups.get(key) ?? {
      key,
      direction: r.direction,
      storeName: r.store.name,
      tz: r.store.timezone,
      at: r.targetAt,
      rides: [],
    };
    g.rides.push(r);
    if (r.targetAt < g.at) g.at = r.targetAt;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/* ----- Needs attention: what to act on, first ------------------------------ */

interface Attention {
  key: string;
  tone: 'alert' | 'warning' | 'info';
  title: string;
  body?: string;
  actions: Array<{ label: string; onClick?: () => void; href?: string }>;
}

function NeedsAttention({ items }: { items: Attention[] }) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/[0.06] px-4 py-3 text-sm text-success">
        <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
        All clear — every booking has a van and every van on the road is on time.
      </div>
    );
  }
  return (
    <section aria-label="Needs attention" className="rounded-lg border border-warning/40 bg-warning/[0.05]">
      <h2 className="flex items-center gap-1.5 px-4 pt-3 text-xs font-semibold uppercase tracking-wider text-warning">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        Needs attention <span className="text-white">{items.length}</span>
      </h2>
      <ul className="divide-y divide-navy-secondary/60 px-4">
        {items.map((a) => (
          <li key={a.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                a.tone === 'alert' ? 'bg-alert' : a.tone === 'warning' ? 'bg-warning' : 'bg-gold',
              )}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-white">{a.title}</div>
              {a.body && <div className="text-xs text-silver">{a.body}</div>}
            </div>
            {/* The first action here writes something — close a run, message
                a van's riders, re-offer a seat — and the one beside it just
                navigates. Same-size neighbours on touch, so they get the
                wider gap there. */}
            <div className="flex flex-wrap gap-2 coarse:gap-3">
              {a.actions.map((x, i) =>
                x.href ? (
                  <Button key={x.label} size="xs" variant={i === 0 ? 'primary' : 'secondary'} asChild>
                    <a href={x.href}>{x.label}</a>
                  </Button>
                ) : (
                  <Button key={x.label} size="xs" variant={i === 0 ? 'primary' : 'secondary'} onClick={x.onClick}>
                    {x.label}
                  </Button>
                ),
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function KpiStrip({ k }: { k: TransportBoard['kpis'] }) {
  const tiles: Array<{ label: string; value: string | number; warn?: boolean }> = [
    { label: 'Booked', value: k.booked },
    { label: 'Needs a van', value: k.needsVan, warn: k.needsVan > 0 },
    { label: 'Vans out', value: `${k.vansOut}/${k.runs}` },
    { label: 'On board', value: k.onBoard },
    { label: 'Done', value: k.completed },
    { label: 'No-shows', value: k.noShows, warn: k.noShows > 0 },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
      {tiles.map((x) => (
        <div key={x.label} className="rounded-lg border border-navy-secondary bg-navy px-3 py-2.5">
          <div className="text-2xs font-medium uppercase tracking-wider text-silver">{x.label}</div>
          <div className={cn('mt-0.5 text-xl font-bold tabular-nums', x.warn ? 'text-warning' : 'text-white')}>{x.value}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Closing an abandoned run is a write with money implications for people
 * who aren't in the room, so it names them before it acts: riders already
 * marked on board complete and keep their fare, anyone never marked is
 * cancelled and charged nothing.
 */
function useCloseRun() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  return async (runId: string, vanName: string) => {
    const ok = await confirm({
      title: `Close out ${vanName}?`,
      description:
        'The driver never completed this run, so it still counts as on the road. ' +
        'Riders marked on board will be completed as normal. Anyone the driver never ' +
        'marked will be cancelled and charged nothing — hours later there is no honest ' +
        'way to say whether they rode, and guessing either way costs them money.',
      confirmLabel: 'Close the run',
    });
    if (!ok) return;
    try {
      const { unmarkedCancelled } = await closeRunFromDispatch(runId);
      toast.success(
        unmarkedCancelled > 0
          ? `${vanName} closed — ${unmarkedCancelled} rider${unmarkedCancelled === 1 ? '' : 's'} were never marked and were not charged.`
          : `${vanName} closed.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['transport'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not close the run.');
    }
  };
}

function useMessageRun() {
  const prompt = usePrompt();
  return async (run: { id: string; van: { name: string } }, suggestion?: string) => {
    const body = await prompt({
      title: `Message everyone on ${run.van.name}`,
      description: 'The riders and the driver get it right away.',
      reasonLabel: 'Message',
      reasonPlaceholder: suggestion ?? 'Running about 10 minutes late — sorry, we’re on our way.',
      confirmLabel: 'Send',
    });
    if (!body) return;
    try {
      const { sent } = await messageRun(run.id, body);
      toast.success(`Sent to ${sent} ${sent === 1 ? 'person' : 'people'}`);
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
}

function TodayBoard({ board, manage }: { board: TransportBoard; manage: boolean }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dispatch, setDispatch] = useState<{ rides: Ride[] } | { run: RideRun } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [, setParams] = useSearchParams();
  const actions = useRideActions();
  const prompt = usePrompt();
  const message = useMessageRun();
  const closeRun = useCloseRun();
  const queryClient = useQueryClient();
  const live = useQuery({ queryKey: ['transport', 'live'], queryFn: () => getLiveBoard(), refetchInterval: 15_000 });
  useEffect(
    () => onLiveEvent('transport', () => void queryClient.invalidateQueries({ queryKey: ['transport'] })),
    [queryClient],
  );
  const liveById = new Map((live.data?.runs ?? []).map((r) => [r.runId, r]));
  const waiting = board.rides.filter((r) => r.status === 'REQUESTED');
  const groups = groupWaiting(waiting);
  const pickedRides = waiting.filter((r) => picked.has(r.id));
  const mixed = new Set(pickedRides.map((r) => r.direction)).size > 1;
  const now = Date.now();

  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const callOff = async (run: RideRun) => {
    const reason = await prompt({
      title: `Call off ${run.van.name} at ${fmtTimeTz(run.departAt, run.rides[0]?.store.timezone)}?`,
      description: 'Its riders go back to “needs a van” — their bookings stay — and they and the driver are told.',
      reasonLabel: 'Reason',
      reasonPlaceholder: 'Van in the shop',
      confirmLabel: 'Call off run',
      destructive: true,
    });
    if (!reason) return;
    try {
      await cancelRun(run.id, reason);
      toast.success('Run called off');
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  // On the road first, then by departure.
  const liveRuns = board.runs
    .filter((r) => r.status !== 'CANCELLED')
    .sort((a, b) => (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1) || a.departAt.localeCompare(b.departAt));
  const driverPhone = (userId: string) => board.drivers.find((d) => d.userId === userId)?.phone ?? null;

  // What to act on, most urgent first.
  const attention: Attention[] = [];
  for (const r of live.data?.runs ?? []) {
    if (r.status !== 'ACTIVE') continue;
    const late = Math.max(0, ...r.late.map((l) => l.minutes));
    // Past STUCK_RUN_MINUTES this isn't a delay, it's a run nobody closed
    // — runs only end when a driver taps Complete, so a forgotten one sits
    // ACTIVE for ever and reports itself as "late" in ever-growing
    // numbers, burying the runs that are genuinely a few minutes behind.
    // Different problem, different words, different action: you don't
    // apologise to riders who went home hours ago, you close the run.
    if (late >= STUCK_RUN_MINUTES) {
      attention.push({
        key: `stuck-${r.runId}`,
        tone: 'warning',
        title: `${r.van.name} has been out for ${fmtMinutes(late)} — still open`,
        body: `${r.driver.name} · the run was never completed, so it still counts as on the road`,
        actions: [
          ...(manage ? [{ label: 'Close this run', onClick: () => void closeRun(r.runId, r.van.name) }] : []),
          { label: 'Live map', onClick: () => setParams({ tab: 'live' }) },
        ],
      });
    } else if (late >= 5) {
      attention.push({
        key: `late-${r.runId}`,
        tone: 'alert',
        title: `${r.van.name} is running about ${fmtMinutes(late)} late`,
        body: r.late.map((l) => `${l.store} · ${fmtMinutes(l.minutes)}`).join(' · '),
        actions: [
          ...(manage ? [{ label: 'Message riders', onClick: () => void message({ id: r.runId, van: r.van }, `Running about ${fmtMinutes(late)} late — sorry, we’re on our way.`) }] : []),
          { label: 'Live map', onClick: () => setParams({ tab: 'live' }) },
        ],
      });
    }
    if (r.stale) {
      const phone = driverPhone(r.driver.userId);
      attention.push({
        key: `stale-${r.runId}`,
        tone: 'warning',
        title: `${r.van.name} — no signal ${r.position ? `since ${ago(r.position.at, now)}` : 'from the driver’s phone yet'}`,
        body: `${r.driver.name} · riders can’t see the van`,
        actions: [...(phone ? [{ label: `Call ${r.driver.name.split(' ')[0]}`, href: `tel:${phone}` }] : []), { label: 'Live map', onClick: () => setParams({ tab: 'live' }) }],
      });
    }
  }
  // A shift whose vans are full, with riders in line: add a van and they ride.
  const lines = new Map<string, typeof waiting>();
  for (const r of waiting.filter((x) => x.waitlist && x.windowLabel)) {
    const k = `${r.store.id}|${r.direction}|${r.windowLabel}|${r.targetAt}`;
    lines.set(k, [...(lines.get(k) ?? []), r]);
  }
  for (const [k, riders] of lines) {
    const r = riders[0]!;
    attention.push({
      key: `line-${k}`,
      tone: 'warning',
      title: `${r.windowLabel} ${r.direction === 'TO_WORK' ? 'to' : 'home from'} ${r.store.name} is full — ${riders.length} on the waitlist`,
      body: `${fmtTimeTz(r.targetAt, r.store.timezone)} · every van on it is full · add a van and they ride`,
      actions: manage ? [{ label: 'Add a van', onClick: () => setDispatch({ rides: riders }) }] : [],
    });
  }
  for (const r of waiting.filter((x) => x.allDeclined)) {
    attention.push({
      key: `declined-${r.id}`,
      tone: 'alert',
      title: `No driver took ${r.rider.name.split(' ')[0]}'s seat`,
      body: `${r.direction === 'TO_WORK' ? 'To' : 'Home from'} ${r.store.name} · ${fmtTimeTz(r.targetAt, r.store.timezone)} · every driver declined`,
      actions: manage
        ? [
            { label: 'Dispatch', onClick: () => setDispatch({ rides: [r] }) },
            {
              label: 'Offer again',
              onClick: () =>
                void reofferRide(r.id)
                  .then(() => {
                    toast.success('Back in front of every driver');
                    return queryClient.invalidateQueries({ queryKey: ['transport'] });
                  })
                  .catch((err) => toast.error(errMsg(err))),
            },
          ]
        : [],
    });
  }
  if (waiting.length > 0) {
    const first = [...waiting].sort((a, b) => a.targetAt.localeCompare(b.targetAt))[0]!;
    const soon = Date.parse(first.targetAt) - now < 18 * 3_600_000;
    attention.push({
      key: 'waiting',
      tone: soon ? 'warning' : 'info',
      title: `${waiting.length} seat ${waiting.length === 1 ? 'request is' : 'requests are'} waiting for a driver`,
      body: `First: ${first.rider.name} · ${first.direction === 'TO_WORK' ? 'arrive by' : 'leaving'} ${fmtTimeTz(first.targetAt, first.store.timezone)} · ${first.store.name}`,
      actions: manage ? [{ label: 'Plan runs', onClick: () => setPlanning(true) }] : [],
    });
  }
  if (board.kpis.openIssues > 0) {
    attention.push({
      key: 'issues',
      tone: 'info',
      title: `${board.kpis.openIssues} open ${board.kpis.openIssues === 1 ? 'issue' : 'issues'}`,
      actions: [{ label: 'Open issues', onClick: () => setParams({ tab: 'issues' }) }],
    });
  }

  // Something new needs the desk: buzz, chime.
  useNewKeys(
    live.data ? attention.filter((a) => a.tone !== 'info').map((a) => a.key) : null,
    () => rideAlert('attention'),
  );

  return (
    <div className="space-y-5">
      <NeedsAttention items={attention} />
      <KpiStrip k={board.kpis} />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {/* Waiting on a van */}
        <section aria-label="Needs a van">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">
              Needs a van <span className="text-white">{waiting.length}</span>
            </h2>
            {manage && (
              <div className="flex items-center gap-2">
                {pickedRides.length > 0 ? (
                  <>
                    {mixed && <span className="text-xs text-warning">One way per run</span>}
                    <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                      Clear
                    </Button>
                    <Button size="sm" disabled={mixed} onClick={() => setDispatch({ rides: pickedRides })}>
                      <Send className="h-3.5 w-3.5" />
                      Dispatch {pickedRides.length}
                    </Button>
                  </>
                ) : (
                  waiting.length > 0 && (
                    <Button size="sm" onClick={() => setPlanning(true)}>
                      <Wand2 className="h-3.5 w-3.5" />
                      Plan runs
                    </Button>
                  )
                )}
              </div>
            )}
          </div>
          {groups.length === 0 ? (
            <EmptyState icon={Bus} title="Everyone has a van" description="New bookings for this day land here." />
          ) : (
            <div className="space-y-3">
              {groups.map((g) => {
                const all = g.rides.every((r) => picked.has(r.id));
                return (
                  <Card key={g.key}>
                    <CardContent className="pt-4">
                      <div className="flex items-center gap-2">
                        {manage && (
                          <PickBox
                            label={`Pick all ${g.rides.length}`}
                            checked={all}
                            onChange={(on) => toggle(g.rides.map((r) => r.id), on)}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-white">
                            {g.direction === 'TO_WORK' ? 'To' : 'Home from'} {g.storeName} ·{' '}
                            <span className="tabular-nums">
                              {g.direction === 'TO_WORK' ? 'arrive by' : 'leaving'} {fmtTimeTz(g.at, g.tz)}
                            </span>
                          </div>
                          <div className="text-xs text-silver">
                            {g.rides.length} {g.rides.length === 1 ? 'rider' : 'riders'}
                          </div>
                        </div>
                        {manage && (
                          <Button size="xs" onClick={() => setDispatch({ rides: g.rides })} aria-label={`Dispatch ${g.storeName} ${fmtTimeTz(g.at, g.tz)}`}>
                            <Send className="h-3.5 w-3.5" />
                            Dispatch
                          </Button>
                        )}
                      </div>
                      <ul className="mt-2 divide-y divide-navy-secondary/60">
                        {g.rides.map((r) => (
                          <li key={r.id} className="flex items-center gap-3 py-2">
                            {manage && (
                              <PickBox label={`Pick ${r.rider.name}`} checked={picked.has(r.id)} onChange={(on) => toggle([r.id], on)} />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 text-sm text-white">
                                {r.rider.name}
                                {r.windowLabel && <span className="text-xs text-silver">{r.windowLabel} shift</span>}
                                {r.waitlist && (
                                  <Badge size="sm" variant="pending">
                                    Waitlist #{r.waitlist.position}
                                  </Badge>
                                )}
                                {r.declines > 0 && (
                                  <Badge size="sm" variant={r.allDeclined ? 'destructive' : 'pending'}>
                                    {r.allDeclined ? 'Every driver declined' : `Declined by ${r.declines}`}
                                  </Badge>
                                )}
                              </div>
                              <div className="flex items-center gap-1 truncate text-xs text-silver">
                                <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                                <span className="truncate">{homeEnd(r)}</span>
                                <span className="shrink-0 tabular-nums"> · {fmtTimeTz(r.targetAt, r.store.timezone)}</span>
                              </div>
                              {r.note && <div className="text-xs text-gold">{r.note}</div>}
                            </div>
                            {manage && (
                              <Button size="icon-sm" variant="ghost" aria-label={`Cancel ${r.rider.name}'s ride`} onClick={() => void actions.cancel(r)}>
                                <X className="h-4 w-4" />
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        {/* The runs */}
        <section aria-label="Runs">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">
            Runs <span className="text-white">{liveRuns.length}</span>
          </h2>
          {liveRuns.length === 0 ? (
            <EmptyState icon={Bus} title="No runs yet" description="Plan runs, or pick bookings on the left and dispatch them onto a van." />
          ) : (
            <div className="space-y-3">
              {liveRuns.map((run) => (
                <RunPanel
                  key={run.id}
                  run={run}
                  live={liveById.get(run.id) ?? null}
                  driverPhone={driverPhone(run.driver.userId)}
                  manage={manage}
                  onEdit={() => setDispatch({ run })}
                  onCallOff={() => void callOff(run)}
                  onMessage={() => void message(run)}
                  onCancelRide={(r) => void actions.cancel(r)}
                  onWaive={(r) => void actions.waive(r)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {dispatch && (
        <DispatchDialog
          board={board}
          initial={dispatch}
          onClose={(done) => {
            setDispatch(null);
            if (done) setPicked(new Set());
          }}
        />
      )}
      {planning && <PlanDialog board={board} onClose={() => setPlanning(false)} />}
    </div>
  );
}

function RunPanel({
  run,
  live,
  driverPhone,
  manage,
  onEdit,
  onCallOff,
  onMessage,
  onCancelRide,
  onWaive,
}: {
  run: RideRun;
  live: RunMap | null;
  driverPhone: string | null;
  manage: boolean;
  onEdit: () => void;
  onCallOff: () => void;
  onMessage: () => void;
  onCancelRide: (r: Ride) => void;
  onWaive: (r: Ride) => void;
}) {
  const tz = run.rides[0]?.store.timezone;
  const riders = run.rides.filter((r) => r.status !== 'CANCELLED');
  const full = run.seats.taken >= run.seats.capacity;
  const active = run.status === 'ACTIVE';
  const late = live ? Math.max(0, ...live.late.map((l) => l.minutes)) : 0;
  const next = live?.waypoints.find((w) => w.etaAt);
  const riderLive = new Map((live?.riders ?? []).map((x) => [x.rideId, x]));
  const now = Date.now();
  return (
    <Card className={cn(active && (late >= 5 ? 'border-alert/50' : 'border-success/40'))}>
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Bus className={cn('h-4 w-4', active ? 'text-success' : 'text-gold')} aria-hidden="true" />
          <span className="font-semibold text-white">{run.van.name}</span>
          <span className="text-sm text-silver">· {run.driver.name}</span>
          <span className="text-sm tabular-nums text-silver">· leaves {fmtTimeTz(run.departAt, tz)}</span>
          <span className="ml-auto flex items-center gap-2">
            <span className={cn('text-xs tabular-nums', full ? 'text-warning' : 'text-silver')}>
              {run.seats.taken}/{run.seats.capacity} seats
            </span>
            {active && late >= 5 ? (
              <Badge variant="destructive">~{fmtMinutes(late)} late</Badge>
            ) : (
              <Badge variant={active ? 'success' : run.status === 'COMPLETED' ? 'default' : 'accent'}>
                {run.status === 'PLANNED' ? 'Planned' : active ? 'On the road' : run.status === 'COMPLETED' ? 'Finished' : 'Called off'}
              </Badge>
            )}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-silver">
          {run.direction === 'TO_WORK' ? 'To work' : 'Home from work'}
          {run.notes ? ` · ${run.notes}` : ''}
        </div>
        {active && live && (
          <div className={cn('mt-2 rounded-md px-2.5 py-1.5 text-xs', live.stale ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success')}>
            {next ? (
              <>
                Next: <span className="font-medium">{next.label}</span>
                {next.etaAt && ` · about ${Math.max(1, Math.round((Date.parse(next.etaAt) - now) / 60_000))} min`}
              </>
            ) : (
              'All stops done'
            )}
            {' · '}
            {live.position ? (live.stale ? `no signal since ${ago(live.position.at, now)}` : `updated ${ago(live.position.at, now)}`) : 'waiting for the driver’s phone'}
          </div>
        )}
        <ol className="mt-2 divide-y divide-navy-secondary/60">
          {riders.map((r, i) => {
            const eta = riderLive.get(r.id)?.pickupEtaAt;
            return (
              <li key={r.id} className="flex items-center gap-3 py-2">
                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-silver">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-white">
                    {r.rider.name}
                    {r.riderSignal && (
                      <Badge size="sm" variant={r.riderSignal.kind === 'OUTSIDE' ? 'success' : 'pending'}>
                        {r.riderSignal.kind === 'OUTSIDE' ? 'Outside' : 'Running late'}
                      </Badge>
                    )}
                    {r.vanArrivedAt && r.status === 'SCHEDULED' && (
                      <Badge size="sm" variant="info">
                        Van here {fmtTimeTz(r.vanArrivedAt, r.store.timezone)}
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-xs text-silver">
                    {r.pickupAt ? fmtTimeTz(r.pickupAt, r.store.timezone) : '—'}
                    {active && eta && r.status === 'SCHEDULED' && !r.vanArrivedAt && ` (ETA ${fmtTimeTz(eta, r.store.timezone)})`} ·{' '}
                    {run.direction === 'TO_WORK' ? homeEnd(r) : `${r.store.name} → ${homeEnd(r)}`}
                  </div>
                </div>
                <Badge size="sm" variant={statusVariant(r.status)}>
                  {STATUS_LABEL[r.status]}
                </Badge>
                {manage && r.owedCents > 0 && !r.charged && (
                  <Button size="xs" variant="ghost" onClick={() => onWaive(r)}>
                    Waive {cents(r.owedCents)}
                  </Button>
                )}
                {manage && r.status === 'SCHEDULED' && run.status === 'PLANNED' && (
                  <Button size="icon-sm" variant="ghost" aria-label={`Cancel ${r.rider.name}'s ride`} onClick={() => onCancelRide(r)}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
        {manage && (run.status === 'PLANNED' || active) && (
          <div className="mt-2 flex flex-wrap gap-2 coarse:gap-3">
            <Button size="sm" variant="secondary" onClick={onMessage}>
              <MessageSquare className="h-3.5 w-3.5" />
              Message riders
            </Button>
            {driverPhone && (
              <Button size="sm" variant="secondary" asChild>
                <a href={`tel:${driverPhone}`}>
                  <Phone className="h-3.5 w-3.5" />
                  Call {run.driver.name.split(' ')[0]}
                </a>
              </Button>
            )}
            {run.status === 'PLANNED' && (
              <>
                <Button size="sm" variant="secondary" onClick={onEdit}>
                  Edit run
                </Button>
                {/* Calling off a run puts every rider back on "needs a van"
                    and tells them so. On touch it is a 44px slab 12px from
                    "Edit run" — the extra margin gives the one irreversible
                    button on this card its own moat. */}
                <Button size="sm" variant="ghost" className="coarse:ml-2" onClick={onCallOff}>
                  Call off
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ----- Plan runs: the whole day's waiting bookings, in one go ---------------- */

function PlanDialog({ board, onClose }: { board: TransportBoard; onClose: () => void }) {
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: ['transport', 'plan', board.date], queryFn: () => planDay(board.date), staleTime: 0 });
  const [edits, setEdits] = useState<Record<string, { vanId?: string; driverUserId?: string; skip?: boolean }>>({});
  const [busy, setBusy] = useState(false);
  const proposals = (plan.data?.proposals ?? []).map((p) => ({ ...p, ...edits[p.key] }));
  const ready = proposals.filter((p) => !p.skip && p.vanId && p.driverUserId);

  const dispatchAll = async () => {
    setBusy(true);
    let made = 0;
    try {
      for (const p of ready) {
        await createRun({
          vanId: p.vanId!,
          driverUserId: p.driverUserId!,
          direction: p.direction,
          serviceDate: p.serviceDate,
          departAt: p.departAt,
          rides: p.rides.map((r) => ({ rideId: r.rideId, pickupAt: r.pickupAt })),
        });
        made += 1;
      }
      toast.success(`${made} ${made === 1 ? 'run' : 'runs'} dispatched — every rider has their van and pickup time`);
      onClose();
    } catch (err) {
      toast.error(`${made} dispatched, then: ${errMsg(err)}`);
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* No max-h here on purpose: DialogContent already caps itself at the
          viewport minus the notch and home-indicator insets and scrolls
          inside. A plain `max-h-[90dvh]` merges over that cap and pushes the
          sheet's grab handle up under the status bar on a notched phone. */}
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Plan runs</DialogTitle>
          <DialogDescription>
            Every booking still waiting on a van, grouped by way, store and time, filled into free vans and drivers,
            pickups in the shortest order with times worked back from the arrive-by. Change anything, then dispatch.
          </DialogDescription>
        </DialogHeader>
        {plan.isLoading ? (
          <Skeleton className="h-48" />
        ) : plan.isError ? (
          <QueryError what="the plan for this day" query={plan} />
        ) : proposals.length === 0 ? (
          <p className="text-sm text-silver">Nothing to plan — every booking this day has a van.</p>
        ) : (
          <div className="space-y-3">
            {proposals.map((p) => {
              const tz = p.store.timezone;
              const van = board.vans.find((v) => v.id === p.vanId);
              return (
                <div key={p.key} className={cn('rounded-lg border p-3', p.skip ? 'border-navy-secondary opacity-60' : 'border-gold/40')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <PickBox
                      label={`Include ${p.store.name} ${fmtTimeTz(p.departAt, tz)}`}
                      checked={!p.skip}
                      onChange={(on) => setEdits((x) => ({ ...x, [p.key]: { ...x[p.key], skip: !on } }))}
                    />
                    <span className="text-sm font-semibold text-white">
                      {p.direction === 'TO_WORK' ? 'To' : 'Home from'} {p.store.name}
                    </span>
                    <span className="text-xs tabular-nums text-silver">
                      · leaves {fmtTimeTz(p.departAt, tz)}
                      {p.arriveAt && ` · there ${fmtTimeTz(p.arriveAt, tz)}`} · {p.rides.length}/{van?.capacity ?? '—'} seats
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Select
                      size="sm"
                      aria-label="Van"
                      value={p.vanId ?? ''}
                      onChange={(e) => setEdits((x) => ({ ...x, [p.key]: { ...x[p.key], vanId: e.target.value } }))}
                    >
                      <option value="">Pick a van</option>
                      {board.vans.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} · {v.capacity} seats
                        </option>
                      ))}
                    </Select>
                    <Select
                      size="sm"
                      aria-label="Driver"
                      value={p.driverUserId ?? ''}
                      onChange={(e) => setEdits((x) => ({ ...x, [p.key]: { ...x[p.key], driverUserId: e.target.value } }))}
                    >
                      <option value="">Pick a driver</option>
                      {board.drivers.map((d) => (
                        <option key={d.userId} value={d.userId}>
                          {d.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <ol className="mt-2 space-y-1 text-xs">
                    {p.rides.map((r, i) => (
                      <li key={r.rideId} className="flex items-center gap-2">
                        <span className="w-4 text-right tabular-nums text-silver">{i + 1}</span>
                        <span className="tabular-nums text-white">{fmtTimeTz(r.pickupAt, tz)}</span>
                        <span className="min-w-0 flex-1 truncate text-silver">
                          {r.name} · {r.place}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {p.warnings.length > 0 && <p className="mt-2 text-xs text-warning">{p.warnings.join(' ')}</p>}
                </div>
              );
            })}
            {(plan.data?.unplaced.length ?? 0) > 0 && (
              <p className="text-xs text-warning">
                Not planned: {plan.data!.unplaced.map((u) => `${u.name} (${u.reason})`).join(', ')}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void dispatchAll()} loading={busy} disabled={busy || ready.length === 0}>
            <Send className="h-4 w-4" />
            Dispatch {ready.length} {ready.length === 1 ? 'run' : 'runs'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- Dispatch: a van, a driver, a departure, pickups in order ----------- */

const STOP_GAP_MIN = 10;

function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h! * 60 + m! + mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function wall(iso: string, tz: string): string {
  return utcToZonedDatetimeInput(iso, tz).slice(11, 16);
}

/** Pickup times from a departure: to work, one stop every 10 minutes after
 *  leaving; home from work, everyone at the store at departure. */
function planPickups(direction: RideDirection, depart: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => (direction === 'TO_WORK' ? addMinutes(depart, STOP_GAP_MIN * (i + 1)) : depart));
}

function DispatchDialog({
  board,
  initial,
  onClose,
}: {
  board: TransportBoard;
  initial: { rides: Ride[] } | { run: RideRun };
  onClose: (done: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const editing = 'run' in initial ? initial.run : null;
  const startRides = editing ? editing.rides.filter((r) => r.status === 'SCHEDULED') : (initial as { rides: Ride[] }).rides;
  const direction: RideDirection = editing ? editing.direction : startRides[0]!.direction;
  const tz = startRides[0]?.store.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const serviceDate = editing ? editing.serviceDate : startRides[0]!.serviceDate;

  const sortedStart = [...startRides].sort((a, b) =>
    editing ? (a.pickupOrder ?? 0) - (b.pickupOrder ?? 0) : a.targetAt.localeCompare(b.targetAt),
  );
  const defaultDepart = editing
    ? wall(editing.departAt, tz)
    : direction === 'TO_WORK'
      ? addMinutes(wall(sortedStart[0]!.targetAt, tz), -(STOP_GAP_MIN * sortedStart.length + 20))
      : wall(sortedStart[sortedStart.length - 1]!.targetAt, tz);

  const firstVan = editing?.van.id ?? board.vans.find((v) => v.capacity >= startRides.length)?.id ?? board.vans[0]?.id ?? '';
  const [vanId, setVanIdState] = useState(firstVan);
  // Each van's own driver by default.
  const [driverUserId, setDriverUserId] = useState(
    editing?.driver.userId ??
      board.vans.find((v) => v.id === firstVan)?.driverUserId ??
      // Someone whose trade is driving — which includes the shift
      // supervisor who also drives, not just accounts filed as DRIVER.
      board.drivers.find((d) => d.drivesByTrade)?.userId ??
      '',
  );
  const setVanId = (id: string) => {
    setVanIdState(id);
    const own = board.vans.find((v) => v.id === id)?.driverUserId;
    if (own) setDriverUserId(own);
  };
  const [depart, setDepart] = useState(defaultDepart);
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [order, setOrder] = useState<Array<{ ride: Ride; pickup: string }>>(() => {
    const times = planPickups(direction, defaultDepart, sortedStart.length);
    return sortedStart.map((ride, i) => ({ ride, pickup: editing && ride.pickupAt ? wall(ride.pickupAt, tz) : times[i]! }));
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const van = board.vans.find((v) => v.id === vanId);
  const over = !!van && order.length > van.capacity;
  const addable = board.rides.filter(
    (r) => r.status === 'REQUESTED' && r.direction === direction && r.serviceDate === serviceDate && !order.some((o) => o.ride.id === r.id),
  );

  const move = (i: number, d: -1 | 1) =>
    setOrder((prev) => {
      const next = [...prev];
      const j = i + d;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const retime = () => {
    const times = planPickups(direction, depart, order.length);
    setOrder((prev) => prev.map((o, i) => ({ ...o, pickup: times[i]! })));
  };

  // The shortest pickup order, times worked back from the arrive-by — done
  // for you when a new dispatch opens.
  const [routing, setRouting] = useState(false);
  const bestOrder = async () => {
    setRouting(true);
    try {
      const r = await routeRides(order.map((o) => o.ride.id));
      setDepart(wall(r.departAt, tz));
      setOrder((prev) =>
        r.rides
          .map((x) => {
            const o = prev.find((p) => p.ride.id === x.rideId);
            return o ? { ride: o.ride, pickup: wall(x.pickupAt, tz) } : null;
          })
          .filter((x): x is { ride: Ride; pickup: string } => !!x),
      );
    } catch (err) {
      if (!quietRoute.current) toast.error(errMsg(err));
    } finally {
      setRouting(false);
      quietRoute.current = false;
    }
  };
  const quietRoute = useRef(true);
  useEffect(() => {
    if (!editing && startRides.length > 0) void bestOrder();
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toIso = (hhmm: string) => {
    // A pickup "before" the departure on the clock is past midnight.
    const day = hhmm < depart && direction === 'TO_WORK' ? shiftDay(serviceDate, 1) : serviceDate;
    return localInputToUtcIso(`${day}T${hhmm}`, tz);
  };

  const submit = async () => {
    if (!vanId || !driverUserId) return setError('Pick a van and a driver.');
    if (order.length === 0) return setError('A run needs at least one rider.');
    setBusy(true);
    setError(null);
    const rides = order.map((o) => ({ rideId: o.ride.id, pickupAt: toIso(o.pickup) }));
    const departAt = localInputToUtcIso(`${serviceDate}T${depart}`, tz);
    try {
      if (editing) {
        await updateRun(editing.id, { vanId, driverUserId, departAt, notes: notes.trim() || null, rides });
        toast.success('Run updated — riders have their pickup times');
      } else {
        await createRun({ vanId, driverUserId, direction, serviceDate, departAt, ...(notes.trim() ? { notes: notes.trim() } : {}), rides });
        toast.success(`Dispatched — ${rides.length} rider${rides.length === 1 ? '' : 's'} told their van and pickup time`);
      }
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
      onClose(true);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      {/* See PlanDialog — the primitive owns the height cap and the scroll. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.van.name}` : 'Dispatch a van'}</DialogTitle>
          <DialogDescription>
            {direction === 'TO_WORK' ? 'To work' : 'Home from work'} · {fmtRelativeDayTz(startRides[0]?.targetAt ?? `${serviceDate}T12:00:00Z`, tz)}.
            Every rider hears their van, driver and pickup time.
          </DialogDescription>
        </DialogHeader>
        {board.vans.length === 0 || board.drivers.length === 0 ? (
          <p className="text-sm text-warning">
            {board.vans.length === 0 ? 'Add a van first (Vans & drivers). ' : ''}
            {board.drivers.length === 0 ? 'Add a driver — a user with the Driver role — in Users.' : ''}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Van" required>
                {(p) => (
                  <Select {...p} value={vanId} onChange={(e) => setVanId(e.target.value)}>
                    {board.vans.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} · {v.capacity} seats{v.plate ? ` · ${v.plate}` : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Driver" required>
                {(p) => (
                  <Select {...p} value={driverUserId} onChange={(e) => setDriverUserId(e.target.value)}>
                    <option value="">Pick a driver</option>
                    {board.drivers.map((d) => (
                      <option key={d.userId} value={d.userId}>
                        {d.name}
                        {d.role === 'TRANSPORTATION_DIRECTOR' ? ' (director)' : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Leaves at" required>
                {(p) => <Input {...p} type="time" value={depart} onChange={(e) => setDepart(e.target.value)} />}
              </Field>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-silver">
                  Pickups in order{' '}
                  <span className={cn('tabular-nums', over ? 'text-alert' : 'text-white')}>
                    {order.length}/{van?.capacity ?? '—'}
                  </span>
                </span>
                {/* Both of these throw away every pickup time in the list
                    and recompute it. 4px between two 44px slabs on touch
                    was the tightest pair on the page. */}
                <span className="flex items-center gap-1 coarse:gap-2">
                  <Button size="xs" variant="secondary" onClick={() => void bestOrder()} loading={routing} disabled={routing}>
                    <Wand2 className="h-3.5 w-3.5" />
                    Best order
                  </Button>
                  <Button size="xs" variant="ghost" onClick={retime}>
                    Re-time from departure
                  </Button>
                </span>
              </div>
              <ol className="divide-y divide-navy-secondary/60 rounded-md border border-navy-secondary">
                {order.map((o, i) => (
                  <li key={o.ride.id} className="flex flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap">
                    <span className="w-5 shrink-0 text-right text-xs tabular-nums text-silver">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-white">{o.ride.rider.name}</div>
                      <div className="flex items-center gap-1 truncate text-xs text-silver">
                        {direction === 'TO_WORK' ? (
                          <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                        ) : (
                          <Home className="h-3 w-3 shrink-0" aria-hidden="true" />
                        )}
                        <span className="truncate">{homeEnd(o.ride)}</span>
                        <span className="shrink-0">
                          {' '}
                          · {direction === 'TO_WORK' ? 'arrive by' : 'leaves'} {fmtTimeTz(o.ride.targetAt, tz)} · {o.ride.store.name}
                        </span>
                      </div>
                    </div>
                    <Input
                      type="time"
                      aria-label={`Pickup time for ${o.ride.rider.name}`}
                      value={o.pickup}
                      onChange={(e) => setOrder((prev) => prev.map((x, j) => (j === i ? { ...x, pickup: e.target.value } : x)))}
                      className="w-28"
                      size="sm"
                    />
                    <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    {/* Three icon-only buttons in a row, and this is the
                        one that drops a rider. Reorder is a nudge you can
                        undo by nudging back; losing someone off the run is
                        only noticed after it dispatches — so it sits a
                        finger's width clear of Move down. */}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="coarse:ml-1"
                      aria-label={`Take ${o.ride.rider.name} off this run`}
                      onClick={() => setOrder((prev) => prev.filter((x) => x.ride.id !== o.ride.id))}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ol>
              {addable.length > 0 && (
                <Select
                  className="mt-2"
                  size="sm"
                  aria-label="Add a rider"
                  value=""
                  onChange={(e) => {
                    const r = addable.find((x) => x.id === e.target.value);
                    if (!r) return;
                    setOrder((prev) => [
                      ...prev,
                      { ride: r, pickup: direction === 'TO_WORK' ? addMinutes(prev[prev.length - 1]?.pickup ?? depart, STOP_GAP_MIN) : depart },
                    ]);
                  }}
                >
                  <option value="">+ Add a rider waiting for a van…</option>
                  {addable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.rider.name} · {fmtTimeTz(r.targetAt, r.store.timezone)} · {r.store.name} · {homeEnd(r)}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            <Field label="Notes for the driver">
              {(p) => <Input {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Gas card is in the glovebox" />}
            </Field>
            {over && <p className="text-sm text-alert">{van!.name} seats {van!.capacity} — take riders off or pick a bigger van.</p>}
            {error && (
              <p role="alert" className="rounded-md border border-alert/40 bg-alert/10 p-3 text-sm text-alert">
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(false)}>
            Close
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={busy || over || order.length === 0 || !vanId || !driverUserId}>
            <Send className="h-4 w-4" />
            {editing ? 'Save run' : `Dispatch ${order.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Live map ============================================================= */

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : `${fmtMinutes(s / 60)} ago`;
}

function LiveTab() {
  const queryClient = useQueryClient();
  const live = useQuery({ queryKey: ['transport', 'live'], queryFn: () => getLiveBoard(), refetchInterval: 10_000 });
  useEffect(
    () => onLiveEvent('transport', () => void queryClient.invalidateQueries({ queryKey: ['transport', 'live'] })),
    [queryClient],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const runs = live.data?.runs ?? [];
  const onRoad = runs.filter((r) => r.status === 'ACTIVE');
  const planned = runs.filter((r) => r.status === 'PLANNED');
  const selected = runs.find((r) => r.runId === picked) ?? onRoad[0] ?? null;
  const now = Date.now();

  const markers: MapMarker[] = [];
  for (const r of onRoad) {
    if (!r.position) continue;
    markers.push({
      id: `van-${r.runId}`,
      kind: 'van',
      ...r.position,
      label: `${r.van.name} · ${r.driver.name}`,
      stale: r.stale,
      highlight: r.runId === selected?.runId,
    });
  }
  let n = 0;
  for (const w of selected?.waypoints ?? []) {
    if (!w.point) continue;
    if (w.kind === 'store') markers.push({ id: `store-${w.label}`, kind: 'store', ...w.point, label: w.label });
    else markers.push({ id: `stop-${w.rideIds.join(',')}`, kind: 'stop', ...w.point, order: ++n, label: w.label });
  }
  const route: Array<[number, number]> = selected
    ? [
        ...(selected.position ? [[selected.position.lng, selected.position.lat] as [number, number]] : []),
        ...selected.waypoints.filter((w) => w.point).map((w) => [w.point!.lng, w.point!.lat] as [number, number]),
      ]
    : [];

  if (live.isLoading) return <Skeleton className="h-96" />;
  if (live.isError) return <QueryError what="the live board" query={live} />;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        {markers.length > 0 ? (
          <LazyLiveMap
            ariaLabel="Live map of the vans"
            className="h-[55vh] min-h-80 w-full"
            markers={markers}
            route={route.length > 1 ? route : undefined}
            trail={selected?.trail}
          />
        ) : (
          <EmptyState
            icon={Bus}
            title="No vans on the road"
            description="A van shows here as soon as its driver starts the run and their phone shares its location."
          />
        )}
      </div>
      <section aria-label="Runs" className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">
          On the road <span className="text-white">{onRoad.length}</span>
        </h2>
        {onRoad.length === 0 && <p className="text-sm text-silver">Nothing on the road right now.</p>}
        {onRoad.map((r) => (
          <LiveRunRow key={r.runId} run={r} now={now} selected={r.runId === selected?.runId} onPick={() => setPicked(r.runId)} />
        ))}
        {planned.length > 0 && (
          <>
            <h2 className="pt-3 text-sm font-semibold uppercase tracking-wider text-silver">
              Leaving later <span className="text-white">{planned.length}</span>
            </h2>
            {planned.map((r) => (
              <LiveRunRow key={r.runId} run={r} now={now} selected={r.runId === selected?.runId} onPick={() => setPicked(r.runId)} />
            ))}
          </>
        )}
      </section>
    </div>
  );
}

function LiveRunRow({ run, now, selected, onPick }: { run: RunMap; now: number; selected: boolean; onPick: () => void }) {
  const late = Math.max(0, ...run.late.map((l) => l.minutes));
  const next = run.waypoints.find((w) => w.etaAt) ?? run.waypoints[0];
  const active = run.status === 'ACTIVE';
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={cn(
        'w-full rounded-lg border p-3 text-left transition-colors',
        selected ? 'border-gold/60 bg-gold/5' : 'border-navy-secondary hover:border-silver/40',
      )}
    >
      <div className="flex items-center gap-2">
        <Bus className={cn('h-4 w-4', active ? 'text-success' : 'text-gold')} aria-hidden="true" />
        <span className="font-semibold text-white">{run.van.name}</span>
        <span className="truncate text-sm text-silver">· {run.driver.name}</span>
        <span className="ml-auto">
          {active ? (
            late >= 5 ? (
              <Badge variant="pending">~{fmtMinutes(late)} late</Badge>
            ) : (
              <Badge variant="success">On time</Badge>
            )
          ) : (
            <Badge variant="accent">Leaves {fmtTimeTz(run.departAt, run.timezone)}</Badge>
          )}
        </span>
      </div>
      <div className="mt-1 text-xs text-silver">
        {run.direction === 'TO_WORK' ? 'To work' : 'Home from work'} · {run.riders.filter((r) => r.status === 'BOARDED').length} on board ·{' '}
        {run.riders.filter((r) => r.status === 'SCHEDULED').length} to pick up
      </div>
      {active && next && (
        <div className="mt-1 text-sm text-white">
          Next: {next.label}
          {next.etaAt && <span className="text-silver"> · about {Math.max(1, Math.round((Date.parse(next.etaAt) - now) / 60_000))} min</span>}
        </div>
      )}
      {active && (
        <div className={cn('mt-1 text-xs', run.stale ? 'text-warning' : 'text-silver')}>
          {run.position ? (run.stale ? `No signal since ${ago(run.position.at, now)}` : `Updated ${ago(run.position.at, now)}`) : 'Waiting for the driver’s phone'}
        </div>
      )}
    </button>
  );
}

/* ===== Rides ================================================================ */

function RidesTab({ manage }: { manage: boolean }) {
  const today = ymdLocal();
  const [from, setFrom] = useState(shiftDay(today, -7));
  const [to, setTo] = useState(shiftDay(today, 14));
  const [status, setStatus] = useState<RideStatus | ''>('');
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q.trim());
  const rides = useQuery({
    queryKey: ['transport', 'rides', from, to, status, dq],
    queryFn: () => searchRides({ from, to, ...(status ? { status } : {}), ...(dq ? { q: dq } : {}) }),
  });
  const actions = useRideActions();
  const queryClient = useQueryClient();

  /**
   * Dispatch from here, not just from Today.
   *
   * Today's board only ever shows one service date, so a week of unassigned
   * rides had to be dispatched a day at a time — and this tab, which is the
   * one that spans days and actually shows them all, could only cancel and
   * waive. Selecting across the range and sending them to a van in one go
   * is the same DispatchDialog the board uses.
   */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dispatching, setDispatching] = useState(false);
  const all = rides.data?.rides ?? [];
  // What the server will actually accept onto a run: still waiting, no van.
  const eligible = all.filter((r) => r.status === 'REQUESTED' && !r.run);
  const pickedRides = eligible.filter((r) => picked.has(r.id));
  const allPicked = eligible.length > 0 && pickedRides.length === eligible.length;

  // A run is one van going one way on one day — the server refuses anything
  // else with ride_mismatch, so say so here rather than letting them build a
  // selection that can only fail.
  const ways = new Set(pickedRides.map((r) => r.direction));
  const days = new Set(pickedRides.map((r) => r.serviceDate));
  const stores = new Set(pickedRides.map((r) => r.store.id));
  const blocked =
    ways.size > 1 ? 'One way per run' : days.size > 1 ? 'One day per run' : null;
  const dispatchDate = days.size === 1 ? [...days][0]! : null;

  // The dialog needs the vans and drivers for the day being dispatched —
  // fetched only once they ask, since this tab otherwise never needs it.
  const board = useQuery({
    queryKey: ['transport', 'board', dispatchDate],
    queryFn: () => getTransportBoard(dispatchDate!),
    enabled: dispatching && !!dispatchDate,
  });

  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });

  return (
    <div className="space-y-3">
      {/* The sm inputs go from 12px to 16px text on a touch pointer (so iOS
          doesn't zoom the whole board on focus), and 16px "09/22/2026" plus
          the native picker glyph no longer fits w-36. Widened only there —
          a mouse keeps the compact filter row. */}
      <div className="flex flex-wrap items-end gap-2">
        <Input size="sm" className="w-48" placeholder="Search a rider" aria-label="Search a rider" value={q} onChange={(e) => setQ(e.target.value)} />
        <Input size="sm" type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36 coarse:w-44" />
        <Input size="sm" type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} className="w-36 coarse:w-44" />
        <Select size="sm" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as RideStatus | '')} className="w-40">
          <option value="">Every status</option>
          {(Object.keys(STATUS_LABEL) as RideStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </div>
      {manage && pickedRides.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gold/40 bg-gold/[0.06] px-3 py-2">
          <span className="text-sm text-white">
            <span className="font-semibold tabular-nums">{pickedRides.length}</span> selected
          </span>
          {blocked ? (
            <span className="text-xs text-warning">{blocked}</span>
          ) : (
            <span className="text-xs text-silver">
              {ways.has('TO_WORK') ? 'To work' : 'Home from work'} ·{' '}
              {fmtRelativeDayTz(`${dispatchDate}T12:00:00Z`, 'UTC')}
              {/* Not blocking: the server allows one run to serve two
                  stores, and a van covering neighbours is legitimate —
                  but it should never be a surprise. */}
              {stores.size > 1 && <span className="text-warning"> · {stores.size} stores on one run</span>}
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
            <Button size="sm" disabled={!!blocked || board.isFetching} loading={board.isFetching} onClick={() => setDispatching(true)}>
              <Send className="h-3.5 w-3.5" />
              Dispatch {pickedRides.length}
            </Button>
          </span>
        </div>
      )}
      {/* Without this the Dispatch button is a click that does nothing:
          the dialog can't mount without a board, and the selection is
          still sitting there looking ready. */}
      {dispatching && board.isError && <QueryError what="the vans for that day" query={board} />}
      {rides.isLoading ? (
        <Skeleton className="h-48" />
      ) : rides.isError ? (
        <QueryError what="these rides" query={rides} />
      ) : (rides.data?.rides.length ?? 0) === 0 ? (
        <EmptyState icon={Bus} title="No rides" description="Nothing matches — widen the dates or clear the search." />
      ) : (
        // Eight columns of ride: it is wider than an iPad in portrait and
        // far wider than a phone. It slides inside this box — the page body
        // itself never goes pannable, which is what would make the header
        // and the tab strip drift off-screen mid-dispatch.
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {manage && (
                  /* The pick column is sized to its control, so it widens
                     with it on touch rather than squeezing "When". */
                  <TableHead className="w-8 coarse:w-14">
                    <PickBox
                      label={`Select all ${eligible.length} waiting for a van`}
                      checked={allPicked}
                      disabled={eligible.length === 0}
                      onChange={(on) => toggle(eligible.map((r) => r.id), on)}
                    />
                  </TableHead>
                )}
                <TableHead>When</TableHead>
                <TableHead>Rider</TableHead>
                <TableHead>Way</TableHead>
                <TableHead>Pickup / drop</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Van</TableHead>
                <TableHead className="text-right">Owed</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rides.data!.rides.map((r) => (
                <TableRow key={r.id}>
                  {manage && (
                    <TableCell>
                      {r.status === 'REQUESTED' && !r.run ? (
                        <PickBox label={`Select ${r.rider.name}`} checked={picked.has(r.id)} onChange={(on) => toggle([r.id], on)} />
                      ) : null}
                    </TableCell>
                  )}
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {fmtRelativeDayTz(r.targetAt, r.store.timezone)} {fmtTimeTz(r.targetAt, r.store.timezone)}
                  </TableCell>
                  <TableCell>{r.rider.name}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {r.direction === 'TO_WORK' ? 'To' : 'From'} {r.store.name}
                  </TableCell>
                  <TableCell className="max-w-56 truncate">{homeEnd(r)}</TableCell>
                  <TableCell>
                    <Badge size="sm" variant={statusVariant(r.status)}>
                      {STATUS_LABEL[r.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>{r.run?.van.name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.waived ? <span className="text-success">waived</span> : r.owedCents > 0 ? cents(r.owedCents) : '—'}
                    {r.charged && <div className="text-2xs text-silver">from pay</div>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {/* These two were siblings with nothing between them —
                        JSX eats the newline, so Cancel and Waive rendered
                        edge to edge. Two ghost buttons sharing a border is
                        a coin toss under a finger, and one of them tells a
                        rider their ride is off. Separated always, wider on
                        touch where both are 44px tall. */}
                    <div className="flex items-center justify-end gap-1 coarse:gap-3">
                      {manage && (r.status === 'REQUESTED' || r.status === 'SCHEDULED') && r.run?.status !== 'ACTIVE' && (
                        <Button size="xs" variant="ghost" onClick={() => void actions.cancel(r)}>
                          Cancel
                        </Button>
                      )}
                      {manage && r.owedCents > 0 && !r.charged && (
                        <Button size="xs" variant="ghost" onClick={() => void actions.waive(r)}>
                          Waive
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* The same dialog the Today board uses — one van, one driver, pickup
          times worked back from the arrive-by. */}
      {dispatching && board.data && pickedRides.length > 0 && (
        <DispatchDialog
          board={board.data}
          initial={{ rides: pickedRides }}
          onClose={(done) => {
            setDispatching(false);
            if (done) {
              setPicked(new Set());
              void queryClient.invalidateQueries({ queryKey: ['transport'] });
            }
          }}
        />
      )}
    </div>
  );
}

/* ===== Issues =============================================================== */

function IssuesTab({ manage }: { manage: boolean }) {
  const [view, setView] = useState<'open' | 'resolved'>('open');
  const issues = useQuery({
    queryKey: ['transport', 'issues', view],
    queryFn: () => listTransportIssues(view === 'resolved' ? 'RESOLVED' : undefined),
  });
  const prompt = usePrompt();
  const queryClient = useQueryClient();
  const actions = useRideActions();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['transport'] });

  const working = async (i: TransportIssue) => {
    try {
      await updateTransportIssue(i.id, { status: 'IN_PROGRESS' });
      await refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const resolve = async (i: TransportIssue) => {
    const resolution = await prompt({
      title: 'Resolve this issue',
      description: `${i.reportedBy.name} hears your answer.`,
      reasonLabel: 'What was done',
      reasonPlaceholder: 'Waived the fee — the van was 20 minutes late.',
      confirmLabel: 'Resolve',
    });
    if (!resolution) return;
    try {
      await updateTransportIssue(i.id, { status: 'RESOLVED', resolution });
      toast.success('Resolved — they were told');
      await refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <div className="space-y-3">
      <SegmentedControl
        ariaLabel="Issues"
        value={view}
        onChange={setView}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'resolved', label: 'Resolved' },
        ]}
      />
      {issues.isLoading ? (
        <Skeleton className="h-40" />
      ) : issues.isError ? (
        <QueryError what="the reported issues" query={issues} />
      ) : (issues.data?.issues.length ?? 0) === 0 ? (
        <EmptyState icon={AlertTriangle} title={view === 'open' ? 'Nothing open' : 'Nothing resolved yet'} description="Riders and drivers report problems from their app." />
      ) : (
        <div className="space-y-3">
          {issues.data!.issues.map((i) => (
            <Card key={i.id} className={cn(i.category === 'SAFETY' && i.status !== 'RESOLVED' && 'border-alert/50')}>
              <CardContent className="pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={i.category === 'SAFETY' ? 'destructive' : 'accent'} withDot={false}>
                    {ISSUE_LABEL[i.category] ?? i.category}
                  </Badge>
                  <span className="text-sm font-medium text-white">{i.reportedBy.name}</span>
                  <span className="text-xs text-silver">
                    {i.reportedBy.role === 'DRIVER' ? 'driver' : i.reportedBy.role === 'ASSOCIATE' ? 'rider' : i.reportedBy.role.toLowerCase().replace(/_/g, ' ')}
                    {' · '}
                    {fmtDateTime(i.createdAt)}
                  </span>
                  <Badge className="ml-auto" variant={i.status === 'RESOLVED' ? 'success' : i.status === 'IN_PROGRESS' ? 'accent' : 'pending'}>
                    {i.status === 'IN_PROGRESS' ? 'Working on it' : i.status === 'RESOLVED' ? 'Resolved' : 'Open'}
                  </Badge>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-white">{i.body}</p>
                {i.ride && (
                  <p className="mt-2 text-xs text-silver">
                    Ride: {fmtRelativeDayTz(i.ride.targetAt, i.ride.store.timezone)} {fmtTimeTz(i.ride.targetAt, i.ride.store.timezone)} ·{' '}
                    {i.ride.direction === 'TO_WORK' ? 'to' : 'from'} {i.ride.store.name} · {STATUS_LABEL[i.ride.status]}
                    {i.ride.run ? ` · ${i.ride.run.van.name}, ${i.ride.run.driver.name}` : ''}
                    {i.ride.owedCents > 0 ? ` · ${cents(i.ride.owedCents)} owed` : ''}
                  </p>
                )}
                {i.run && !i.ride && (
                  <p className="mt-2 text-xs text-silver">
                    Run: {i.run.van} · {fmtDateTime(i.run.departAt)}
                  </p>
                )}
                {i.resolution && <p className="mt-2 border-l-2 border-success/50 pl-2 text-sm text-silver">{i.resolution}</p>}
                {manage && i.status !== 'RESOLVED' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {i.status === 'OPEN' && (
                      <Button size="sm" variant="secondary" onClick={() => void working(i)}>
                        Working on it
                      </Button>
                    )}
                    {i.ride && i.ride.owedCents > 0 && !i.ride.charged && (
                      <Button size="sm" variant="secondary" onClick={() => void actions.waive(i.ride!)}>
                        Waive {cents(i.ride.owedCents)}
                      </Button>
                    )}
                    <Button size="sm" onClick={() => void resolve(i)}>
                      Resolve
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===== Vans & drivers ======================================================= */

function periodDates(days: number): { from: string; to: string } {
  const to = ymdLocal();
  return { from: shiftDay(to, -(days - 1)), to };
}

/** A tiny bar chart of daily revenue. */
function Spark({ daily, from, to }: { daily: Array<{ date: string; cents: number }>; from: string; to: string }) {
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 62; d = shiftDay(d, 1)) days.push(d);
  const by = new Map(daily.map((x) => [x.date, x.cents]));
  const max = Math.max(1, ...daily.map((x) => x.cents));
  return (
    <div className="flex h-10 items-end gap-px" aria-hidden="true">
      {days.map((d) => (
        <div
          key={d}
          className={cn('flex-1 rounded-sm', (by.get(d) ?? 0) > 0 ? 'bg-gold/70' : 'bg-navy-secondary')}
          style={{ height: `${Math.max(6, ((by.get(d) ?? 0) / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function FleetTab({ manage, drivers }: { manage: boolean; drivers: TransportBoard['drivers'] }) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const { from, to } = periodDates(days);
  const fleet = useQuery({ queryKey: ['transport', 'fleet', from, to], queryFn: () => getFleet(from, to), refetchInterval: 60_000 });
  const [editing, setEditing] = useState<Van | 'new' | null>(null);
  const [, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const vans = fleet.data?.vans ?? [];
  const totals = vans.reduce(
    (t, v) => ({
      revenue: t.revenue + v.stats.revenueCents,
      riders: t.riders + v.stats.riders,
      runs: t.runs + v.stats.runs,
      miles: t.miles + v.stats.miles,
    }),
    { revenue: 0, riders: 0, runs: 0, miles: 0 },
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['transport'] });
  const setDriver = async (v: Van, driverUserId: string | null) => {
    try {
      await updateVan(v.id, { driverUserId });
      toast.success(driverUserId ? `${v.name} assigned` : `${v.name} is off its driver`);
      await refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const toggle = async (v: Van) => {
    try {
      await updateVan(v.id, { isActive: !v.isActive });
      await refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const now = Date.now();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          ariaLabel="Period"
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: 'Last 7 days' },
            { value: 30, label: 'Last 30 days' },
            { value: 90, label: 'Last 90 days' },
          ]}
        />
        {manage && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-3.5 w-3.5" />
            Add van
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'Earned', value: cents(totals.revenue) },
          { label: 'Riders carried', value: totals.riders },
          { label: 'Runs', value: totals.runs },
          { label: 'Miles', value: Math.round(totals.miles) },
        ].map((x) => (
          <div key={x.label} className="rounded-lg border border-navy-secondary bg-navy px-3 py-2.5">
            <div className="text-2xs font-medium uppercase tracking-wider text-silver">{x.label}</div>
            <div className="mt-0.5 text-xl font-bold tabular-nums text-white">{x.value}</div>
          </div>
        ))}
      </div>
      {fleet.isLoading ? (
        <Skeleton className="h-64" />
      ) : fleet.isError ? (
        <QueryError what="the fleet" query={fleet} />
      ) : vans.length === 0 ? (
        <EmptyState icon={Bus} title="No vans yet" description="Add the fleet — name, plate, seats, and who drives it." />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {vans.map((v) => {
            const st = v.stats;
            const status = !v.isActive ? 'Out of service' : v.now ? 'On the road' : 'Parked';
            return (
              <Card key={v.id} className={cn(!v.isActive && 'opacity-70', v.now && 'border-success/40')}>
                <CardContent className="pt-4">
                  <div className="flex items-start gap-3">
                    <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full', v.now ? 'bg-success/15 text-success' : 'bg-gold/15 text-gold')}>
                      <Bus className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-white">{v.name}</span>
                        {v.plate && (
                          <span className="rounded border border-silver/40 bg-white px-1.5 font-mono text-2xs font-bold tracking-wider text-[#0B1832]">{v.plate}</span>
                        )}
                        <Badge size="sm" variant={v.now ? 'success' : v.isActive ? 'default' : 'destructive'}>
                          {status}
                        </Badge>
                      </div>
                      <div className="truncate text-xs text-silver">
                        {v.look || 'Add make, model and color'} · {v.capacity} seats
                      </div>
                      {v.now && (
                        <div className="text-xs text-success">
                          {v.now.driver} · {v.now.lastSeenAt ? `seen ${ago(v.now.lastSeenAt, now)}` : 'no signal yet'}
                        </div>
                      )}
                    </div>
                    {manage && (
                      <Button size="xs" variant="ghost" onClick={() => setEditing(v)}>
                        Edit
                      </Button>
                    )}
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    {v.driver ? (
                      <Avatar src={v.driver.associateId ? `/api/associates/${v.driver.associateId}/photo` : undefined} name={v.driver.name} email="" size="sm" />
                    ) : (
                      <span className="grid h-8 w-8 place-items-center rounded-full border border-dashed border-silver/50 text-silver" aria-hidden="true">
                        ?
                      </span>
                    )}
                    {manage ? (
                      <Select
                        size="sm"
                        aria-label={`Driver for ${v.name}`}
                        value={v.driver?.userId ?? ''}
                        onChange={(e) => void setDriver(v, e.target.value || null)}
                        className="w-full"
                      >
                        <option value="">No driver — unassigned</option>
                        {drivers.map((d) => (
                          <option key={d.userId} value={d.userId}>
                            {d.name}
                            {d.role === 'TRANSPORTATION_DIRECTOR' ? ' (director)' : ''}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span className="text-sm text-white">{v.driver?.name ?? 'No driver'}</span>
                    )}
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
                    {[
                      ['Earned', cents(st.revenueCents)],
                      ['Riders', st.riders],
                      ['Seat fill', st.seatFill === null ? '—' : `${st.seatFill}%`],
                      ['Runs', st.runs],
                      ['Miles', st.miles],
                      ['No-shows', st.noShows],
                    ].map(([label, value]) => (
                      <div key={label as string} className="rounded-md bg-navy-secondary/30 px-1.5 py-1.5">
                        <div className="text-2xs uppercase tracking-wider text-silver">{label}</div>
                        <div className="text-sm font-semibold tabular-nums text-white">{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3">
                    <Spark daily={st.daily} from={fleet.data!.from} to={fleet.data!.to} />
                  </div>
                  {manage && (
                    // "Call <driver>" dials the moment it's hit and "Take out
                    // of service" pulls a van from dispatch with no confirm
                    // step — neither is something to catch with a thumb aimed
                    // at its neighbour.
                    <div className="mt-3 flex flex-wrap gap-2 coarse:gap-3">
                      {v.now && (
                        <Button size="xs" variant="secondary" onClick={() => setParams({ tab: 'live' })}>
                          <MapPin className="h-3.5 w-3.5" />
                          On the map
                        </Button>
                      )}
                      {v.driver?.phone && (
                        <Button size="xs" variant="secondary" asChild>
                          <a href={`tel:${v.driver.phone}`}>
                            <Phone className="h-3.5 w-3.5" />
                            Call {v.driver.name.split(' ')[0]}
                          </a>
                        </Button>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => void toggle(v)}>
                        {v.isActive ? 'Take out of service' : 'Back in service'}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <p className="text-xs text-silver">
        Earned is fares and no-show fees charged in the period, less waivers. Seat fill is riders carried over seats run. Miles come from each van’s
        trail. Drivers are people with the Driver role — invite them from Users.
      </p>
      {editing && <VanDialog van={editing === 'new' ? null : editing} drivers={drivers} onClose={() => setEditing(null)} />}
    </div>
  );
}

function VanDialog({ van, drivers, onClose }: { van: Van | null; drivers: TransportBoard['drivers']; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(van?.name ?? '');
  const [plate, setPlate] = useState(van?.plate ?? '');
  const [capacity, setCapacity] = useState(String(van?.capacity ?? 12));
  const [make, setMake] = useState(van?.make ?? '');
  const [model, setModel] = useState(van?.model ?? '');
  const [color, setColor] = useState(van?.color ?? '');
  const [year, setYear] = useState(van?.year ? String(van.year) : '');
  const [driverUserId, setDriverUserId] = useState(van?.driver?.userId ?? '');
  const [notes, setNotes] = useState(van?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        plate: plate.trim() || null,
        capacity: Number(capacity),
        make: make.trim() || null,
        model: model.trim() || null,
        color: color.trim() || null,
        year: year ? Number(year) : null,
        notes: notes.trim() || null,
        driverUserId: driverUserId || null,
      };
      if (van) await updateVan(van.id, body);
      else await createVan(body);
      toast.success(van ? 'Van saved' : 'Van added');
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
      onClose();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const valid = name.trim().length > 0 && Number(capacity) >= 1 && Number(capacity) <= 60 && (!year || (Number(year) >= 1990 && Number(year) <= 2100));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* See PlanDialog — the primitive owns the height cap and the scroll. */}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{van ? `Edit ${van.name}` : 'Add a van'}</DialogTitle>
          <DialogDescription>What riders look for at the curb, and who drives it.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Van 1" maxLength={60} />}
          </Field>
          <Field label="Plate">
            {(p) => <Input {...p} value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} maxLength={20} />}
          </Field>
          <Field label="Make">
            {(p) => <Input {...p} value={make} onChange={(e) => setMake(e.target.value)} placeholder="Ford" maxLength={40} />}
          </Field>
          <Field label="Model">
            {(p) => <Input {...p} value={model} onChange={(e) => setModel(e.target.value)} placeholder="Transit" maxLength={40} />}
          </Field>
          <Field label="Color">
            {(p) => <Input {...p} value={color} onChange={(e) => setColor(e.target.value)} placeholder="White" maxLength={30} />}
          </Field>
          <Field label="Year">
            {(p) => <Input {...p} type="number" min={1990} max={2100} value={year} onChange={(e) => setYear(e.target.value)} placeholder="2023" />}
          </Field>
          <Field label="Seats" required>
            {(p) => <Input {...p} type="number" min={1} max={60} value={capacity} onChange={(e) => setCapacity(e.target.value)} />}
          </Field>
          <Field label="Driver">
            {(p) => (
              <Select {...p} value={driverUserId} onChange={(e) => setDriverUserId(e.target.value)}>
                <option value="">No driver</option>
                {drivers.map((d) => (
                  <option key={d.userId} value={d.userId}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Notes" className="col-span-2">
            {(p) => <Input {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={busy || !valid}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Stops ================================================================ */

function StopsTab({ manage }: { manage: boolean }) {
  const stops = useQuery({ queryKey: ['transport', 'stops'], queryFn: listStops });
  const [editing, setEditing] = useState<TransportStop | 'new' | null>(null);
  const queryClient = useQueryClient();
  const toggle = async (s: TransportStop) => {
    try {
      await updateStop(s.id, { isActive: !s.isActive });
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <section aria-label="Stops" className="max-w-3xl">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm text-silver">Housing complexes and pickup points riders can pick instead of an address.</p>
        {manage && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-3.5 w-3.5" />
            Add stop
          </Button>
        )}
      </div>
      {stops.isLoading ? (
        <Skeleton className="h-32" />
      ) : stops.isError ? (
        <QueryError what="the stops" query={stops} />
      ) : (stops.data?.stops.length ?? 0) === 0 ? (
        <EmptyState icon={MapPin} title="No stops yet" description="Add the housing complexes your riders live at." />
      ) : (
        <Card>
          <CardContent className="pt-2">
            <ul className="divide-y divide-navy-secondary/60">
              {stops.data!.stops.map((s) => (
                <li key={s.id} className={cn('flex items-center gap-3 py-3', !s.isActive && 'opacity-60')}>
                  <MapPin className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-white">{s.name}</div>
                    <div className="truncate text-xs text-silver">
                      {s.address}
                      {s.notes ? ` · ${s.notes}` : ''}
                    </div>
                  </div>
                  {!s.isActive && <Badge>Hidden</Badge>}
                  {manage && (
                    <>
                      <Button size="xs" variant="ghost" onClick={() => setEditing(s)}>
                        Edit
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => void toggle(s)}>
                        {s.isActive ? 'Hide' : 'Show'}
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {editing && <StopDialog stop={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function StopDialog({ stop, onClose }: { stop: TransportStop | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(stop?.name ?? '');
  const [address, setAddress] = useState(stop?.address ?? '');
  const [notes, setNotes] = useState(stop?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name.trim(), address: address.trim(), notes: notes.trim() || null };
      if (stop) await updateStop(stop.id, body);
      else await createStop(body);
      toast.success(stop ? 'Stop saved' : 'Stop added');
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{stop ? `Edit ${stop.name}` : 'Add a stop'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Name" required>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Seaside Housing" maxLength={120} />}
          </Field>
          <Field label="Address" required>
            {(p) => <Input {...p} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />}
          </Field>
          <Field label="Where to wait">
            {(p) => <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="By the front office" />}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={busy || !name.trim() || address.trim().length < 5}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Charges ============================================================== */

function ChargesTab() {
  // Default: the last two Sat→Fri workweeks — a biweekly period's shape.
  const initial = useMemo(() => {
    const start = workweekStart();
    start.setDate(start.getDate() - 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 13);
    return { from: ymdLocal(start), to: ymdLocal(end) };
  }, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const charges = useQuery({ queryKey: ['transport', 'charges', from, to], queryFn: () => getTransportCharges(from, to) });
  const rows = charges.data?.rows ?? [];
  const totals = charges.data?.totals;
  const exportCsv = () =>
    downloadCsv(`ride-charges-${from}-to-${to}.csv`, [
      ['Associate', 'Rides', 'No-shows', 'Still owed', 'Taken from pay', 'Waived'],
      ...rows.map((r) => [r.name, r.rides, r.noShows, (r.owedCents / 100).toFixed(2), (r.takenCents / 100).toFixed(2), (r.waivedCents / 100).toFixed(2)]),
    ]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        {/* w-36 clips the picker glyph once the text goes 16px — see Rides. */}
        <Input size="sm" type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36 coarse:w-44" />
        <Input size="sm" type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} className="w-36 coarse:w-44" />
        <Button size="sm" variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="h-3.5 w-3.5" />
          CSV
        </Button>
      </div>
      {totals && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <MetricCard label="Rides" value={totals.rides} />
          <MetricCard label="No-shows" value={totals.noShows} />
          <MetricCard label="Still owed" value={cents(totals.owedCents)} hint="comes out at the next payroll" />
          <MetricCard label="Taken from pay" value={cents(totals.takenCents)} />
          <MetricCard label="Waived" value={cents(totals.waivedCents)} />
        </div>
      )}
      {charges.isLoading ? (
        <Skeleton className="h-40" />
      ) : charges.isError ? (
        <QueryError what="the charges" query={charges} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Bus} title="No charges in these dates" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Associate</TableHead>
                <TableHead className="text-right">Rides</TableHead>
                <TableHead className="text-right">No-shows</TableHead>
                <TableHead className="text-right">Still owed</TableHead>
                <TableHead className="text-right">Taken from pay</TableHead>
                <TableHead className="text-right">Waived</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.associateId}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.rides}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.noShows}</TableCell>
                  <TableCell className="text-right tabular-nums">{cents(r.owedCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{cents(r.takenCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{cents(r.waivedCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ===== Fares ================================================================ */

function SettingsTab({ manage }: { manage: boolean }) {
  const settings = useQuery({ queryKey: ['transport', 'settings'], queryFn: getTransportSettings });
  if (settings.isError) return <QueryError what="the transport settings" query={settings} />;
  if (settings.isLoading || !settings.data) return <Skeleton className="h-40 max-w-md" />;
  return <SettingsForm key={JSON.stringify(settings.data.settings)} initial={settings.data.settings} manage={manage} />;
}

function SettingsForm({ initial, manage }: { initial: { fareCents: number; noShowFeeCents: number; cutoffHours: number }; manage: boolean }) {
  const queryClient = useQueryClient();
  const [fare, setFare] = useState((initial.fareCents / 100).toFixed(2));
  const [fee, setFee] = useState((initial.noShowFeeCents / 100).toFixed(2));
  const [cutoff, setCutoff] = useState(String(initial.cutoffHours));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await saveTransportSettings({
        fareCents: Math.round(Number(fare) * 100),
        noShowFeeCents: Math.round(Number(fee) * 100),
        cutoffHours: Number(cutoff),
      });
      toast.success('Saved — new bookings use these');
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="max-w-md">
      <CardContent className="space-y-4 pt-5">
        <Field label="Fare per ride ($)" hint="Each way. A round trip is two rides.">
          {(p) => <Input {...p} type="number" min={0} step="0.25" value={fare} onChange={(e) => setFare(e.target.value)} disabled={!manage} />}
        </Field>
        <Field label="No-show fee ($)" hint="When the driver marks a rider who didn't come.">
          {(p) => <Input {...p} type="number" min={0} step="0.25" value={fee} onChange={(e) => setFee(e.target.value)} disabled={!manage} />}
        </Field>
        <Field label="Book at least (hours ahead)" hint="How far ahead riders must book so the vans can be planned.">
          {(p) => <Input {...p} type="number" min={0} max={72} value={cutoff} onChange={(e) => setCutoff(e.target.value)} disabled={!manage} />}
        </Field>
        <p className="text-xs text-silver">
          Changes apply to new bookings. Rides already booked keep the fare the rider agreed to.
        </p>
        {manage && (
          <Button onClick={() => void save()} loading={busy} disabled={busy}>
            Save
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
