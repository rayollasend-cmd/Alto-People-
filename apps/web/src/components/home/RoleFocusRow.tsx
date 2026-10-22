import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, CalendarCheck, ClipboardList, Clock, ShieldAlert, Timer, Users, type LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { useInbox } from '@/lib/inboxApi';
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
 *   HR administrator — the people desk, legal clocks first: leave notices,
 *     claims to answer, E-Verify mismatches, and onboarding gone quiet —
 *     the same counts (and filtered links) the Inbox carries.
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
  const source = (key: string) => inbox.data?.sources.find((s) => s.key === key) ?? null;
  const count = (key: string) => (inbox.data ? (source(key)?.count ?? 0) : null);
  // A queue's own link: the Inbox builds the filtered one (E-Verify opens on
  // the mismatches, and on the person when there is exactly one).
  const pathOf = (key: string, fallback: string) => source(key)?.path ?? fallback;
  const legalTone = (n: number | null): Tile['tone'] => ((n ?? 0) > 0 ? 'urgent' : 'calm');
  const leave = count('leave-desk');
  const ui = count('ui-claims');
  const wc = count('wc-claims');
  const claims = ui === null && wc === null ? null : (ui ?? 0) + (wc ?? 0);
  const everify = count('everify-mismatches');
  const stuck = count('onboarding-stuck');
  // Legal clocks first (HR walk 2): leave notices, claim responses and the
  // federal E-Verify deadline run whether or not anyone opens the Inbox.
  const tiles: Tile[] = [
    {
      key: 'leave',
      label: 'Leave notices due',
      value: leave,
      hint: 'Notices owed, certifications due in 3 days, returns this week',
      to: pathOf('leave-desk', '/leave'),
      icon: CalendarCheck,
      tone: legalTone(leave),
    },
    {
      key: 'claims',
      label: 'Claims to answer',
      value: claims,
      hint: inbox.data ? `${ui ?? 0} unemployment · ${wc ?? 0} workers’ comp` : undefined,
      to: (ui ?? 0) === 0 && (wc ?? 0) > 0 ? pathOf('wc-claims', '/claims/workers-comp') : pathOf('ui-claims', '/claims/unemployment'),
      icon: ShieldAlert,
      tone: legalTone(claims),
    },
    {
      key: 'everify',
      label: 'E-Verify mismatches',
      value: everify,
      hint: 'Give the notice and record their choice — a federal clock',
      to: pathOf('everify-mismatches', '/compliance?tab=everify&status=issue'),
      icon: ClipboardList,
      tone: legalTone(everify),
    },
    {
      key: 'stuck',
      label: 'Stuck onboarding',
      value: stuck,
      hint: `New ${term('workers').toLowerCase()} idle more than 7 days`,
      to: pathOf('onboarding-stuck', '/onboarding'),
      icon: Users,
      tone: (stuck ?? 0) > 0 ? 'attention' : 'calm',
    },
  ];
  return <Row title="Your people desk" icon={ClipboardList} tiles={tiles} loading={inbox.isLoading} />;
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
