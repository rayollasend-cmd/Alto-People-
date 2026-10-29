import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  GripVertical,
  MapPin,
  MapPinOff,
  MessageSquare,
  Phone,
  Plus,
  Send,
  Wand2,
  X,
} from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { downloadCsv } from '@/lib/csv';
import { STUCK_RUN_MINUTES, fmtDate, fmtDateOnly, fmtDateTime, fmtMinutes, fmtMoney, fmtRelativeDayTz, fmtTimeTz, localInputToUtcIso, utcToZonedDatetimeInput, ymdLocal } from '@/lib/format';
import { useMinWidth } from '@/lib/useViewport';
import { useChargesRange } from '@/lib/transportRange';
import { useTransportKeyboard } from '@/lib/transportKeyboard';
import { Sparkline } from '@/components/ui/charts';
import {
  cancelRide,
  cancelRun,
  closeRunFromDispatch,
  createRun,
  createStop,
  createVan,
  getFleet,
  getDriverAccess,
  decideDriverAccess,
  grantDriverAccess,
  revokeDriverAccess,
  type DriverAccessRow,
  getLiveBoard,
  getPlanMap,
  getTransportBoard,
  listVans,
  transportChargesCsvUrl,
  getRideAuthorizations,
  listUnsignedRiders,
  remindUnsignedRiders,
  getTransportCharges,
  getTransportSettings,
  type GeocoderStatus,
  type RideAuthorizationRow,
  type RideAuthorizationState,
  type RideRate,
  type TransportSettings,
  listStops,
  listTransportIssues,
  reofferRide,
  saveTransportSettings,
  searchRides,
  updateRun,
  updateStop,
  updateTransportIssue,
  updateVan,
  unwaiveRide,
  waiveRide,
  waiveRides,
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
import { dispatchBatch, messageRun, planDay, routeRides, type BatchRefusal, type RunProposal } from '@/lib/transportDispatchApi';
import { rideAlert, useNewKeys } from '@/lib/rideAlerts';
import { SoundToggle } from '@/components/transport/SoundToggle';
import { DispatchMap } from '@/components/transport/DispatchMap';
import { RiderDrawer } from '@/components/transport/RiderDrawer';
import { VanDayTimeline, conflictWords, firstFreeVan, runConflicts, timelineBars } from '@/components/transport/VanDayTimeline';
import { Avatar } from '@/components/ui/Avatar';
import { associatePhotoUrl, personPhotoUrl } from '@/lib/photoUrl';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { DateField, DateRangeField } from '@/components/ui/DateField';
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { DataGrid } from '@/components/ui/DataGrid';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { LiveOpsTab } from './live/LiveOpsTab';
import { ExceptionsQueue } from './live/ExceptionsQueue';
import { TransportKpiRow } from './live/TransportKpiRow';
import { useTransportOps } from '@/lib/transportOpsApi';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { DayLine } from './desk/DayLine';
import { ReadinessStrip, needsPlan, useReadiness, type ReadinessAction } from './desk/ReadinessStrip';
import { MoveMenu } from './desk/MoveMenu';
import { NEEDS_VAN, canMoveRide, checkMove, checkMoveToRun, seatsText, type MoveCheck, type MovingRide } from './desk/moves';
import { runIdOfTarget, runTarget, useDragDispatch } from './desk/dragDispatch';
import { useRideMoves } from './desk/useRideMoves';
import { STATUS_WORDS, canCancelRide, rideStatusWords, runNotStarted } from './desk/rideWords';
import { ListTemplate } from '@/components/templates';
import { CostsSection, DriversTab, FeedbackSection, IncidentsSection, ReceiptThumb, TransportNeedsYou, VanRecordDrawer } from './TransportDesk';
import { TransportTrends } from './TransportTrends';
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
 *   Vans / Stops   the fleet (each van's record: papers, service log,
 *             pre-trip checks) and the housing complexes / pickup stops
 *   Drivers   licences, DOT cards, MVRs, and the day's driver shifts
 *   Charges   who owes what for a date range, what payroll already took
 *   Settings  the fare, the no-show fee, the booking cutoff
 *
 * view:transport reads everything here; manage:transport acts.
 */

const TABS = ['today', 'live', 'rides', 'issues', 'vans', 'drivers', 'stops', 'charges', 'settings'] as const;
type Tab = (typeof TABS)[number];
/** The day's work, one tab each (F500 G2: nine tabs mixed the day with setup). */
const DAILY_TABS = ['today', 'live', 'rides', 'issues'] as const;
/** Set up once, visited rarely: one "Setup" tab, a section each. Their
 *  ?tab= values (vans, drivers, stops, settings, charges) still open them. */
const SETUP_TABS = ['vans', 'drivers', 'stops', 'settings', 'charges'] as const;
type SetupTab = (typeof SETUP_TABS)[number];
const isSetupTab = (t: string): t is SetupTab => (SETUP_TABS as readonly string[]).includes(t);
const TAB_LABEL: Record<Tab, string> = {
  today: 'Today',
  live: 'Live map',
  rides: 'Rides',
  issues: 'Issues',
  vans: 'Fleet',
  drivers: 'Drivers',
  stops: 'Stops',
  charges: 'Charges',
  settings: 'Fares',
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

function homeEnd(r: Ride): string {
  return r.pickup.kind === 'stop' ? r.pickup.name : r.pickup.address;
}

function shiftDay(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** "today", "tomorrow", or "Tue, Oct 27" — the board's day in a sentence. */
function dayName(ymd: string): string {
  const today = ymdLocal();
  if (ymd === today) return 'today';
  if (ymd === shiftDay(today, 1)) return 'tomorrow';
  return fmtDateOnly(ymd, { weekday: true, year: 'auto' });
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day (2026-02-31 is not), so a hand-typed link never opens a blank board. */
function isRealYmd(s: string | null): s is string {
  if (!s || !YMD.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}
/**
 * After 6 PM the desk is usually planning tomorrow's vans — but only once
 * tonight is done. While a run is still planned or out, or a rider still
 * waits for a van, the board stays on today.
 */
const EVENING_HOUR = 18;
function eveningBoardDay(board: Pick<TransportBoard, 'runs' | 'kpis'>, today: string, now = new Date()): string {
  if (now.getHours() < EVENING_HOUR) return today;
  const tonightLive = board.runs.some((r) => r.status === 'PLANNED' || r.status === 'ACTIVE') || board.kpis.needsVan > 0 || board.kpis.onBoard > 0;
  return tonightLive ? today : shiftDay(today, 1);
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
  const wide = useMinWidth(640);
  // The page header's own phone/desktop line (PageHeader switches at 768).
  const headerWide = useMinWidth(768);
  // Transport walk 7: the rider's record, from a link (?rider=…).
  const riderId = params.get('rider');
  const setRider = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('rider', id);
    else next.delete('rider');
    setParams(next, { replace: true });
  };
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'today';
  const setTab = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === 'today') next.delete('tab');
    else next.set('tab', v);
    setParams(next, { replace: true });
  };
  // "Setup" reopens the section last looked at this visit (Fleet first).
  const [lastSetup, setLastSetup] = useState<SetupTab>(() => (isSetupTab(tab) ? tab : 'vans'));
  useEffect(() => {
    if (isSetupTab(tab)) setLastSetup(tab);
  }, [tab]);
  // The board's day lives in the URL (/transport?date=YYYY-MM-DD) so a link
  // from anywhere opens the right day, and Back returns to it.
  const urlDate = params.get('date');
  const linkedDay = isRealYmd(urlDate) ? urlDate : null;
  // With no day in the link: today, then — in the evening, once tonight's
  // runs are done — tomorrow (decided once, from today's board).
  const [autoDay, setAutoDay] = useState<string | null>(null);
  const date = linkedDay ?? autoDay ?? ymdLocal();
  const setDate = (d: string) => {
    const next = new URLSearchParams(params);
    next.set('date', d);
    setParams(next, { replace: true });
  };
  const today = ymdLocal();
  const tomorrow = shiftDay(today, 1);
  // A readiness fix or an exception can point at another day's board: land there.
  const [boardFocus, setBoardFocus] = useState<BoardFocus | null>(null);
  const focusBoard = (f: BoardFocus | null) => {
    setBoardFocus(f);
    if (f && f.date !== date) setDate(f.date);
  };
  const board = useQuery({
    queryKey: ['transport', 'board', date],
    queryFn: () => getTransportBoard(date),
    refetchInterval: 30_000,
  });
  const openIssues = board.data?.kpis.openIssues ?? 0;
  // "Assign a van" on the live map: the dispatch for those riders opens over
  // the map — the dispatcher stays where they are. Riders not on this day's
  // board (or already on a van) are the Today tab's to find.
  const [liveDispatch, setLiveDispatch] = useState<Ride[] | null>(null);
  const openRidesFromLive = (rideIds: string[]) => {
    const ids = new Set(rideIds);
    const hit = (board.data?.rides ?? []).filter((r) => ids.has(r.id) && r.status === 'REQUESTED' && !r.run);
    if (hit.length > 0 && manage) setLiveDispatch(hit.filter((r) => r.direction === hit[0]!.direction));
    else {
      setTab('today');
      setBoardFocus({ date, target: NEEDS_VAN });
    }
  };
  useEffect(() => {
    if (linkedDay || autoDay || !board.data || board.data.date !== today) return;
    setAutoDay(eveningBoardDay(board.data, today));
  }, [linkedDay, autoDay, board.data, today]);

  // The day: one control everywhere — the app's date field, and Today /
  // Tomorrow as the view toggle it is. On a phone (below the header's own
  // 768px phone layout) it is ONE row: the day, the toggle, and the sound
  // switch as an icon; the audit found three rows (date, chips, a lone
  // "More" holding only the sound switch) eating ~190px of the first screen.
  const dayToggle = (
    <SegmentedControl
      ariaLabel="Jump to"
      value={date === today ? 'today' : date === tomorrow ? 'tomorrow' : 'other'}
      onChange={(v) => setDate(v === 'tomorrow' ? tomorrow : today)}
      className="flex-nowrap"
      options={[
        { value: 'today', label: 'Today' },
        { value: 'tomorrow', label: 'Tomorrow' },
      ]}
    />
  );
  const soundToggle = (compact: boolean) => (
    <SoundToggle onLabel="Sounds on — tap to mute" offLabel="Sounds off — tap to turn on" {...(compact ? {} : { text: { on: 'Sounds on', off: 'Sounds off' } })} />
  );
  const dayControls =
    tab !== 'today' ? undefined : headerWide ? (
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" aria-label="Previous day" onClick={() => setDate(shiftDay(date, -1))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <DateField aria-label="Day" value={date} clearable={false} onChange={(v) => v && setDate(v)} className="w-36" />
        <Button variant="ghost" size="icon-sm" aria-label="Next day" onClick={() => setDate(shiftDay(date, 1))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <div className="ml-2">{dayToggle}</div>
      </div>
    ) : (
      <div className="flex w-full min-w-0 flex-nowrap items-center gap-2" data-testid="transport-day-row">
        <DateField aria-label="Day" size="sm" value={date} clearable={false} onChange={(v) => v && setDate(v)} className="min-w-0 flex-1" />
        {dayToggle}
        {soundToggle(true)}
      </div>
    );

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Transportation"
        topbarTitle="Transportation"
        subtitle="The Alto vans — bookings, dispatch, drivers, and everything that comes up."
        // On a phone the sound switch rides in the day row (no "More" of one).
        secondaryActions={headerWide || tab !== 'today' ? soundToggle(false) : undefined}
        primaryAction={dayControls}
    >
      <Tabs value={isSetupTab(tab) ? 'setup' : tab} onValueChange={(v) => setTab(v === 'setup' ? lastSetup : v)}>
        <TabsList className="mb-4">
          {DAILY_TABS.map((k) => (
            <TabsTrigger key={k} value={k}>
              {TAB_LABEL[k]}
              {k === 'issues' && openIssues > 0 && (
                <Badge size="sm" variant="pending" withDot={false} className="ml-1.5 tabular-nums">
                  {openIssues}
                </Badge>
              )}
            </TabsTrigger>
          ))}
          <TabsTrigger value="setup">Setup</TabsTrigger>
        </TabsList>
        <TabsContent value="today">
          {board.isLoading ? (
            <Skeleton className="h-64" />
          ) : board.isError ? (
            <QueryError what="today's board" query={board} />
          ) : board.data ? (
            <div className="space-y-5">
              <TodayBoard
                board={board.data}
                manage={manage}
                compact={!wide}
                onRider={setRider}
                nav={{ prev: () => setDate(shiftDay(date, -1)), next: () => setDate(shiftDay(date, 1)), today: () => setDate(today), tomorrow: () => setDate(tomorrow) }}
                onSetup={(section) => setTab(section)}
                focus={boardFocus}
                onFocus={focusBoard}
              />
              <TransportTrends />
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="live">
          <LiveOpsTab onOpenRide={openRidesFromLive} />
        </TabsContent>
        <TabsContent value="rides">
          <RidesTab manage={manage} onRider={setRider} />
        </TabsContent>
        <TabsContent value="issues">
          <div className="space-y-8">
            <IncidentsSection manage={manage} />
            <IssuesTab manage={manage} onRider={setRider} />
            <FeedbackSection />
          </div>
        </TabsContent>
        <TabsContent value="setup">
          <div className="space-y-4">
            <SegmentedControl
              ariaLabel="Setup section"
              value={isSetupTab(tab) ? tab : lastSetup}
              onChange={(v) => setTab(v)}
              options={SETUP_TABS.map((k) => ({ value: k, label: TAB_LABEL[k] }))}
            />
            {tab === 'vans' && <FleetTab manage={manage} drivers={board.data?.drivers ?? []} />}
            {tab === 'drivers' && <DriversTab manage={manage} />}
            {tab === 'stops' && <StopsTab manage={manage} />}
            {tab === 'charges' && (
              <div className="space-y-8">
                <ChargesTab onRider={setRider} />
                <CostsSection />
              </div>
            )}
            {tab === 'settings' && <SettingsTab manage={manage} />}
          </div>
        </TabsContent>
      </Tabs>
      <RiderDrawer associateId={riderId} manage={manage} onClose={() => setRider(null)} onIssues={() => { setRider(null); setTab('issues'); }} />
      {liveDispatch && board.data && <DispatchDialog board={board.data} initial={{ rides: liveDispatch }} onClose={() => setLiveDispatch(null)} />}
    </ListTemplate>
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
        title: `Waive ${r.rider.name}’s ${cents(r.owedCents)} no-show fee?`,
        description: 'It won’t come out of their pay. They hear about it. A ride someone took is never waived.',
        reasonLabel: 'Reason',
        reasonPlaceholder: 'The van came to the wrong stop',
        confirmLabel: 'Waive',
      });
      if (!reason) return;
      try {
        await waiveRide(r.id, reason);
        toast.success('Fee waived');
        await refresh();
      } catch (err) {
        toast.error(errMsg(err));
      }
    },
    /** Several no-show fees, one reason. Taken rides never come off — the server says so per ride. */
    waiveMany: async (rides: Ride[], title: string): Promise<boolean> => {
      const fees = rides.filter(canWaive);
      if (fees.length === 0) return false;
      const total = fees.reduce((s, r) => s + r.owedCents, 0);
      const reason = await prompt({
        title,
        description: `${fees.length} no-show ${fees.length === 1 ? 'fee' : 'fees'}, ${cents(total)} in all. None of it comes out of pay, and each rider hears about it. A ride someone took is never waived.`,
        reasonLabel: 'Reason',
        reasonPlaceholder: 'The van came to the wrong stop',
        confirmLabel: `Waive ${fees.length === 1 ? 'the fee' : `${fees.length} fees`}`,
      });
      if (!reason) return false;
      try {
        const out = await waiveRides(fees.map((r) => r.id), reason);
        if (out.skipped.length > 0) toast.warning(`${out.waived} waived · ${out.skipped.length} not: ${out.skipped[0]!.message}`);
        else toast.success(`${out.waived} ${out.waived === 1 ? 'fee' : 'fees'} waived`);
        await refresh();
        return true;
      } catch (err) {
        toast.error(errMsg(err));
        return false;
      }
    },
    unwaive: async (r: Ride) => {
      const amount = r.waiveKind === 'NOT_AUTHORIZED' ? (r.uncollectedCents ?? r.fareCents) : r.owedCents || (r.status === 'NO_SHOW' ? r.noShowFeeCents : r.fareCents);
      const reason = await prompt({
        title: `Put ${cents(amount)} back on ${r.rider.name}’s ride?`,
        description:
          r.waiveKind === 'NOT_AUTHORIZED'
            ? 'They took this ride, so it’s owed. It comes out of pay once they sign the ride authorization, and they hear about it.'
            : 'It’s owed again and comes out of an upcoming paycheck, never below minimum wage. They hear about it.',
        reasonLabel: 'Reason',
        reasonPlaceholder: 'Waived by mistake',
        confirmLabel: 'Undo waiver',
      });
      if (!reason) return;
      try {
        const { ride } = await unwaiveRide(r.id, reason);
        toast.success(ride.heldForSignature ? 'Owed again — held until they sign' : 'Owed again — they were told');
        await refresh();
      } catch (err) {
        toast.error(errMsg(err));
      }
    },
  };
}

/** A director waives a no-show fee, never a ride someone took. */
const canWaive = (r: Ride) => r.status === 'NO_SHOW' && r.owedCents > 0 && !r.charged && !r.waived;
/** Any waiver can be undone before payroll settles the ride — except a no-show left uncharged for want of a signature. */
const canUnwaive = (r: Ride) => r.waived && !r.charged && !(r.waiveKind === 'NOT_AUTHORIZED' && r.status === 'NO_SHOW');

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

/* ----- The day's own actions ------------------------------------------------ */

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

/** Where a link from elsewhere on the page wants the board to land once that day loads. */
export interface BoardFocus {
  date: string;
  /** NEEDS_VAN, or a run id. */
  target: string | null;
}

type DragDispatch = ReturnType<typeof useDragDispatch>;

/** Plan a day that isn't the one on screen (tomorrow, from today's readiness strip). */
function PlanForDay({ date, onClose }: { date: string; onClose: () => void }) {
  const day = useQuery({ queryKey: ['transport', 'board', date], queryFn: () => getTransportBoard(date) });
  if (day.isError) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Plan runs</DialogTitle>
          </DialogHeader>
          <QueryError what="the vans and drivers for that day" query={day} />
        </DialogContent>
      </Dialog>
    );
  }
  return day.data ? <PlanDialog board={day.data} onClose={onClose} /> : null;
}

