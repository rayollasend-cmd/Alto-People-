import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { EMPLOYED_WHERE } from '../lib/activeDefinition.js';
import { shiftTimezone } from '../lib/shiftZone.js';
import { coveringManagerIds, teamScope } from '../lib/delegations.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import {
  approveRequest,
  IllegalStateError,
} from '../lib/timeOffRequests.js';
import { recordTimeEvent } from '../lib/audit.js';
import { accrueSickLeaveForEntry } from '../lib/timeOffAccrual.js';
import { accruePolicyLeaveForEntry } from '../lib/timeOffPolicy.js';
import { notifyAssociate } from '../lib/notify.js';
import { runWithConcurrency } from '../lib/concurrency.js';
import { emitWebhookEvent } from '../lib/webhookDispatch.js';
import { emit as emitWorkflow } from '../lib/workflow.js';

/**
 * Phase 79 — Manager-scoped routes.
 *
 * These endpoints require `view:my-team` (read) or one of the
 * team-scoped manage capabilities (`manage:team-time`,
 * `manage:team-time-off`). On every action we *also* verify the target
 * entity belongs to one of the calling user's direct reports — capability
 * alone is not enough; managers must only act on their own team.
 *
 * "Direct report" = Associate.managerId == req.user.associateId. A
 * future iteration could walk the full chain (skip-level approvals)
 * but the v1 contract is one level only.
 */

export const teamRouter = Router();

const VIEW = requireCapability('view:my-team');
const APPROVE_TIME = requireCapability('manage:team-time');
const APPROVE_PTO = requireCapability('manage:team-time-off');

async function requireTeamAssociate(
  user: { id: string; associateId: string | null | undefined },
  associateId: string,
): Promise<void> {
  const managerIds = await coveringManagerIds(user);
  if (managerIds.length === 0) {
    throw new HttpError(
      403,
      'no_associate_link',
      'Your account is not linked to an associate record.',
    );
  }
  const target = await prisma.associate.findFirst({
    where: { id: associateId, managerId: { in: managerIds }, deletedAt: null },
    select: { id: true },
  });
  if (!target) {
    throw new HttpError(
      403,
      'not_your_report',
      'That associate is not on your team.',
    );
  }
}

// A manager's own reports, plus the reports of anyone currently delegating
// their inbox to this user (lib/delegations).
const managerScope = teamScope;

// ----- Direct reports list -------------------------------------------------

