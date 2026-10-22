import { useEffect, useMemo, useRef, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Link, useSearchParams } from 'react-router-dom';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { hapticConfirm } from '@/lib/haptics';
import {
  ArrowLeftRight,
  CalendarCheck,
  BellRing,
  CalendarOff,
  Check,
  ChevronLeft,
  ClipboardCheck,
  DoorOpen,
  Store,
  X,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { TIMESHEET_QUEUE_WINDOW_DAYS, timesheetQueuePath, type TimeOffRequest } from '@alto-people/shared';
import {
  approveAdminRequest,
  bulkDecideRequests,
  denyAdminRequest,
  listAdminRequests,
} from '@/lib/timeOffApi';
import {
  approveOpenShiftClaim,
  listAdminSwaps,
  listOpenShiftClaims,
  listUnconfirmedShifts,
  managerApproveSwap,
  managerRejectSwap,
  rejectOpenShiftClaim,
} from '@/lib/schedulingApi';
import {
  approveClockInRequest,
  countAdminTimeEntries,
  denyClockInRequest,
  listClockInRequests,
} from '@/lib/timeApi';
import type { ClockInRequestRow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtRelativeDayTz, fmtShiftTz, fmtTime, parseYmd, ymdLocal } from '@/lib/format';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { usePrompt } from '@/lib/confirm';
import { useClientBounded } from '@/lib/useClientBounded';
import { useSelection } from '@/lib/useSelection';
import { useListKeyboard } from '@/lib/shortcuts';
import { DeskTemplate } from '@/components/templates';
import { EmptyState } from '@/components/ui/EmptyState';
import { AsOf } from '@/components/ui/AsOf';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { AdminUnconfirmedPanel } from '@/pages/scheduling/AdminApprovalPanels';
import { PendingTimesheetsPanel } from '@/pages/time/PendingTimesheetsPanel';
import { useAuth, useTerm } from '@/lib/auth';
import { ProposalList } from '@/components/agents/ProposalDecision';
import { listMyProposals, MY_PROPOSALS_KEY } from '@/lib/agentProposalsApi';
import { listApprovalRequests, MY_REQUESTS_KEY } from '@/lib/approvalRequestsApi';
import { ApprovalRequestList } from '@/components/approvals/ApprovalRequestCard';
import { DelegationDialog } from '@/components/approvals/DelegationDialog';

/**
 * One inbox for everything waiting on a manager's decision. Before this
 * page, the queues were scattered: swaps + pickups + unconfirmed shifts
 * at the bottom of /scheduling, time off in its own tab, timesheets on
 * /time-attendance — a manager had to remember to visit each one. Here
 * they all stack on a single URL that can be checked (or deep-linked)
 * in one pass.
 *
 * The swap + pickup panels here are LOCAL variants of the shared
 * AdminApprovalPanels — same queries and single-decide endpoints, plus
 * row checkboxes and an "Approve selected (n)" bulk bar (the shared
 * panels on /scheduling stay checkbox-free).
 */
const TIME_OFF_KEY = ['approvals', 'timeOff'] as const;
const SWAPS_KEY = ['approvals', 'swaps'] as const;
const PICKUPS_KEY = ['approvals', 'pickups'] as const;
const CLOCK_INS_KEY = ['approvals', 'clockIns'] as const;

/* Query options shared by the summary strip and the panels — one cache
 * entry per queue, so the count on a tile is always the list below it. */
const clockInsQuery = {
  queryKey: CLOCK_INS_KEY,
  queryFn: async () => {
    try {
      return (await listClockInRequests('PENDING')).requests;
    } catch (err) {
      // 403 = not permitted — hide the whole panel (null), never an
      // asserted "no one is waiting" the caller can't actually know.
      if (err instanceof ApiError && err.status === 403) return null;
      throw err;
    }
  },
  // Someone is at the kiosk — keep this fresher than the other panels.
  refetchInterval: 60_000,
};
const timeOffQuery = {
  queryKey: TIME_OFF_KEY,
  queryFn: async () => {
    try {
      return (await listAdminRequests('PENDING')).requests;
    } catch (err) {
      // 403 = not permitted to see the admin queue — an honest empty
      // list, not an error.
      if (err instanceof ApiError && err.status === 403) return [];
      throw err;
    }
  },
};
const swapsQuery = {
  queryKey: SWAPS_KEY,
  queryFn: () => listAdminSwaps({ status: 'PEER_ACCEPTED' }),
};
const pickupsQuery = {
  queryKey: PICKUPS_KEY,
  queryFn: () => listOpenShiftClaims(),
};
/* What an agent proposes and this person may decide ("agents propose,
 * people decide"): the server filters the list to the caller's own rule,
 * so a site supervisor sees their shifts' proposals and nothing else. */
const proposalsQuery = {
  queryKey: MY_PROPOSALS_KEY,
  queryFn: async () => (await listMyProposals()).approvals,
  refetchInterval: 60_000,
};

/* The approval engine's requests: changes that need a second person — pay
 * and bill rates, separations, promotions, requisitions, access — already
 * filtered to what this person may decide (never their own). */
const requestsQuery = {
  queryKey: MY_REQUESTS_KEY,
  queryFn: async () => (await listApprovalRequests('decide')).requests,
  refetchInterval: 60_000,
};

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

/** "Today · 9:00 PM", "Tomorrow · 6:00 AM", "Sat, Sep 19 · 6:00 AM" — on
 *  the shift's own store clock (one shift, one time). */
const when = (iso: string, tz?: string | null) => `${fmtRelativeDayTz(iso, tz)} · ${fmtShiftTz(iso, tz, { day: false })}`;


/** The queues on the desk, in the order they are worked. */
type QueueKey = 'walk-ins' | 'time-off' | 'swaps' | 'pickups' | 'proposals' | 'requests' | 'timesheets' | 'unconfirmed';

/** ?tab= names a queue (the links' contract: swaps, pickups, walkins,
 *  timeoff, proposals, requests, unconfirmed); an item param names one row
 *  and implies its queue. Exported for tests. */
const TAB_QUEUES: Record<string, QueueKey> = {
  swaps: 'swaps',
  pickups: 'pickups',
  walkins: 'walk-ins',
  'walk-ins': 'walk-ins',
  timeoff: 'time-off',
  'time-off': 'time-off',
  proposals: 'proposals',
  requests: 'requests',
  timesheets: 'timesheets',
  unconfirmed: 'unconfirmed',
};

/* The shifts nobody has confirmed — the same cache entry the chase panel
 * reads (AdminApprovalPanels), so the count on the tile is its list. */
const unconfirmedQuery = {
  queryKey: ['approvals', 'unconfirmed'] as const,
  queryFn: async () => {
    try {
      return (await listUnconfirmedShifts()).shifts;
    } catch {
      return [];
    }
  },
};

/** The queue's name and its one-line state, by count — translated. */
const QUEUE_TEXT: Record<QueueKey, { label: MessageKey; busy: MessageKey; idle: MessageKey }> = {
  'walk-ins': { label: 'appr.q.walkIns', busy: 'appr.q.walkInsBusy', idle: 'appr.q.walkInsIdle' },
  'time-off': { label: 'appr.q.timeOff', busy: 'appr.q.timeOffBusy', idle: 'appr.q.idle' },
  swaps: { label: 'appr.q.swaps', busy: 'appr.q.swapsBusy', idle: 'appr.q.idle' },
  pickups: { label: 'appr.q.pickups', busy: 'appr.q.pickupsBusy', idle: 'appr.q.idle' },
  proposals: { label: 'appr.q.proposals', busy: 'appr.q.proposalsBusy', idle: 'appr.q.idle' },
  requests: { label: 'appr.q.requests', busy: 'appr.q.requestsBusy', idle: 'appr.q.idle' },
  timesheets: { label: 'appr.q.timesheets', busy: 'appr.q.timesheetsBusy', idle: 'appr.q.idle' },
  unconfirmed: { label: 'appr.q.unconfirmed', busy: 'appr.q.unconfirmedBusy', idle: 'appr.q.unconfirmedIdle' },
};
export function queueFromParams(p: URLSearchParams): QueueKey | null {
  if (p.get('request')) return 'time-off';
  if (p.get('walkin')) return 'walk-ins';
  if (p.get('swap')) return 'swaps';
  if (p.get('pickup')) return 'pickups';
  if (p.get('proposal')) return 'proposals';
  if (p.get('approval')) return 'requests';
  return TAB_QUEUES[p.get('tab') ?? ''] ?? null;
}

export function ApprovalsHome() {
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const { t } = useI18n();
  // The tenant's full approval record (Settings & trust → Audit) is for the audit desk, admins and Finance.
  const canReadRecord = can('view:audit') || can('manage:org') || can('process:payroll');
  // Pull down from the top = refetch everything on the page — the gesture
  // approvers reach for by habit on a phone.
  const pullState = usePullToRefresh(() => queryClient.invalidateQueries());
  // The queue a person opened (or a notification deep-linked: ?request=
  // lands on time off, ?walkin= on the kiosk queue). Nothing picked: the
  // desk opens the first queue with work on desktop, and on a phone the
  // queue list is the page.
  const [searchParams, setSearchParams] = useSearchParams();
  const [picked, setPicked] = useState<QueueKey | null>(() => queueFromParams(searchParams));
  // ?approval=<id> (a request's notification, the Inbox, a pay-change row) lands on that card.
  const [focusRequest, setFocusRequest] = useState<string | null>(() => searchParams.get('approval'));
  const [coverOpen, setCoverOpen] = useState(false);
  // ?proposal=<id> (an agent's notification, the decision queue, the control
  // room) lands on that proposal's card; consumed once seen so Back and
  // refetches do not re-open it.
  const [focusProposal, setFocusProposal] = useState<string | null>(() => searchParams.get('proposal'));
  useEffect(() => {
    if (!searchParams.get('proposal') && !searchParams.get('tab') && !searchParams.get('approval')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('proposal');
    next.delete('approval');
    next.delete('tab');
    setSearchParams(next, { replace: true });
    // Consumed once; the params' identity changes on the consume itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Timesheets are reviewed on Time & attendance; the tile is best-effort
  // and carries its own retry when the count fails.
  const timesheetQuery = useQuery({
    queryKey: ['approvals', 'timesheetCount'],
    queryFn: () => countAdminTimeEntries('COMPLETED'),
  });
  const clockIns = useQuery(clockInsQuery);
  const timeOffQ = useQuery(timeOffQuery);
  const swaps = useQuery(swapsQuery);
  const pickups = useQuery(pickupsQuery);
  const proposals = useQuery(proposalsQuery);
  const requests = useQuery(requestsQuery);
  const unconfirmed = useQuery(unconfirmedQuery);

  const timesheetCount = timesheetQuery.data?.count ?? null;
  const timesheetFailed = timesheetQuery.isError;
  // The full queue opens on the rows the count counted: the oldest pending
  // day through today (shared timesheetQueuePath — one link everywhere).
  const today = ymdLocal();
  const windowStart = ymdLocal(new Date(Date.now() - TIMESHEET_QUEUE_WINDOW_DAYS * 86_400_000));
  const oldestPending = timesheetQuery.data?.oldestPendingAt ? ymdLocal(new Date(timesheetQuery.data.oldestPendingAt)) : null;
  const timesheetLink = timesheetCount
    ? timesheetQueuePath({ from: oldestPending ?? windowStart, to: today })
    : '/time-attendance?tab=queue';
  const timeOff = timeOffQ.data ?? null;
  const timeOffError = timeOffQ.isError
    ? timeOffQ.error instanceof Error
      ? timeOffQ.error.message
      : 'Could not load time-off requests.'
    : null;

  // null = still loading (or not permitted, for the kiosk queue).
  const walkIns = clockIns.data === undefined ? undefined : (clockIns.data?.length ?? null);
  const counts = {
    walkIns,
    timeOff: timeOff?.length,
    swaps: swaps.data?.requests.length,
    pickups: pickups.data?.claims.length,
    proposals: proposals.isError ? 0 : proposals.data?.length,
    requests: requests.isError ? 0 : requests.data?.length,
  };
  const loaded =
    counts.walkIns !== undefined &&
    counts.timeOff !== undefined &&
    counts.swaps !== undefined &&
    counts.pickups !== undefined &&
    counts.proposals !== undefined &&
    counts.requests !== undefined;
  const decisions =
    (counts.walkIns ?? 0) + (counts.timeOff ?? 0) + (counts.swaps ?? 0) + (counts.pickups ?? 0) + (counts.proposals ?? 0) + (counts.requests ?? 0);
  const anyError = !!timeOffError || clockIns.isError || swaps.isError || pickups.isError || proposals.isError || requests.isError;
  const oldestWalkIn = (clockIns.data ?? [])
    .map((r) => r.requestedAt)
    .sort()[0];
  const clear = loaded && decisions === 0 && !anyError;

  const subtitle = !loaded
    ? t('appr.subtitle')
    : decisions === 0
      ? timesheetCount
        ? t(timesheetCount === 1 ? 'appr.subNoDecisionsOneSheet' : 'appr.subNoDecisionsSheets', { n: timesheetCount })
        : t('appr.subNothing')
      : `${t(decisions === 1 ? 'appr.subOneDecision' : 'appr.subDecisions', { n: decisions })}${
          oldestWalkIn ? ` — ${t('appr.subKiosk', { since: waitingSince(oldestWalkIn).replace('waiting ', '') })}` : ''
        }.`;

  // ---- The desk (design system §4.5, UX upgrade step 6): the queues on
  // the left with their counts, the open queue's worklist on the right with
  // the decisions inside it. On a phone the queue list is the page and the
  // worklist opens over it.
  const unconfirmedCount = unconfirmed.data?.length;
  const queueRow = (key: QueueKey, value: number | null | undefined, extra: { sub?: string; urgent?: boolean } = {}) => ({
    key,
    label: t(QUEUE_TEXT[key].label),
    value,
    sub: extra.sub ?? t(value ? QUEUE_TEXT[key].busy : QUEUE_TEXT[key].idle),
    urgent: extra.urgent,
  });
  // The desk order, the order they are worked. Timesheets and the
  // unconfirmed chase are queues like the rest (role walk HR 16, floor 7):
  // counted, opened here, and folded with the zeros when empty.
  const queues: Array<{ key: QueueKey; label: string; value: number | null | undefined; sub: string; urgent?: boolean }> = [
    ...(counts.walkIns !== null
      ? [
          queueRow('walk-ins', counts.walkIns, {
            sub: counts.walkIns && oldestWalkIn ? t('appr.q.walkInsOldest', { since: waitingSince(oldestWalkIn) }) : undefined,
            urgent: !!counts.walkIns,
          }),
        ]
      : []),
    queueRow('time-off', timeOffError ? null : counts.timeOff),
    queueRow('swaps', swaps.isError ? null : counts.swaps),
    queueRow('pickups', pickups.isError ? null : counts.pickups),
    queueRow('proposals', proposals.isError ? null : counts.proposals),
    queueRow('requests', requests.isError ? null : counts.requests),
    queueRow('timesheets', timesheetFailed ? null : timesheetQuery.data ? timesheetCount : undefined),
    queueRow('unconfirmed', unconfirmedCount),
  ];
  const firstWithWork = queues.find((q) => typeof q.value === 'number' && q.value > 0)?.key ?? null;
  const openQueue: QueueKey | null = picked ?? (loaded ? firstWithWork : null);
  const openCount = queues.find((q) => q.key === openQueue)?.value;
  const openLabel = queues.find((q) => q.key === openQueue)?.label ?? t('appr.q.unconfirmed');

  // When the queue being worked runs dry, move on to the next one with
  // work (in desk order, wrapping) instead of leaving an empty panel —
  // only after it had something in it, so a link to an already-decided
  // item doesn't bounce the reader somewhere they didn't ask for.
  // A decision still on its way to the server doesn't count: the row leaves
  // the list before the answer, and a refusal (over balance, already taken)
  // puts it back — the queue is only clear once that's settled.
  const decisionsInFlight = useIsMutating();
  const hadWorkRef = useRef<{ key: QueueKey | null; had: boolean }>({ key: null, had: false });
  useEffect(() => {
    if (hadWorkRef.current.key !== picked) hadWorkRef.current = { key: picked, had: false };
    if (!picked || typeof openCount !== 'number') return;
    if (decisionsInFlight > 0) return;
    if (openCount > 0) {
      hadWorkRef.current.had = true;
      return;
    }
    if (!hadWorkRef.current.had) return;
    const order = queues.map((q) => q.key);
    const at = order.indexOf(picked);
    const next = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))]
      .map((k) => queues.find((q) => q.key === k)!)
      .find((q) => typeof q.value === 'number' && q.value > 0);
    const doneLabel = queues.find((q) => q.key === picked)?.label ?? t('appr.thatQueue');
    if (next) {
      toast.success(`${doneLabel} is clear — on to ${next.label.toLowerCase()}.`);
      setPicked(next.key);
    } else {
      toast.success(`${doneLabel} is clear — nothing else is waiting on you.`);
    }
    hadWorkRef.current = { key: next?.key ?? picked, had: false };
    // queues is rebuilt every render from the counts already in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, openCount, decisionsInFlight]);

  // What has work first, in desk order; still loading or failed next (a
  // count nobody knows is not "clear"); the zeros fold into one row of
  // chips under "All clear" (role walk HR 16, floor 7) — still named, still
  // a tap away, no longer a wall of tiles above the one queue with work.
  const withWork = queues.filter((q) => typeof q.value === 'number' && q.value > 0);
  const unknown = queues.filter((q) => q.value === null || q.value === undefined);
  const quiet = queues.filter((q) => q.value === 0);
  const queue = (
    <div className="space-y-3 animate-enter">
      {[...withWork, ...unknown].map((q) =>
        q.key === 'timesheets' && timesheetFailed ? (
          <div key={q.key} className="rounded-lg border border-alert/40 bg-surface px-4 py-3">
            <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">{q.label}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <span role="alert" className="text-alert">
                {t('appr.couldNotLoad')}
              </span>
              <Button size="xs" variant="outline" onClick={() => timesheetQuery.refetch()}>
                {t('common.retry')}
              </Button>
            </div>
          </div>
        ) : (
          <QueueTile
            key={q.key}
            label={q.label}
            value={q.value}
            sub={q.sub}
            urgent={q.urgent}
            // A bell only when someone is still unconfirmed.
            icon={q.key === 'unconfirmed' && (q.value ?? 0) > 0 ? BellRing : undefined}
            selected={openQueue === q.key}
            onClick={() => setPicked(q.key)}
          />
        ),
      )}
      {quiet.length > 0 && (
        <section aria-labelledby="approvals-clear" data-testid="approvals-clear">
          <h2 id="approvals-clear" className="mb-1.5 mt-1 text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">
            {t('appr.allClear')}
          </h2>
          <ul className="flex flex-wrap gap-1.5" aria-label={t('appr.allClearAria')}>
            {quiet.map((q) => (
              <li key={q.key}>
                <button
                  type="button"
                  onClick={() => setPicked(q.key)}
                  aria-pressed={openQueue === q.key}
                  className={cn(
                    'inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line px-3 text-xs text-ink-muted transition-colors hover:border-gold/40 hover:text-ink coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    openQueue === q.key && 'border-gold/60 text-ink',
                  )}
                >
                  {q.label}
                  <span className="tabular-nums text-ink-muted/70">0</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );

  const panelFor = (key: QueueKey) =>
    key === 'walk-ins' ? (
      <WalkInClockInsPanel />
    ) : key === 'time-off' ? (
      <PendingTimeOffPanel items={timeOffError ? null : timeOff} error={timeOffError} onRetry={() => timeOffQ.refetch()} />
    ) : key === 'swaps' ? (
      <SwapsPanel />
    ) : key === 'pickups' ? (
      <PickupsPanel />
    ) : key === 'timesheets' ? (
      <div className="space-y-3">
        {/* TIME's panel: the clean ones approve in one tap, the flagged ones
            listed with their reason (pages/time/PendingTimesheetsPanel). */}
        <PendingTimesheetsPanel />
        <Link to={timesheetLink} className="inline-flex items-center gap-1 text-sm text-accent underline underline-offset-2">
          {t('appr.openFullQueue')}
        </Link>
      </div>
    ) : key === 'requests' ? (
      <div className="space-y-3">
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setCoverOpen(true)}>
            Cover my approvals
          </Button>
        </div>
        <ApprovalRequestList
          requests={requests.data}
          loading={requests.isLoading}
          error={requests.error}
          onRetry={() => void requests.refetch()}
          focusId={focusRequest}
          onDecided={() => setFocusRequest(null)}
        />
      </div>
    ) : key === 'proposals' ? (
      <ProposalList
        approvals={proposals.data}
        loading={proposals.isLoading}
        error={proposals.error}
        onRetry={() => void proposals.refetch()}
        focusId={focusProposal}
        onFocusMissing={() => {
          setFocusProposal(null);
          toast.info('That proposal is no longer waiting — it may already be decided.');
        }}
        emptyTitle="No agent proposals waiting"
        emptyDescription="When an agent proposes a shift fill, a case or another action that needs a person, it lands here with its reasons."
      />
    ) : (
      <AdminUnconfirmedPanel
        className=""
        emptyFallback={
          <EmptyState
            icon={CalendarCheck}
            title={t('appr.q.unconfirmedIdle')}
            description="No shift in the next 48 hours is waiting on an “I’ll be there”."
          />
        }
      />
    );

  const item = !loaded ? (
    <Skeleton className="h-64" />
  ) : openQueue === null ? (
    clear ? (
      <Card className="border-success/30 bg-success/5 animate-enter">
        <CardContent className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-success/15 text-success">
            <CalendarCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <div className="font-medium text-white">{t('appr.clearTitle')}</div>
            <div className="text-sm text-silver">{t('appr.clearBody')}</div>
          </div>
        </CardContent>
      </Card>
    ) : (
      <EmptyState icon={ClipboardCheck} title={t('appr.pickTitle')} description={t('appr.pickBody')} />
    )
  ) : (
    <div className="space-y-3">
      {picked && (
        <Button size="sm" variant="ghost" className="lg:hidden" onClick={() => setPicked(null)}>
          <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          {t('appr.allQueues')}
        </Button>
      )}
      {openCount === 0 ? (
        <EmptyState icon={CalendarCheck} title={t('appr.nothingIn', { queue: openLabel.toLowerCase() })} description={t('appr.nothingInBody')} />
      ) : (
        panelFor(openQueue)
      )}
    </div>
  );

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      <DelegationDialog open={coverOpen} onOpenChange={setCoverOpen} />
      <DeskTemplate
        title={t('tabs.approvals')}
        subtitle={subtitle}
        className="mx-auto max-w-6xl"
        counts={
          <>
            {/* Four queues polling every minute owe the reader the minute. */}
            <AsOf
              at={timeOffQ.dataUpdatedAt}
              refreshing={clockIns.isFetching || timeOffQ.isFetching || swaps.isFetching || pickups.isFetching || proposals.isFetching || requests.isFetching}
              onRefresh={() => {
                void clockIns.refetch();
                void timeOffQ.refetch();
                void swaps.refetch();
                void pickups.refetch();
                void proposals.refetch();
                void requests.refetch();
                void unconfirmed.refetch();
                void timesheetQuery.refetch();
              }}
            />
            {canReadRecord && (
              <Button size="sm" variant="outline" asChild>
                <Link to="/audit/approvals">{t('appr.allRequests')}</Link>
              </Button>
            )}
            <Button size="sm" variant="outline" asChild>
              <Link to={timesheetLink}>
                <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('appr.q.timesheets')}
              </Link>
            </Button>
          </>
        }
        queue={queue}
        item={item}
        itemOpen={picked !== null}
      />
    </>
  );
}

/** A summary tile that jumps to its queue (inert when the queue is empty). */
function QueueTile({
  label,
  value,
  sub,
  urgent = false,
  icon: Icon,
  selected = false,
  onClick,
}: {
  label: string;
  value: number | null | undefined;
  sub: string;
  urgent?: boolean;
  /** A mark beside the count (the unconfirmed chase's bell, only above zero). */
  icon?: LucideIcon;
  /** The queue open on the desk. */
  selected?: boolean;
  onClick?: () => void;
}) {
  // A queue row on the desk: the count on the right, the one-line state
  // beneath the name. Compact on purpose — the column lists six of them.
  const body = (
    <>
      <span className="min-w-0">
        <span className="block text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">{label}</span>
        {value !== undefined && value !== null && <span className="mt-0.5 block truncate text-xs text-ink-muted">{sub}</span>}
      </span>
      <span className={cn('flex shrink-0 items-center gap-2 text-2xl font-semibold tabular-nums', urgent ? 'text-alert' : 'text-ink')}>
        {Icon && <Icon className="h-5 w-5 text-warning" aria-hidden="true" />}
        {value === undefined ? '…' : value === null ? '—' : value}
      </span>
    </>
  );
  const frame = cn(
    'flex w-full items-center justify-between gap-3 rounded-lg border bg-surface px-4 py-3 text-left transition-colors',
    urgent ? 'border-alert/40 bg-alert/[0.06]' : 'border-line',
  );
  if (!onClick) return <div className={frame}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        frame,
        'hover:border-gold/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        selected && 'border-gold/60 bg-gold/[0.04]',
      )}
    >
      {body}
    </button>
  );
}

/**
 * One queue: a card with its icon, title and count, the bulk actions on
 * the right, and its rows. Queues with nothing in them don't render — the
 * summary strip already says "nothing pending".
 */
function QueueCard({
  id,
  icon: Icon,
  title,
  count,
  urgent = false,
  actions,
  children,
  stagger = 2,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  count: number | null;
  urgent?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
  stagger?: number;
}) {
  return (
    <Card
      id={id}
      className={cn('scroll-mt-20 animate-enter', urgent && 'border-alert/40')}
      style={enterStagger(stagger)}
    >
      <CardContent>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium text-white">
            <Icon className={cn('h-4 w-4', urgent ? 'text-alert' : 'text-gold')} aria-hidden="true" />
            {title}
            {count !== null && count > 0 && (
              <span className="rounded-full bg-navy-secondary px-2 py-0.5 text-2xs tabular-nums text-silver">
                {count}
              </span>
            )}
          </h2>
          {actions}
        </div>
        <div className="mt-3">{children}</div>
      </CardContent>
    </Card>
  );
}

/** Tri-state select-all over a queue's row checkboxes. */
function SelectAll({
  label,
  allSelected,
  someSelected,
  onToggle,
}: {
  label: string;
  allSelected: boolean;
  someSelected: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-3 pb-1 text-xs text-silver">
      <input
        type="checkbox"
        aria-label={label}
        checked={allSelected}
        ref={(el) => {
          if (el) el.indeterminate = someSelected;
        }}
        onChange={onToggle}
      />
      Select all
    </label>
  );
}

function fmtHours(minutes: number): string {
  const h = minutes / 60;
  return `${h.toFixed(h % 1 === 0 ? 0 : 1)}h`;
}

/** Human labels for the time-off category enum (never show SICK/JURY_DUTY raw). */
const CATEGORY_LABELS: Record<string, string> = {
  SICK: 'Sick',
  VACATION: 'Vacation',
  PTO: 'PTO',
  BEREAVEMENT: 'Bereavement',
  JURY_DUTY: 'Jury duty',
  OTHER: 'Other',
};

/** Date-only "YYYY-MM-DD" — parse at local midnight so it never renders a
 *  day early west of UTC. */
const fmtYmd = (iso: string) => fmtDate(parseYmd(iso));

/**
 * Notification deep-link landing (?request=<id> for time off, ?walkin=<id>
 * for kiosk clock-ins): once the panel's rows have loaded, scroll the target
 * row (DOM id `<param>-<rowId>`) into view and flash it for ~2s. The query
 * param is consumed either way so refetches and Back don't re-trigger; a
 * target that's no longer pending gets an explanatory toast instead.
 */
function useDeepLinkFlash(
  param: 'request' | 'walkin' | 'swap' | 'pickup',
  ids: string[] | null,
): string | null {
  const [searchParams, setSearchParams] = useSearchParams();
  const [flashId, setFlashId] = useState<string | null>(null);
  const target = searchParams.get(param);
  useEffect(() => {
    if (!target || ids === null) return;
    const next = new URLSearchParams(searchParams);
    next.delete(param);
    setSearchParams(next, { replace: true });
    if (!ids.includes(target)) {
      toast.info('That request is no longer pending — it may already be decided.');
      return;
    }
    setFlashId(target);
    // Let the row paint before scrolling to it.
    requestAnimationFrame(() => {
      document
        .getElementById(`${param}-${target}`)
        ?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    });
    window.setTimeout(() => setFlashId(null), 2000);
    // searchParams/setSearchParams change identity on the consume above;
    // target going null ends the cycle, so they're deliberately not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [param, target, ids]);
  return flashId;
}

/** Deep-link flash ring — appended to the target row's classes for ~2s. */
const FLASH_ROW_CLASS = 'ring-2 ring-gold bg-gold/10';

/**
 * Loop a single-approve endpoint over the selection; report both halves,
 * naming each failure. Returns the FAILED ids so the caller can keep just
 * those selected — a partial failure must not wipe the selection and make
 * the manager re-hunt the rows that still need a retry.
 */
async function approveAllSettled(
  rows: Array<{ id: string; name: string }>,
  fn: (id: string) => Promise<unknown>,
  noun: string,
): Promise<string[]> {
  const results = await Promise.allSettled(rows.map((r) => fn(r.id)));
  const failedIds: string[] = [];
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') return;
    failedIds.push(rows[i].id);
    toast.error(`Could not approve ${rows[i].name}.`, {
      description:
        res.reason instanceof ApiError ? res.reason.message : undefined,
    });
  });
  const ok = rows.length - failedIds.length;
  if (ok > 0) toast.success(`Approved ${ok} ${noun}${ok === 1 ? '' : 's'}.`);
  return failedIds;
}

/* --------------------------------------------- walk-in clock-ins panel */

/** "8:02 AM · waiting 14m" — how long they've been standing at the kiosk. */
function waitingSince(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `waiting ${min}m`;
  return `waiting ${Math.floor(min / 60)}h ${min % 60}m`;
}

function WalkInClockInsPanel() {
  const { t } = useI18n();
  const term = useTerm();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Which bulk action is in flight — so only its button shows the spinner.
  const [bulkBusy, setBulkBusy] = useState<'approve' | 'deny' | null>(null);
  const [denyTarget, setDenyTarget] = useState<ClockInRequestRow | null>(null);
  // The deny dialog serves both the per-row deny (denyTarget set) and the
  // bulk deny (bulkDenyOpen) — one optional reason shared across the batch.
  const [bulkDenyOpen, setBulkDenyOpen] = useState(false);
  const [denyReason, setDenyReason] = useState('');

  const query = useQuery(clockInsQuery);
  const items = query.data ?? null;
  const forbidden = query.data === null && !query.isLoading && !query.isError;
  const error = query.isError
    ? query.error instanceof Error
      ? query.error.message
      : 'Could not load clock-in requests.'
    : null;
  // Memoized: a fresh array identity on every render defeats memoization
  // inside useSelection, and this panel refetches itself every minute.
  const itemIds = useMemo(() => items?.map((r) => r.id) ?? [], [items]);
  const { selected, toggle, clear, selectAll, allSelected, someSelected, toggleAll } =
    useSelection(itemIds);
  const flashId = useDeepLinkFlash('walkin', items === null ? null : itemIds);
  // j/k over the people at the kiosk, a clocks them in, d opens the deny note.
  const kb = useListKeyboard({
    items: items ?? [],
    idOf: (r) => r.id,
    onApprove: (r) => void decide(r.id, () => approveClockInRequest(r.id), `${r.associateName} is clocked in.`),
    onDecline: (r) => {
      setDenyReason('');
      setDenyTarget(r);
    },
    enabled: !denyTarget && !bulkDenyOpen && pendingId === null,
  });

  // Optimistic removal, matching PendingTimeOffPanel directly below —
  // two panels in one stack must not behave differently under the same tap.
  const decide = async (id: string, fn: () => Promise<unknown>, successMsg: string) => {
    setPendingId(id);
    await queryClient.cancelQueries({ queryKey: CLOCK_INS_KEY });
    const previous = queryClient.getQueryData<ClockInRequestRow[] | null>(CLOCK_INS_KEY);
    queryClient.setQueryData<ClockInRequestRow[] | null>(CLOCK_INS_KEY, (old) =>
      old ? old.filter((r) => r.id !== id) : old,
    );
    try {
      await fn();
      hapticConfirm();
      toast.success(successMsg);
    } catch (err) {
      queryClient.setQueryData(CLOCK_INS_KEY, previous);
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPendingId(null);
      void queryClient.invalidateQueries({ queryKey: CLOCK_INS_KEY });
    }
  };

  // No bulk endpoint for clock-in requests — loop the single-approve calls
  // and settle them all, then report both halves (same as swaps/pickups).
  // Partial failure keeps ONLY the failed rows selected for a retry.
  const bulkApprove = async () => {
    const rows = (items ?? []).filter((r) => selected.has(r.id));
    if (rows.length === 0) return;
    setBulkBusy('approve');
    const failedIds = await approveAllSettled(
      rows.map((r) => ({ id: r.id, name: r.associateName })),
      (id) => approveClockInRequest(id),
      'clock-in',
    );
    if (failedIds.length > 0) selectAll(failedIds);
    else clear();
    setBulkBusy(null);
    queryClient.invalidateQueries({ queryKey: CLOCK_INS_KEY });
  };

  // Same settle-them-all pattern as bulkApprove, but failures name the
  // associate — a denial that silently didn't land leaves someone standing
  // at the kiosk assuming they were told no.
  const bulkDeny = async () => {
    const rows = (items ?? []).filter((r) => selected.has(r.id));
    if (rows.length === 0) return;
    setBulkBusy('deny');
    const reason = denyReason.trim() || undefined;
    const results = await Promise.allSettled(
      rows.map((r) => denyClockInRequest(r.id, reason)),
    );
    let ok = 0;
    const failedIds: string[] = [];
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        ok += 1;
        return;
      }
      failedIds.push(rows[i].id);
      toast.error(`Could not deny ${rows[i].associateName}.`, {
        description:
          res.reason instanceof ApiError ? res.reason.message : undefined,
      });
    });
    if (ok > 0) {
      hapticConfirm();
      toast.success(`Denied ${ok} clock-in${ok === 1 ? '' : 's'}.`);
    }
    // Partial failure: keep only the failed rows selected for a retry.
    if (failedIds.length > 0) selectAll(failedIds);
    else clear();
    setBulkBusy(null);
    queryClient.invalidateQueries({ queryKey: CLOCK_INS_KEY });
  };

  if (forbidden) return null;
  // Nobody at the kiosk — the summary tile already says so.
  if (!error && items && items.length === 0) return null;

  return (
    <QueueCard
      id="queue-walk-ins"
      icon={DoorOpen}
      title={t('appr.walkInsTitle')}
      count={items?.length ?? null}
      urgent={!!items && items.length > 0}
      actions={
          selected.size > 0 && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={bulkApprove}
                loading={bulkBusy === 'approve'}
                disabled={bulkBusy !== null}
              >
                Approve selected ({selected.size})
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDenyReason('');
                  setBulkDenyOpen(true);
                }}
                loading={bulkBusy === 'deny'}
                disabled={bulkBusy !== null}
              >
                Deny selected ({selected.size})
              </Button>
            </div>
          )
      }
    >
        {error && (
          <div className="space-y-3">
            <ErrorBanner>{error}</ErrorBanner>
            <Button size="sm" variant="secondary" onClick={() => query.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {!error && !items && <Skeleton className="h-16" />}
        {!error && items && items.length > 0 && (
          <>
            {items.length > 1 && (
            <SelectAll
              label={t('appr.selectAllWalkIns')}
              allSelected={allSelected}
              someSelected={someSelected}
              onToggle={toggleAll}
            />
            )}
          <ul className="divide-y divide-navy-secondary/60" aria-label={t('appr.walkInsAria')} {...kb.listProps}>
            {items.map((r) => (
              <li
                key={r.id}
                id={`walkin-${r.id}`}
                className={`flex flex-wrap items-center justify-between gap-3 py-3${
                  flashId === r.id ? ` rounded-md ${FLASH_ROW_CLASS}` : ''
                }`}
                {...kb.rowProps(r.id)}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Select clock-in from ${r.associateName}`}
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                  <Avatar src={photoUrl(r.associateId)} name={r.associateName} email="" size="md" />
                  <div className="min-w-0">
                    <div className="font-medium text-white">
                      <AssociateLink associateId={r.associateId}>
                        {r.associateName}
                      </AssociateLink>
                    </div>
                    <div className="text-xs text-silver">
                      {r.locationName ?? r.clientName ?? 'Kiosk'}
                      {/* Time-only: these are minutes old — a full date reads
                          like paperwork, not a person at a kiosk. */}
                      {' · punched '}
                      {fmtTime(r.requestedAt)}
                      {' · '}
                      <span className="tabular-nums text-warning">
                        {waitingSince(r.requestedAt)}
                      </span>
                    </div>
                    <div className="text-2xs text-silver/60">
                      Approving clocks them in from the punch time; they do not
                      need to punch again.
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      decide(
                        r.id,
                        () => approveClockInRequest(r.id),
                        `${r.associateName} is clocked in.`,
                      )
                    }
                    loading={pendingId === r.id}
                    disabled={pendingId === r.id || bulkBusy !== null}
                  >
                    <Check className="h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setDenyReason('');
                      setDenyTarget(r);
                    }}
                    disabled={pendingId === r.id || bulkBusy !== null}
                  >
                    <X className="h-4 w-4" />
                    Deny
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          </>
        )}

      <Dialog
        open={denyTarget !== null || bulkDenyOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDenyTarget(null);
            setBulkDenyOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {bulkDenyOpen
                ? `Deny ${selected.size} clock-in${selected.size === 1 ? '' : 's'}?`
                : 'Deny this clock-in?'}
            </DialogTitle>
            <DialogDescription>
              {bulkDenyOpen
                ? `Each selected ${term('worker').toLowerCase()} will be notified that their clock-in was not approved. No time entries are created.`
                : `${denyTarget?.associateName} will be notified that their clock-in was not approved. No time entry is created.`}
            </DialogDescription>
          </DialogHeader>
          <Field
            label={
              bulkDenyOpen
                ? `Reason (optional, shared with every selected ${term('worker').toLowerCase()})`
                : `Reason (optional, shared with the ${term('worker').toLowerCase()})`
            }
          >
            <Textarea
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder={t('appr.denyWalkInPlaceholder')}
            />
          </Field>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDenyTarget(null);
                setBulkDenyOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (bulkDenyOpen) {
                  setBulkDenyOpen(false);
                  void bulkDeny();
                  return;
                }
                const target = denyTarget;
                setDenyTarget(null);
                if (target) {
                  void decide(
                    target.id,
                    () => denyClockInRequest(target.id, denyReason.trim() || undefined),
                    'Clock-in denied.',
                  );
                }
              }}
            >
              {bulkDenyOpen
                ? `Deny ${selected.size} clock-in${selected.size === 1 ? '' : 's'}`
                : 'Deny clock-in'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </QueueCard>
  );
}

/* --------------------------------------------------- time-off panel */

function PendingTimeOffPanel({
  items,
  error,
  onRetry,
}: {
  items: TimeOffRequest[] | null;
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [denyTarget, setDenyTarget] = useState<TimeOffRequest | 'selected' | null>(null);
  // Memoized: a fresh array identity on every render defeats memoization
  // inside useSelection, and this page refetches itself every minute.
  const itemIds = useMemo(() => items?.map((r) => r.id) ?? [], [items]);
  const { selected, toggle, clear, selectAll, allSelected, someSelected, toggleAll } =
    useSelection(itemIds);
  const [bulkBusy, setBulkBusy] = useState(false);
  const flashId = useDeepLinkFlash('request', items === null ? null : itemIds);

  // Optimistically drop the row from the cached list the moment a
  // decision is submitted; snapshot the previous list so onError can
  // roll it back, and let onSettled re-sync with the server.
  const removeOptimistically = async (id: string) => {
    await queryClient.cancelQueries({ queryKey: TIME_OFF_KEY });
    const previous = queryClient.getQueryData<TimeOffRequest[]>(TIME_OFF_KEY);
    queryClient.setQueryData<TimeOffRequest[]>(TIME_OFF_KEY, (old) =>
      old?.filter((r) => r.id !== id),
    );
    return { previous };
  };
  const rollback = (ctx: { previous?: TimeOffRequest[] } | undefined) => {
    if (ctx?.previous !== undefined) {
      queryClient.setQueryData(TIME_OFF_KEY, ctx.previous);
    }
  };

  const prompt = usePrompt();
  const approveMutation = useMutation({
    mutationFn: (r: TimeOffRequest) => approveAdminRequest(r.id),
    onMutate: (r) => removeOptimistically(r.id),
    onError: (err, _r, ctx) => {
      rollback(ctx);
      if (err instanceof ApiError && err.code === 'insufficient_balance') {
        const d = err.details as { currentMinutes: number; requestedMinutes: number };
        // Not a dead end. Most associates have no balance at all — only
        // SICK accrues, and only where state law provides for it — so the
        // approver is offered the way through, with a reason that lands
        // in the ledger beside the negative balance.
        const who = _r.associateName ?? 'this request';
        void (async () => {
          const reason = (
            await prompt({
              title: 'Approve without the balance?',
              description:
                `${who} has ${fmtHours(d.currentMinutes)} available and asked for ` +
                `${fmtHours(d.requestedMinutes)}. Approving anyway takes the balance negative — ` +
                'say why, and it goes on the ledger beside it.',
              reasonLabel: 'Why this is approved anyway',
              reasonPlaceholder: 'e.g. Unpaid day, agreed with Ops',
              confirmLabel: 'Approve anyway',
            })
          )?.trim();
          if (!reason) return;
          try {
            await approveAdminRequest(_r.id, undefined, reason);
            hapticConfirm();
            toast.success(`Approved ${who} — balance now negative.`);
          } catch (e) {
            toast.error('Could not approve.', {
              description: e instanceof Error ? e.message : 'Something went wrong.',
            });
          } finally {
            void queryClient.invalidateQueries({ queryKey: TIME_OFF_KEY });
          }
        })();
        return;
      }
      toast.error('Could not approve.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    },
    onSuccess: (_res, r) => {
      hapticConfirm();
      toast.success(`Approved ${r.associateName ?? 'request'}.`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TIME_OFF_KEY }),
  });

  const denyMutation = useMutation({
    mutationFn: ({ target, note }: { target: TimeOffRequest; note: string }) =>
      denyAdminRequest(target.id, { note }),
    onMutate: ({ target }) => removeOptimistically(target.id),
    onError: (err, _vars, ctx) => {
      rollback(ctx);
      toast.error('Could not deny.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    },
    onSuccess: () => {
      hapticConfirm();
      toast.success('Request denied.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TIME_OFF_KEY }),
  });

  const onApprove = (r: TimeOffRequest) => {
    setPendingId(r.id);
    approveMutation.mutate(r, { onSettled: () => setPendingId(null) });
  };
  // j/k over the requests, a approves, d opens the deny reason (lib/shortcuts).
  const kb = useListKeyboard({
    items: items ?? [],
    idOf: (r) => r.id,
    onApprove: (r) => onApprove(r),
    onDecline: (r) => setDenyTarget(r),
    enabled: !denyTarget,
  });

  // Deny selected — one note for all of them, through the same bulk
  // endpoint; a failed row stays selected and is named.
  const bulkDeny = async (note: string) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await bulkDecideRequests({ ids, decision: 'DENY', note });
      if (res.decided > 0) toast.success(`Denied ${res.decided} request${res.decided === 1 ? '' : 's'}.`);
      if (res.failed.length > 0) {
        const nameById = new Map((items ?? []).map((r) => [r.id, r.associateName ?? 'request']));
        for (const f of res.failed) toast.error(`Could not deny ${nameById.get(f.id) ?? 'request'}.`, { description: f.error });
        selectAll(res.failed.map((f) => f.id));
      } else {
        clear();
      }
    } finally {
      setBulkBusy(false);
      void queryClient.invalidateQueries({ queryKey: TIME_OFF_KEY });
    }
  };

  // Bulk approvals go through the server's bulk endpoint — one round-trip,
  // per-id failure reporting. Partial failure keeps ONLY the failed rows
  // selected (named per-row) so a retry doesn't start from scratch.
  const bulkApprove = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await bulkDecideRequests({ ids, decision: 'APPROVE' });
      if (res.decided > 0) {
        toast.success(
          `Approved ${res.decided} request${res.decided === 1 ? '' : 's'}.`,
        );
      }
      if (res.failed.length > 0) {
        const nameById = new Map(
          (items ?? []).map((r) => [r.id, r.associateName ?? 'request']),
        );
        for (const f of res.failed) {
          toast.error(`Could not approve ${nameById.get(f.id) ?? 'request'}.`, {
            description: f.error,
          });
        }
        selectAll(res.failed.map((f) => f.id));
      } else {
        clear();
      }
    } catch (err) {
      // Whole call failed — nothing was decided; keep the selection intact.
      toast.error('Could not approve selected.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setBulkBusy(false);
      queryClient.invalidateQueries({ queryKey: TIME_OFF_KEY });
    }
  };

  // Nothing to decide — the summary tile already says so.
  if (!error && items && items.length === 0) return null;

  return (
    <QueueCard
      id="queue-time-off"
      icon={CalendarOff}
      title={t('appr.q.timeOff')}
      count={items?.length ?? null}
      stagger={3}
      actions={
        selected.size > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setDenyTarget('selected')} disabled={bulkBusy}>
              Deny selected ({selected.size})
            </Button>
            <Button size="sm" onClick={bulkApprove} loading={bulkBusy}>
              Approve selected ({selected.size})
            </Button>
          </div>
        )
      }
    >
        {error && (
          <div className="space-y-3">
            <ErrorBanner>{error}</ErrorBanner>
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}
        {!error && !items && <Skeleton className="h-16" />}
        {!error && items && items.length > 0 && (
          <>
            {items.length > 1 && (
            <SelectAll
              label={t('appr.selectAllTimeOff')}
              allSelected={allSelected}
              someSelected={someSelected}
              onToggle={toggleAll}
            />
            )}
          <ul className="divide-y divide-navy-secondary/60" aria-label={t('appr.timeOffAria')} {...kb.listProps}>
            {items.map((r) => (
              <li
                key={r.id}
                id={`request-${r.id}`}
                className={`flex flex-wrap items-center justify-between gap-3 py-3${
                  flashId === r.id ? ` rounded-md ${FLASH_ROW_CLASS}` : ''
                }`}
                {...kb.rowProps(r.id)}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Select request from ${r.associateName ?? 'associate'}`}
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                  <Avatar src={photoUrl(r.associateId)} name={r.associateName ?? ''} email="" size="md" />
                  <div className="min-w-0">
                    <div className="text-white text-sm font-medium">
                      {r.associateName ?? '—'}
                    </div>
                    <div className="text-xs text-silver mt-0.5 tabular-nums">
                      {CATEGORY_LABELS[r.category] ?? r.category} · {fmtYmd(r.startDate)}
                      {r.startDate !== r.endDate && ` – ${fmtYmd(r.endDate)}`} ·{' '}
                      <span className={r.balanceMinutes != null && r.balanceMinutes < r.requestedMinutes ? 'text-alert' : undefined}>
                        {fmtHours(r.requestedMinutes)}
                        {r.balanceMinutes != null && ` of ${fmtHours(r.balanceMinutes)} available`}
                      </span>
                    </div>
                    {/* The coverage hole this approval would punch — seen
                        before the click, same badge as Time off. */}
                    {(r.assignedShiftOverlaps ?? 0) > 0 && (
                      <Badge variant="pending" size="sm" className="mt-1">
                        releases {r.assignedShiftOverlaps} {r.assignedShiftOverlaps === 1 ? 'shift' : 'shifts'}
                      </Badge>
                    )}
                    {r.reason && (
                      <div className="text-xs text-silver/70 italic mt-1">
                        "{r.reason}"
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => onApprove(r)}
                    disabled={pendingId === r.id || bulkBusy}
                  >
                    <Check className="h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDenyTarget(r)}
                    disabled={pendingId === r.id || bulkBusy}
                  >
                    <X className="h-4 w-4" />
                    Deny
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          </>
        )}

      <DenyDialog
        target={denyTarget}
        count={denyTarget === 'selected' ? selected.size : 1}
        onSubmit={(target, note) => (target === 'selected' ? bulkDeny(note) : denyMutation.mutateAsync({ target, note }))}
        onClose={() => setDenyTarget(null)}
      />
    </QueueCard>
  );
}

function DenyDialog({
  target,
  count = 1,
  onSubmit,
  onClose,
}: {
  /** One request, or 'selected' — every checked row, one shared note. */
  target: TimeOffRequest | 'selected' | null;
  count?: number;
  /** Must reject on server failure (mutateAsync) — the dialog only closes
   *  itself on success so a failed deny keeps the typed note in place. */
  onSubmit: (target: TimeOffRequest | 'selected', note: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const open = target !== null;

  useEffect(() => {
    if (open) {
      setNote('');
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    if (!target || busy) return;
    const trimmed = note.trim();
    if (trimmed.length === 0) {
      toast.error('A note is required when denying.');
      return;
    }
    setBusy(true);
    try {
      // Optimistic: the row disappears the moment the deny is submitted;
      // the mutation rolls it back (with a toast) if the server rejects.
      await onSubmit(target, trimmed);
      onClose(); // success only — on failure the dialog stays open with the note
    } catch {
      // The mutation's onError already toasted; keep the dialog (and the
      // typed note) so the manager can retry without retyping.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && !busy && onClose()}
      confirmDiscard={() => note.trim().length > 0}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target === 'selected' ? `Deny ${count} request${count === 1 ? '' : 's'}` : 'Deny request'}</DialogTitle>
          <DialogDescription>
            {target === 'selected'
              ? 'Each person sees this same note in their request history.'
              : 'The associate will see your note in their request history.'}
          </DialogDescription>
        </DialogHeader>
        <Field label={t('appr.note')} required>
          {(p) => (
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('appr.denyTimeOffPlaceholder')}
              maxLength={500}
              rows={3}
              {...p}
            />
          )}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose()} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} variant="destructive" loading={busy} disabled={busy}>
            Deny
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------- swaps panel */

function SwapsPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const showClient = !useClientBounded();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const swapsQ = useQuery(swapsQuery);
  const items = swapsQ.data?.requests ?? null;
  const itemIds = useMemo(() => items?.map((s) => s.id) ?? [], [items]);
  const { selected, toggle, clear, selectAll, allSelected, someSelected, toggleAll } =
    useSelection(itemIds);
  // ?swap=<id> (the swap's notification) rings its row once it loads.
  const flashId = useDeepLinkFlash('swap', items === null ? null : itemIds);
  // j/k over the swaps, a approves, d rejects (lib/shortcuts).
  const kb = useListKeyboard({
    items: items ?? [],
    idOf: (x) => x.id,
    onApprove: (x) => void decide(x.id, () => managerApproveSwap(x.id), 'Swap approved.'),
    onDecline: (x) => void decide(x.id, () => managerRejectSwap(x.id), 'Swap rejected.'),
    enabled: pendingId === null && !bulkBusy,
  });
  const error = swapsQ.isError
    ? swapsQ.error instanceof ApiError
      ? swapsQ.error.message
      : 'Failed to load swaps.'
    : null;

  const decide = async (
    id: string,
    fn: () => Promise<unknown>,
    successMsg: string,
  ) => {
    setPendingId(id);
    try {
      await fn();
      toast.success(successMsg);
      await queryClient.invalidateQueries({ queryKey: SWAPS_KEY });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPendingId(null);
    }
  };

  // No bulk endpoint for swaps — loop the single-approve calls and settle
  // them all, then report both halves. Partial failure keeps ONLY the
  // failed rows selected for a retry.
  const bulkApprove = async () => {
    const rows = (items ?? []).filter((s) => selected.has(s.id));
    if (rows.length === 0) return;
    setBulkBusy(true);
    const failedIds = await approveAllSettled(
      rows.map((s) => ({ id: s.id, name: `${s.requesterName} → ${s.counterpartyName}` })),
      (id) => managerApproveSwap(id),
      'swap',
    );
    if (failedIds.length > 0) selectAll(failedIds);
    else clear();
    setBulkBusy(false);
    queryClient.invalidateQueries({ queryKey: SWAPS_KEY });
  };

  if (!error && items && items.length === 0) return null;

  return (
    <QueueCard
      id="queue-swaps"
      icon={ArrowLeftRight}
      title={t('appr.q.swaps')}
      count={items?.length ?? null}
      stagger={4}
      actions={
        selected.size > 0 && (
          <Button size="sm" onClick={bulkApprove} loading={bulkBusy}>
            Approve selected ({selected.size})
          </Button>
        )
      }
    >
        {error && (
          <div className="space-y-3">
            <ErrorBanner>{error}</ErrorBanner>
            <Button size="sm" variant="secondary" onClick={() => swapsQ.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {!error && !items && <Skeleton className="h-16" />}
        {!error && items && items.length > 0 && (
          <>
            {items.length > 1 && (
            <SelectAll
              label={t('appr.selectAllSwaps')}
              allSelected={allSelected}
              someSelected={someSelected}
              onToggle={toggleAll}
            />
            )}
          <ul className="divide-y divide-navy-secondary/60" aria-label={t('appr.swapsAria')} {...kb.listProps}>
            {items.map((s) => (
              <li
                key={s.id}
                id={`swap-${s.id}`}
                className={`flex flex-wrap items-center justify-between gap-3 py-3${flashId === s.id ? ` rounded-md ${FLASH_ROW_CLASS}` : ''}`}
                {...kb.rowProps(s.id)}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Select swap from ${s.requesterName}`}
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                  />
                  {/* Who gives it up → who takes it, as faces. */}
                  <div className="flex shrink-0 items-center" aria-hidden="true">
                    <Avatar src={photoUrl(s.requesterAssociateId)} name={s.requesterName} email="" size="sm" />
                    <ArrowLeftRight className="mx-1 h-3 w-3 text-silver/60" />
                    <Avatar src={photoUrl(s.counterpartyAssociateId)} name={s.counterpartyName} email="" size="sm" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-white text-sm">
                      <span className="font-medium">{s.requesterName}</span>
                      {' → '}
                      <span className="font-medium">{s.counterpartyName}</span>
                    </div>
                    <div className="text-xs text-silver mt-0.5">
                      {s.shiftPosition}
                      {showClient && ` · ${s.shiftClientName ?? '—'}`} ·{' '}
                      <span className="tabular-nums">{when(s.shiftStartsAt, s.shiftTimezone)}</span>
                    </div>
                    {s.inExchange && (
                      <div className="text-xs text-gold/90 mt-0.5 tabular-nums">
                        Trade — {s.requesterName} takes: {s.inExchange.position} ·{' '}
                        {when(s.inExchange.startsAt, s.inExchange.timezone)}
                      </div>
                    )}
                    {s.note && (
                      <div className="text-xs text-silver/70 italic mt-1">
                        "{s.note}"
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {s.wouldExceed40h && (
                    <Badge variant="destructive">{t('appr.over40')}</Badge>
                  )}
                  <Button
                    size="sm"
                    onClick={() =>
                      decide(s.id, () => managerApproveSwap(s.id), 'Swap approved.')
                    }
                    disabled={pendingId === s.id || bulkBusy}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      decide(s.id, () => managerRejectSwap(s.id), 'Swap rejected.')
                    }
                    disabled={pendingId === s.id || bulkBusy}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          </>
        )}
    </QueueCard>
  );
}

/* --------------------------------------------------- pickups panel */

function PickupsPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const showClient = !useClientBounded();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const pickupsQ = useQuery(pickupsQuery);
  const items = pickupsQ.data?.claims ?? null;
  const itemIds = useMemo(() => items?.map((c) => c.id) ?? [], [items]);
  const { selected, toggle, clear, selectAll, allSelected, someSelected, toggleAll } =
    useSelection(itemIds);
  // ?pickup=<id> (the claim's notification) rings its row once it loads.
  const flashId = useDeepLinkFlash('pickup', items === null ? null : itemIds);
  // j/k over the pickups, a approves (assigns the shift), d rejects.
  const kb = useListKeyboard({
    items: items ?? [],
    idOf: (x) => x.id,
    onApprove: (x) => void decide(x.id, () => approveOpenShiftClaim(x.id), 'Pickup approved — shift assigned.'),
    onDecline: (x) => void decide(x.id, () => rejectOpenShiftClaim(x.id), 'Pickup rejected.'),
    enabled: pendingId === null && !bulkBusy,
  });
  const error = pickupsQ.isError
    ? pickupsQ.error instanceof ApiError
      ? pickupsQ.error.message
      : 'Failed to load pickup requests.'
    : null;

  const decide = async (
    id: string,
    fn: () => Promise<unknown>,
    successMsg: string,
  ) => {
    setPendingId(id);
    try {
      await fn();
      toast.success(successMsg);
      await queryClient.invalidateQueries({ queryKey: PICKUPS_KEY });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPendingId(null);
    }
  };

  // Partial failure keeps ONLY the failed rows selected for a retry.
  const bulkApprove = async () => {
    const rows = (items ?? []).filter((c) => selected.has(c.id));
    if (rows.length === 0) return;
    setBulkBusy(true);
    const failedIds = await approveAllSettled(
      rows.map((c) => ({ id: c.id, name: c.associateName })),
      (id) => approveOpenShiftClaim(id),
      'pickup',
    );
    if (failedIds.length > 0) selectAll(failedIds);
    else clear();
    setBulkBusy(false);
    queryClient.invalidateQueries({ queryKey: PICKUPS_KEY });
  };

  if (!error && items && items.length === 0) return null;

  return (
    <QueueCard
      id="queue-pickups"
      icon={Store}
      title={t('appr.pickupsTitle')}
      count={items?.length ?? null}
      stagger={5}
      actions={
        selected.size > 0 && (
          <Button size="sm" onClick={bulkApprove} loading={bulkBusy}>
            Approve selected ({selected.size})
          </Button>
        )
      }
    >
        {error && (
          <div className="space-y-3">
            <ErrorBanner>{error}</ErrorBanner>
            <Button size="sm" variant="secondary" onClick={() => pickupsQ.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {!error && !items && <Skeleton className="h-16" />}
        {!error && items && items.length > 0 && (
          <>
            {items.length > 1 && (
            <SelectAll
              label={t('appr.selectAllPickups')}
              allSelected={allSelected}
              someSelected={someSelected}
              onToggle={toggleAll}
            />
            )}
          <ul className="divide-y divide-navy-secondary/60" aria-label={t('appr.pickupsAria')} {...kb.listProps}>
            {items.map((c) => (
              <li
                key={c.id}
                id={`pickup-${c.id}`}
                className={`flex flex-wrap items-center justify-between gap-3 py-3${flashId === c.id ? ` rounded-md ${FLASH_ROW_CLASS}` : ''}`}
                {...kb.rowProps(c.id)}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Select pickup from ${c.associateName}`}
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <Avatar src={photoUrl(c.associateId)} name={c.associateName} email="" size="md" />
                  <div className="min-w-0">
                    <div className="text-white text-sm">
                      <AssociateLink associateId={c.associateId} className="font-medium">
                        {c.associateName}
                      </AssociateLink>
                      {' wants '}
                      <span className="font-medium">{c.shiftPosition}</span>
                    </div>
                    <div className="text-xs text-silver mt-0.5 tabular-nums">
                      {showClient && `${c.shiftClientName ?? '—'} · `}
                      {when(c.shiftStartsAt, c.shiftTimezone)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {c.wouldExceed40h && (
                    <Badge variant="destructive">{t('appr.over40')}</Badge>
                  )}
                  <Button
                    size="sm"
                    onClick={() =>
                      decide(
                        c.id,
                        () => approveOpenShiftClaim(c.id),
                        'Pickup approved — shift assigned.',
                      )
                    }
                    disabled={pendingId === c.id || bulkBusy}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      decide(c.id, () => rejectOpenShiftClaim(c.id), 'Pickup rejected.')
                    }
                    disabled={pendingId === c.id || bulkBusy}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          </>
        )}
    </QueueCard>
  );
}
