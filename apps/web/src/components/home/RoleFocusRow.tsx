import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, CalendarCheck, ClipboardList, Clock, Megaphone, ShieldAlert, Timer, Users, type LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { useInbox } from '@/lib/inboxApi';
import { getCaseSummary } from '@/lib/hrCases123Api';
import { listPolicyCampaigns } from '@/lib/policyCampaignsApi';
import { getHeadcount } from '@/lib/positionsApi';
import { laborCosts } from '@/lib/schedulingApi';
import { ymdLocal } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

const INT = new Intl.NumberFormat('en-US');

/**
 * The first row of the shared admin home, by role (HR pack 2026-10). Three
 * roles used to land on the same page with the same tiles:
 *
 *   HR administrator — the people desk: cases against their SLA, policy
 *     campaigns still out, credentials expiring, applications to review.
 *   Operations manager — the floor: coverage today, fill rate this week,
 *     worked hours against scheduled, seats still open.
 *
 * The Manager has its own home (ManagerDashboard). Every tile links to the
 * place the number comes from, and says plainly when a number is unknown.
 */

interface Tile {
  key: string;
  label: string;
  value: string | number | null;
  hint?: string;
  to: string;
  icon: LucideIcon;
  tone?: 'urgent' | 'attention' | 'calm';
}

function FocusTile({ tile }: { tile: Tile }) {
  const Icon = tile.icon;
  return (
    <Link
      to={tile.to}
      className={cn(
        'group flex flex-col rounded-lg border bg-surface p-4 elev-1 transition-all hover:-translate-y-0.5 hover:elev-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        tile.tone === 'urgent' ? 'border-alert/40' : tile.tone === 'attention' ? 'border-warning/30' : 'border-line',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs2 uppercase tracking-wider text-ink-muted">{tile.label}</span>
        <Icon className={cn('h-4 w-4', tile.tone === 'urgent' ? 'text-alert' : tile.tone === 'attention' ? 'text-warning' : 'text-ink-muted')} aria-hidden="true" />
      </div>
      <div className={cn('mt-2 font-display text-2xl tabular-nums', tile.tone === 'urgent' ? 'text-alert' : 'text-ink')}>{tile.value ?? '—'}</div>
      {tile.hint && <div className="mt-1 text-xs text-ink-muted">{tile.hint}</div>}
    </Link>
  );
}

function Row({ title, icon, tiles, loading }: { title: string; icon: LucideIcon; tiles: Tile[]; loading: boolean }) {
  return (
    <section aria-label={title} className="space-y-3">
      <SectionTitle icon={icon} title={title} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="pt-5">
                  <Skeleton className="mb-3 h-3 w-20" />
                  <Skeleton className="h-7 w-1/2" />
                </CardContent>
              </Card>
            ))
          : tiles.map((t) => <FocusTile key={t.key} tile={t} />)}
      </div>
    </section>
  );
}

function HrRow() {
  const term = useTerm();
  const inbox = useInbox();
  const cases = useQuery({ queryKey: ['hrCases', 'summary'], queryFn: () => getCaseSummary() });
  const campaigns = useQuery({ queryKey: ['policy-campaigns'], queryFn: listPolicyCampaigns });
  const count = (key: string) => inbox.data?.sources.find((s) => s.key === key)?.count ?? null;
  const active = (campaigns.data?.campaigns ?? []).filter((c) => c.status === 'ACTIVE');
  const pendingSignatures = active.reduce((sum, c) => sum + c.completion.pending, 0);
  const breached = cases.data?.sla?.breached ?? 0;
  const tiles: Tile[] = [
    {
      key: 'cases',
      label: 'HR cases open',
      value: cases.data?.openTotal ?? null,
      hint: cases.data ? (breached > 0 ? `${breached} past SLA · ${cases.data.sla?.atRisk ?? 0} due within 4h` : `${cases.data.sla?.atRisk ?? 0} due within 4 hours`) : undefined,
      to: breached > 0 ? '/hr-cases?sla=breached' : '/hr-cases',
      icon: ClipboardList,
      tone: breached > 0 ? 'urgent' : (cases.data?.sla?.atRisk ?? 0) > 0 ? 'attention' : 'calm',
    },
    {
      key: 'campaigns',
      label: 'Policy signatures out',
      value: campaigns.data ? pendingSignatures : null,
      hint: campaigns.data ? `${active.length} active ${active.length === 1 ? 'campaign' : 'campaigns'}` : undefined,
      to: '/policy-campaigns',
      icon: Megaphone,
      tone: pendingSignatures > 0 ? 'attention' : 'calm',
    },
    {
      key: 'expiring',
      label: 'Credentials expiring',
      value: count('expirations'),
      hint: 'Expired or due within 30 days',
      to: '/expirations',
      icon: ShieldAlert,
      tone: (count('expirations') ?? 0) > 0 ? 'attention' : 'calm',
    },
    {
      key: 'onboarding',
      label: 'Applications to review',
      value: count('onboarding-review'),
      hint: `New ${term('workers').toLowerCase()} waiting on HR`,
      to: '/onboarding?status=SUBMITTED',
      icon: Users,
      tone: (count('onboarding-review') ?? 0) > 10 ? 'urgent' : (count('onboarding-review') ?? 0) > 0 ? 'attention' : 'calm',
    },
  ];
  return <Row title="Your people desk" icon={ClipboardList} tiles={tiles} loading={cases.isLoading && inbox.isLoading} />;
}

