// Role-scoped decision queues — the chairman's "Needs your decision"
// pattern, generalized to every seat in the company. Items are GENERATED
// from live data by CAPABILITY (not hardcoded role lists), clamped to the
// user's client scope where the role is site-bound, and auto-clear when
// the underlying condition resolves — the queue is worked by DOING the
// work, so there is no dismiss/snooze lifecycle here (that stays the
// chairman's prerogative on his own queue).

import type { PrismaClient } from '@prisma/client';
import { hasCapability, type Role } from '@alto-people/shared';
import { computeNoShowRisk } from './noShowRisk.js';
import { startOfWeekUTC } from './timeAnomalies.js';

const DAY_MS = 24 * 3600_000;

export type DecisionDomain =
  | 'site-ops'
  | 'people'
  | 'hiring'
  | 'compliance'
  | 'money'
  | 'personal';

export interface RoleDecision {
  key: string;
  severity: 'critical' | 'high' | 'normal';
  label: string;
  detail: string;
  stakes: number | null;
  ageDays: number | null;
  linkUrl: string;
  /** Which craft this item belongs to — drives the role-affinity layer. */
  domain: DecisionDomain;
  /** One-tap resolution, when a safe bulk fix exists — the button label
   *  shown on the item (POST /me/decisions/quick executes it). */
  quickAction?: string;
}

const SEVERITY_RANK = { critical: 0, high: 1, normal: 2 } as const;

/**
 * Role affinity — capabilities gate ACCESS, this shapes RELEVANCE. Six
 * roles share the identical full-admin capability set as product policy,
 * so a pure capability engine served the Marketing Manager the same
 * queue as the HR Administrator. Each role leads with its own craft and
 * excludes domains that aren't its job (personal items are never
 * excluded). Roles not listed keep everything their capabilities allow.
 */
const ROLE_PROFILES: Partial<
  Record<Role, { lead: DecisionDomain[]; exclude: DecisionDomain[] }>
> = {
  SHIFT_SUPERVISOR: { lead: ['site-ops', 'people'], exclude: [] },
  FINANCE_ACCOUNTANT: { lead: ['money'], exclude: [] },
  HR_ADMINISTRATOR: { lead: ['hiring', 'compliance', 'people'], exclude: [] },
  OPERATIONS_MANAGER: { lead: ['site-ops', 'people', 'money'], exclude: [] },
  MANAGER: { lead: ['people', 'site-ops'], exclude: ['money', 'compliance', 'hiring'] },
  INTERNAL_RECRUITER: { lead: ['hiring', 'compliance'], exclude: ['money', 'site-ops', 'people'] },
  WORKFORCE_MANAGER: { lead: ['site-ops', 'people', 'hiring'], exclude: ['money'] },
  // Marketing runs communications, not operations — their queue is
  // honestly quiet rather than a copy of HR's worries.
  MARKETING_MANAGER: {
    lead: [],
    exclude: ['site-ops', 'people', 'hiring', 'compliance', 'money'],
  },
};

interface QueueUser {
  id: string;
  role: Role;
  clientId: string | null;
  associateId: string | null;
}

