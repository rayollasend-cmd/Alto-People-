import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Calendar,
  ClipboardList,
  Clock,
  DollarSign,
  FileSearch,
  FileText,
  ShieldCheck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type {
  AuditSearchEntry,
  DashboardKPIs,
} from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS, type Role } from '@/lib/roles';
import { getDashboardKPIs } from '@/lib/analyticsApi';
import { searchAuditLogs } from '@/lib/auditApi';
import { ApiError } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * Role-tailored subtitle on the greeting strip. The same dashboard scaffold
 * serves every non-associate role, but the framing copy and the visible
 * sections vary based on what the user can actually act on (see
 * ActionRequiredSection / ActivityFeed gating below).
 */
const SUBTITLE_BY_ROLE: Partial<Record<Role, string>> = {
  HR_ADMINISTRATOR:
    "Here's what's happening across your workforce today.",
  OPERATIONS_MANAGER:
    'Operations snapshot — schedule, time, and onboarding at a glance.',
  EXECUTIVE_CHAIRMAN:
    'Company-wide pulse. Read-only across every module.',
  FINANCE_ACCOUNTANT:
    'Financial pulse — payroll runs, disbursements, and pending tax filings.',
  INTERNAL_RECRUITER:
    'Recruiting pipeline and open onboarding applications.',
  CLIENT_PORTAL: 'Your workforce snapshot.',
  MANAGER: 'Your team — pending approvals and time-off requests.',
};

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

const fmtRelative = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
};

const greetingFor = (hour: number): string => {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 22) return 'Good evening';
  return 'Burning the midnight oil';
};

const firstNameFromEmail = (email: string): string => {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._-]+/)[0] ?? local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'there';
};

/**
 * Friendly verbs for audit `action` codes. The audit log emits dotted
 * machine codes (auth.login_succeeded, document.verified, etc.) — in the
 * dashboard activity feed we need short, scannable English. Falls back
 * to a humanized version of the dotted code when the verb isn't mapped.
 */
const ACTION_VERB: Record<string, string> = {
  'auth.login_succeeded': 'signed in',
  'auth.login_failed': 'failed to sign in',
  'auth.logout': 'signed out',
  'auth.password_changed': 'changed their password',
  'application.created': 'opened a new application',
  'application.submitted': 'submitted an application',
  'application.approved': 'approved an application',
  'application.rejected': 'rejected an application',
  'document.uploaded': 'uploaded a document',
  'document.verified': 'verified a document',
  'document.rejected': 'rejected a document',
  'i9.section1_completed': 'completed I-9 Section 1',
  'i9.section2_completed': 'completed I-9 Section 2',
  'payroll.disbursed': 'disbursed a payroll run',
  'payroll.finalized': 'finalized a payroll run',
  'time.entry_approved': 'approved a time entry',
  'time.entry_rejected': 'rejected a time entry',
  'kiosk.pin_assigned': 'issued an employee number',
};
const humanizeAction = (action: string): string => {
  if (ACTION_VERB[action]) return ACTION_VERB[action];
  // Fall back: take the part after the last dot, swap underscores.
  const tail = action.split('.').pop() ?? action;
  return tail.replace(/_/g, ' ');
};

export function AdminDashboard() {
  const { user, role, can } = useAuth();
  const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
  const [activity, setActivity] = useState<AuditSearchEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Live header time, ticking every minute. Cheap.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Audit feed only loads when the user has audit access. Saves a
  // pointless 403 round-trip and keeps the section out of view entirely
  // for everyone else.
  const canSeeAudit = can('view:audit');
  const canSeeOnboarding = can('view:onboarding');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [k, a] = await Promise.all([
          getDashboardKPIs(),
          canSeeAudit
            ? searchAuditLogs({ limit: 8 }).catch(() => ({
                entries: [] as AuditSearchEntry[],
                nextBefore: null,
              }))
            : Promise.resolve({
                entries: [] as AuditSearchEntry[],
                nextBefore: null,
              }),
        ]);
        if (cancelled) return;
        setKpis(k);
        setActivity(a.entries);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err.message
            : 'Failed to load dashboard data.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canSeeAudit]);

  const greetingName = user?.email
    ? firstNameFromEmail(user.email)
    : 'there';
  const greeting = greetingFor(now.getHours());
  const dateLabel = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      {/* Greeting strip — calm, generous typography, time + role context. */}
      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] text-silver/70 flex items-center gap-2">
          <Calendar className="h-3 w-3" aria-hidden="true" />
          {dateLabel}
          {role && (
            <>
              <span className="text-silver/30">·</span>
              <span className="text-silver">{ROLE_LABELS[role]}</span>
            </>
          )}
        </div>
        <h1 className="font-display text-3xl md:text-4xl text-white mt-2 leading-tight">
          {greeting}, <span className="text-gold">{greetingName}</span>.
        </h1>
        <p className="text-silver mt-2 text-sm md:text-base">
          {(role && SUBTITLE_BY_ROLE[role]) ??
            "Here's what's happening across your workforce today."}
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 px-4 py-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <ActionRequiredSection
        kpis={kpis}
        canManageOnboarding={can('manage:onboarding')}
        canManageCompliance={can('manage:compliance')}
        canManageDocuments={can('manage:documents')}
        canProcessPayroll={can('process:payroll')}
      />

      <KpiSection kpis={kpis} />

      {canSeeOnboarding && <OnboardingFunnel kpis={kpis} />}

      {canSeeAudit && <ActivityFeed entries={activity} />}
    </div>
  );
}

