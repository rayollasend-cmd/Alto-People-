// Role-scoped decision queues — the chairman's "Needs your decision"
// pattern, generalized to every seat in the company. Items are GENERATED
// from live data by CAPABILITY (not hardcoded role lists), clamped to the
// user's client scope where the role is site-bound, and auto-clear when
// the underlying condition resolves — the queue is worked by DOING the
// work, so there is no dismiss/snooze lifecycle here (that stays the
// chairman's prerogative on his own queue).

import type { PrismaClient } from '@prisma/client';
import { hasCapability, type Role } from '@alto-people/shared';
import { startOfWeekUTC } from './timeAnomalies.js';

const DAY_MS = 24 * 3600_000;

export interface RoleDecision {
  key: string;
  severity: 'critical' | 'high' | 'normal';
  label: string;
  detail: string;
  stakes: number | null;
  ageDays: number | null;
  linkUrl: string;
}

const SEVERITY_RANK = { critical: 0, high: 1, normal: 2 } as const;

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
        severity: 'critical',
        label: `${walkIns.length} walk-in clock-in${walkIns.length === 1 ? '' : 's'} waiting on you`,
        detail: `Someone is standing at a kiosk unable to work — oldest has waited ${oldestMin} minutes.`,
        stakes: null,
        ageDays: null,
        linkUrl: '/approvals',
      });
    }
    if (unapproved >= 10) {
      out.push({
        key: scoped('time:unapproved'),
        severity: unapproved >= 100 ? 'high' : 'normal',
        label: `${unapproved} punches from past weeks awaiting approval`,
        detail: 'Unapproved time is unbillable and holds up payroll — run timesheet approval.',
        stakes: null,
        ageDays: null,
        linkUrl: '/time-attendance',
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
        severity: 'high',
        label: `${openToday} shift${openToday === 1 ? '' : 's'} in the next 24h still unassigned`,
        detail: 'Every unfilled shift is unbilled hours and a coverage gap on the floor.',
        stakes: null,
        ageDays: null,
        linkUrl: '/scheduling',
      });
    }
    if (claims > 0) {
      out.push({
        key: scoped('claims:pending'),
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
  if (can('approve:reimbursement')) {
    const pending = await prisma.reimbursement.count({ where: { status: 'SUBMITTED' } });
    if (pending > 0) {
      out.push({
        key: 'reimbursements:approve',
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
    const pending = await prisma.timeOffRequest.count({ where: { status: 'PENDING' } });
    if (pending > 0) {
      out.push({
        key: 'timeoff:pending',
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
        severity: 'normal',
        label: `${p.firstName} ${p.lastName} has been paused ${days} days`,
        detail: 'Limbo is the wrong state — reactivate them or run a separation.',
        stakes: null,
        ageDays: days,
        linkUrl: `/people?associateId=${p.id}`,
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
        severity: 'high',
        label: `${expiringOwn} of your documents expire${expiringOwn === 1 ? 's' : ''} within 60 days`,
        detail: 'Upload the renewal before it blocks you from working.',
        stakes: null,
        ageDays: null,
        linkUrl: '/me',
      });
    }
  }

  out.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return (b.stakes ?? 0) - (a.stakes ?? 0);
  });
  return out;
}
