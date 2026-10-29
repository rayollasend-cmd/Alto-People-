import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getTimeOffSummary } from '@/lib/timeOffApi';
import { useUrlParam } from '@/lib/useUrlState';
import { AssociateTimeOffView } from './AssociateTimeOffView';
import { AdminTimeOffView } from './AdminTimeOffView';
import { AdminTimeOffEntitlementsView } from './AdminTimeOffEntitlementsView';
import { TimeOffPoliciesView } from './TimeOffPoliciesView';
import { WhosOffStrip } from './WhosOffStrip';
import { ListTemplate } from '@/components/templates';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { NoAccess } from '@/components/ui/NoAccess';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

type Tab = 'requests' | 'policies' | 'entitlements' | 'mine';
const TABS: readonly Tab[] = ['requests', 'policies', 'entitlements', 'mine'];

const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Oct 17" from a YYYY-MM-DD key; '' for anything that isn't one (never a crash). */
const fmtKey = (key: string | null | undefined) => {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
  return MONTH_DAY.format(new Date(`${key}T12:00:00Z`));
};

export function TimeOffHome() {
  const { user, can } = useAuth();
  const isAssociate = user?.role === 'ASSOCIATE';
  const canManage = can('manage:time');
  // Managers/HR who are ALSO on the roster (linked associate record) get a
  // "My time off" tab so they can request their own leave without a second
  // account.
  const hasOwnTimeOff = Boolean(user?.associateId);
  // The tab lives in ?tab= so a notification can open Entitlements or the
  // queue directly; Back returns to the last tab (F500 G2).
  const [tab, setTab] = useUrlParam<Tab>('tab', 'requests', TABS, { history: 'push' });
  // Who is out — the manager view opened on an empty queue with no sense of it.
  const summary = useQuery({
    queryKey: ['time-off', 'admin', 'summary'],
    queryFn: getTimeOffSummary,
    enabled: canManage && !isAssociate,
    staleTime: 60_000,
  });

  if (isAssociate) {
    return <AssociateTimeOffView />;
  }
  // The desk (the queue, entitlements, who is out) reads manage:time
  // endpoints. Without it, someone on the roster gets their own time off;
  // anyone else the access page — not a queue that answers "You don't have
  // permission" (deep audit 2026-10-29, CRAWL-11).
  if (!canManage) return hasOwnTimeOff ? <AssociateTimeOffView /> : <NoAccess />;
  // An answer without the day keys and counts is no summary (never a crash
  // or an "undefined" tile).
  const raw = summary.data;
  const s =
    raw && typeof raw.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.today) && Array.isArray(raw.whosOff) && typeof raw.outToday === 'number'
      ? raw
      : undefined;
  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title="Time off"
      subtitle="Who is out, what waits for a decision, and how leave is earned."
      summary={
        canManage ? (
          summary.isError ? (
            <QueryError what="who is out" query={summary} />
          ) : !s ? (
            <Skeleton className="h-24" />
          ) : (
            <MetricStrip label="Who is out">
              <MetricCard
                label="Out today"
                value={String(s.outToday)}
                hint="Approved time off"
                nothing={s.outToday === 0 ? 'No one out today' : undefined}
              />
              <MetricCard
                label="Out this week"
                value={String(s.outThisWeek)}
                hint={fmtKey(s.weekStart) && fmtKey(s.weekEnd) ? `${fmtKey(s.weekStart)} – ${fmtKey(s.weekEnd)}` : undefined}
                nothing={s.outThisWeek === 0 ? 'No one out this week' : undefined}
              />
              <MetricCard
                label="Waiting for a decision"
                value={String(s.pending)}
                hint={s.pending > 0 ? 'Open the queue' : 'Nothing to decide'}
                tone={s.pending > 0 ? 'warning' : 'default'}
                href="/time-off"
              />
              <MetricCard
                label="Starting in 14 days"
                value={String(s.upcoming)}
                hint="Approved, not started yet"
                nothing={s.upcoming === 0 ? 'Nothing coming up' : undefined}
              />
            </MetricStrip>
          )
        ) : undefined
      }
    >
      {canManage && s && (
        <Card id="whos-off" className="scroll-mt-20">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Who's off · next 2 weeks</CardTitle>
          </CardHeader>
          <CardContent>
            <WhosOffStrip summary={s} />
          </CardContent>
        </Card>
      )}
      <Tabs value={tab === 'mine' && !hasOwnTimeOff ? 'requests' : tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="entitlements">Entitlements</TabsTrigger>
          {hasOwnTimeOff && <TabsTrigger value="mine">My time off</TabsTrigger>}
        </TabsList>
        <TabsContent value="requests">
          <AdminTimeOffView canManage={canManage} whosOffShown={canManage && !!s} />
        </TabsContent>
        <TabsContent value="policies">
          <TimeOffPoliciesView canManage={canManage} />
        </TabsContent>
        <TabsContent value="entitlements">
          <AdminTimeOffEntitlementsView canManage={canManage} />
        </TabsContent>
        {hasOwnTimeOff && (
          <TabsContent value="mine">
            <AssociateTimeOffView />
          </TabsContent>
        )}
      </Tabs>
    </ListTemplate>
  );
}