/* ============================ Action required ============================ */

interface ActionItem {
  count: number;
  label: string;
  hint?: string;
  to: string;
  cta: string;
  icon: LucideIcon;
  /** Severity drives the accent color. */
  severity: 'info' | 'attention' | 'urgent';
}

function ActionRequiredSection({
  kpis,
  canManageOnboarding,
  canManageCompliance,
  canManageDocuments,
  canProcessPayroll,
}: {
  kpis: DashboardKPIs | null;
  canManageOnboarding: boolean;
  canManageCompliance: boolean;
  canManageDocuments: boolean;
  canProcessPayroll: boolean;
}) {
  const hasAnyActionCapability =
    canManageOnboarding ||
    canManageCompliance ||
    canManageDocuments ||
    canProcessPayroll;

  const items: ActionItem[] = useMemo(() => {
    if (!kpis) return [];
    const xs: ActionItem[] = [];
    if (canManageOnboarding && kpis.pendingOnboardingApplications > 0) {
      xs.push({
        count: kpis.pendingOnboardingApplications,
        label:
          kpis.pendingOnboardingApplications === 1
            ? 'Application to review'
            : 'Applications to review',
        hint: 'Move them through onboarding.',
        to: '/onboarding',
        cta: 'Open onboarding',
        icon: ClipboardList,
        severity:
          kpis.pendingOnboardingApplications > 10 ? 'urgent' : 'attention',
      });
    }
    if (canManageCompliance && kpis.pendingI9Section2 > 0) {
      xs.push({
        count: kpis.pendingI9Section2,
        label: 'I-9 Section 2 due',
        hint: 'Federal deadline: 3 business days from hire.',
        to: '/compliance',
        cta: 'Complete Section 2',
        icon: ShieldCheck,
        severity: 'urgent',
      });
    }
    if (canManageDocuments && kpis.pendingDocumentReviews > 0) {
      xs.push({
        count: kpis.pendingDocumentReviews,
        label:
          kpis.pendingDocumentReviews === 1
            ? 'Document waiting for verification'
            : 'Documents waiting for verification',
        to: '/documents',
        cta: 'Review documents',
        icon: FileSearch,
        severity: kpis.pendingDocumentReviews > 20 ? 'urgent' : 'attention',
      });
    }
    if (canProcessPayroll && kpis.netPendingDisbursement > 0) {
      xs.push({
        count: 1,
        label: `${fmtMoney(kpis.netPendingDisbursement)} pending payroll`,
        hint: 'Finalized runs awaiting disbursement.',
        to: '/payroll',
        cta: 'Open payroll',
        icon: Wallet,
        severity: 'attention',
      });
    }
    return xs;
  }, [
    kpis,
    canManageOnboarding,
    canManageCompliance,
    canManageDocuments,
    canProcessPayroll,
  ]);

  // Roles with no manage capabilities at all (EXECUTIVE_CHAIRMAN,
  // CLIENT_PORTAL view-only) never have actions to take from here —
  // hide the whole section instead of showing a misleading "all caught
  // up" green banner.
  if (!hasAnyActionCapability) return null;

  if (!kpis) {
    return (
      <section aria-label="Action required" className="space-y-3">
        <SectionTitle icon={AlertTriangle}>Needs your attention</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-5">
                <Skeleton className="h-3 w-20 mb-3" />
                <Skeleton className="h-7 w-1/2 mb-2" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    );
  }
  if (items.length === 0) {
    return (
      <section aria-label="Action required">
        <Card className="border-success/30 bg-success/5">
          <CardContent className="py-5 flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-success/15 grid place-items-center text-success shrink-0">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-white font-medium">You're all caught up</div>
              <div className="text-sm text-silver">
                No applications, I-9s, document reviews, or payroll disbursements
                waiting on you.
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }
  return (
    <section aria-label="Action required" className="space-y-3">
      <SectionTitle icon={AlertTriangle}>Needs your attention</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.map((item) => (
          <ActionCard key={item.to + item.label} item={item} />
        ))}
      </div>
    </section>
  );
}

