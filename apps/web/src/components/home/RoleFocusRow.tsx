import { useQuery } from '@tanstack/react-query';
import { Briefcase, CalendarCheck, ClipboardList, Clock, ShieldAlert, Timer, Users, type LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { useInbox } from '@/lib/inboxApi';
import { getHeadcount } from '@/lib/positionsApi';
import { laborCosts } from '@/lib/schedulingApi';
import { fmtCount, ymdLocal } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

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
  /** Nothing to count (no shifts, no positions): said in words, never a 0. */
  nothing?: string;
  to: string;
  icon: LucideIcon;
  tone?: 'urgent' | 'attention' | 'calm';
}

const TONE = { urgent: 'alert', attention: 'warning', calm: 'default' } as const;

/** The home's focus tile is the app's KPI tile (MetricCard), linked to the list behind it. */
function FocusTile({ tile }: { tile: Tile }) {
  return (
    <MetricCard
      label={tile.label}
      value={tile.value ?? '—'}
      hint={tile.hint}
      nothing={tile.nothing}
      href={tile.to}
      icon={tile.icon}
      tone={TONE[tile.tone ?? 'calm']}
    />
  );
}

function Row({ title, icon, tiles, loading }: { title: string; icon: LucideIcon; tiles: Tile[]; loading: boolean }) {
  return (
    <section aria-label={title} className="space-y-3">
      <SectionTitle icon={icon} title={title} />
      {loading ? (
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-3 sm:pt-5">
                <Skeleton className="mb-3 h-3 w-20" />
                <Skeleton className="h-7 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <MetricStrip label={title}>
          {tiles.map((t) => (
            <FocusTile key={t.key} tile={t} />
          ))}
        </MetricStrip>
      )}
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
  const shiftsToday = o ? o.today.filled + o.today.open : 0;
  const tiles: Tile[] = [
    {
      key: 'coverage',
      label: 'Coverage today',
      value: o ? `${o.today.filled} / ${shiftsToday}` : null,
      // "0 / 0 · Every shift filled" read as good news on a day with nothing scheduled.
      nothing: o && shiftsToday === 0 ? 'No shifts today' : undefined,
      hint: o ? (o.today.open > 0 ? `${fmtCount(o.today.open, 'shift')} still open` : 'Every shift filled') : undefined,
      to: '/scheduling',
      icon: CalendarCheck,
      tone: o && o.today.open > 0 ? 'attention' : 'calm',
    },
    {
      key: 'fill',
      label: 'Fill rate this week',
      value: o ? (o.week.fillRatePct === null ? '—' : `${o.week.fillRatePct}%`) : null,
      nothing: o && o.week.fillRatePct === null ? 'No shifts this week' : undefined,
      hint: o ? `${o.now.onFloor} on the floor now of ${o.now.scheduledNow} scheduled` : undefined,
      to: '/time-attendance',
      icon: Timer,
      tone: o && o.week.fillRatePct !== null && o.week.fillRatePct < 90 ? 'attention' : 'calm',
    },
    {
      key: 'labor',
      label: 'Hours worked this week',
      value: worked === null ? null : INT.format(worked),
      nothing: worked === 0 && scheduled === 0 ? 'No hours scheduled this week' : undefined,
      hint: scheduled === null ? undefined : `against ${INT.format(scheduled)} scheduled across ${term('sites').toLowerCase()}`,
      to: '/labor-costs',
      icon: Clock,
    },
    {
      key: 'positions',
      label: 'Open positions',
      value: openSeats,
      // "0 · 0 of 0 FTE filled" when no position has been set up.
      nothing: positions.data && positions.data.total === 0 ? 'No positions set up' : undefined,
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
