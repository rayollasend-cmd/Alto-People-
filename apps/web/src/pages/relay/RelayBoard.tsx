import { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Users } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { ClockStrip } from '@/components/ClockStrip';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { FacePile } from './RelayParts';
import { RelayBatons } from './RelayBatons';
import { RelayPipeline } from './RelayPipeline';
import { LaneDrawer } from './LaneDrawer';
import { ActivityFeed, DecisionsPanel, MondayPack } from './RelayRail';
import { ClientRequestsSection, WavesSection } from './RelayRequestsWaves';
import { RelayRequests } from './RelayRequests';
import { RelayFiles } from './RelayFiles';
import { workApi, workDeskOf } from './workTypes';
import {
  DESK_BAR,
  DESK_LABELS,
  DESK_RING,
  DESKS,
  deskOf,
  relayApi,
  type ActivityNote,
  type Desk,
  type RelayBoardData,
} from './relayTypes';

/**
 * THE RELAY — where HR, Workforce and Finance work together.
 *
 * One shared picture, with names on it:
 *
 *   the desks      each desk's people, and what's on their desk right now
 *                  (tap one to see the board through that desk's eyes —
 *                  it opens on yours)
 *   batons         every cross-department queue, loud when late, with
 *                  the person holding it — claim it, or hand it on
 *   the pipeline   every new hire's run to a first paycheck, stage by
 *                  stage; open a lane for its timeline, the move that
 *                  unsticks it, and the conversation about them
 *   the rail       the Monday pack, rulings owed between desks (answer
 *                  them here), the latest on every thread, and the
 *                  client's own requests
 *
 * Live: it refreshes every minute and whenever you come back to it.
 */

type Lens = Desk | 'ALL';