function TodayBoard({
  board,
  manage,
  compact = false,
  onRider,
  nav,
  onSetup,
  focus,
  onFocus,
}: {
  board: TransportBoard;
  manage: boolean;
  compact?: boolean;
  onRider?: (associateId: string) => void;
  /** The day controls, for the keyboard (transport walk 12). */
  nav?: { prev: () => void; next: () => void; today: () => void; tomorrow: () => void };
  /** Open a Setup section (a readiness fix: drivers' papers, vans). */
  onSetup?: (section: 'drivers' | 'vans') => void;
  /** A run or the riders without a van to land on, once the focus names this board’s day. */
  focus?: BoardFocus | null;
  /** Go to another day and land on something there (null: done landing). */
  onFocus?: (f: BoardFocus | null) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dispatch, setDispatch] = useState<{ rides: Ride[]; vanId?: string | null } | { run: RideRun } | null>(null);
  // The day being planned: this board's (Plan runs), or the next (the readiness strip).
  const [planFor, setPlanFor] = useState<string | null>(null);
  const planning = planFor !== null;
  const actions = useRideActions();
  const prompt = usePrompt();
  const message = useMessageRun();
  const closeRun = useCloseRun();
  const queryClient = useQueryClient();
  const remindUnsigned = useMutation({
    mutationFn: (ids: string[]) => remindUnsignedRiders(ids),
    onSuccess: (r) => toast.success(r.sent ? `Asked ${r.sent} ${r.sent === 1 ? 'rider' : 'riders'} to sign.` : 'Everyone here was reminded in the last day.'),
    onError: (err) => toast.error(errMsg(err)),
  });
  // Transport walk 12: j/k walk the waiting groups, x picks one, d
  // dispatches what's picked, p plans; [ ] t m move the day.
  const [cursor, setCursor] = useState<string | null>(null);
  const live = useQuery({ queryKey: ['transport', 'live'], queryFn: () => getLiveBoard(), refetchInterval: 15_000 });
  useEffect(
    () => onLiveEvent('transport', () => void queryClient.invalidateQueries({ queryKey: ['transport'] })),
    [queryClient],
  );
  const today = ymdLocal();
  const tz = board.rides[0]?.store.timezone ?? board.runs.find((r) => r.rides[0])?.rides[0]?.store.timezone;
  const liveById = new Map((live.data?.runs ?? []).map((r) => [r.runId, r]));
  const waiting = board.rides.filter((r) => r.status === 'REQUESTED');
  const groups = groupWaiting(waiting);
  const pickedRides = waiting.filter((r) => picked.has(r.id));
  const mixed = new Set(pickedRides.map((r) => r.direction)).size > 1;
  const now = Date.now();
  const cursorAt = cursor ? groups.findIndex((g) => g.key === cursor) : -1;

  // Is the next day ready? On today's board: tomorrow. On a day ahead: that day.
  const readinessDate = board.date === today ? shiftDay(today, 1) : board.date > today ? board.date : null;
  const readinessDay = readinessDate === shiftDay(today, 1) ? 'tomorrow' : readinessDate ? fmtDateOnly(readinessDate, { weekday: true, year: 'auto' }) : '';
  const readiness = useReadiness(readinessDate);
  // One primary button on the screen: "Plan tomorrow" while riders have no van.
  const planIsPrimary = manage && needsPlan(readiness.data);

  // Something new needs the desk: buzz, chime (the queue below lists it).
  const ops = useTransportOps(board.date);
  useNewKeys(
    // The queue chimes for an SOS itself; this is everything else that matters.
    ops.data ? ops.data.exceptions.filter((e) => e.severity !== 'low' && e.kind !== 'sos').map((e) => e.id) : null,
    () => rideAlert('attention'),
  );

  useTransportKeyboard(
    {
      prevDay: () => nav?.prev(),
      nextDay: () => nav?.next(),
      today: () => nav?.today(),
      tomorrow: () => nav?.tomorrow(),
      down: () => setCursor(groups[Math.min(groups.length - 1, cursorAt + 1)]?.key ?? null),
      up: () => setCursor(groups[Math.max(0, cursorAt - 1)]?.key ?? null),
      pick: () => {
        const g = groups[cursorAt];
        if (!g || !manage) return;
        const all = g.rides.every((r) => picked.has(r.id));
        toggle(g.rides.map((r) => r.id), !all);
      },
      dispatch: () => {
        if (manage && pickedRides.length > 0 && !mixed) setDispatch({ rides: pickedRides });
      },
      plan: () => {
        if (manage && waiting.length > 0) setPlanFor(board.date);
      },
    },
    !dispatch && !planning,
  );

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

  // On the road first, then by departure; a run that didn't run last, muted.
  const liveRuns = board.runs
    .filter((r) => r.status !== 'CANCELLED' || r.notRun)
    .sort(
      (a, b) =>
        (a.notRun ? 1 : 0) - (b.notRun ? 1 : 0) ||
        (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1) ||
        a.departAt.localeCompare(b.departAt),
    );
  const driverPhone = (userId: string) => board.drivers.find((d) => d.userId === userId)?.phone ?? null;

  /* ----- Landing on a run or the riders without a van -------------------- */
  const runCards = useRef(new Map<string, HTMLElement>());
  const needsVanRef = useRef<HTMLElement | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  const land = (key: string, el: HTMLElement | null | undefined) => {
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    setFlash(key);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 2600);
  };
  const [params, setParams] = useSearchParams();
  /** Scroll to the run's card and light it; a run on another day opens on the live map (the queue's own default). */
  const openRun = (runId: string) => {
    const card = runCards.current.get(runId);
    if (card) return land(runId, card);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set('tab', 'live');
        next.set('run', runId);
        return next;
      },
      { replace: true },
    );
  };
  const openNeedsVan = () => land(NEEDS_VAN, needsVanRef.current);
  /** An exception's riders: the dispatch for those still waiting, else the run they're on, else the rider. */
  const openRide = (rideIds: string[]) => {
    const ids = new Set(rideIds);
    const hit = waiting.filter((r) => ids.has(r.id));
    if (hit.length > 0 && manage) {
      setDispatch({ rides: hit.filter((r) => r.direction === hit[0]!.direction) });
      return;
    }
    const run = board.runs.find((r) => r.rides.some((x) => ids.has(x.id)));
    if (run) return openRun(run.id);
    const one = board.rides.find((r) => ids.has(r.id));
    if (one) onRider?.(one.rider.associateId);
  };
  useEffect(() => {
    if (!focus || focus.date !== board.date) return;
    // After this day's cards have drawn.
    const t = window.setTimeout(() => {
      if (focus.target === NEEDS_VAN) openNeedsVan();
      else if (focus.target) openRun(focus.target);
      onFocus?.(null);
    }, 50);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, board.date]);
  // ?run=<id> — the live map's "Open run" for a run it doesn't show: land on its card, once.
  const runParam = params.get('run');
  useEffect(() => {
    if (!runParam) return;
    const t = window.setTimeout(() => {
      const card = runCards.current.get(runParam);
      if (card) land(runParam, card);
      else toast.info(`That run isn’t on ${dayName(board.date)}’s board.`);
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete('run');
          return next;
        },
        { replace: true },
      );
    }, 50);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runParam, board.date]);
  const onReadinessAction = (a: ReadinessAction, date: string) => {
    if (a.kind === 'plan') setPlanFor(date);
    else if (a.kind === 'open_setup_drivers') onSetup?.('drivers');
    else if (a.kind === 'open_setup_vans') onSetup?.('vans');
    else {
      const target = a.kind === 'open_needs_van' ? NEEDS_VAN : (a.target ?? null);
      if (date !== board.date) onFocus?.({ date, target });
      else if (target === NEEDS_VAN) openNeedsVan();
      else if (target) openRun(target);
    }
  };

  /* ----- Drag to dispatch ------------------------------------------------- */
  const moves = useRideMoves(board, tz);
  const drag = useDragDispatch((m, target) => {
    const runId = runIdOfTarget(target);
    void moves.move(m, target === NEEDS_VAN ? null : runId);
  });
  const moveTo = (m: MovingRide, toRunId: string | null) => void moves.move(m, toRunId);
  const dragWords = (() => {
    if (!drag.moving) return '';
    const who = drag.moving.ride.rider.name;
    if (!drag.over) return `Moving ${who}. Drop them on a run, or use Move on their row.`;
    const check = checkMove(drag.moving, drag.over === NEEDS_VAN ? null : runIdOfTarget(drag.over), board, tz);
    if (!check.ok) return check.reason;
    return drag.over === NEEDS_VAN ? `Drop to take ${who} off their run.` : `Drop to move ${who} here${check.seatsAfter ? ` — ${seatsText(check.seatsAfter)} after` : ''}.`;
  })();

  // Every driver declined the seat: put it in front of them again.
  const reoffer = (r: Ride) =>
    void reofferRide(r.id)
      .then(() => {
        toast.success('Back in front of every driver');
        return queryClient.invalidateQueries({ queryKey: ['transport'] });
      })
      .catch((err) => toast.error(errMsg(err)));

  // Transport walk 8: riders on this day who haven't signed ride uncharged.
  const dayRides = new Map([...board.rides, ...board.runs.flatMap((r) => r.rides)].map((r) => [r.id, r]));
  const unsignedToday = [...dayRides.values()].filter((r) => (r.status === 'REQUESTED' || r.status === 'SCHEDULED') && r.signatureNeeded);
  const unsignedIds = [...new Set(unsignedToday.map((r) => r.rider.associateId))];

  // Nothing booked and no run planned: one quiet state for the day, not a
  // line of zeros and two "nothing here" boxes.
  const quietDay = board.rides.length === 0 && liveRuns.length === 0;
  const dayTitle =
    board.date === today
      ? `Today · ${fmtDateOnly(board.date, { weekday: true, year: 'auto' })}`
      : board.date === shiftDay(today, 1)
        ? `Tomorrow · ${fmtDateOnly(board.date, { weekday: true, year: 'auto' })}`
        : fmtDateOnly(board.date, { weekday: true, year: 'auto' });

  return (
    <div className="space-y-5">
      {!quietDay && <DayLine day={dayTitle} kpis={board.kpis} />}
      <ExceptionsQueue date={board.date} compact onOpenRun={openRun} onOpenRide={openRide} />
      {/* The desk's paperwork the queue doesn't carry: incidents, papers lapsing, access requests. */}
      {board.date === today && <TransportNeedsYou variant="line" exclude={['sos', 'no-answer', 'needs-van', 'late']} />}
      <TransportKpiRow date={board.date} />
      {readinessDate && <ReadinessStrip date={readinessDate} dayLabel={readinessDay} manage={manage} onAction={onReadinessAction} />}
      {quietDay && (
        <EmptyState
          icon={Bus}
          title={`No rides booked for ${dayName(board.date)}`}
          description="Bookings land here as riders make them. Then plan runs, or pick bookings and dispatch them onto a van."
          className="py-8"
        />
      )}
      {unsignedIds.length > 0 && (
        <section aria-label="Unsigned riders">
          <ErrorBanner
            severity="warning"
            action={
              manage ? (
                <Button size="xs" variant="outline" loading={remindUnsigned.isPending} onClick={() => remindUnsigned.mutate(unsignedIds)}>
                  Ask {unsignedIds.length === 1 ? 'them' : `all ${unsignedIds.length}`} to sign
                </Button>
              ) : undefined
            }
          >
            <span className="font-medium">
              {unsignedIds.length} {unsignedIds.length === 1 ? 'rider' : 'riders'} {dayName(board.date)} won’t be charged — not signed.
            </span>{' '}
            {unsignedToday.slice(0, 3).map((r) => r.rider.name.split(' ')[0]).join(', ')}
            {unsignedToday.length > 3 ? ` and ${unsignedToday.length - 3} more` : ''} · a ride taken is never waived: it’s held until they sign.
          </ErrorBanner>
        </section>
      )}
      {/* Transport walk 6: which van is free at 5:30, at a glance. */}
      {!compact && !quietDay && (
        <VanDayTimeline
          board={board}
          onDispatch={manage ? (rides, vanId) => setDispatch({ rides, vanId }) : undefined}
          onRun={manage ? (run) => { if (run.status === 'PLANNED') setDispatch({ run }); } : undefined}
        />
      )}

      {!quietDay && (
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {/* Waiting on a van — and where a rider dragged off a run lands. */}
        <section
          aria-label="Needs a van"
          ref={needsVanRef}
          {...(manage ? drag.target(NEEDS_VAN) : {})}
          className={cn(
            'scroll-mt-24 rounded-lg',
            drag.moving?.fromRunId && (drag.over === NEEDS_VAN ? '[outline-style:solid] outline-2 outline-offset-4 outline-info-600' : '[outline-style:dashed] outline-1 outline-offset-4 outline-info-500'),
            flash === NEEDS_VAN && '[outline-style:solid] outline-2 outline-offset-4 outline-accent-600',
          )}
        >
          <SectionTitle
            className="mb-2"
            wrap
            title={
              <>
                Needs a van{waiting.length > 0 && <span className="ml-2 text-sm font-normal tabular-nums text-ink-muted">{waiting.length}</span>}
              </>
            }
            trailing={
              manage ? (
              <div className="flex items-center gap-2">
                {pickedRides.length > 0 ? (
                  <>
                    {mixed && <span className="text-xs text-caution-800">One way per run</span>}
                    <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                      Clear
                    </Button>
                    <Button size="sm" variant={planIsPrimary ? 'secondary' : 'primary'} disabled={mixed} onClick={() => setDispatch({ rides: pickedRides })}>
                      <Send className="h-3.5 w-3.5" />
                      Dispatch {pickedRides.length}
                    </Button>
                  </>
                ) : (
                  // The strip's "Plan tomorrow" is the same action on tomorrow's board.
                  waiting.length > 0 && !(planIsPrimary && readinessDate === board.date) && (
                    <Button size="sm" variant="secondary" onClick={() => setPlanFor(board.date)}>
                      <Wand2 className="h-3.5 w-3.5" />
                      Plan runs
                    </Button>
                  )
                )}
              </div>
              ) : undefined
            }
          />
          {drag.moving?.fromRunId && (
            <DropHint check={checkMove(drag.moving, null, board, tz)} over={drag.over === NEEDS_VAN} who={drag.moving.ride.rider.name} offRun />
          )}
          {groups.length === 0 ? (
            <div data-testid="needs-van-none">
              <EmptyState size="sm" icon={Check} title="Everyone has a van" description="New bookings for this day land here." />
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => {
                const all = g.rides.every((r) => picked.has(r.id));
                // A shift whose vans are full, riders in line: add a van and they ride.
                const inLine = g.rides.filter((r) => r.waitlist).length;
                return (
                  <Card key={g.key} className={cn(cursor === g.key && 'ring-1 ring-gold')} data-kb-cursor={cursor === g.key ? 'true' : undefined} aria-selected={cursor === g.key}>
                    <CardContent>
                      <div className="flex items-center gap-2">
                        {manage && (
                          <PickBox
                            label={`Pick all ${g.rides.length}`}
                            checked={all}
                            onChange={(on) => toggle(g.rides.map((r) => r.id), on)}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-ink">
                            {g.direction === 'TO_WORK' ? 'To' : 'Home from'} {g.storeName} ·{' '}
                            <span className="tabular-nums">
                              {g.direction === 'TO_WORK' ? 'arrive by' : 'leaving'} {fmtTimeTz(g.at, g.tz)}
                            </span>
                          </div>
                          <div className="text-xs text-ink-muted">
                            {g.rides.length} {g.rides.length === 1 ? 'rider' : 'riders'}
                            {inLine > 0 && ` · the shift’s vans are full, ${inLine} on the waitlist — add a van and they ride`}
                          </div>
                        </div>
                        {manage && (
                          <Button size="xs" variant="secondary" onClick={() => setDispatch({ rides: g.rides })} aria-label={`Dispatch ${g.storeName} ${fmtTimeTz(g.at, g.tz)}`}>
                            <Send className="h-3.5 w-3.5" />
                            {inLine > 0 ? 'Add a van' : 'Dispatch'}
                          </Button>
                        )}
                      </div>
                      <ul className="mt-2 divide-y divide-line">
                        {g.rides.map((r) => {
                          const moving: MovingRide = { ride: r, fromRunId: null };
                          const movable = manage && canMoveRide(r, null, now);
                          return (
                            <li
                              key={r.id}
                              {...(movable ? drag.source(moving) : {})}
                              className={cn('flex items-center gap-2 py-2 sm:gap-3', movable && 'cursor-grab active:cursor-grabbing', drag.moving?.ride.id === r.id && 'opacity-50')}
                            >
                              {movable && !compact && <GripVertical className="-mr-1 h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />}
                              {manage && (
                                <PickBox label={`Pick ${r.rider.name}`} checked={picked.has(r.id)} onChange={(on) => toggle([r.id], on)} />
                              )}
                              <Avatar src={associatePhotoUrl(r.rider.associateId)} name={r.rider.name} size="sm" />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-x-2 text-sm text-ink">
                                  <RiderName ride={r} onRider={onRider} />
                                  {r.signatureNeeded && (
                                    <Badge size="sm" variant="pending" title={r.signatureNeeded}>
                                      Unsigned
                                    </Badge>
                                  )}
                                  {r.windowLabel && <span className="text-xs text-ink-muted">{r.windowLabel} shift</span>}
                                  {r.waitlist && (
                                    <Badge size="sm" variant="pending">
                                      Waitlist #{r.waitlist.position}
                                    </Badge>
                                  )}
                                  {r.shortNotice && (
                                    <Badge size="sm" variant="accent">
                                      Short notice
                                    </Badge>
                                  )}
                                  {r.declines > 0 && (
                                    <Badge size="sm" variant={r.allDeclined ? 'destructive' : 'pending'}>
                                      {r.allDeclined ? 'Every driver declined' : `Declined by ${r.declines}`}
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-1 truncate text-xs text-ink-muted">
                                  <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                                  <span className="truncate">{homeEnd(r)}</span>
                                  <span className="shrink-0 tabular-nums"> · {fmtTimeTz(r.targetAt, r.store.timezone)}</span>
                                </div>
                                {r.note && <div className="text-xs text-accent">{r.note}</div>}
                                {/* On a phone the row has no room beside the name: under it. */}
                                {manage && r.allDeclined && compact && (
                                  <Button size="xs" variant="outline" className="mt-1" onClick={() => reoffer(r)}>
                                    Offer again
                                  </Button>
                                )}
                              </div>
                              {manage && r.allDeclined && !compact && (
                                <Button size="xs" variant="ghost" onClick={() => reoffer(r)}>
                                  Offer again
                                </Button>
                              )}
                              {movable && <MoveMenu moving={moving} runs={board.runs} tz={tz} onMove={(to) => moveTo(moving, to)} />}
                              {manage && canCancelRide(r, now) && (
                                <Button size="icon-sm" variant="ghost" aria-label={`Cancel ${r.rider.name}'s ride`} onClick={() => void actions.cancel(r)}>
                                  <X className="h-4 w-4" />
                                </Button>
                              )}
                            </li>
                          );
                        })}
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
          <SectionTitle
            className="mb-2"
            title={
              <>
                Runs{liveRuns.length > 0 && <span className="ml-2 text-sm font-normal tabular-nums text-ink-muted">{liveRuns.length}</span>}
              </>
            }
          />
          {liveRuns.length === 0 ? (
            <div data-testid="runs-none">
              <EmptyState size="sm" icon={Bus} title="No runs yet" description="Plan runs, or pick bookings and dispatch them onto a van." />
            </div>
          ) : (
            <div className="space-y-3">
              {liveRuns.map((run) => (
                <RunPanel
                  key={run.id}
                  run={run}
                  runs={board.runs}
                  tz={tz}
                  live={liveById.get(run.id) ?? null}
                  driverPhone={driverPhone(run.driver.userId)}
                  manage={manage}
                  compact={compact}
                  now={now}
                  drag={drag}
                  highlighted={flash === run.id}
                  cardRef={(el) => {
                    if (el) runCards.current.set(run.id, el);
                    else runCards.current.delete(run.id);
                  }}
                  onOpenRun={openRun}
                  onMove={moveTo}
                  onRider={onRider}
                  onCloseStuck={() => void closeRun(run.id, run.van.name)}
                  onEdit={() => setDispatch({ run })}
                  onCallOff={() => void callOff(run)}
                  onMessage={() => void message(run)}
                  onCancelRide={(r) => void actions.cancel(r)}
                  onWaive={(r) => void actions.waive(r)}
                  onWaiveAll={(rides) => void actions.waiveMany(rides, `Waive every no-show fee on ${run.van.name}’s ${fmtTimeTz(run.departAt, run.rides[0]?.store.timezone)} run?`)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
      )}
      {/* What a drag would do, for a screen reader (the cards say it on screen). */}
      <p className="sr-only" aria-live="polite">
        {dragWords}
      </p>

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
      {planFor === board.date && <PlanDialog board={board} onClose={() => setPlanFor(null)} />}
      {planFor && planFor !== board.date && <PlanForDay date={planFor} onClose={() => setPlanFor(null)} />}
    </div>
  );
}

/**
 * What a drop would do, on the card under a rider in the air: the seats after
 * the move, or — over a run that can't take them — why not.
 */
function DropHint({ check, over, who, offRun = false }: { check: MoveCheck; over: boolean; who: string; offRun?: boolean }) {
  const first = who.split(' ')[0];
  if (!check.ok) {
    if (!over) return null;
    return (
      <p role="note" className="mb-2 rounded-md border border-caution-300 bg-caution-50 px-2.5 py-1.5 text-xs text-caution-800">
        Can’t take {first}: {check.reason}
      </p>
    );
  }
  return (
    <p
      role="note"
      className={cn(
        'mb-2 rounded-md border border-dashed px-2.5 py-1.5 text-xs',
        over ? 'border-info-400 bg-info-100 text-info-800' : 'border-info-300 bg-info-50 text-info-800',
      )}
    >
      {offRun ? `Drop to take ${first} off their run — back to needing a van` : `Drop to move ${first} here`}
      {check.seatsAfter && <span className="tabular-nums"> · {seatsText(check.seatsAfter)} after</span>}
      {check.caution && <span className="block text-caution-800">{check.caution}</span>}
    </p>
  );
}

/** A rider's name, as the door into their record (transport walk 7). */
function RiderName({ ride, onRider, className }: { ride: Pick<Ride, 'rider'>; onRider?: (associateId: string) => void; className?: string }) {
  if (!onRider) return <span className={className}>{ride.rider.name}</span>;
  return (
    <button type="button" onClick={() => onRider(ride.rider.associateId)} className={cn('rounded text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright', className)}>
      {ride.rider.name}
    </button>
  );
}

function RunPanel({
  run,
  runs,
  tz: boardTz,
  live,
  driverPhone,
  manage,
  compact = false,
  now,
  drag,
  highlighted = false,
  cardRef,
  onOpenRun,
  onMove,
  onRider,
  onCloseStuck,
  onEdit,
  onCallOff,
  onMessage,
  onCancelRide,
  onWaive,
  onWaiveAll,
}: {
  run: RideRun;
  /** The day's runs: the double-bookings and the Move to… menu read them. */
  runs: RideRun[];
  tz?: string;
  live: RunMap | null;
  driverPhone: string | null;
  manage: boolean;
  compact?: boolean;
  now: number;
  drag?: DragDispatch;
  highlighted?: boolean;
  cardRef?: (el: HTMLElement | null) => void;
  onOpenRun?: (runId: string) => void;
  onMove?: (m: MovingRide, toRunId: string | null) => void;
  onRider?: (associateId: string) => void;
  onCloseStuck?: () => void;
  onEdit: () => void;
  onCallOff: () => void;
  onMessage: () => void;
  onCancelRide: (r: Ride) => void;
  onWaive: (r: Ride) => void;
  onWaiveAll: (rides: Ride[]) => void;
}) {
  const tz = run.rides[0]?.store.timezone ?? boardTz;
  const waivable = run.rides.filter(canWaive);
  const didntRun = !!run.notRun;
  // A run that didn't run keeps its riders on the card (cancelled by the sweep, never charged).
  const riders = didntRun ? run.rides : run.rides.filter((r) => r.status !== 'CANCELLED');
  const full = run.seats.taken >= run.seats.capacity;
  const active = run.status === 'ACTIVE';
  const notStarted = runNotStarted(run, now);
  const late = live ? Math.max(0, ...live.late.map((l) => l.minutes)) : 0;
  const stuck = active && (run.stuck || live?.stuck || late >= STUCK_RUN_MINUTES);
  const next = live?.waypoints.find((w) => w.etaAt);
  const riderLive = new Map((live?.riders ?? []).map((x) => [x.rideId, x]));
  const byId = new Map(runs.map((r) => [r.id, r]));
  const clashes = didntRun || run.status === 'CANCELLED' ? [] : runConflicts(run, runs);
  // A rider in the air: what a drop here would do.
  const moving = drag?.moving ?? null;
  const target = runTarget(run.id);
  const over = drag?.over === target;
  const check = moving && moving.fromRunId !== run.id ? checkMoveToRun(moving, run, tz) : null;
  const dropOk = !!check?.ok;
  return (
    <Card
      ref={cardRef}
      data-run-id={run.id}
      aria-label={`${run.van.name}, leaves ${fmtTimeTz(run.departAt, tz)}`}
      role="group"
      {...(manage && drag && !didntRun ? drag.target(target) : {})}
      className={cn(
        'scroll-mt-24',
        didntRun && 'border-dashed bg-surface-sunken',
        active && (stuck ? 'border-caution-300' : late >= 5 ? 'border-negative-300' : 'border-positive-300'),
        !active && !didntRun && clashes.length > 0 && 'border-caution-300',
        // Outlines, not rings: the card's own elevation is a box-shadow and would hide a ring.
        moving && dropOk && (over ? '[outline-style:solid] outline-2 outline-offset-2 outline-info-600' : '[outline-style:dashed] outline-1 outline-offset-2 outline-info-500'),
        moving && check && !check.ok && over && '[outline-style:solid] outline-2 outline-offset-2 outline-caution-600',
        highlighted && '[outline-style:solid] outline-2 outline-offset-4 outline-accent-600',
      )}
    >
      <CardContent>
        {moving && check && <DropHint check={check} over={over} who={moving.ride.rider.name} />}
        <div className="flex flex-wrap items-center gap-2">
          <Bus className={cn('h-4 w-4', didntRun ? 'text-ink-muted' : active ? 'text-positive-700' : 'text-accent')} aria-hidden="true" />
          <span className={cn('font-semibold', didntRun ? 'text-ink-muted' : 'text-ink')}>{run.van.name}</span>
          <span className="flex items-center gap-1.5 text-sm text-ink-muted">
            · <Avatar src={personPhotoUrl({ userId: run.driver.userId })} name={run.driver.name} size="xs" />
            {run.driver.name}
          </span>
          <span className="text-sm tabular-nums text-ink-muted">
            · {didntRun || notStarted ? 'was to leave' : 'leaves'} {fmtTimeTz(run.departAt, tz)}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {!didntRun && (
              <span className={cn('text-xs tabular-nums', full ? 'text-caution-800' : 'text-ink-muted')}>
                {run.seats.taken}/{run.seats.capacity} seats
              </span>
            )}
            {didntRun ? (
              <Badge variant="default">Didn’t run</Badge>
            ) : stuck ? (
              <Badge variant="pending">Not closed</Badge>
            ) : active && late >= 5 ? (
              <Badge variant="destructive">~{fmtMinutes(late)} late</Badge>
            ) : notStarted ? (
              <Badge variant="pending">Not started</Badge>
            ) : (
              <Badge variant={active ? 'success' : run.status === 'COMPLETED' ? 'default' : 'accent'}>
                {run.status === 'PLANNED' ? 'Planned' : active ? 'On the road' : run.status === 'COMPLETED' ? (run.autoClosedAt ? 'Closed automatically' : 'Finished') : 'Called off'}
              </Badge>
            )}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-ink-muted">
          {run.direction === 'TO_WORK' ? 'To work' : 'Home from work'}
          {/* The sweep's own note ("Didn't run — …") is the line below, in full. */}
          {run.notes && !(didntRun && /didn[’']t run/i.test(run.notes)) ? ` · ${run.notes}` : ''}
        </div>
        {didntRun && (
          <p className="mt-2 text-xs text-ink-muted">
            Nobody started this run, so it was closed. {riders.length === 1 ? 'Its rider was' : `Its ${riders.length} riders were`} told and{' '}
            {riders.length === 1 ? 'isn’t' : 'aren’t'} charged.
          </p>
        )}
        {clashes.map((c) => {
          const other = byId.get(c.runId);
          const words = conflictWords(run, c, other, tz);
          return (
            <button
              key={c.runId}
              type="button"
              onClick={() => onOpenRun?.(c.runId)}
              disabled={!other || !onOpenRun}
              aria-label={`${words}. Show that run.`}
              className="mt-2 flex w-full items-start gap-2 rounded-md border border-caution-300 bg-caution-50 px-2.5 py-1.5 text-left text-xs text-caution-800 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:no-underline"
            >
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{words}</span>
            </button>
          );
        })}
        {stuck && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-caution-300 bg-caution-50 px-2.5 py-1.5 text-xs text-caution-800">
            <span>The driver never completed this run — it still counts as on the road.</span>
            {manage && onCloseStuck && (
              <Button size="xs" variant="secondary" onClick={onCloseStuck}>
                Close run
              </Button>
            )}
          </div>
        )}
        {active && live && !stuck && (
          <div className={cn('mt-2 rounded-md border px-2.5 py-1.5 text-xs', live.stale ? 'border-caution-300 bg-caution-50 text-caution-800' : 'border-positive-200 bg-positive-50 text-positive-800')}>
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
        <ol className="mt-2 divide-y divide-line">
          {riders.map((r, i) => {
            const eta = riderLive.get(r.id)?.pickupEtaAt;
            const words = rideStatusWords(r);
            const m: MovingRide = { ride: r, fromRunId: run.id };
            const movable = manage && !!drag && canMoveRide(r, run, now);
            return (
              <li
                key={r.id}
                {...(movable ? drag!.source(m) : {})}
                className={cn('flex items-center gap-2 py-2 sm:gap-3', movable && 'cursor-grab active:cursor-grabbing', moving?.ride.id === r.id && 'opacity-50')}
              >
                {movable && !compact ? (
                  <GripVertical className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                ) : (
                  <span className="w-4 shrink-0 text-right text-xs tabular-nums text-ink-muted">{i + 1}</span>
                )}
                <Avatar src={associatePhotoUrl(r.rider.associateId)} name={r.rider.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm', didntRun ? 'text-ink-muted' : 'text-ink')}>
                    <RiderName ride={r} onRider={onRider} />
                    {r.signatureNeeded && r.status === 'SCHEDULED' && (
                      <Badge size="sm" variant="pending" title={r.signatureNeeded}>
                        Unsigned
                      </Badge>
                    )}
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
                  <div className="truncate text-xs text-ink-muted">
                    {movable && !compact && <span className="tabular-nums">{i + 1} · </span>}
                    {r.pickupAt ? fmtTimeTz(r.pickupAt, r.store.timezone) : '—'}
                    {active && eta && r.status === 'SCHEDULED' && !r.vanArrivedAt && ` (ETA ${fmtTimeTz(eta, r.store.timezone)})`} ·{' '}
                    {run.direction === 'TO_WORK' ? homeEnd(r) : `${r.store.name} → ${homeEnd(r)}`}
                  </div>
                </div>
                {!didntRun && (
                  <Badge size="sm" variant={words.variant} className={cn(compact && r.status === 'SCHEDULED' && 'hidden')}>
                    {words.label}
                  </Badge>
                )}
                {manage && canWaive(r) && (
                  <Button size="xs" variant="ghost" onClick={() => onWaive(r)}>
                    Waive {cents(r.owedCents)} fee
                  </Button>
                )}
                {movable && onMove && <MoveMenu moving={m} runs={runs} tz={tz} onMove={(to) => onMove(m, to)} />}
                {manage && r.status === 'SCHEDULED' && run.status === 'PLANNED' && canCancelRide(r, now) && (
                  <Button size="icon-sm" variant="ghost" aria-label={`Cancel ${r.rider.name}'s ride`} onClick={() => onCancelRide(r)}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
        {manage && waivable.length > 1 && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-muted">
            <span>
              {waivable.length} no-show fees on this run · {cents(waivable.reduce((sum, r) => sum + r.owedCents, 0))}
            </span>
            <Button size="xs" variant="secondary" onClick={() => onWaiveAll(waivable)}>
              Waive all no-shows on this run
            </Button>
          </div>
        )}
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

type PlanOutcome =
  | { ok: true; created: number; updated: number }
  | { ok: false; errors: BatchRefusal[] };

function PlanDialog({ board, onClose }: { board: TransportBoard; onClose: () => void }) {
  const queryClient = useQueryClient();
  const wide = useMinWidth(1024);
  const plan = useQuery({ queryKey: ['transport', 'plan', board.date], queryFn: () => planDay(board.date), staleTime: 0 });
  const [edits, setEdits] = useState<Record<string, { vanId?: string; driverUserId?: string; skip?: boolean }>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PlanOutcome | null>(null);
  const proposals: Array<RunProposal & { skip?: boolean }> = (plan.data?.proposals ?? []).map((p) => ({ ...p, ...edits[p.key] }));
  const ready = proposals.filter((p) => !p.skip && p.vanId && p.driverUserId);
  const runById = new Map(board.runs.map((r) => [r.id, r]));
  const errorFor = (key: string) => (outcome && !outcome.ok ? outcome.errors.find((e) => e.key === key) : undefined);

  // Transport walk 10: one request, all or nothing. A refusal names each
  // proposal that can't go and nothing was written; fix those and send again.
  const dispatchAll = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await dispatchBatch({
        runs: ready
          .filter((p) => p.kind !== 'topUp')
          .map((p) => ({
            key: p.key,
            vanId: p.vanId!,
            driverUserId: p.driverUserId!,
            direction: p.direction,
            serviceDate: p.serviceDate,
            departAt: p.departAt,
            rides: p.rides.map((r) => ({ rideId: r.rideId, pickupAt: r.pickupAt })),
          })),
        topUps: ready
          .filter((p) => p.kind === 'topUp' && p.runId)
          .map((p) => ({ key: p.key, runId: p.runId!, rides: p.rides.map((r) => ({ rideId: r.rideId, pickupAt: r.pickupAt })) })),
      });
      setOutcome({ ok: true, created: res.created.length, updated: res.updated.length });
      toast.success(
        `${res.created.length} ${res.created.length === 1 ? 'run' : 'runs'} dispatched${res.updated.length ? `, ${res.updated.length} topped up` : ''} — every rider has their van and pickup time`,
      );
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
      onClose();
    } catch (err) {
      const refusal = err instanceof ApiError && err.status === 409 && Array.isArray((err.details as { errors?: BatchRefusal[] } | undefined)?.errors)
        ? (err.details as { errors: BatchRefusal[] }).errors
        : null;
      if (refusal) setOutcome({ ok: false, errors: refusal });
      else toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* No max-h here on purpose: DialogContent already caps itself at the
          viewport minus the notch and home-indicator insets and scrolls
          inside. A plain `max-h-[90dvh]` merges over that cap and pushes the
          sheet's grab handle up under the status bar on a notched phone. */}
      <DialogContent className="sm:max-w-3xl lg:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Plan runs</DialogTitle>
          <DialogDescription>
            Every booking still waiting on a van, grouped by way, store and time. Seats on a run that already exists are filled
            first; the rest go into free vans and drivers, pickups in the shortest order with times worked back from the arrive-by.
            Change anything, then dispatch — all at once, or not at all.
          </DialogDescription>
        </DialogHeader>
        {outcome && !outcome.ok && (
          <div role="alert" className="rounded-md border border-alert/40 bg-alert/10 p-3 text-sm text-alert">
            <p className="font-medium">
              {outcome.errors.length} of {ready.length} can’t go — nothing was dispatched.
            </p>
            <ul className="mt-1 list-disc pl-5 text-xs">
              {outcome.errors.map((e) => {
                const p = proposals.find((x) => x.key === e.key);
                return (
                  <li key={e.key}>
                    {p ? `${p.direction === 'TO_WORK' ? 'To' : 'Home from'} ${p.store.name} ${fmtTimeTz(p.departAt, p.store.timezone)}: ` : ''}
                    {e.message}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {plan.isLoading ? (
          <Skeleton className="h-48" />
        ) : plan.isError ? (
          <QueryError what="the plan for this day" query={plan} />
        ) : proposals.length === 0 ? (
          <EmptyState size="sm" title={"Nothing to plan — every booking this day has a van."} />
        ) : (
          <div className="space-y-3">
            {proposals.map((p) => {
              const tz = p.store.timezone;
              const van = board.vans.find((v) => v.id === p.vanId);
              const topUp = p.kind === 'topUp';
              const existing = topUp ? runById.get(p.runId ?? '') : undefined;
              const err = errorFor(p.key);
              const added = p.seats?.added ?? p.rides.length;
              return (
                <div key={p.key} className={cn('rounded-lg border p-3', p.skip ? 'border-navy-secondary opacity-60' : err ? 'border-alert/60' : topUp ? 'border-success/40' : 'border-gold/40')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <PickBox
                      label={`Include ${p.store.name} ${fmtTimeTz(p.departAt, tz)}`}
                      checked={!p.skip}
                      onChange={(on) => setEdits((x) => ({ ...x, [p.key]: { ...x[p.key], skip: !on } }))}
                    />
                    <span className="text-sm font-semibold text-white">
                      {topUp
                        ? `Add ${added} to ${existing?.van.name ?? van?.name ?? 'the run'} (${(p.seats?.taken ?? 0) - added}→${p.seats?.taken ?? p.rides.length}/${p.seats?.capacity ?? van?.capacity ?? '—'})`
                        : `${p.direction === 'TO_WORK' ? 'To' : 'Home from'} ${p.store.name}`}
                    </span>
                    {topUp && (
                      <Badge size="sm" variant="success">
                        Existing run
                      </Badge>
                    )}
                    <span className="text-xs tabular-nums text-silver">
                      {topUp && `${p.direction === 'TO_WORK' ? 'to' : 'home from'} ${p.store.name} `}· leaves {fmtTimeTz(p.departAt, tz)}
                      {p.arriveAt && ` · there ${fmtTimeTz(p.arriveAt, tz)}`}
                      {!topUp && ` · ${p.rides.length}/${van?.capacity ?? '—'} seats`}
                    </span>
                    {err && (
                      <Badge size="sm" variant="destructive" className="ml-auto">
                        Can’t go
                      </Badge>
                    )}
                  </div>
                  <div className={cn('mt-2 grid grid-cols-1 gap-3', wide && 'lg:grid-cols-[1fr_240px]')}>
                    <div>
                      {topUp ? (
                        <p className="text-xs text-silver">
                          {existing ? `${existing.driver.name} · ` : ''}the run keeps its van and driver; everyone on it hears the new pickup time.
                        </p>
                      ) : (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                              <option key={d.userId} value={d.userId} disabled={d.canDrive === false}>
                                {d.name}
                                {d.canDrive === false ? ` (${d.credentialProblem ?? 'can’t drive'})` : ''}
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                      <ol className="mt-2 space-y-1 text-xs">
                        {p.rides.map((r, i) => (
                          <li key={r.rideId} className="flex items-center gap-2">
                            <span className="w-4 text-right tabular-nums text-silver">{i + 1}</span>
                            <span className="tabular-nums text-white">{fmtTimeTz(r.pickupAt, tz)}</span>
                            <span className={cn('min-w-0 flex-1 truncate', r.existing ? 'text-silver/70' : 'text-silver')}>
                              {r.name} · {r.place}
                              {r.existing ? ' · already on it' : ''}
                            </span>
                            {!r.point && (
                              <span className="inline-flex items-center gap-1 text-2xs text-warning" title="No map location">
                                <MapPinOff className="h-3 w-3" aria-hidden="true" />
                                no map location
                              </span>
                            )}
                          </li>
                        ))}
                      </ol>
                      {p.warnings.length > 0 && <p className="mt-2 text-xs text-warning">{p.warnings.join(' ')}</p>}
                    </div>
                    {wide && (
                      <DispatchMap
                        direction={p.direction}
                        store={{ name: p.store.name, point: p.store.point ?? null }}
                        stops={p.rides.map((r) => ({ id: r.rideId, label: r.name, point: r.point }))}
                        className="h-44 w-full rounded-md"
                        interactive={false}
                      />
                    )}
                  </div>
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

/** Who is on another run inside this departure's window — the dialog's "(on 5:09 run)" marks (transport walk 1). */
function busyAt(board: TransportBoard, departIso: string | null, excludeRunId: string | null) {
  const bars = timelineBars(board.runs.filter((r) => r.id !== excludeRunId));
  const at = departIso ? Date.parse(departIso) : NaN;
  const window = Number.isNaN(at) ? null : { from: at - 15 * 60_000, to: at + 2 * 3_600_000 };
  const tz = board.rides[0]?.store.timezone;
  const label = (runId: string) => {
    const run = board.runs.find((r) => r.id === runId);
    return run ? `on ${fmtTimeTz(run.departAt, tz)} run` : 'on a run';
  };
  const hit = (key: 'vanId' | 'driverUserId', id: string) => (window ? bars.find((b) => b[key] === id && b.from < window.to && b.to > window.from) : undefined);
  return {
    van: (id: string) => {
      const b = hit('vanId', id);
      return b ? label(b.runId) : null;
    },
    driver: (id: string) => {
      const b = hit('driverUserId', id);
      return b ? label(b.runId) : null;
    },
  };
}

function DispatchDialog({
  board,
  initial,
  onClose,
}: {
  board: TransportBoard;
  initial: { rides: Ride[]; vanId?: string | null } | { run: RideRun };
  onClose: (done: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const wide = useMinWidth(1024);
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

  // Transport walk 1: the default is a van and a driver who are FREE at
  // the computed departure — never the pair already leaving three minutes
  // earlier. A driver dispatch would refuse (no licence on file, lapsed)
  // is never the default either (walk 2).
  const defaultDepartIso = localInputToUtcIso(`${serviceDate}T${defaultDepart}`, tz);
  const bars0 = timelineBars(board.runs.filter((r) => r.id !== editing?.id));
  const presetVan = 'rides' in initial ? initial.vanId ?? null : null;
  const firstVan =
    editing?.van.id ??
    presetVan ??
    // firstFreeVan judges around a target time; a run leaving now keeps its van until two hours on.
    firstFreeVan(board.vans, bars0, Date.parse(defaultDepartIso) + 2 * 3_600_000, startRides.length) ??
    board.vans.find((v) => v.capacity >= startRides.length)?.id ??
    board.vans[0]?.id ??
    '';
  const [vanId, setVanIdState] = useState(firstVan);
  const freeDriver = (id: string | null | undefined, departIso: string) => {
    if (!id) return false;
    const d = board.drivers.find((x) => x.userId === id);
    if (!d || d.canDrive === false) return false;
    const at = Date.parse(departIso);
    return !bars0.some((b) => b.driverUserId === id && b.from < at + 2 * 3_600_000 && b.to > at - 15 * 60_000);
  };
  const defaultDriverFor = (van: string, departIso: string) => {
    const own = board.vans.find((v) => v.id === van)?.driverUserId;
    if (freeDriver(own, departIso)) return own!;
    // Someone whose trade is driving — which includes the shift
    // supervisor who also drives, not just accounts filed as DRIVER.
    return board.drivers.find((d) => d.drivesByTrade && freeDriver(d.userId, departIso))?.userId ?? board.drivers.find((d) => freeDriver(d.userId, departIso))?.userId ?? '';
  };
  const [driverUserId, setDriverUserId] = useState(editing?.driver.userId ?? defaultDriverFor(firstVan, defaultDepartIso));
  const [depart, setDepart] = useState(defaultDepart);
  const departIso = localInputToUtcIso(`${serviceDate}T${depart}`, tz);
  const busy = busyAt(board, departIso, editing?.id ?? null);
  const setVanId = (id: string) => {
    setVanIdState(id);
    const own = board.vans.find((v) => v.id === id)?.driverUserId;
    if (own && freeDriver(own, departIso)) setDriverUserId(own);
  };
  // Transport walk 5: the store's pin for the map beside the list.
  const planMap = useQuery({ queryKey: ['transport', 'plan-map', serviceDate], queryFn: () => getPlanMap(serviceDate), enabled: wide, staleTime: 60_000 });
  const storeId = startRides[0]?.store.id;
  const storeTrip = planMap.data?.trips.find((t) => t.locationId === storeId && t.direction === direction) ?? planMap.data?.trips.find((t) => t.locationId === storeId);
  const [seq, setSeq] = useState<string[]>([]);
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [order, setOrder] = useState<Array<{ ride: Ride; pickup: string }>>(() => {
    const times = planPickups(direction, defaultDepart, sortedStart.length);
    return sortedStart.map((ride, i) => ({ ride, pickup: editing && ride.pickupAt ? wall(ride.pickupAt, tz) : times[i]! }));
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const van = board.vans.find((v) => v.id === vanId);
  const over = !!van && order.length > van.capacity;
  const vanBusy = vanId ? busy.van(vanId) : null;
  const driverBusy = driverUserId ? busy.driver(driverUserId) : null;
  const driverPick = board.drivers.find((d) => d.userId === driverUserId);
  // Tap pins in sequence: the order is applied once every placed pickup has been tapped.
  const tapStop = (id: string) => {
    if (seq.includes(id)) return;
    const next = [...seq, id];
    const placed = order.filter((o) => o.ride.point).map((o) => o.ride.id);
    if (next.length >= placed.length) {
      setOrder((prev) => {
        const byId = new Map(prev.map((o) => [o.ride.id, o]));
        const first = next.map((x) => byId.get(x)!).filter(Boolean);
        const rest = prev.filter((o) => !next.includes(o.ride.id));
        return [...first, ...rest];
      });
      setSeq([]);
    } else setSeq(next);
  };
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
    setSaving(true);
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
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      {/* See PlanDialog — the primitive owns the height cap and the scroll. */}
      <DialogContent className="sm:max-w-2xl lg:max-w-4xl">
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
          <div className={cn('grid grid-cols-1 gap-4', wide && 'lg:grid-cols-[1fr_240px]')}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Van" required hint={vanBusy ? `${van?.name ?? 'This van'} is ${vanBusy} — dispatch will refuse it.` : undefined}>
                {(p) => (
                  <Select {...p} value={vanId} onChange={(e) => setVanId(e.target.value)}>
                    {board.vans.map((v) => {
                      const on = busy.van(v.id);
                      return (
                        <option key={v.id} value={v.id}>
                          {v.name} · {v.capacity} seats{v.plate ? ` · ${v.plate}` : ''}
                          {on ? ` (${on})` : ''}
                        </option>
                      );
                    })}
                  </Select>
                )}
              </Field>
              <Field
                label="Driver"
                required
                hint={driverBusy ? `${driverPick?.name ?? 'This driver'} is ${driverBusy} — dispatch will refuse it.` : driverPick?.canDrive === false ? `${driverPick.credentialProblem ?? 'Can’t drive'} — dispatch will refuse it.` : undefined}
              >
                {(p) => (
                  <Select {...p} value={driverUserId} onChange={(e) => setDriverUserId(e.target.value)}>
                    <option value="">Pick a driver</option>
                    {board.drivers.map((d) => {
                      const on = busy.driver(d.userId);
                      return (
                        <option key={d.userId} value={d.userId}>
                          {d.name}
                          {d.role === 'TRANSPORTATION_DIRECTOR' ? ' (director)' : ''}
                          {on ? ` (${on})` : d.canDrive === false ? ` (${(d.credentialProblem ?? 'can’t drive').toLowerCase()})` : ''}
                        </option>
                      );
                    })}
                  </Select>
                )}
              </Field>
              <Field label="Leaves at" required>
                {(p) => <Input {...p} type="time" value={depart} onChange={(e) => setDepart(e.target.value)} />}
              </Field>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium text-ink">
                  Pickups in order{' '}
                  <span className={cn('tabular-nums', over ? 'text-alert' : 'text-ink-muted')}>
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
                      <div className="flex flex-wrap items-center gap-x-2 text-sm text-white">
                        {o.ride.rider.name}
                        {o.ride.signatureNeeded && (
                          <Badge size="sm" variant="pending" title={o.ride.signatureNeeded}>
                            Unsigned
                          </Badge>
                        )}
                        {!o.ride.point && (
                          <span className="inline-flex items-center gap-1 text-2xs text-warning" title="No map location — the time is an estimate">
                            <MapPinOff className="h-3 w-3" aria-hidden="true" />
                            no map location
                          </span>
                        )}
                      </div>
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
          {wide && (
            <div className="space-y-1.5">
              <DispatchMap
                direction={direction}
                store={storeTrip ? { name: storeTrip.store.name, point: storeTrip.store.point } : startRides[0] ? { name: startRides[0].store.name, point: null } : null}
                stops={order.map((o) => ({ id: o.ride.id, label: o.ride.rider.name, point: o.ride.point }))}
                onStopClick={tapStop}
                className="h-72 w-full rounded-md"
              />
              <p className="text-2xs text-silver">
                {seq.length > 0 ? `Tap pins in order: ${seq.length} of ${order.filter((o) => o.ride.point).length}` : 'Tap the pins in the order to drive them.'}
                {seq.length > 0 && (
                  <button type="button" className="ml-2 underline" onClick={() => setSeq([])}>
                    Clear
                  </button>
                )}
              </p>
            </div>
          )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(false)}>
            Close
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={saving || over || order.length === 0 || !vanId || !driverUserId}>
            <Send className="h-4 w-4" />
            {editing ? 'Save run' : `Dispatch ${order.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "just now", "40s ago", "6 min ago" — how fresh a van's position is. */
function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : `${fmtMinutes(s / 60)} ago`;
}

/* ===== Rides ================================================================ */

function RidesTab({ manage, onRider }: { manage: boolean; onRider?: (associateId: string) => void }) {
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
  // No-show fees can be picked too — waived together, with one reason.
  const waivable = all.filter(canWaive);
  const pickedFees = waivable.filter((r) => picked.has(r.id));

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


  return (
    <div className="space-y-3">
      {/* The sm inputs go from 12px to 16px text on a touch pointer (so iOS
          doesn't zoom the whole board on focus), and 16px "09/22/2026" plus
          the native picker glyph no longer fits w-36. Widened only there —
          a mouse keeps the compact filter row. */}
      <div className="flex flex-wrap items-end gap-2">
        <Input size="sm" className="w-48" placeholder="Search a rider" aria-label="Search a rider" value={q} onChange={(e) => setQ(e.target.value)} />
        <DateRangeField size="sm" from={from} to={to} fromLabel="From" toLabel="To" onChange={(r) => { setFrom(r.from); setTo(r.to); }} />
        <Select size="sm" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as RideStatus | '')} className="w-40">
          <option value="">Every status</option>
          {(Object.keys(STATUS_WORDS) as RideStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_WORDS[s]}
            </option>
          ))}
        </Select>
      </div>
      {manage && (pickedRides.length > 0 || pickedFees.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gold/40 bg-gold/[0.06] px-3 py-2">
          <span className="text-sm text-white">
            <span className="font-semibold tabular-nums">{pickedRides.length + pickedFees.length}</span> selected
          </span>
          {pickedRides.length === 0 ? (
            <span className="text-xs text-silver">
              {pickedFees.length} no-show {pickedFees.length === 1 ? 'fee' : 'fees'} · {cents(pickedFees.reduce((sum, r) => sum + r.owedCents, 0))}
            </span>
          ) : blocked ? (
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
            {pickedFees.length > 0 && (
              <Button
                size="sm"
                variant={pickedRides.length > 0 ? 'secondary' : 'primary'}
                onClick={() =>
                  void actions
                    .waiveMany(pickedFees, `Waive ${pickedFees.length === 1 ? `${pickedFees[0]!.rider.name}’s no-show fee` : `${pickedFees.length} no-show fees`}?`)
                    .then((done) => {
                      if (done) setPicked((prev) => new Set([...prev].filter((id) => !pickedFees.some((r) => r.id === id))));
                    })
                }
              >
                Waive {pickedFees.length === 1 ? 'fee' : `${pickedFees.length} fees`}
              </Button>
            )}
            {pickedRides.length > 0 && (
              <Button size="sm" disabled={!!blocked || board.isFetching} loading={board.isFetching} onClick={() => setDispatching(true)}>
                <Send className="h-3.5 w-3.5" />
                Dispatch {pickedRides.length}
              </Button>
            )}
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
          <DataGrid<NonNullable<typeof rides.data>['rides'][number]>
            id="transport-rides"
            caption="Rides"
            rows={rides.data!.rides}
            rowKey={(r) => r.id}
            search={false}
            urlState={false}
            exportCsv={{ filename: 'rides' }}
            selectable={
              manage
                ? {
                    // What the server will act on: a ride still waiting with no van
                    // (dispatch), or a no-show fee still owed (waive).
                    disabled: (r) => !((r.status === 'REQUESTED' && !r.run) || canWaive(r)),
                    selectAllLabel:
                      waivable.length === 0
                        ? `Select all ${eligible.length} waiting for a van`
                        : eligible.length === 0
                          ? `Select all ${waivable.length} no-show fees`
                          : `Select all ${eligible.length} waiting and ${waivable.length} no-show fees`,
                    selection: { selected: picked, onChange: setPicked },
                  }
                : undefined
            }
            columns={[
              { key: 'when', header: 'When', accessor: (r) => r.targetAt, csv: (r) => `${fmtRelativeDayTz(r.targetAt, r.store.timezone)} ${fmtTimeTz(r.targetAt, r.store.timezone)}`, sortable: true, searchable: false, cardMeta: true, className: 'whitespace-nowrap tabular-nums', cell: (r) => `${fmtRelativeDayTz(r.targetAt, r.store.timezone)} ${fmtTimeTz(r.targetAt, r.store.timezone)}` },
              { key: 'rider', header: 'Rider', accessor: (r) => r.rider.name, sortable: true, primary: true, cell: (r) => <RiderName ride={r} onRider={onRider} /> },
              { key: 'way', header: 'Way', accessor: (r) => `${r.direction === 'TO_WORK' ? 'To' : 'From'} ${r.store.name}`, sortable: true, cardMeta: true, className: 'whitespace-nowrap' },
              { key: 'end', header: 'Pickup / drop', accessor: (r) => homeEnd(r), className: 'max-w-56 truncate' },
              {
                key: 'status',
                header: 'Status',
                accessor: (r) => rideStatusWords(r).label,
                sortable: true,
                cardMeta: true,
                cell: (r) => {
                  const w = rideStatusWords(r);
                  return (
                    <Badge size="sm" variant={w.variant} title={w.label === 'Didn’t run' ? 'The van never left — the ride was closed and not charged.' : undefined}>
                      {w.label}
                    </Badge>
                  );
                },
              },
              { key: 'van', header: 'Van', accessor: (r) => r.run?.van.name, sortable: true, cell: (r) => r.run?.van.name ?? '—' },
              {
                key: 'owed',
                header: 'Owed',
                accessor: (r) => (r.waived ? 0 : r.owedCents),
                csv: (r) => (r.waiveKind === 'NOT_AUTHORIZED' ? 'not authorized' : r.waived ? 'waived' : r.heldForSignature ? `${cents(r.owedCents)} held until signed` : r.owedCents > 0 ? cents(r.owedCents) : ''),
                sortable: true,
                searchable: false,
                align: 'right',
                className: 'tabular-nums',
                cell: (r) => (
                  <>
                    {r.waiveKind === 'NOT_AUTHORIZED' ? (
                      // Not a decision anyone made: the rider had no current signed authorization.
                      <span className="text-warning" title={r.waiveReason ?? undefined}>
                        Not authorized
                        {(r.uncollectedCents ?? 0) > 0 && <span className="block text-2xs text-silver">{cents(r.uncollectedCents ?? 0)} not charged</span>}
                      </span>
                    ) : r.waived ? (
                      <span className="text-success" title={r.waiveReason ?? undefined}>
                        Waived
                        {r.waiveReason && <span className="block max-w-[14rem] truncate text-2xs text-silver">{r.waiveReason}</span>}
                      </span>
                    ) : r.heldForSignature ? (
                      // Taken, so owed — waiting for the rider's signature before payroll takes it.
                      <span title="They took this ride; it comes out of pay once they sign the ride authorization.">
                        {cents(r.owedCents)}
                        <span className="block text-2xs text-warning">held until they sign</span>
                      </span>
                    ) : r.owedCents > 0 ? (
                      cents(r.owedCents)
                    ) : r.signatureNeeded ? (
                      <span className="text-warning" title={r.signatureNeeded}>Needs signature</span>
                    ) : (
                      '—'
                    )}
                    {r.charged && <div className="text-2xs text-silver">from pay</div>}
                  </>
                ),
              },
              {
                key: 'actions',
                header: '',
                accessor: () => null,
                searchable: false,
                csv: () => '',
                align: 'right',
                stopRowClick: true,
                className: 'whitespace-nowrap',
                cell: (r) => (
                  // Cancel and Waive stay apart — two ghost buttons sharing a
                  // border is a coin toss under a finger, and one of them
                  // tells a rider their ride is off.
                  <div className="flex items-center justify-end gap-1 coarse:gap-3">
                    {/* Only a ride that can still be stopped: waiting or on a van
                        that hasn't left, its time still ahead. */}
                    {manage && canCancelRide(r) && (
                      <Button size="xs" variant="ghost" onClick={() => void actions.cancel(r)}>
                        Cancel
                      </Button>
                    )}
                    {manage && canWaive(r) && (
                      <Button size="xs" variant="ghost" onClick={() => void actions.waive(r)}>
                        Waive fee
                      </Button>
                    )}
                    {manage && canUnwaive(r) && (
                      <Button size="xs" variant="ghost" onClick={() => void actions.unwaive(r)}>
                        Undo waiver
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
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

function IssuesTab({ manage, onRider }: { manage: boolean; onRider?: (associateId: string) => void }) {
  const [view, setView] = useState<'open' | 'resolved'>('open');
  const issues = useQuery({
    queryKey: ['transport', 'issues', view],
    queryFn: () => listTransportIssues(view === 'resolved' ? 'RESOLVED' : undefined),
  });
  // ?issue=<id> (an exception's "Open issue"): scroll to that report and light it —
  // looking in Resolved too when it was closed meanwhile.
  const [params, setParams] = useSearchParams();
  const issueParam = params.get('issue');
  const issueCards = useRef(new Map<string, HTMLElement>());
  const [lit, setLit] = useState<string | null>(null);
  const triedResolved = useRef(false);
  useEffect(() => {
    if (!issueParam || !issues.data) return;
    const found = issues.data.issues.some((i) => i.id === issueParam);
    if (!found && view === 'open' && !triedResolved.current) {
      triedResolved.current = true;
      setView('resolved');
      return;
    }
    const t = window.setTimeout(() => {
      if (found) {
        issueCards.current.get(issueParam)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        setLit(issueParam);
      } else toast.info('That issue isn’t on the list any more.');
      triedResolved.current = false;
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete('issue');
          return next;
        },
        { replace: true },
      );
    }, 50);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueParam, issues.data, view]);
  useEffect(() => {
    if (!lit) return;
    const t = window.setTimeout(() => setLit(null), 2600);
    return () => window.clearTimeout(t);
  }, [lit]);
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
            <Card
              key={i.id}
              ref={(el) => {
                if (el) issueCards.current.set(i.id, el);
                else issueCards.current.delete(i.id);
              }}
              data-issue-id={i.id}
              className={cn('scroll-mt-24', i.category === 'SAFETY' && i.status !== 'RESOLVED' && 'border-alert/50', lit === i.id && '[outline-style:solid] outline-2 outline-offset-4 outline-accent-600')}
            >
              <CardContent>
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
                    <RiderName ride={i.ride} onRider={onRider} className="text-ink" /> · Ride: {fmtRelativeDayTz(i.ride.targetAt, i.ride.store.timezone)} {fmtTimeTz(i.ride.targetAt, i.ride.store.timezone)} ·{' '}
                    {i.ride.direction === 'TO_WORK' ? 'to' : 'from'} {i.ride.store.name} · {STATUS_WORDS[i.ride.status]}
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
                    {i.ride && canWaive(i.ride) && (
                      <Button size="sm" variant="secondary" onClick={() => void actions.waive(i.ride!)}>
                        Waive {cents(i.ride.owedCents)} fee
                      </Button>
                    )}
                    {i.ride && canUnwaive(i.ride) && (
                      <Button size="sm" variant="secondary" onClick={() => void actions.unwaive(i.ride!)}>
                        Undo waiver
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

/** Daily revenue over the period, on the chart kit's sparkline (days with nothing earned read as zero). */
function Spark({ daily, from, to, label }: { daily: Array<{ date: string; cents: number }>; from: string; to: string; label: string }) {
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 92; d = shiftDay(d, 1)) days.push(d);
  const by = new Map(daily.map((x) => [x.date, x.cents]));
  return <Sparkline series={days.map((d) => (by.get(d) ?? 0) / 100)} tone="primary" width={240} height={40} className="h-10 w-full" label={label} />;
}

function FleetTab({ manage, drivers }: { manage: boolean; drivers: TransportBoard['drivers'] }) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const { from, to } = periodDates(days);
  const fleet = useQuery({ queryKey: ['transport', 'fleet', from, to], queryFn: () => getFleet(from, to), refetchInterval: 60_000 });
  const [editing, setEditing] = useState<Van | 'new' | null>(null);
  const [record, setRecord] = useState<string | null>(null);
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
      <MetricStrip label={`The fleet, last ${days} days`}>
        <MetricCard label="Earned" value={cents(totals.revenue)} />
        <MetricCard label="Riders carried" value={totals.riders.toLocaleString('en-US')} />
        <MetricCard label="Runs" value={totals.runs.toLocaleString('en-US')} />
        <MetricCard label="Miles" value={Math.round(totals.miles).toLocaleString('en-US')} />
      </MetricStrip>
      <DriverAccessCard manage={manage} />
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
            const status = !v.isActive ? 'Retired' : v.outOfService ? 'Out of service' : v.now ? 'On the road' : 'Parked';
            return (
              <Card key={v.id} className={cn(!v.isActive && 'opacity-70', v.now && 'border-success/40')}>
                <CardContent>
                  <div className="flex items-start gap-3">
                    <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full', v.now ? 'bg-success/15 text-success' : 'bg-surface-raised text-ink-muted')}>
                      <Bus className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-white">{v.name}</span>
                        {v.plate && (
                          <span className="rounded border border-silver/40 bg-white px-1.5 font-mono text-2xs font-bold tracking-wider text-on-accent">{v.plate}</span>
                        )}
                        <Badge size="sm" variant={v.now ? 'success' : v.isActive && !v.outOfService ? 'default' : 'destructive'}>
                          {status}
                        </Badge>
                        {(v.papersDue ?? []).map((d) => (
                          <Badge key={d.label} size="sm" variant={d.expired ? 'destructive' : 'pending'}>
                            {d.label} {d.expired ? 'lapsed' : 'due'}
                          </Badge>
                        ))}
                        {v.serviceDue?.due && (
                          <Badge size="sm" variant={v.serviceDue.overdue ? 'destructive' : 'pending'} title={`Service at ${v.serviceDue.atMiles.toLocaleString()} mi`}>
                            {v.serviceDue.overdue ? `Service ${Math.abs(v.serviceDue.milesLeft).toLocaleString()} mi overdue` : `Service in ${v.serviceDue.milesLeft.toLocaleString()} mi`}
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-xs text-silver">
                        {v.look || 'Add make, model and color'} · {v.capacity} seats
                      </div>
                      {v.now && (
                        <div className="text-xs text-success">
                          {v.now.driver} · {v.now.lastSeenAt ? `seen ${ago(v.now.lastSeenAt, now)}` : 'no signal yet'}
                        </div>
                      )}
                      {v.lastFuel && (
                        <div className="mt-1 flex items-center gap-2 text-xs text-silver" data-testid="fleet-last-fuel">
                          {v.lastFuel.photoUrl && <ReceiptThumb url={v.lastFuel.photoUrl} label={`${v.name} fuel receipt`} />}
                          <span>
                            Last fuel {fmtDate(v.lastFuel.occurredAt)} · {cents(v.lastFuel.costCents)}
                            {v.lastFuel.notes ? ` · ${v.lastFuel.notes}` : ''}
                            {!v.lastFuel.photoUrl && ' · no receipt photo'}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => setRecord(v.id)}>
                        Record
                      </Button>
                      {manage && (
                        <Button size="xs" variant="ghost" onClick={() => setEditing(v)}>
                          Edit
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    {v.driver ? (
                      <Avatar src={personPhotoUrl(v.driver)} name={v.driver.name} email="" size="sm" />
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
                    <Spark daily={st.daily} from={fleet.data!.from} to={fleet.data!.to} label={`${v.name}: earned by day`} />
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
                        {v.isActive ? 'Retire van' : 'Bring back'}
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
      <VansRoster manage={manage} onRecord={setRecord} onEdit={setEditing} />
      {editing && <VanDialog van={editing === 'new' ? null : editing} drivers={drivers} onClose={() => setEditing(null)} />}
      {record && <VanRecordDrawer vanId={record} manage={manage} onClose={() => setRecord(null)} />}
    </div>
  );
}

/**
 * Audit Tier 3: the fleet's plain roster — every van, retired ones too
 * (the cards above are the period's numbers for the live fleet), one line
 * each, from /transport/vans. The record and the edit are one click.
 */
function VansRoster({ manage, onRecord, onEdit }: { manage: boolean; onRecord: (id: string) => void; onEdit: (v: Van) => void }) {
  const q = useQuery({ queryKey: ['transport', 'vans'], queryFn: listVans, staleTime: 60_000 });
  const vans = q.data?.vans ?? [];
  if (q.isError) return <QueryError what="the van list" query={q} />;
  if (q.isLoading) return <Skeleton className="h-24" />;
  if (vans.length === 0) return null;
  return (
    <section aria-label="All vans" className="space-y-2">
      <h3 className="text-base font-medium text-ink">
        All vans <span className="ml-1 text-sm font-normal tabular-nums text-ink-muted">{vans.length}</span>
      </h3>
      <div className="overflow-x-auto">
        <DataGrid<Van>
          id="transport-vans"
          caption="Every van on file"
          rows={vans}
          rowKey={(v) => v.id}
          search={{ placeholder: 'Van…' }}
          urlState={false}
          exportCsv={{ filename: 'vans' }}
          columns={[
            { key: 'name', header: 'Van', accessor: (v) => v.name, sortable: true, primary: true },
            { key: 'plate', header: 'Plate', accessor: (v) => v.plate ?? '', sortable: true, cardMeta: true, className: 'font-mono' },
            { key: 'look', header: 'Make / model', accessor: (v) => v.look, searchable: true },
            { key: 'capacity', header: 'Seats', accessor: (v) => v.capacity, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
            { key: 'driver', header: 'Driver', accessor: (v) => v.driver?.name ?? '', sortable: true, cell: (v) => v.driver?.name ?? '—' },
            {
              key: 'status',
              header: 'Status',
              accessor: (v) => (!v.isActive ? 'Retired' : v.outOfService ? 'Out of service' : 'In service'),
              sortable: true,
              searchable: false,
              cardMeta: true,
              cell: (v) => (
                <Badge size="sm" variant={!v.isActive ? 'default' : v.outOfService ? 'destructive' : 'success'}>
                  {!v.isActive ? 'Retired' : v.outOfService ? `Out of service${v.outOfService.reason ? ` · ${v.outOfService.reason}` : ''}` : 'In service'}
                </Badge>
              ),
            },
            {
              key: 'actions',
              header: '',
              accessor: () => '',
              searchable: false,
              csv: () => '',
              align: 'right',
              stopRowClick: true,
              cell: (v) => (
                <div className="flex items-center justify-end gap-1">
                  <Button size="xs" variant="ghost" onClick={() => onRecord(v.id)}>
                    Record
                  </Button>
                  {manage && (
                    <Button size="xs" variant="ghost" onClick={() => onEdit(v)}>
                      Edit
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>
    </section>
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

/**
 * Which clients each driver picks up for. Drivers ask — all clients, or the
 * ones they want — and wait here for the director; approved clients are the
 * only ones whose seat requests that driver sees. Grant and revoke are
 * direct: the director's word, as with dispatch.
 */
function DriverAccessCard({ manage }: { manage: boolean }) {
  const q = useQuery({ queryKey: ['transport', 'driver-access'], queryFn: getDriverAccess, refetchInterval: 60_000 });
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const [grantDriver, setGrantDriver] = useState('');
  const [grantClient, setGrantClient] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);
  if (q.isError) return <QueryError what="driver access" query={q} />;
  if (!q.data) return <Skeleton className="h-24" />;
  const { rows, clients, drivers } = q.data;
  const pending = rows.filter((r) => r.status === 'REQUESTED');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['transport', 'driver-access'] });
  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  const nameOf = (r: DriverAccessRow) => r.client?.name ?? 'all clients';
  const approve = (r: DriverAccessRow) => act(r.id, () => decideDriverAccess(r.id, 'APPROVED'), `${r.driver.name} now drives for ${nameOf(r)}`);
  const deny = async (r: DriverAccessRow) => {
    const note = await prompt({
      title: `Deny ${nameOf(r)} for ${r.driver.name}?`,
      description: 'The driver sees the reason.',
      reasonLabel: 'Reason',
      required: false,
      confirmLabel: 'Deny',
    });
    if (note === null) return;
    await act(r.id, () => decideDriverAccess(r.id, 'DENIED', note || undefined));
  };
  const revoke = async (r: DriverAccessRow) => {
    const ok = await confirm({
      title: `Take ${nameOf(r)} off ${r.driver.name}?`,
      description: 'They stop seeing those seat requests at once.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    await act(r.id, () => revokeDriverAccess(r.id));
  };
  const grant = () =>
    act(
      'grant',
      () => grantDriverAccess({ driverUserId: grantDriver, ...(grantClient === 'all' ? { all: true } : { clientIds: [grantClient] }) }),
      'Granted',
    );
  const byDriver = drivers.map((d) => ({
    ...d,
    approved: rows.filter((r) => r.driver.userId === d.userId && r.status === 'APPROVED'),
    denied: rows.filter((r) => r.driver.userId === d.userId && r.status === 'DENIED'),
  }));
  return (
    <Card>
      <CardContent className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Driver access</h3>
          <p className="text-xs text-silver">
            Drivers see seat requests from the clients approved here. They ask; you decide — or grant directly.
          </p>
        </div>
        <section aria-label="Access requests">
          {pending.length === 0 ? (
            <p className="text-xs text-silver">No requests waiting.</p>
          ) : (
            <ul className="divide-y divide-navy-secondary/60">
              {pending.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white">
                      {r.driver.name} <span className="text-silver">asked to drive for</span> {nameOf(r)}
                    </div>
                    <div className="text-xs text-silver">
                      {r.note ? `“${r.note}” · ` : ''}
                      {fmtDateTime(r.requestedAt)}
                    </div>
                  </div>
                  {manage && (
                    <>
                      <Button size="xs" onClick={() => void approve(r)} loading={busy === r.id} disabled={busy !== null}>
                        <Check className="h-3.5 w-3.5" />
                        Approve
                      </Button>
                      <Button size="xs" variant="secondary" onClick={() => void deny(r)} disabled={busy !== null}>
                        Deny
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        {byDriver.length > 0 && (
          <ul aria-label="Drivers and their clients" className="space-y-1.5">
            {byDriver.map((d) => (
              <li key={d.userId} className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="mr-1 text-white">{d.name}</span>
                {d.approved.length === 0 && <span className="text-xs text-silver/70">no clients yet</span>}
                {d.approved.map((r) => (
                  <span key={r.id} className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">
                    {r.client?.name ?? 'All clients'}
                    {manage && (
                      <button
                        type="button"
                        aria-label={`Remove ${nameOf(r)} from ${d.name}`}
                        onClick={() => void revoke(r)}
                        disabled={busy !== null}
                        className="rounded hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
                {d.denied.map((r) => (
                  <span key={r.id} className="rounded-full bg-navy-secondary px-2 py-0.5 text-xs text-silver line-through">
                    {r.client?.name ?? 'All clients'}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
        {manage && drivers.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Select size="sm" aria-label="Driver to grant" value={grantDriver} onChange={(e) => setGrantDriver(e.target.value)} className="min-w-[160px]">
              <option value="">Driver…</option>
              {drivers.map((d) => (
                <option key={d.userId} value={d.userId}>
                  {d.name}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label="Client to grant" value={grantClient} onChange={(e) => setGrantClient(e.target.value)} className="min-w-[160px]">
              <option value="all">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="secondary" onClick={() => void grant()} loading={busy === 'grant'} disabled={!grantDriver || busy !== null}>
              Grant
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

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
  // A picked address brings its point, so the stop is on the map without a second lookup.
  const [point, setPoint] = useState<{ lat: number; lng: number; address: string } | null>(null);
  const [notes, setNotes] = useState(stop?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const picked = point && point.address === address.trim() ? { lat: point.lat, lng: point.lng } : {};
      const body = { name: name.trim(), address: address.trim(), notes: notes.trim() || null, ...picked };
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
            {(p) => (
              <AddressAutocomplete
                {...p}
                autoComplete="street-address"
                value={address}
                onChange={setAddress}
                onPick={(s) => {
                  // A stop keeps the whole address on one line, the way a driver reads it.
                  setAddress(s.address);
                  setPoint({ lat: s.lat, lng: s.lng, address: s.address });
                }}
                maxLength={300}
              />
            )}
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

function ChargesTab({ onRider }: { onRider?: (associateId: string) => void }) {
  // Transport walk 13: one range, in the URL, shared with cost per seat below.
  const { from, to } = useChargesRange();
  // Both ends in one write: moving "from" past "to" moves "to" with it, and
  // two setters back to back would each start from the old URL.
  const [, setParams] = useSearchParams();
  const setRange = (r: { from: string; to: string }) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('from', YMD.test(r.from) ? r.from : from);
        next.set('to', YMD.test(r.to) ? r.to : to);
        return next;
      },
      { replace: true },
    );
  const charges = useQuery({ queryKey: ['transport', 'charges', from, to], queryFn: () => getTransportCharges(from, to) });
  const rows = charges.data?.rows ?? [];
  const totals = charges.data?.totals;
  // Who's costing us seats: two or more no-shows in the range.
  const repeat = rows.filter((r) => r.noShows >= 2).sort((a, b) => b.noShows - a.noShows);
  const exportCsv = () =>
    downloadCsv(`ride-charges-${from}-to-${to}.csv`, [
      ['Associate', 'Rides', 'No-shows', 'Still owed', 'Taken from pay', 'Deferred (minimum-wage guard)', 'Not authorized (not deducted)', 'Waived', 'Authorization'],
      ...rows.map((r) => [
        r.name,
        r.rides,
        r.noShows,
        (r.owedCents / 100).toFixed(2),
        (r.takenCents / 100).toFixed(2),
        ((r.deferredCents ?? 0) / 100).toFixed(2),
        ((r.unauthorizedCents ?? 0) / 100).toFixed(2),
        (r.waivedCents / 100).toFixed(2),
        AUTHORIZATION_LABEL[r.authorization ?? 'none'],
      ]),
    ]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <DateRangeField
          size="sm"
          from={from}
          to={to}
          fromLabel="From"
          toLabel="To"
          onChange={(r) => setRange(r)}
        />
        <Button size="sm" variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="h-3.5 w-3.5" />
          CSV
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href={transportChargesCsvUrl(from, to)} download title="The server's CSV of the same report, with a totals line">
            <Download className="h-3.5 w-3.5" />
            Server CSV
          </a>
        </Button>
      </div>
      {repeat.length > 0 && (
        <Card className="border-warning/40">
          <CardContent>
            <p className="text-sm font-medium text-ink">
              Repeat no-shows · {repeat.length} {repeat.length === 1 ? 'rider' : 'riders'} with 2 or more in these dates
            </p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-silver">
              {repeat.slice(0, 12).map((r) => (
                <li key={r.associateId}>
                  <button type="button" className="text-ink hover:underline" onClick={() => onRider?.(r.associateId)}>
                    {r.name}
                  </button>{' '}
                  · {r.noShows} no-shows · {r.rides} rides
                </li>
              ))}
              {repeat.length > 12 && <li>and {repeat.length - 12} more</li>}
            </ul>
          </CardContent>
        </Card>
      )}
      {totals && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricCard label="Rides" value={totals.rides} />
          <MetricCard label="No-shows" value={totals.noShows} />
          <MetricCard label="Still owed" value={cents(totals.owedCents)} hint="comes out at the next payroll" />
          <MetricCard label="Taken from pay" value={cents(totals.takenCents)} />
          <MetricCard label="Waived" value={cents(totals.waivedCents)} hint="by transportation, with a reason" />
          <MetricCard label="Not authorized" value={cents(totals.unauthorizedCents ?? 0)} hint="no signed authorization — not charged" accent={(totals.unauthorizedCents ?? 0) > 0} />
        </div>
      )}
      {totals && ((totals.deferredCents ?? 0) > 0 || (totals.unauthorizedCents ?? 0) > 0) && (
        <p className="text-xs text-silver">
          {(totals.deferredCents ?? 0) > 0 && (
            <>
              <span className="font-medium text-white">{cents(totals.deferredCents)}</span> deferred by the minimum-wage guard — taken from a later check.{' '}
            </>
          )}
          {(totals.unauthorizedCents ?? 0) > 0 && (
            <>
              <span className="font-medium text-white">{cents(totals.unauthorizedCents)}</span> not deducted — no signed authorization on file. See Fares → Authorizations.
            </>
          )}
        </p>
      )}
      {charges.isLoading ? (
        <Skeleton className="h-40" />
      ) : charges.isError ? (
        <QueryError what="the charges" query={charges} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Bus} title="No charges in these dates" />
      ) : (
        <div className="overflow-x-auto">
          <DataGrid<(typeof rows)[number]>
            id="ride-charges"
            caption="Ride charges by associate"
            rows={rows}
            rowKey={(r) => r.associateId}
            search={{ placeholder: 'Associate…' }}
            urlState={false}
            exportCsv={{ filename: 'ride-charges' }}
            columns={[
              { key: 'associate', header: 'Associate', accessor: (r) => r.name, sortable: true, primary: true, cell: (r) => <RiderName ride={{ rider: { associateId: r.associateId, name: r.name, phone: null } }} onRider={onRider} /> },
              { key: 'rides', header: 'Rides', accessor: (r) => r.rides, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
              { key: 'noShows', header: 'No-shows', accessor: (r) => r.noShows, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
              { key: 'owed', header: 'Still owed', accessor: (r) => r.owedCents, csv: (r) => cents(r.owedCents), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (r) => cents(r.owedCents) },
              { key: 'taken', header: 'Taken from pay', accessor: (r) => r.takenCents, csv: (r) => cents(r.takenCents), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => cents(r.takenCents) },
              { key: 'deferred', header: 'Deferred', accessor: (r) => r.deferredCents ?? 0, csv: (r) => cents(r.deferredCents ?? 0), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => cents(r.deferredCents ?? 0) },
              { key: 'unauthorized', header: 'Not authorized', accessor: (r) => r.unauthorizedCents ?? 0, csv: (r) => cents(r.unauthorizedCents ?? 0), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => cents(r.unauthorizedCents ?? 0) },
              { key: 'waived', header: 'Waived', accessor: (r) => r.waivedCents, csv: (r) => cents(r.waivedCents), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => cents(r.waivedCents) },
              { key: 'authorization', header: 'Authorization', accessor: (r) => AUTHORIZATION_LABEL[r.authorization ?? 'none'], sortable: true, searchable: false, cell: (r) => <AuthorizationChip status={r.authorization ?? 'none'} /> },
            ]}
          />
        </div>
      )}
    </div>
  );
}

/* ===== Fares ================================================================ */

const AUTHORIZATION_LABEL: Record<RideAuthorizationState, string> = {
  current: 'Signed',
  none: 'Must sign',
  legacy: 'Must sign (old one-click consent)',
  outdated: 'Must sign again (rate or wording changed)',
  withdrawn: 'Withdrawn',
};

function AuthorizationChip({ status }: { status: RideAuthorizationState }) {
  const variant = status === 'current' ? 'success' : status === 'withdrawn' ? 'destructive' : 'pending';
  return <Badge variant={variant}>{status === 'current' ? 'Signed' : status === 'withdrawn' ? 'Withdrawn' : 'Must sign'}</Badge>;
}

function SettingsTab({ manage }: { manage: boolean }) {
  const settings = useQuery({ queryKey: ['transport', 'settings'], queryFn: getTransportSettings });
  if (settings.isError) return <QueryError what="the transport settings" query={settings} />;
  if (settings.isLoading || !settings.data) return <Skeleton className="h-40 max-w-md" />;
  return (
    <div className="space-y-6">
      <SettingsForm
        key={JSON.stringify(settings.data.settings)}
        initial={settings.data.settings}
        rates={settings.data.rates ?? []}
        geocoder={settings.data.geocoder ?? null}
        manage={manage}
      />
      <AuthorizationsSection manage={manage} />
    </div>
  );
}

/** Brief 1A-3: every rate that has been in force, newest first. */
function RateHistory({ rates }: { rates: RideRate[] }) {
  if (rates.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-silver hover:text-white">Rate history ({rates.length})</summary>
      <div className="overflow-x-auto">
      <table className="mt-2 w-full text-left text-xs">
        <caption className="sr-only">Ride rate history</caption>
        <thead>
          <tr className="text-silver">
            <th scope="col" className="py-1 pr-3 font-medium">From</th>
            <th scope="col" className="py-1 pr-3 font-medium">To</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Fare</th>
            <th scope="col" className="py-1 text-right font-medium">No-show</th>
          </tr>
        </thead>
        <tbody>
          {rates.map((r) => (
            <tr key={r.id} className="border-t border-navy-secondary text-white">
              <td className="py-1 pr-3 tabular-nums">{r.effectiveFrom}</td>
              <td className="py-1 pr-3 tabular-nums">{r.effectiveTo ?? 'current'}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{cents(r.fareCents)}</td>
              <td className="py-1 text-right tabular-nums">{cents(r.noShowFeeCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </details>
  );
}

/** Brief 1A-3: who has signed the ride charge authorization, and who must. */
function AuthorizationsSection({ manage }: { manage: boolean }) {
  const q = useQuery({ queryKey: ['transport', 'authorizations'], queryFn: getRideAuthorizations });
  const rows = q.data?.rows ?? [];
  const signed = rows.filter((r) => r.status === 'current').length;
  const unsigned = rows.filter((r) => r.status === 'none' || r.status === 'legacy' || r.status === 'outdated');
  const mustSign = unsigned.length;
  const withdrawn = rows.filter((r) => r.status === 'withdrawn').length;
  // Transport walk 8: the table can nudge — everyone who must sign, or one row.
  const ask = useMutation({
    mutationFn: (ids: string[]) => remindUnsignedRiders(ids),
    onSuccess: (r) => toast.success(r.sent ? `Asked ${r.sent} ${r.sent === 1 ? 'rider' : 'riders'} to sign${r.skipped ? ` (${r.skipped} reminded in the last day or not reachable)` : ''}.` : 'Everyone here was reminded in the last day, or has no login to reach.'),
    onError: (err) => toast.error(errMsg(err)),
  });
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-white">Authorizations</h3>
        <p className="text-xs text-silver">
          A rider is charged only with a signed written authorization on file that covers the fare. A signature covers any fare up to the one signed
          for, so only a rate increase asks everyone to sign again.
        </p>
      </div>
      <UnsignedRiders manage={manage} />
      {q.isLoading ? (
        <Skeleton className="h-24" />
      ) : q.isError ? (
        <QueryError what="the authorizations" query={q} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Bus} title="No riders yet" />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid flex-1 grid-cols-3 gap-3 sm:max-w-md">
              <MetricCard label="Signed" value={signed} />
              <MetricCard label="Must sign" value={mustSign} hint={mustSign > 0 ? 'cannot book or be charged' : undefined} />
              <MetricCard label="Withdrawn" value={withdrawn} />
            </div>
            {manage && mustSign > 0 && (
              <Button size="sm" loading={ask.isPending} disabled={ask.isPending} onClick={() => ask.mutate(unsigned.map((r) => r.associateId))}>
                Ask all {mustSign} to sign
              </Button>
            )}
          </div>
          <div className="overflow-x-auto">
            <DataGrid<RideAuthorizationRow>
              id="ride-authorizations"
              caption="Ride charge authorizations by associate"
              rows={rows}
              rowKey={(r) => r.associateId}
              search={{ placeholder: 'Associate…' }}
              urlState={false}
              exportCsv={{ filename: 'ride-authorizations' }}
              columns={[
                { key: 'associate', header: 'Associate', accessor: (r) => r.name, sortable: true, primary: true },
                { key: 'status', header: 'Status', accessor: (r) => AUTHORIZATION_LABEL[r.status], sortable: true, searchable: false, cardMeta: true, cell: (r) => <AuthorizationChip status={r.status} /> },
                { key: 'signedAt', header: 'Signed', accessor: (r) => r.signedAt ?? '', sortable: true, searchable: false, cell: (r) => (r.signedAt ? `${fmtDateTime(r.signedAt)} as ${r.signedName ?? ''}` : '—') },
                { key: 'rate', header: 'Rate signed', accessor: (r) => r.fareCents ?? 0, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.fareCents === null ? '—' : `${cents(r.fareCents)} · ${cents(r.noShowFeeCents ?? 0)}`) },
                { key: 'reason', header: 'Note', accessor: (r) => r.reason ?? '', searchable: false, cell: (r) => <span className="text-silver">{r.status === 'current' ? '' : (r.reason ?? '')}</span> },
                ...(manage
                  ? [
                      {
                        key: 'ask',
                        header: '',
                        accessor: () => '',
                        searchable: false,
                        csv: () => '',
                        align: 'right' as const,
                        stopRowClick: true,
                        cell: (r: RideAuthorizationRow) =>
                          r.status === 'current' || r.status === 'withdrawn' ? null : (
                            <Button size="xs" variant="ghost" disabled={ask.isPending} onClick={() => ask.mutate([r.associateId])}>
                              Ask
                            </Button>
                          ),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Riders with a ride coming up whose authorization doesn't cover it: their
 * rides would be marked and cost them nothing. Ask them to sign first.
 */
function UnsignedRiders({ manage }: { manage: boolean }) {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['transport', 'unsigned'], queryFn: listUnsignedRiders });
  const remind = useMutation({
    mutationFn: (ids?: string[]) => remindUnsignedRiders(ids),
    onSuccess: (r) => {
      toast.success(r.sent ? `Asked ${r.sent} ${r.sent === 1 ? 'rider' : 'riders'} to sign${r.skipped ? ` (${r.skipped} reminded in the last day or not reachable)` : ''}.` : 'Everyone here was reminded in the last day.');
      void queryClient.invalidateQueries({ queryKey: ['transport', 'unsigned'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send the reminders.'),
  });
  const people = q.data?.people ?? [];
  if (q.isLoading) return <Skeleton className="h-20" />;
  if (q.isError || people.length === 0) return null;
  const atRisk = people.reduce((n, p) => n + p.atRiskCents, 0);
  const held = people.reduce((n, p) => n + (p.heldCents ?? 0), 0);
  return (
    <Card className="border-warning/40">
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              {people.length} {people.length === 1 ? 'rider needs' : 'riders need'} to sign the ride authorization
            </p>
            <p className="mt-0.5 text-xs text-silver">
              {held > 0 && `${cents(held)} for rides already taken is held until they sign. `}
              {atRisk > 0 && `${cents(atRisk)} in fares over the next two weeks will be held too if they ride unsigned. `}
              A ride taken is never waived — it comes out of pay once they sign.
            </p>
          </div>
          {manage && (
            <Button size="sm" loading={remind.isPending} disabled={remind.isPending || !people.some((p) => p.canNotify)} onClick={() => remind.mutate(undefined)}>
              Ask them to sign
            </Button>
          )}
        </div>
        <ul className="divide-y divide-navy-secondary text-sm">
          {people.slice(0, 8).map((p) => (
            <li key={p.associateId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="block truncate text-ink">{p.name}</span>
                <span className="block text-xs text-silver">
                  {p.nextRideAt ? `Next ride ${fmtDateTime(p.nextRideAt)} · ${p.rides} ${p.rides === 1 ? 'ride' : 'rides'} · ` : ''}
                  {p.heldCents > 0 ? `${cents(p.heldCents)} held for ${p.heldRides} ${p.heldRides === 1 ? 'ride' : 'rides'} taken · ` : ''}
                  {p.reason}
                </span>
              </span>
              {manage && p.canNotify && (
                <Button size="xs" variant="ghost" disabled={remind.isPending} onClick={() => remind.mutate([p.associateId])}>
                  Remind
                </Button>
              )}
            </li>
          ))}
        </ul>
        {people.length > 8 && <p className="text-xs text-silver">and {people.length - 8} more</p>}
      </CardContent>
    </Card>
  );
}

function SettingsForm({
  initial,
  rates,
  geocoder,
  manage,
}: {
  initial: TransportSettings;
  rates: RideRate[];
  geocoder: GeocoderStatus | null;
  manage: boolean;
}) {
  const queryClient = useQueryClient();
  const [fare, setFare] = useState((initial.fareCents / 100).toFixed(2));
  const [fee, setFee] = useState((initial.noShowFeeCents / 100).toFixed(2));
  const [effectiveFrom, setEffectiveFrom] = useState(ymdLocal(new Date()));
  const rateChanged = Math.round(Number(fare) * 100) !== initial.fareCents || Math.round(Number(fee) * 100) !== initial.noShowFeeCents;
  const [cutoff, setCutoff] = useState(String(initial.cutoffHours));
  const [shortNotice, setShortNotice] = useState(String(initial.shortNoticeMinutes));
  const [dispatchPhone, setDispatchPhone] = useState(initial.dispatchPhone ?? '');
  // Drivers' hours of service and the pre-trip check.
  const [maxHours, setMaxHours] = useState(String(initial.driverMaxHoursPerDay ?? 10));
  const [minRest, setMinRest] = useState(String(initial.driverMinRestHours ?? 8));
  const [preTrip, setPreTrip] = useState(initial.preTripRequired ?? true);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await saveTransportSettings({
        fareCents: Math.round(Number(fare) * 100),
        noShowFeeCents: Math.round(Number(fee) * 100),
        cutoffHours: Number(cutoff),
        shortNoticeMinutes: Math.max(0, Math.round(Number(shortNotice) || 0)),
        dispatchPhone: dispatchPhone.trim() || null,
        driverMaxHoursPerDay: Math.min(24, Math.max(1, Math.round(Number(maxHours) || 10))),
        driverMinRestHours: Math.min(24, Math.max(0, Math.round(Number(minRest) || 0))),
        preTripRequired: preTrip,
        ...(rateChanged ? { effectiveFrom } : {}),
      });
      toast.success(rateChanged ? `Saved — the new rate starts ${effectiveFrom}; riders sign again before their next booking` : 'Saved — new bookings use these');
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const lookup =
    geocoder === null
      ? null
      : geocoder.primary === 'mapbox'
        ? 'Mapbox, with OpenStreetMap behind it — house numbers, apartment complexes and businesses.'
        : geocoder.primary === 'nominatim'
          ? 'OpenStreetMap only — limited house-number coverage and one lookup a second. Set MAPBOX_TOKEN on the API to fix "my address doesn’t come up".'
          : 'Off — riders can only pick a stop, a saved address, or where they are.';
  return (
    <Card className="max-w-md">
      <CardContent className="space-y-4">
        <Field label="Fare per ride ($)" hint="Each way. A round trip is two rides.">
          {(p) => <Input {...p} type="number" min={0} step="0.25" value={fare} onChange={(e) => setFare(e.target.value)} disabled={!manage} />}
        </Field>
        <Field label="No-show fee ($)" hint="When the driver marks a rider who didn't come.">
          {(p) => <Input {...p} type="number" min={0} step="0.25" value={fee} onChange={(e) => setFee(e.target.value)} disabled={!manage} />}
        </Field>
        {rateChanged && (
          <Field label="New rate effective from" hint="Rides booked from this day are priced at the new rate. Every rider signs a new authorization naming it before their next booking.">
            {(p) => <Input {...p} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} disabled={!manage} className="w-44" />}
          </Field>
        )}
        <RateHistory rates={rates} />
        <Field label="Plan ahead (hours)" hint="Rides booked this far ahead are planned onto vans. Inside it, see short notice.">
          {(p) => <Input {...p} type="number" min={0} max={72} value={cutoff} onChange={(e) => setCutoff(e.target.value)} disabled={!manage} />}
        </Field>
        <Field
          label="Short notice (minutes)"
          hint="Inside the planning window a rider can still request a seat up to this close to the time. Drivers see it flagged and you are told; it is real only once a driver takes it. 0 turns short notice off."
        >
          {(p) => (
            <Input {...p} type="number" min={0} max={1440} step={15} value={shortNotice} onChange={(e) => setShortNotice(e.target.value)} disabled={!manage} />
          )}
        </Field>
        <Field label="Dispatch phone" hint="Shown to riders, with a tap-to-call link, when a ride can't be requested in time.">
          {(p) => (
            <Input {...p} type="tel" value={dispatchPhone} onChange={(e) => setDispatchPhone(e.target.value)} placeholder="(850) 555-0100" maxLength={40} disabled={!manage} />
          )}
        </Field>
        <div className="space-y-3 border-t border-navy-secondary pt-4">
          <h3 className="text-sm font-medium text-ink">Drivers</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Most hours a day" hint="Driver shifts and runs past this are refused.">
              {(p) => <Input {...p} type="number" min={1} max={24} value={maxHours} onChange={(e) => setMaxHours(e.target.value)} disabled={!manage} />}
            </Field>
            <Field label="Rest between shifts (hours)" hint="A shift this close to another is refused.">
              {(p) => <Input {...p} type="number" min={0} max={24} value={minRest} onChange={(e) => setMinRest(e.target.value)} disabled={!manage} />}
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm text-ink coarse:min-h-11">
            <input type="checkbox" className="mt-0.5 h-4 w-4 coarse:h-6 coarse:w-6" checked={preTrip} onChange={(e) => setPreTrip(e.target.checked)} disabled={!manage} />
            <span>
              Pre-trip check before every run
              <span className="block text-xs text-silver">A failed safety item keeps the van on the lot and opens a vehicle issue. Off only for a fleet that checks on paper.</span>
            </span>
          </label>
        </div>
        {lookup && (
          <p className="text-xs text-silver">
            <span className="font-medium text-white">Address search:</span> {lookup}
          </p>
        )}
        <p className="text-xs text-silver">
          Changes apply to new bookings. Rides already booked keep the fare the rider signed for; a rider is never charged without a signed
          authorization, and no check takes ride charges past the minimum wage for the hours worked.
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