export async function computeRoleDecisions(
  prisma: PrismaClient,
  user: QueueUser,
  now: Date = new Date(),
): Promise<RoleDecision[]> {
  const out: RoleDecision[] = [];
  const can = (c: Parameters<typeof hasCapability>[1]) => hasCapability(user.role, c);
  const thisWeekStart = startOfWeekUTC(now);
  // Client-scoped operators see their site; org roles see everything.
  const clientClamp = user.clientId ? { clientId: user.clientId } : {};
  // Scope-aware keys: two supervisors at the SAME site share one item
  // (and see each other's claims); different sites never collide.
  const scoped = (key: string) => (user.clientId ? `${key}:${user.clientId}` : key);

  /* ----- Site operations (supervisors + anyone managing time) ----------- */
  if (can('manage:time')) {
    const [walkIns, unapproved] = await Promise.all([
      prisma.clockInRequest.findMany({
        where: { status: 'PENDING', ...clientClamp },
        select: { requestedAt: true },
        take: 100,
      }),
      prisma.timeEntry.count({
        where: { status: 'COMPLETED', clockInAt: { lt: thisWeekStart }, ...clientClamp },
      }),
    ]);
    if (walkIns.length > 0) {
      const oldestMin = Math.max(
        ...walkIns.map((w) => Math.round((now.getTime() - w.requestedAt.getTime()) / 60_000)),
      );
      out.push({
        key: scoped('walkins:pending'),
        domain: 'site-ops',
        severity: 'critical',
        label: `${walkIns.length} walk-in clock-in${walkIns.length === 1 ? '' : 's'} waiting on you`,
        detail: `Someone is standing at a kiosk unable to work — oldest has waited ${oldestMin} minutes.`,
        stakes: null,
        ageDays: null,
        linkUrl: '/approvals',
        quickAction: 'Approve all',
      });
    }
    if (unapproved >= 10) {
      out.push({
        key: scoped('time:unapproved'),
        domain: 'site-ops',
        severity: unapproved >= 100 ? 'high' : 'normal',
        label: `${unapproved} punches from past weeks awaiting approval`,
        detail: 'Unapproved time is unbillable and holds up payroll — run timesheet approval.',
        stakes: null,
        ageDays: null,
        linkUrl: '/time-attendance',
      });
    }
  }
  // Store-ops floor signals — keys mirrored with the executive engine
  // (same convention as time:unapproved: scoped for bounded supervisors,
  // plain for org-wide roles).
  if (can('view:ops') || can('run:ops-shifts')) {
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const [tempAlerts, incompleteCloses] = await Promise.all([
      prisma.opsTask.count({
        where: {
          tempOutOfRange: true,
          updatedAt: { gte: dayAgo },
          opsShift: { is: { ...clientClamp } },
        },
      }),
      prisma.opsShift.count({
        where: { closedIncomplete: true, closedAt: { gte: dayAgo }, ...clientClamp },
      }),
    ]);
    if (tempAlerts > 0) {
      out.push({
        key: scoped('ops:temp-alerts'),
        domain: 'site-ops',
        severity: 'critical',
        label: `${tempAlerts} temperature reading${tempAlerts === 1 ? '' : 's'} out of range`,
        detail: 'Food-safety equipment may be failing — check the cases and log the fix.',
        stakes: null,
        ageDays: null,
        linkUrl: '/ops',
      });
    }
    if (incompleteCloses > 0) {
      out.push({
        key: scoped('ops:incomplete'),
        domain: 'site-ops',
        severity: 'high',
        label: `${incompleteCloses} ops shift${incompleteCloses === 1 ? '' : 's'} closed with required work unfinished`,
        detail: 'The record says the standard was not met — read the closing notes and follow up.',
        stakes: null,
        ageDays: null,
        linkUrl: '/ops',
      });
    }
  }
  if (can('manage:scheduling')) {
    const [openToday, claims] = await Promise.all([
      prisma.shift.count({
        where: {
          publishedAt: { not: null },
          status: 'OPEN',
          assignedAssociateId: null,
          startsAt: { gte: now, lt: new Date(now.getTime() + DAY_MS) },
          ...clientClamp,
        },
      }),
      prisma.openShiftClaim.count({
        where: { status: 'PENDING', ...(user.clientId ? { shift: { clientId: user.clientId } } : {}) },
      }),
    ]);
    if (openToday > 0) {
      out.push({
        key: scoped('shifts:open-24h'),
        domain: 'site-ops',
        severity: 'high',
        label: `${openToday} shift${openToday === 1 ? '' : 's'} in the next 24h still unassigned`,
        detail:
          'The auto-fill engine already invited the eligible bench — these still need a hand.',
        stakes: null,
        ageDays: null,
        linkUrl: '/scheduling',
      });
    }
    // Prediction, not reaction: tomorrow's shifts held by high-risk
    // attendees, flagged tonight (site-scoped callers only — org admins
    // get the evening digest instead of a per-site row).
    if (user.clientId) {
      const risky = await computeNoShowRisk(prisma, now, user.clientId);
      if (risky.length > 0) {
        out.push({
          key: scoped('risk:tomorrow'),
          domain: 'site-ops',
          severity: 'high',
          label: `${risky.length} of tomorrow's shifts ${risky.length === 1 ? 'is' : 'are'} held by high-risk attendees`,
          detail: `History-based flag (${risky
            .slice(0, 3)
            .map((r) => r.holderName)
            .join(', ')}) — worth a confirmation text tonight or a pre-arranged backup.`,
          stakes: null,
          ageDays: null,
          linkUrl: '/scheduling',
        });
      }
    }
    if (claims > 0) {
      out.push({
        key: scoped('claims:pending'),
        domain: 'site-ops',
        severity: 'normal',
        label: `${claims} open-shift pickup${claims === 1 ? '' : 's'} awaiting review`,
        detail: 'Associates volunteered — a fast yes fills the schedule and rewards initiative.',
        stakes: null,
        ageDays: null,
        linkUrl: '/approvals',
      });
    }
  }

  /* ----- People management (managers + admins) --------------------------- */
  // A MANAGER's queue is team-wide, not org-wide: when their login links
  // to an associate record, approvals count only their direct reports.
  // Other roles (and managers without team linkage) stay org-wide.
  const teamClamp =
    user.role === 'MANAGER' && user.associateId
      ? { associate: { managerId: user.associateId } }
      : {};
  if (can('approve:reimbursement')) {
    const pending = await prisma.reimbursement.count({
      where: { status: 'SUBMITTED', ...teamClamp },
    });
    if (pending > 0) {
      out.push({
        key: 'reimbursements:approve',
        domain: 'people',
        severity: 'normal',
        label: `${pending} reimbursement${pending === 1 ? '' : 's'} awaiting your approval`,
        detail: 'Associates fronted this money — a quick decision keeps trust intact.',
        stakes: null,
        ageDays: null,
        linkUrl: '/reimbursements',
      });
    }
  }
  if (can('manage:team-time-off')) {
    const pending = await prisma.timeOffRequest.count({
      where: { status: 'PENDING', ...teamClamp },
    });
    if (pending > 0) {
      out.push({
        key: 'timeoff:pending',
        domain: 'people',
        severity: 'normal',
        label: `${pending} time-off request${pending === 1 ? '' : 's'} awaiting a decision`,
        detail: 'People are holding plans on your answer.',
        stakes: null,
        ageDays: null,
        linkUrl: '/time-off',
      });
    }
  }

  /* ----- Hiring & compliance (HR admins) --------------------------------- */
  if (can('manage:onboarding')) {
    const [stuck, i9Pending] = await Promise.all([
      prisma.application.count({
        where: {
          deletedAt: null,
          status: { in: ['SUBMITTED', 'IN_REVIEW'] },
          updatedAt: { lt: new Date(now.getTime() - 5 * DAY_MS) },
        },
      }),
      prisma.i9Verification.count({
        where: {
          section1CompletedAt: { not: null },
          section2CompletedAt: null,
          associate: { deletedAt: null, separatedAt: null, deactivatedAt: null },
        },
      }),
    ]);
    if (stuck > 0) {
      out.push({
        key: 'onboarding:stuck',
        domain: 'hiring',
        severity: stuck >= 5 ? 'high' : 'normal',
        label: `${stuck} candidate${stuck === 1 ? '' : 's'} stuck in review over 5 days`,
        detail: 'Every stalled day risks losing them to another employer.',
        stakes: null,
        ageDays: null,
        linkUrl: '/onboarding',
      });
    }
    if (i9Pending > 0) {
      out.push({
        key: 'i9:section2',
        domain: 'hiring',
        severity: 'high',
        label: `${i9Pending} I-9 Section 2 verification${i9Pending === 1 ? '' : 's'} pending`,
        detail: 'Federal deadline: Section 2 within 3 business days of the start date.',
        stakes: null,
        ageDays: null,
        linkUrl: '/compliance',
      });
    }
  }
  if (can('manage:compliance')) {
    const expiring = await prisma.documentRecord.findMany({
      where: {
        deletedAt: null,
        kind: { in: ['ID', 'I9_SUPPORTING', 'J1_VISA', 'J1_DS2019'] },
        expiresAt: { gte: now, lt: new Date(now.getTime() + 30 * DAY_MS) },
        associate: { deletedAt: null, separatedAt: null, deactivatedAt: null },
      },
      select: { associateId: true },
      take: 500,
    });
    const people = new Set(expiring.map((d) => d.associateId)).size;
    if (people > 0) {
      out.push({
        key: 'compliance:expiring-docs',
        domain: 'compliance',
        severity: 'high',
        label: `${people} associate${people === 1 ? "'s" : "s'"} work documents expire within 30 days`,
        detail: 'Expired documents block legal work — collect renewals now.',
        stakes: null,
        ageDays: null,
        linkUrl: '/expirations',
      });
    }
  }
  if (can('manage:org')) {
    // Per-associate keys, IDENTICAL to the executive engine's — the
    // chairman and HR collaborate on the same item, not two shadows.
    const paused = await prisma.associate.findMany({
      where: { deletedAt: null, deactivatedAt: { lt: new Date(now.getTime() - 42 * DAY_MS) } },
      select: { id: true, firstName: true, lastName: true, deactivatedAt: true },
      take: 5,
    });
    for (const p of paused) {
      const days = Math.floor((now.getTime() - p.deactivatedAt!.getTime()) / DAY_MS);
      out.push({
        key: `associate:paused:${p.id}`,
        domain: 'people',
        severity: 'normal',
        label: `${p.firstName} ${p.lastName} has been paused ${days} days`,
        detail: 'Limbo is the wrong state — reactivate them or run a separation.',
        stakes: null,
        ageDays: days,
        linkUrl: `/people?associateId=${p.id}`,
        quickAction: 'Reactivate',
      });
    }
  }

  /* ----- Money (payroll / finance) ---------------------------------------- */
  if (can('settle:reimbursement')) {
    const toSettle = await prisma.reimbursement.count({
      where: { status: 'MANAGER_APPROVED' },
    });
    if (toSettle > 0) {
      out.push({
        key: 'reimbursements:settle',
        domain: 'money',
        severity: 'normal',
        label: `${toSettle} approved reimbursement${toSettle === 1 ? '' : 's'} to settle`,
        detail: 'Fold them into the next regular payroll run.',
        stakes: null,
        ageDays: null,
        linkUrl: '/reimbursements',
      });
    }
  }
  if (can('process:payroll')) {
    const statementTotal = (snapshot: unknown): number => {
      const t = (snapshot as { totals?: { amount?: number } } | null)?.totals?.amount;
      return typeof t === 'number' ? t : 0;
    };
    const [drafts, unpaid] = await Promise.all([
      prisma.clientStatement.findMany({
        where: { status: 'DRAFT', updatedAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } },
        select: { snapshot: true },
        take: 50,
      }),
      prisma.clientStatement.findMany({
        where: {
          status: 'FINAL',
          paidAt: null,
          finalizedAt: { lt: new Date(now.getTime() - 45 * DAY_MS) },
        },
        select: {
          id: true,
          number: true,
          snapshot: true,
          finalizedAt: true,
          client: { select: { name: true } },
        },
        take: 20,
      }),
    ]);
    if (drafts.length > 0) {
      const total = drafts.reduce((n, d) => n + statementTotal(d.snapshot), 0);
      out.push({
        // Same key as the executive engine — one shared item.
        key: 'statements:stale-drafts',
        domain: 'money',
        severity: 'normal',
        label: `${drafts.length} draft statement${drafts.length === 1 ? '' : 's'} to finalize`,
        detail: 'Drafts idle over a week are unbilled revenue.',
        stakes: total || null,
        ageDays: null,
        linkUrl: '/clients',
      });
    }
    // Per-statement, with keys IDENTICAL to the executive engine's, so a
    // Finance claim shows on the chairman's queue and vice versa.
    for (const s of unpaid) {
      const days = s.finalizedAt
        ? Math.floor((now.getTime() - s.finalizedAt.getTime()) / DAY_MS)
        : 0;
      const amount = statementTotal(s.snapshot);
      out.push({
        key: `receivable:${s.id}`,
        domain: 'money',
        severity: days >= 60 || amount >= 5_000 ? 'critical' : 'high',
        label: `Chase ${s.client.name} statement #${s.number ?? '—'}`,
        detail: `${days} days unpaid — chase the cash or flag it upward.`,
        stakes: amount || null,
        ageDays: days,
        linkUrl: '/clients',
      });
    }
  }

  /* ----- Personal to-dos (anyone with an associate record) --------------- */
  if (user.associateId) {
    const [openTasks, expiringOwn] = await Promise.all([
      prisma.application.findFirst({
        where: { associateId: user.associateId, deletedAt: null },
        orderBy: { invitedAt: 'desc' },
        select: {
          checklist: {
            select: { tasks: { select: { status: true } } },
          },
        },
      }),
      prisma.documentRecord.count({
        where: {
          associateId: user.associateId,
          deletedAt: null,
          expiresAt: { gte: now, lt: new Date(now.getTime() + 60 * DAY_MS) },
        },
      }),
    ]);
    const remaining =
      openTasks?.checklist?.tasks.filter(
        (t) => t.status === 'PENDING' || t.status === 'IN_PROGRESS',
      ).length ?? 0;
    if (remaining > 0) {
      out.push({
        key: 'me:onboarding-tasks',
        domain: 'personal',
        severity: 'high',
        label: `${remaining} onboarding task${remaining === 1 ? '' : 's'} left to finish`,
        detail: 'Finishing them clears you for the schedule and payroll.',
        stakes: null,
        ageDays: null,
        linkUrl: '/onboarding',
      });
    }
    if (expiringOwn > 0) {
      out.push({
        key: 'me:expiring-docs',
        domain: 'personal',
        severity: 'high',
        label: `${expiringOwn} of your documents expire${expiringOwn === 1 ? 's' : ''} within 60 days`,
        detail: 'Upload the renewal before it blocks you from working.',
        stakes: null,
        ageDays: null,
        linkUrl: '/me',
      });
    }
  }

  // Role affinity: exclude domains that aren't this role's job (never
  // personal items), then rank severity → own-craft-first → stakes.
  const profile = ROLE_PROFILES[user.role];
  const filtered = profile
    ? out.filter((d) => d.domain === 'personal' || !profile.exclude.includes(d.domain))
    : out;
  const leadRank = (d: RoleDecision): number => {
    if (!profile) return 99;
    const i = profile.lead.indexOf(d.domain);
    return i === -1 ? 99 : i;
  };
  filtered.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    const lead = leadRank(a) - leadRank(b);
    if (lead !== 0) return lead;
    return (b.stakes ?? 0) - (a.stakes ?? 0);
  });
  return filtered;
}