function useTick(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function DeskScoreboard({
  data,
  decisions,
  lens,
  myDesk,
  onLens,
}: {
  data: RelayBoardData;
  decisions: ActivityNote[];
  lens: Lens;
  myDesk: Desk | null;
  onLens: (l: Lens) => void;
}) {
  return (
    <section aria-label="The desks">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <Users className="h-4 w-4 text-gold" aria-hidden="true" />
          The desks
        </h2>
        <Button size="sm" variant={lens === 'ALL' ? 'secondary' : 'ghost'} aria-pressed={lens === 'ALL'} onClick={() => onLens('ALL')}>
          All desks
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {DESKS.map((d) => {
          const batons = data.batons.filter((b) => b.desk === d && b.count > 0);
          const late = batons.filter((b) => b.status === 'overdue').length;
          const lanes = data.lanes.filter((l) => l.stages.find((s) => s.key === l.currentStage)?.desk === d);
          const stalled = lanes.filter((l) => l.stalled).length;
          const owed = decisions.filter((x) => x.decisionDesk === d).length;
          const people = data.desks?.[d] ?? [];
          const on = lens === d;
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              onClick={() => onLens(on ? 'ALL' : d)}
              className={cn(
                'group relative overflow-hidden rounded-lg border bg-navy/60 p-3.5 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                on ? cn('border-transparent ring-2', DESK_RING[d]) : 'border-navy-secondary hover:border-silver/30',
              )}
            >
              <span className={cn('absolute inset-x-0 top-0 h-1', DESK_BAR[d])} aria-hidden="true" />
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-white">
                  {DESK_LABELS[d]}
                  {myDesk === d && <span className="ml-1.5 rounded-full bg-gold/15 px-1.5 py-0.5 text-2xs font-medium text-gold">your desk</span>}
                </span>
                <FacePile people={people.map((p) => ({ key: p.userId, name: p.name, photoUrl: p.photoUrl }))} max={4} label={`${DESK_LABELS[d]}: ${people.map((p) => p.name).join(', ') || 'nobody yet'}`} />
              </span>
              <span className="mt-2 flex items-baseline gap-1.5">
                <span className={cn('text-2xl font-semibold tabular-nums', late ? 'text-alert' : batons.length ? 'text-white' : 'text-success')}>{batons.length}</span>
                <span className="text-xs text-silver">
                  {batons.length === 1 ? 'baton open' : 'batons open'}
                  {late > 0 && <span className="font-medium text-alert"> · {late} late</span>}
                </span>
              </span>
              <span className="mt-1 block text-xs text-silver/80">
                {lanes.length} {lanes.length === 1 ? 'new hire waits' : 'new hires wait'} on them
                {stalled > 0 && <span className="text-alert"> · {stalled} stalled</span>}
                {owed > 0 && <span className="text-warning"> · {owed} ruling{owed === 1 ? '' : 's'} owed</span>}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function RelayBoard() {
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  useTick(30_000);

  const board = useQuery({ queryKey: ['relay', 'board'], queryFn: relayApi.board, refetchInterval: 60_000 });
  // What's waiting on this person's desk — the badge on the Requests tab.
  const inbox = useQuery({ queryKey: ['relay', 'requests', 'inbox', 'open'], queryFn: () => workApi.requests('inbox'), refetchInterval: 60_000 });
  const activity = useQuery({ queryKey: ['relay', 'activity'], queryFn: relayApi.activity, refetchInterval: 60_000 });
  const requests = useQuery({ queryKey: ['relay', 'client-requests'], queryFn: relayApi.requests, refetchInterval: 60_000 });
  const data = board.data;

  const myDesk = data?.me?.desk ?? deskOf(user?.role);
  const lensParam = params.get('desk');
  const lens: Lens = lensParam === 'ALL' || (lensParam && (DESKS as string[]).includes(lensParam)) ? (lensParam as Lens) : (myDesk ?? 'ALL');
  const setLens = (l: Lens) =>
    setParams(
      (p) => {
        p.set('desk', l);
        return p;
      },
      { replace: true },
    );

  // The lane drawer: ?lane=<associateId> — deep-linkable (a hand-off lands here).
  const laneId = params.get('lane');
  const [drawerName, setDrawerName] = useState<string | null>(null);
  const openLane = (associateId: string, name?: string) => {
    setDrawerName(name ?? null);
    setParams(
      (p) => {
        p.set('lane', associateId);
        return p;
      },
      { replace: false },
    );
  };
  const closeLane = () =>
    setParams(
      (p) => {
        p.delete('lane');
        return p;
      },
      { replace: true },
    );

  const refreshAll = () => void queryClient.invalidateQueries({ queryKey: ['relay'] });

  // #decisions, #client-requests, #<baton> — scroll there once the board is in.
  useEffect(() => {
    if (!data || !location.hash) return;
    const id = decodeURIComponent(location.hash.slice(1)).split(':')[0];
    if (id) window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }, [data, location.hash]);

  const tab = (params.get('tab') as 'board' | 'requests' | 'files' | null) ?? 'board';
  const setTab = (t: 'board' | 'requests' | 'files') =>
    setParams(
      (p) => {
        if (t === 'board') p.delete('tab');
        else p.set('tab', t);
        return p;
      },
      { replace: true },
    );
  const myWorkDesk = workDeskOf(user?.role);
  const claims = data?.claims ?? {};
  const decisions = activity.data?.decisions ?? [];
  const lane = useMemo(() => data?.lanes.find((l) => l.associateId === laneId), [data, laneId]);

  if (board.isError) {
    return (
      <div className="space-y-4">
        <PageHeader title="The relay" subtitle="Where the desks work together — the board, the questions between HR, Recruiting, Workforce and Finance, and the documents the work runs on." />
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void board.refetch()}>
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
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const meId = data.me?.userId ?? user?.id;
  return (
    <div className="space-y-5">
      <div>
        <PageHeader
          title="The relay"
          subtitle="Where the desks work together — the board, the questions between HR, Recruiting, Workforce and Finance, and the documents the work runs on."
          secondaryActions={
            <span className="flex items-center gap-2 text-xs text-silver/70">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-50 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              Live · updated {ago(board.dataUpdatedAt)}
              <Button size="sm" variant="ghost" onClick={refreshAll} aria-label="Refresh the relay" disabled={board.isFetching}>
                <RefreshCw className={cn('h-3.5 w-3.5', board.isFetching && 'animate-spin')} />
              </Button>
            </span>
          }
        />
        <ClockStrip className="mt-1" />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'board' | 'requests' | 'files')}>
        <TabsList>
          <TabsTrigger value="board">The board</TabsTrigger>
          <TabsTrigger value="requests">
            Requests
            {(inbox.data?.counts.inbox ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-gold/20 px-1.5 text-2xs font-semibold text-gold tabular-nums">{inbox.data!.counts.inbox}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="files">Documents</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'requests' ? (
        <RelayRequests
          desks={data.desks}
          myDesk={myWorkDesk}
          openId={params.get('request')}
          onOpen={(id) =>
            setParams(
              (p) => {
                if (id) p.set('request', id);
                else p.delete('request');
                return p;
              },
              { replace: true },
            )
          }
        />
      ) : tab === 'files' ? (
        <RelayFiles myDesk={myWorkDesk} />
      ) : (
        <>
      <DeskScoreboard data={data} decisions={decisions} lens={lens} myDesk={myDesk} onLens={setLens} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          <RelayBatons batons={data.batons} lens={lens} claims={claims} desks={data.desks} meId={meId} onChanged={refreshAll} />
          <RelayPipeline
            data={data}
            lens={lens}
            claims={claims}
            desks={data.desks}
            meId={meId}
            onOpenLane={(id) => openLane(id)}
            onChanged={refreshAll}
          />
          <WavesSection cohorts={data.cohorts} canManage={can('manage:recruiting')} onChanged={refreshAll} />
        </div>
        <aside className="min-w-0 space-y-6" aria-label="Where the desks talk">
          <MondayPack agenda={data.agenda} lens={lens} />
          <DecisionsPanel decisions={decisions} loading={activity.isLoading} lens={lens} myDesk={myDesk} onOpen={openLane} onChanged={refreshAll} />
          <ActivityFeed notes={activity.data?.notes ?? []} loading={activity.isLoading} lens={lens} onOpen={openLane} />
          <ClientRequestsSection
            rows={requests.data?.requests ?? []}
            lens={lens}
            canWork={can('manage:scheduling')}
            claims={claims}
            desks={data.desks}
            meId={meId}
            onChanged={refreshAll}
          />
        </aside>
      </div>
        </>
      )}

      <LaneDrawer
        associateId={laneId}
        name={drawerName ?? lane?.name ?? activity.data?.notes.find((n) => n.subject.associateId === laneId)?.subject.name ?? null}
        lane={lane}
        claims={claims}
        desks={data.desks}
        meId={meId}
        cohorts={data.cohorts}
        canManageCohorts={can('manage:recruiting')}
        onClose={closeLane}
        onChanged={refreshAll}
      />
    </div>
  );
}