function ActionCard({ item }: { item: ActionItem }) {
  const Icon = item.icon;
  const tone =
    item.severity === 'urgent'
      ? {
          ring: 'border-alert/30 hover:border-alert/60',
          dot: 'bg-alert/15 text-alert',
          count: 'text-alert',
        }
      : item.severity === 'attention'
        ? {
            ring: 'border-amber-500/25 hover:border-amber-500/55',
            dot: 'bg-amber-500/15 text-amber-400',
            count: 'text-amber-300',
          }
        : {
            ring: 'border-navy-secondary hover:border-gold/40',
            dot: 'bg-gold/10 text-gold',
            count: 'text-gold',
          };

  return (
    <Link
      to={item.to}
      className={cn(
        'group flex flex-col rounded-lg border bg-navy p-5 transition-all',
        'hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight',
        tone.ring,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={cn(
            'h-10 w-10 rounded-lg grid place-items-center shrink-0',
            tone.dot,
          )}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div
          className={cn(
            'font-display text-3xl tabular-nums leading-none',
            tone.count,
          )}
        >
          {item.count}
        </div>
      </div>
      <div className="mt-4 text-white font-medium leading-snug">
        {item.label}
      </div>
      {item.hint && (
        <div className="mt-1 text-xs text-silver">{item.hint}</div>
      )}
      <div className="mt-4 flex items-center gap-1 text-sm text-gold group-hover:text-gold-bright">
        {item.cta}
        <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
      </div>
    </Link>
  );
}

/* ================================== KPIs ================================= */

interface Kpi {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
}

function KpiSection({ kpis }: { kpis: DashboardKPIs | null }) {
  return (
    <section aria-label="Workforce metrics" className="space-y-3">
      <SectionTitle icon={Activity}>Workforce snapshot</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis ? (
          buildKpis(kpis).map((kpi) => <KpiTile key={kpi.label} kpi={kpi} />)
        ) : (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-5">
                <Skeleton className="h-3 w-20 mb-3" />
                <Skeleton className="h-9 w-1/2 mb-2" />
                <Skeleton className="h-3 w-1/3" />
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </section>
  );
}

function buildKpis(k: DashboardKPIs): Kpi[] {
  return [
    {
      label: 'Active associates',
      value: k.activeAssociates.toLocaleString(),
      hint:
        k.associatesClockedIn > 0
          ? `${k.associatesClockedIn.toLocaleString()} clocked in now`
          : 'No one on the clock',
      icon: Users,
    },
    {
      label: `Open shifts · next ${k.windowDays}d`,
      value: k.openShiftsNext30d.toLocaleString(),
      hint: k.openShiftsNext30d === 0 ? 'Schedule fully covered' : undefined,
      icon: Clock,
    },
    {
      label: 'Onboarding in flight',
      value: k.pendingOnboardingApplications.toLocaleString(),
      hint:
        k.pendingI9Section2 > 0
          ? `${k.pendingI9Section2} I-9 Section 2 pending`
          : 'I-9s up to date',
      icon: ClipboardList,
    },
    {
      label: `Net paid · last ${k.windowDays}d`,
      value: fmtMoney(k.netPaidLast30d),
      hint:
        k.netPendingDisbursement > 0
          ? `${fmtMoney(k.netPendingDisbursement)} queued`
          : 'No pending runs',
      icon: DollarSign,
    },
  ];
}

function KpiTile({ kpi }: { kpi: Kpi }) {
  const Icon = kpi.icon;
  return (
    <Card className="hover:border-gold/30 transition-colors">
      <CardContent className="pt-5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] md:text-[11px] uppercase tracking-[0.15em] text-silver">
            {kpi.label}
          </div>
          <Icon className="h-3.5 w-3.5 text-silver/50" aria-hidden="true" />
        </div>
        <div className="font-display text-3xl md:text-[2rem] text-white mt-3 leading-none tabular-nums">
          {kpi.value}
        </div>
        {kpi.hint && (
          <div className="text-xs text-silver/80 mt-2 truncate">{kpi.hint}</div>
        )}
      </CardContent>
    </Card>
  );
}

/* =========================== Onboarding funnel =========================== */

const PIPELINE_ORDER = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED'] as const;
const PIPELINE_LABEL: Record<(typeof PIPELINE_ORDER)[number], string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};
const PIPELINE_TONE: Record<(typeof PIPELINE_ORDER)[number], string> = {
  DRAFT: 'text-silver',
  SUBMITTED: 'text-amber-300',
  IN_REVIEW: 'text-amber-400',
  APPROVED: 'text-emerald-400',
  REJECTED: 'text-alert',
};

function OnboardingFunnel({ kpis }: { kpis: DashboardKPIs | null }) {
  if (!kpis) {
    return (
      <section aria-label="Onboarding funnel" className="space-y-3">
        <SectionTitle icon={ClipboardList}>Onboarding pipeline</SectionTitle>
        <Card>
          <CardContent className="py-6 grid grid-cols-2 md:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i}>
                <Skeleton className="h-3 w-16 mb-2" />
                <Skeleton className="h-7 w-10" />
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    );
  }
  const counts = kpis.applicationStatusCounts;
  const total = PIPELINE_ORDER.reduce(
    (sum, status) => sum + (counts[status] ?? 0),
    0,
  );
  if (total === 0) {
    return (
      <section aria-label="Onboarding funnel" className="space-y-3">
        <SectionTitle icon={ClipboardList}>Onboarding pipeline</SectionTitle>
        <Card>
          <CardContent className="py-6 text-center">
            <div className="text-silver text-sm">
              No applications yet. New hires will appear here as HR creates them.
            </div>
            <Link
              to="/onboarding"
              className="inline-flex items-center gap-1 text-sm text-gold hover:text-gold-bright mt-2"
            >
              Open onboarding
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </CardContent>
        </Card>
      </section>
    );
  }
  return (
    <section aria-label="Onboarding funnel" className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <SectionTitle icon={ClipboardList}>Onboarding pipeline</SectionTitle>
        <Link
          to="/onboarding"
          className="text-xs text-gold hover:text-gold-bright inline-flex items-center gap-1"
        >
          View all
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <Card>
        <CardContent className="py-5">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {PIPELINE_ORDER.map((status) => {
              const count = counts[status] ?? 0;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={status} className="min-w-0">
                  <div className="text-[10px] uppercase tracking-widest text-silver">
                    {PIPELINE_LABEL[status]}
                  </div>
                  <div
                    className={cn(
                      'font-display text-3xl mt-1 tabular-nums',
                      PIPELINE_TONE[status],
                    )}
                  >
                    {count}
                  </div>
                  {/* Inline funnel bar — width relative to total. */}
                  <div className="mt-2 h-1.5 rounded-full bg-navy-secondary/60 overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        status === 'APPROVED'
                          ? 'bg-emerald-500/70'
                          : status === 'REJECTED'
                            ? 'bg-alert/70'
                            : 'bg-gold/70',
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-silver/70 mt-1 tabular-nums">
                    {pct}% of pipeline
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/* ============================== Activity feed ============================ */

function ActivityFeed({ entries }: { entries: AuditSearchEntry[] | null }) {
  return (
    <section aria-label="Recent activity" className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <SectionTitle icon={FileText}>Recent activity</SectionTitle>
        <Link
          to="/audit"
          className="text-xs text-gold hover:text-gold-bright inline-flex items-center gap-1"
        >
          Audit log
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <Card>
        <CardContent className="p-0">
          {entries === null ? (
            <div className="p-5 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1">
                    <Skeleton className="h-3 w-2/3 mb-1.5" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="p-6 text-center text-silver text-sm">
              No activity in the audit log yet — events will appear here as
              people use the platform.
            </div>
          ) : (
            <ul className="divide-y divide-navy-secondary/60">
              {entries.slice(0, 6).map((e) => (
                <li
                  key={e.id}
                  className="px-5 py-3 flex items-center gap-3 hover:bg-navy-secondary/20 transition-colors"
                >
                  <div className="h-8 w-8 rounded-full bg-navy-secondary/60 grid place-items-center shrink-0 text-silver text-xs">
                    {(e.actorEmail ?? 'S')
                      .split(/[@._-]+/)[0]
                      ?.slice(0, 2)
                      .toUpperCase() ?? '••'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white truncate">
                      <span className="text-silver">
                        {e.actorEmail ?? 'System'}
                      </span>{' '}
                      {humanizeAction(e.action)}
                    </div>
                    <div className="text-[11px] text-silver/70">
                      {e.entityType} ·{' '}
                      <span className="tabular-nums">
                        {fmtRelative(e.createdAt)}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/* ============================== Section title ============================ */

function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <h2 className="text-xs uppercase tracking-[0.18em] text-silver/80 flex items-center gap-2">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
    </h2>
  );
}