interface OverviewSlice {
  now: { onFloor: number; scheduledNow: number };
  today: { filled: number; open: number };
  week: { start: string; fillRatePct: number | null };
}

function OpsRow() {
  const term = useTerm();
  const overview = useQuery({ queryKey: ['workforce', 'overview'], queryFn: () => apiFetch<OverviewSlice>('/workforce/overview'), staleTime: 60_000 });
  const weekStart = overview.data?.week.start ?? null;
  const tomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return ymdLocal(d);
  })();
  const labor = useQuery({
    queryKey: ['labor-costs', 'week', weekStart, tomorrow],
    queryFn: () => laborCosts({ from: weekStart!, to: tomorrow }),
    enabled: Boolean(weekStart),
    staleTime: 5 * 60_000,
  });
  const positions = useQuery({ queryKey: ['positions', 'headcount'], queryFn: () => getHeadcount() });
  const o = overview.data;
  const worked = labor.data ? Math.round(labor.data.rows.reduce((s, r) => s + r.workedMinutes, 0) / 60) : null;
  const scheduled = labor.data ? Math.round(labor.data.rows.reduce((s, r) => s + r.scheduledMinutes, 0) / 60) : null;
  const openSeats = positions.data ? (positions.data.byStatus.OPEN ?? 0) : null;
  const tiles: Tile[] = [
    {
      key: 'coverage',
      label: 'Coverage today',
      value: o ? `${o.today.filled} / ${o.today.filled + o.today.open}` : null,
      hint: o ? (o.today.open > 0 ? `${o.today.open} shifts still open` : 'Every shift filled') : undefined,
      to: '/scheduling',
      icon: CalendarCheck,
      tone: o && o.today.open > 0 ? 'attention' : 'calm',
    },
    {
      key: 'fill',
      label: 'Fill rate this week',
      value: o ? (o.week.fillRatePct === null ? '—' : `${o.week.fillRatePct}%`) : null,
      hint: o ? `${o.now.onFloor} on the floor now of ${o.now.scheduledNow} scheduled` : undefined,
      to: '/time-attendance',
      icon: Timer,
      tone: o && o.week.fillRatePct !== null && o.week.fillRatePct < 90 ? 'attention' : 'calm',
    },
    {
      key: 'labor',
      label: 'Hours worked this week',
      value: worked === null ? null : INT.format(worked),
      hint: scheduled === null ? undefined : `against ${INT.format(scheduled)} scheduled across ${term('sites').toLowerCase()}`,
      to: '/labor-costs',
      icon: Clock,
    },
    {
      key: 'positions',
      label: 'Open positions',
      value: openSeats,
      hint: positions.data ? `${positions.data.fteFilled} of ${positions.data.fteAuthorized} FTE filled` : undefined,
      to: '/org?tab=positions',
      icon: Briefcase,
      tone: (openSeats ?? 0) > 0 ? 'attention' : 'calm',
    },
  ];
  return <Row title="Your floor this week" icon={CalendarCheck} tiles={tiles} loading={overview.isLoading} />;
}

/** The role's first row on the shared admin home; nothing for roles with their own focus elsewhere. */
export function RoleFocusRow() {
  const { role } = useAuth();
  if (role === 'HR_ADMINISTRATOR') return <HrRow />;
  if (role === 'OPERATIONS_MANAGER') return <OpsRow />;
  return null;
}