teamRouter.get('/reports', VIEW, async (req: Request, res: Response) => {
  const user = req.user!;
  const reports = await prisma.associate.findMany({
    take: 1000,
    // Employed reports only, like the dashboard and home — a separated
    // report no longer belongs on the manager's list.
    where: { AND: [await managerScope(user), EMPLOYED_WHERE] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      employmentType: true,
      department: { select: { name: true } },
      jobProfile: { select: { title: true } },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  // The 1:1 rhythm per report: the last one held and the next on the
  // calendar — "Next Tue · last 12d ago" without opening Performance.
  const ids = reports.map((r) => r.id);
  const [lastHeld, upcoming] = ids.length
    ? await Promise.all([
        prisma.oneOnOne.groupBy({
          by: ['associateId'],
          where: { associateId: { in: ids }, status: 'COMPLETED' },
          _max: { completedAt: true },
        }),
        prisma.oneOnOne.findMany({
          where: { associateId: { in: ids }, status: 'SCHEDULED', scheduledFor: { gte: new Date(Date.now() - 86_400_000) } },
          orderBy: { scheduledFor: 'asc' },
          select: { id: true, associateId: true, scheduledFor: true, cadence: true },
        }),
      ])
    : [[], []];
  const lastBy = new Map(lastHeld.map((g) => [g.associateId, g._max.completedAt]));
  const nextBy = new Map<string, (typeof upcoming)[number]>();
  for (const m of upcoming) if (!nextBy.has(m.associateId)) nextBy.set(m.associateId, m);
  res.json({
    reports: reports.map((r) => {
      const next = nextBy.get(r.id);
      return {
        id: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        phone: r.phone,
        employmentType: r.employmentType,
        departmentName: r.department?.name ?? null,
        jobTitle: r.jobProfile?.title ?? null,
        lastOneOnOneAt: lastBy.get(r.id)?.toISOString() ?? null,
        nextOneOnOne: next ? { id: next.id, scheduledFor: next.scheduledFor.toISOString(), cadence: next.cadence } : null,
      };
    }),
  });
});

/**
 * POST /team/reports/:associateId/one-on-ones — a manager books a 1:1 with
 * their own report (a repeating one with a cadence). Team-scoped: the
 * Performance desk's 1:1 routes are HR's; this one is the manager's.
 */
const TeamOneOnOneSchema = z.object({
  scheduledFor: z.string().datetime(),
  cadence: z.enum(['WEEKLY', 'BIWEEKLY']).nullable().optional(),
  agenda: z.string().max(4000).nullable().optional(),
});
teamRouter.post('/reports/:associateId/one-on-ones', VIEW, async (req: Request, res: Response) => {
  const user = req.user!;
  const associateId = z.string().uuid().parse(req.params.associateId);
  await requireTeamAssociate(user, associateId);
  const input = TeamOneOnOneSchema.parse(req.body ?? {});
  const id = randomUUID();
  const created = await prisma.oneOnOne.create({
    data: {
      id,
      associateId,
      managerUserId: user.id,
      scheduledFor: new Date(input.scheduledFor),
      agenda: input.agenda ?? null,
      cadence: input.cadence ?? null,
      seriesId: input.cadence ? id : null,
    },
    select: { id: true, scheduledFor: true },
  });
  res.status(201).json({ id: created.id, scheduledFor: created.scheduledFor.toISOString() });
});

// ----- Dashboard summary --------------------------------------------------

const EMPTY_DASHBOARD = {
  directReports: 0,
  pendingTimesheets: 0,
  pendingTimeOff: 0,
  pendingReimbursements: 0,
  atRiskGoals: 0,
  onboardingInProgress: 0,
};

teamRouter.get('/dashboard', VIEW, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.associateId) {
    res.json(EMPTY_DASHBOARD);
    return;
  }
  const reportIdsRows = await prisma.associate.findMany({
    take: 1000,
    // Brief 1A-2: separated and deactivated people are not reports.
    where: { AND: [await managerScope(user), EMPLOYED_WHERE] },
    select: { id: true },
  });
  const reportIds = reportIdsRows.map((r) => r.id);
  if (reportIds.length === 0) {
    res.json(EMPTY_DASHBOARD);
    return;
  }
  const [
    pendingTimesheets,
    pendingTimeOff,
    pendingReimbursements,
    atRiskGoals,
    onboardingInProgress,
  ] = await Promise.all([
    prisma.timeEntry.count({
      where: { associateId: { in: reportIds }, status: 'COMPLETED' },
    }),
    prisma.timeOffRequest.count({
      where: { associateId: { in: reportIds }, status: 'PENDING' },
    }),
    prisma.reimbursement.count({
      where: { associateId: { in: reportIds }, status: 'SUBMITTED' },
    }),
    prisma.goal.count({
      where: {
        associateId: { in: reportIds },
        status: 'AT_RISK',
        deletedAt: null,
      },
    }),
    prisma.application.count({
      where: {
        associateId: { in: reportIds },
        status: { in: ['SUBMITTED', 'IN_REVIEW'] },
        deletedAt: null,
      },
    }),
  ]);
  res.json({
    directReports: reportIds.length,
    pendingTimesheets,
    pendingTimeOff,
    pendingReimbursements,
    atRiskGoals,
    onboardingInProgress,
  });
});

// ----- The Manager's home (HR pack 2026-10) --------------------------------
//
// One call for everything the home shows beyond the approval queues: what is
// due on the team (reviews, 1:1s, probation decisions, ramp checkpoints,
// documents and credentials expiring), today on the team (shifts, who is on
// the clock, who is out, birthdays and anniversaries), and the suggested
// actions those add up to. Direct-report scoped like every /team route.

const DAY = 86_400_000;

teamRouter.get('/home', VIEW, async (req: Request, res: Response) => {
  const user = req.user!;
  const now = new Date();
  const empty = {
    due: { reviews: [], oneOnOnes: [], probations: [], rampMilestones: [], documents: [], credentials: [], pips: [] },
    today: { shifts: [], onClock: [], out: [], celebrations: [] },
    suggestions: [],
  };
  if (!user.associateId) {
    res.json(empty);
    return;
  }
  const reports = await prisma.associate.findMany({
    take: 1000,
    where: { AND: [await managerScope(user), EMPLOYED_WHERE] },
    select: { id: true, firstName: true, lastName: true, dob: true, hireDate: true },
  });
  if (reports.length === 0) {
    res.json(empty);
    return;
  }
  const ids = reports.map((r) => r.id);
  const nameOf = new Map(reports.map((r) => [r.id, `${r.firstName} ${r.lastName}`.trim()]));
  const in30 = new Date(now.getTime() + 30 * DAY);
  const in14 = new Date(now.getTime() + 14 * DAY);
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + DAY);
  const todayKey = now.toISOString().slice(0, 10);

  const [lastReviews, oneOnOnes, probations, rampPlans, documents, credentials, pips, shifts, onClock, out] = await Promise.all([
    // The most recent review per report; a report without one in 12 months is due.
    prisma.performanceReview.findMany({ where: { associateId: { in: ids } }, orderBy: { periodEnd: 'desc' }, select: { associateId: true, periodEnd: true, status: true }, take: 2000 }),
    prisma.oneOnOne.findMany({ where: { associateId: { in: ids }, status: 'SCHEDULED', scheduledFor: { lt: in14 } }, orderBy: { scheduledFor: 'asc' }, select: { id: true, associateId: true, scheduledFor: true }, take: 50 }),
    prisma.probationPeriod.findMany({ where: { associateId: { in: ids }, status: { in: ['ACTIVE', 'EXTENDED'] }, endDate: { lt: in30 } }, orderBy: { endDate: 'asc' }, select: { id: true, associateId: true, endDate: true }, take: 50 }),
    prisma.rampPlan.findMany({
      where: { associateId: { in: ids }, archivedAt: null },
      select: { id: true, associateId: true, startDate: true, milestones: { where: { status: { in: ['PENDING', 'ON_TRACK'] } }, select: { id: true, title: true, dayCheckpoint: true, status: true } } },
      take: 200,
    }),
    prisma.documentRecord.findMany({ where: { associateId: { in: ids }, deletedAt: null, status: { in: ['UPLOADED', 'VERIFIED', 'EXPIRED'] }, expiresAt: { not: null, lt: in30 } }, select: { id: true, associateId: true, kind: true, expiresAt: true, status: true }, orderBy: { expiresAt: 'asc' }, take: 100 }),
    prisma.associateQualification.findMany({ where: { associateId: { in: ids }, deletedAt: null, expiresAt: { not: null, lt: in30 } }, select: { id: true, associateId: true, expiresAt: true, qualification: { select: { name: true } } }, orderBy: { expiresAt: 'asc' }, take: 100 }),
    prisma.pip.findMany({ where: { associateId: { in: ids }, status: 'ACTIVE', endDate: { lt: in14 } }, select: { id: true, associateId: true, endDate: true }, orderBy: { endDate: 'asc' }, take: 50 }),
    prisma.shift.findMany({ where: { assignedAssociateId: { in: ids }, status: { in: ['ASSIGNED', 'COMPLETED'] }, startsAt: { gte: dayStart, lt: dayEnd } }, select: { id: true, assignedAssociateId: true, startsAt: true, endsAt: true, position: true, location: true, locationRel: { select: { timezone: true } } }, orderBy: { startsAt: 'asc' }, take: 200 }),
    prisma.timeEntry.findMany({ where: { associateId: { in: ids }, status: 'ACTIVE' }, select: { associateId: true, clockInAt: true }, take: 200 }),
    prisma.timeOffRequest.findMany({ where: { associateId: { in: ids }, status: 'APPROVED', startDate: { lte: now }, endDate: { gte: dayStart } }, select: { associateId: true, category: true, endDate: true }, take: 200 }),
  ]);

  const latestReview = new Map<string, { periodEnd: Date; status: string }>();
  for (const r of lastReviews) if (!latestReview.has(r.associateId)) latestReview.set(r.associateId, r);
  const yearAgo = new Date(now.getTime() - 365 * DAY);
  const reviewsDue = reports
    .map((r) => {
      const last = latestReview.get(r.id);
      const since = last?.periodEnd ?? r.hireDate ?? null;
      if (!since || since.getTime() > yearAgo.getTime()) return null;
      return { associateId: r.id, associateName: nameOf.get(r.id)!, lastPeriodEnd: last?.periodEnd.toISOString().slice(0, 10) ?? null, overdueDays: Math.floor((now.getTime() - since.getTime() - 365 * DAY) / DAY) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.overdueDays - a.overdueDays);

  const rampDue = rampPlans.flatMap((p) =>
    p.milestones
      .map((m) => ({ id: m.id, planId: p.id, associateId: p.associateId, associateName: nameOf.get(p.associateId)!, title: m.title, dueOn: new Date(p.startDate.getTime() + m.dayCheckpoint * DAY).toISOString().slice(0, 10), status: m.status }))
      .filter((m) => m.dueOn <= in14.toISOString().slice(0, 10)),
  );

  const celebrations = reports
    .flatMap((r) => {
      const out: { associateId: string; associateName: string; kind: 'BIRTHDAY' | 'ANNIVERSARY'; years: number | null }[] = [];
      const md = (d: Date) => d.toISOString().slice(5, 10);
      if (r.dob && md(r.dob) === todayKey.slice(5)) out.push({ associateId: r.id, associateName: nameOf.get(r.id)!, kind: 'BIRTHDAY', years: null });
      if (r.hireDate && md(r.hireDate) === todayKey.slice(5) && r.hireDate.getUTCFullYear() < now.getUTCFullYear()) out.push({ associateId: r.id, associateName: nameOf.get(r.id)!, kind: 'ANNIVERSARY', years: now.getUTCFullYear() - r.hireDate.getUTCFullYear() });
      return out;
    });

  const suggestions: { key: string; text: string; link: string; count: number }[] = [];
  if (reviewsDue.length) suggestions.push({ key: 'reviews', text: `${reviewsDue.length} ${reviewsDue.length === 1 ? 'review is' : 'reviews are'} more than a year old — schedule them.`, link: '/performance', count: reviewsDue.length });
  if (probations.length) suggestions.push({ key: 'probations', text: `${probations.length} probation ${probations.length === 1 ? 'decision is' : 'decisions are'} due this month.`, link: '/probation', count: probations.length });
  if (pips.length) suggestions.push({ key: 'pips', text: `${pips.length} improvement ${pips.length === 1 ? 'plan ends' : 'plans end'} within two weeks — decide the outcome.`, link: '/performance?tab=pips', count: pips.length });
  if (documents.length + credentials.length) suggestions.push({ key: 'expiring', text: `${documents.length + credentials.length} ${documents.length + credentials.length === 1 ? 'document or credential expires' : 'documents and credentials expire'} within 30 days — remind the person.`, link: '/expirations', count: documents.length + credentials.length });
  if (oneOnOnes.length) suggestions.push({ key: 'one-on-ones', text: `${oneOnOnes.length} 1:1${oneOnOnes.length === 1 ? '' : 's'} scheduled in the next two weeks.`, link: '/performance?tab=one-on-ones', count: oneOnOnes.length });
  if (rampDue.length) suggestions.push({ key: 'ramp', text: `${rampDue.length} ramp ${rampDue.length === 1 ? 'checkpoint is' : 'checkpoints are'} due — check in with the new starter.`, link: '/ramp', count: rampDue.length });

  res.json({
    due: {
      reviews: reviewsDue,
      oneOnOnes: oneOnOnes.map((o) => ({ id: o.id, associateId: o.associateId, associateName: nameOf.get(o.associateId)!, scheduledFor: o.scheduledFor.toISOString() })),
      probations: probations.map((p) => ({ id: p.id, associateId: p.associateId, associateName: nameOf.get(p.associateId)!, endDate: p.endDate.toISOString().slice(0, 10) })),
      rampMilestones: rampDue,
      documents: documents.map((d) => ({ id: d.id, associateId: d.associateId, associateName: nameOf.get(d.associateId)!, kind: d.kind, expiresAt: d.expiresAt!.toISOString().slice(0, 10), expired: d.expiresAt!.getTime() < now.getTime() })),
      credentials: credentials.map((c) => ({ id: c.id, associateId: c.associateId, associateName: nameOf.get(c.associateId)!, name: c.qualification.name, expiresAt: c.expiresAt!.toISOString().slice(0, 10), expired: c.expiresAt!.getTime() < now.getTime() })),
      pips: pips.map((p) => ({ id: p.id, associateId: p.associateId, associateName: nameOf.get(p.associateId)!, endDate: p.endDate.toISOString().slice(0, 10) })),
    },
    today: {
      shifts: shifts.map((sh) => ({ id: sh.id, associateId: sh.assignedAssociateId!, associateName: nameOf.get(sh.assignedAssociateId!)!, startsAt: sh.startsAt.toISOString(), endsAt: sh.endsAt.toISOString(), position: sh.position, location: sh.location, timezone: shiftTimezone(sh.locationRel) })),
      onClock: onClock.map((e) => ({ associateId: e.associateId, associateName: nameOf.get(e.associateId)!, since: e.clockInAt.toISOString() })),
      out: out.map((o) => ({ associateId: o.associateId, associateName: nameOf.get(o.associateId)!, category: o.category, until: o.endDate.toISOString().slice(0, 10) })),
      celebrations,
    },
    suggestions,
  });
});

// ----- Unified inbox ------------------------------------------------------
//
// One endpoint that returns every pending manager action across four
// modules in a single sorted list. The previous flow forced managers to
// check at least five different tabs (Timesheets, Time off,
// Reimbursements, Performance, Org); now the "today" view is one query
// + one render, oldest item surfacing first so stale stuff doesn't get
// buried.

interface InboxItem {
  id: string;
  kind: 'TIMESHEET' | 'TIME_OFF' | 'REIMBURSEMENT' | 'GOAL_AT_RISK';
  associateId: string;
  associateName: string;
  summary: string;
  /** Path the UI should navigate to when the manager clicks "Open". */
  link: string;
  /** ISO timestamp of when the item first needed action — for sorting. */
  pendingSince: string;
  ageDays: number;
}

const PER_CATEGORY_CAP = 50;

teamRouter.get('/inbox', VIEW, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.associateId) {
    res.json({ items: [], categories: EMPTY_DASHBOARD });
    return;
  }
  const reportIdsRows = await prisma.associate.findMany({
    take: 1000,
    where: await managerScope(user),
    select: { id: true },
  });
  const reportIds = reportIdsRows.map((r) => r.id);
  if (reportIds.length === 0) {
    res.json({ items: [], categories: EMPTY_DASHBOARD });
    return;
  }

  const [timesheets, timeOff, reimbursements, atRiskGoals] = await Promise.all(
    [
      prisma.timeEntry.findMany({
        where: { associateId: { in: reportIds }, status: 'COMPLETED' },
        orderBy: { clockOutAt: 'asc' },
        take: PER_CATEGORY_CAP,
        select: {
          id: true,
          associateId: true,
          clockInAt: true,
          clockOutAt: true,
          anomalies: true,
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.timeOffRequest.findMany({
        where: { associateId: { in: reportIds }, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: PER_CATEGORY_CAP,
        select: {
          id: true,
          associateId: true,
          category: true,
          startDate: true,
          endDate: true,
          createdAt: true,
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.reimbursement.findMany({
        where: { associateId: { in: reportIds }, status: 'SUBMITTED' },
        orderBy: { submittedAt: 'asc' },
        take: PER_CATEGORY_CAP,
        select: {
          id: true,
          associateId: true,
          title: true,
          totalAmount: true,
          currency: true,
          submittedAt: true,
          createdAt: true,
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.goal.findMany({
        where: {
          associateId: { in: reportIds },
          status: 'AT_RISK',
          deletedAt: null,
        },
        orderBy: { updatedAt: 'asc' },
        take: PER_CATEGORY_CAP,
        select: {
          id: true,
          associateId: true,
          title: true,
          periodEnd: true,
          updatedAt: true,
          progressPct: true,
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
    ],
  );

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const items: InboxItem[] = [];

  for (const t of timesheets) {
    const pending = t.clockOutAt ?? t.clockInAt;
    const anomalyTags = Array.isArray(t.anomalies)
      ? (t.anomalies as string[])
      : [];
    const anomalyNote = anomalyTags.length
      ? ` · flagged: ${anomalyTags.join(', ').toLowerCase()}`
      : '';
    items.push({
      id: t.id,
      kind: 'TIMESHEET',
      associateId: t.associateId,
      associateName: `${t.associate.firstName} ${t.associate.lastName}`,
      summary: `Shift on ${t.clockInAt.toISOString().slice(0, 10)}${anomalyNote}`,
      link: '/team?tab=timesheets',
      pendingSince: pending.toISOString(),
      ageDays: Math.floor((now - pending.getTime()) / dayMs),
    });
  }
  for (const r of timeOff) {
    items.push({
      id: r.id,
      kind: 'TIME_OFF',
      associateId: r.associateId,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`,
      summary: `${r.category} ${r.startDate.toISOString().slice(0, 10)} → ${r.endDate.toISOString().slice(0, 10)}`,
      link: '/team?tab=timeoff',
      pendingSince: r.createdAt.toISOString(),
      ageDays: Math.floor((now - r.createdAt.getTime()) / dayMs),
    });
  }
  for (const r of reimbursements) {
    const since = r.submittedAt ?? r.createdAt;
    items.push({
      id: r.id,
      kind: 'REIMBURSEMENT',
      associateId: r.associateId,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`,
      summary: `${r.title} · ${r.currency} ${r.totalAmount.toString()}`,
      link: `/reimbursements?id=${r.id}`,
      pendingSince: since.toISOString(),
      ageDays: Math.floor((now - since.getTime()) / dayMs),
    });
  }
  for (const g of atRiskGoals) {
    // Company and team goals belong to no one person; the team inbox lists people's.
    if (!g.associate || !g.associateId) continue;
    items.push({
      id: g.id,
      kind: 'GOAL_AT_RISK',
      associateId: g.associateId,
      associateName: `${g.associate.firstName} ${g.associate.lastName}`,
      summary: `${g.title} (${g.progressPct}% · due ${g.periodEnd.toISOString().slice(0, 10)})`,
      link: `/performance?goalId=${g.id}`,
      pendingSince: g.updatedAt.toISOString(),
      ageDays: Math.floor((now - g.updatedAt.getTime()) / dayMs),
    });
  }

  // Oldest first so stale items can't hide under fresh noise.
  items.sort((a, b) => a.pendingSince.localeCompare(b.pendingSince));

  res.json({
    items,
    categories: {
      directReports: reportIds.length,
      pendingTimesheets: timesheets.length,
      pendingTimeOff: timeOff.length,
      pendingReimbursements: reimbursements.length,
      atRiskGoals: atRiskGoals.length,
      onboardingInProgress: 0, // surfaced in /dashboard, not the inbox itself
    },
  });
});

// ----- Timesheets (time entries) ------------------------------------------

teamRouter.get('/timesheets', VIEW, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.associateId) {
    res.json({ entries: [] });
    return;
  }
  const reportIds = await prisma.associate.findMany({
    take: 1000,
    where: await managerScope(user),
    select: { id: true },
  });
  const ids = reportIds.map((r) => r.id);
  const status =
    typeof req.query.status === 'string' ? req.query.status : 'COMPLETED';
  const validStatuses = ['ACTIVE', 'COMPLETED', 'APPROVED', 'REJECTED'];
  const where: Prisma.TimeEntryWhereInput = {
    associateId: { in: ids },
    ...(validStatuses.includes(status)
      ? { status: status as 'ACTIVE' | 'COMPLETED' | 'APPROVED' | 'REJECTED' }
      : {}),
  };
  const rows = await prisma.timeEntry.findMany({
    where,
    orderBy: { clockInAt: 'desc' },
    take: 200,
    include: {
      associate: { select: { firstName: true, lastName: true } },
      location: { select: { timezone: true } },
    },
  });
  const clientIds = Array.from(
    new Set(rows.map((r) => r.clientId).filter((id): id is string => !!id)),
  );
  const clientNameById = new Map<string, string>();
  if (clientIds.length > 0) {
    const cs = await prisma.client.findMany({
      take: 1000,
      where: { id: { in: clientIds } },
      select: { id: true, name: true },
    });
    for (const c of cs) clientNameById.set(c.id, c.name);
  }
  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      associateId: r.associateId,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`,
      clientId: r.clientId,
      clientName: r.clientId ? clientNameById.get(r.clientId) ?? null : null,
      clockInAt: r.clockInAt.toISOString(),
      clockOutAt: r.clockOutAt?.toISOString() ?? null,
      status: r.status,
      notes: r.notes,
      rejectionReason: r.rejectionReason,
      // Number, matching TimeEntrySchema.payRate and /time/admin/entries.
      // This route emitted a STRING for the same column, so any shared
      // formatter silently switched between arithmetic and lexicographic.
      payRate: r.payRate ? Number(r.payRate) : null,
      // The site's clock, as /time entries carry it (TimeEntrySchema.locationTimezone).
      locationTimezone: r.location?.timezone ?? null,
    })),
  });
});

teamRouter.post(
  '/timesheets/:id/approve',
  APPROVE_TIME,
  async (req: Request, res: Response) => {
    const user = req.user!;
    const id = req.params.id;
    const entry = await prisma.timeEntry.findUnique({ where: { id } });
    if (!entry) {
      throw new HttpError(404, 'time_entry_not_found', 'Time entry not found.');
    }
    await requireTeamAssociate(user, entry.associateId);
    if (entry.status === 'ACTIVE') {
      throw new HttpError(
        409,
        'still_active',
        'Cannot approve an entry that has not been clocked out.',
      );
    }
    if (entry.status === 'APPROVED') {
      res.json({ ok: true, idempotent: true });
      return;
    }
    const updated = await prisma.timeEntry.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedById: user.id,
        approvedAt: new Date(),
        rejectionReason: null,
      },
    });
    const accrual = await accrueSickLeaveForEntry(prisma, updated.id);
    void accruePolicyLeaveForEntry(prisma, updated.id).catch((err) => console.warn('[time-off] policy accrual failed:', err instanceof Error ? err.message : err));
    await recordTimeEvent({
      actorUserId: user.id,
      action: 'time.approved.by_manager',
      timeEntryId: updated.id,
      associateId: updated.associateId,
      clientId: updated.clientId,
      metadata: accrual.accrued
        ? { sickAccrualMinutes: accrual.earnedMinutes, state: accrual.state }
        : {},
      req,
    });
    void notifyAssociate(updated.associateId, {
      subject: 'Your timesheet was approved',
      body: `Your time entry for ${updated.clockInAt.toISOString().slice(0, 10)} was approved by your manager.`,
      category: 'team',
      // The entry on their timesheet — /me (their profile) shows no time.
      linkUrl: `/time-attendance?entry=${updated.id}`,
      emailFallback: true,
    });
    res.json({ ok: true });
  },
);

teamRouter.post(
  '/timesheets/:id/reject',
  APPROVE_TIME,
  async (req: Request, res: Response) => {
    const user = req.user!;
    const id = req.params.id;
    const entry = await prisma.timeEntry.findUnique({ where: { id } });
    if (!entry) {
      throw new HttpError(404, 'time_entry_not_found', 'Time entry not found.');
    }
    await requireTeamAssociate(user, entry.associateId);
    const reason = (req.body?.reason ?? '').toString().trim();
    if (!reason) {
      throw new HttpError(
        400,
        'reason_required',
        'A reason is required to reject a time entry.',
      );
    }
    if (entry.status === 'ACTIVE') {
      throw new HttpError(
        409,
        'still_active',
        'Cannot reject an entry that has not been clocked out.',
      );
    }
    await prisma.timeEntry.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectionReason: reason,
        approvedById: user.id,
        approvedAt: new Date(),
      },
    });
    await recordTimeEvent({
      actorUserId: user.id,
      action: 'time.rejected.by_manager',
      timeEntryId: id,
      associateId: entry.associateId,
      clientId: entry.clientId,
      metadata: { reason },
      req,
    });
    void notifyAssociate(entry.associateId, {
      subject: 'Your timesheet was rejected',
      body: `Your time entry for ${entry.clockInAt.toISOString().slice(0, 10)} was rejected. Reason: ${reason}`,
      category: 'team',
      linkUrl: `/time-attendance?entry=${entry.id}`,
      emailFallback: true,
    });
    res.json({ ok: true });
  },
);

// Bulk-approve timesheets — same rules as the single endpoint, one entry per
// loop so a stale/ineligible row is skipped (not fatal) and the rest succeed.
teamRouter.post(
  '/timesheets/bulk-approve',
  APPROVE_TIME,
  async (req: Request, res: Response) => {
    const user = req.user!;
    const ids = z.array(z.string().uuid()).min(1).max(200).parse(req.body?.ids);
    let approved = 0;
    const skipped: { id: string; reason: string }[] = [];
    // PERF: batch the entry load + the direct-report authorization set
    // up front (was ~6 serial queries per id); the per-id remainder runs
    // with bounded parallelism.
    const entries = await prisma.timeEntry.findMany({
      where: { id: { in: ids } },
    });
    const teamEntryById = new Map(entries.map((e) => [e.id, e]));
    const bulkReportSet = new Set(
      (
        await prisma.associate.findMany({
          where: {
            id: { in: [...new Set(entries.map((e) => e.associateId))] },
            ...(await managerScope(user)),
          },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    await runWithConcurrency(ids, 6, async (id) => {
      try {
        const entry = teamEntryById.get(id);
        if (!entry) {
          skipped.push({ id, reason: 'not_found' });
          return;
        }
        if (!bulkReportSet.has(entry.associateId)) {
          skipped.push({ id, reason: 'not_your_report' });
          return;
        }
        if (entry.status === 'ACTIVE') {
          skipped.push({ id, reason: 'still_active' });
          return;
        }
        if (entry.status === 'APPROVED') {
          skipped.push({ id, reason: 'already_approved' });
          return;
        }
        const updated = await prisma.timeEntry.update({
          where: { id },
          data: {
            status: 'APPROVED',
            approvedById: user.id,
            approvedAt: new Date(),
            rejectionReason: null,
          },
        });
        const accrual = await accrueSickLeaveForEntry(prisma, updated.id);
    void accruePolicyLeaveForEntry(prisma, updated.id).catch((err) => console.warn('[time-off] policy accrual failed:', err instanceof Error ? err.message : err));
        await recordTimeEvent({
          actorUserId: user.id,
          action: 'time.approved.by_manager',
          timeEntryId: updated.id,
          associateId: updated.associateId,
          clientId: updated.clientId,
          metadata: {
            bulk: true,
            ...(accrual.accrued
              ? { sickAccrualMinutes: accrual.earnedMinutes, state: accrual.state }
              : {}),
          },
          req,
        });
        void notifyAssociate(updated.associateId, {
          subject: 'Your timesheet was approved',
          body: `Your time entry for ${updated.clockInAt.toISOString().slice(0, 10)} was approved by your manager.`,
          category: 'team',
          linkUrl: `/time-attendance?entry=${updated.id}`,
          emailFallback: true,
        });
        approved++;
      } catch (err) {
        skipped.push({ id, reason: err instanceof HttpError ? err.code : 'error' });
      }
    });
    res.json({ approved, skipped });
  },
);

// ----- Time off ------------------------------------------------------------

teamRouter.get('/timeoff', VIEW, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.associateId) {
    res.json({ requests: [] });
    return;
  }
  const reportIds = await prisma.associate.findMany({
    take: 1000,
    where: await managerScope(user),
    select: { id: true },
  });
  const ids = reportIds.map((r) => r.id);
  const status =
    typeof req.query.status === 'string' ? req.query.status : 'PENDING';
  const valid = ['PENDING', 'APPROVED', 'DENIED', 'CANCELLED'] as const;
  const where: Prisma.TimeOffRequestWhereInput = {
    associateId: { in: ids },
    ...(valid.includes(status as (typeof valid)[number])
      ? { status: status as (typeof valid)[number] }
      : {}),
  };
  const rows = await prisma.timeOffRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      associate: { select: { firstName: true, lastName: true } },
      reviewer: { select: { email: true } },
    },
  });
  res.json({
    requests: rows.map((r) => ({
      id: r.id,
      associateId: r.associateId,
      associateName: r.associate
        ? `${r.associate.firstName} ${r.associate.lastName}`
        : null,
      category: r.category,
      startDate: r.startDate.toISOString().slice(0, 10),
      endDate: r.endDate.toISOString().slice(0, 10),
      requestedMinutes: r.requestedMinutes,
      reason: r.reason,
      status: r.status,
      reviewerEmail: r.reviewer?.email ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

teamRouter.post(
  '/timeoff/:id/approve',
  APPROVE_PTO,
  async (req: Request, res: Response) => {
    const user = req.user!;
    const id = req.params.id;
    const reqRow = await prisma.timeOffRequest.findUnique({ where: { id } });
    if (!reqRow) {
      throw new HttpError(404, 'not_found', 'Request not found.');
    }
    await requireTeamAssociate(user, reqRow.associateId);
    try {
      await approveRequest(prisma, id, user.id, req.body?.note ?? null);
    } catch (err) {
      if (err instanceof IllegalStateError) {
        throw new HttpError(409, 'illegal_state', err.message);
      }
      throw err;
    }
    const note = (req.body?.note ?? '').toString().trim();
    void notifyAssociate(reqRow.associateId, {
      subject: 'Your time off was approved',
      body:
        `Your ${reqRow.category} request (${reqRow.startDate.toISOString().slice(0, 10)} → ` +
        `${reqRow.endDate.toISOString().slice(0, 10)}) was approved.` +
        (note ? ` Note: ${note}` : ''),
      category: 'team',
      linkUrl: '/time-off',
      emailFallback: true,
    });
    res.json({ ok: true });
  },
);

// Bulk-approve time-off — per-request approveRequest, skipping ineligible
// ones (not a direct report, already decided) so the batch succeeds-partial.
teamRouter.post(
  '/timeoff/bulk-approve',
  APPROVE_PTO,
  async (req: Request, res: Response) => {
    const user = req.user!;
    const ids = z.array(z.string().uuid()).min(1).max(200).parse(req.body?.ids);
    let approved = 0;
    const skipped: { id: string; reason: string }[] = [];
    // PERF: batch the request load + authorization set up front; only
    // approveRequest's balance CAS stays per-id (bounded-parallel).
    const reqRows = await prisma.timeOffRequest.findMany({
      where: { id: { in: ids } },
    });
    const ptoById = new Map(reqRows.map((r) => [r.id, r]));
    const ptoReportSet = new Set(
      (
        await prisma.associate.findMany({
          where: {
            id: { in: [...new Set(reqRows.map((r) => r.associateId))] },
            ...(await managerScope(user)),
          },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    await runWithConcurrency(ids, 6, async (id) => {
      try {
        const reqRow = ptoById.get(id);
        if (!reqRow) {
          skipped.push({ id, reason: 'not_found' });
          return;
        }
        if (!ptoReportSet.has(reqRow.associateId)) {
          skipped.push({ id, reason: 'not_your_report' });
          return;
        }
        await approveRequest(prisma, id, user.id, null);
        void notifyAssociate(reqRow.associateId, {
          subject: 'Your time off was approved',
          body:
            `Your ${reqRow.category} request (${reqRow.startDate.toISOString().slice(0, 10)} → ` +
            `${reqRow.endDate.toISOString().slice(0, 10)}) was approved.`,
          category: 'team',
          linkUrl: '/time-off',
          emailFallback: true,
        });
        approved++;
      } catch (err) {
        if (err instanceof IllegalStateError) {
          skipped.push({ id, reason: 'illegal_state' });
          return;
        }
        skipped.push({ id, reason: err instanceof HttpError ? err.code : 'error' });
      }
    });
    res.json({ approved, skipped });
  },
);

teamRouter.post(
  '/timeoff/:id/deny',
  APPROVE_PTO,
  async (req: Request, res: Response) => {
    const user = req.user!;
    const id = req.params.id;
    const reqRow = await prisma.timeOffRequest.findUnique({ where: { id } });
    if (!reqRow) {
      throw new HttpError(404, 'not_found', 'Request not found.');
    }
    await requireTeamAssociate(user, reqRow.associateId);
    const note = (req.body?.note ?? '').toString().trim();
    if (!note) {
      throw new HttpError(
        400,
        'note_required',
        'A note is required to deny a time-off request.',
      );
    }
    if (reqRow.status !== 'PENDING') {
      throw new HttpError(
        409,
        'illegal_state',
        `Cannot deny a ${reqRow.status} request`,
      );
    }
    await prisma.timeOffRequest.update({
      where: { id },
      data: {
        status: 'DENIED',
        reviewerUserId: user.id,
        reviewerNote: note,
        decidedAt: new Date(),
      },
    });
    void emitWorkflow({
      trigger: 'TIME_OFF_DENIED',
      entityType: 'TimeOffRequest',
      entityId: id,
      context: { associateId: reqRow.associateId, request: { id, category: reqRow.category }, reviewerUserId: user.id },
    }).catch((err) => console.warn('[team] workflow emit failed:', err));
    void emitWebhookEvent('time_off.denied', {
      requestId: id,
      associateId: reqRow.associateId,
      category: reqRow.category,
      startDate: reqRow.startDate.toISOString().slice(0, 10),
      endDate: reqRow.endDate.toISOString().slice(0, 10),
    });
    void notifyAssociate(reqRow.associateId, {
      subject: 'Your time off was denied',
      body:
        `Your ${reqRow.category} request (${reqRow.startDate.toISOString().slice(0, 10)} → ` +
        `${reqRow.endDate.toISOString().slice(0, 10)}) was denied. Reason: ${note}`,
      category: 'team',
      linkUrl: '/time-off',
      emailFallback: true,
    });
    res.json({ ok: true });
  },
);
