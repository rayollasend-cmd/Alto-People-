import { Router } from 'express';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import {
  approveRequest,
  IllegalStateError,
} from '../lib/timeOffRequests.js';
import { recordTimeEvent } from '../lib/audit.js';
import { accrueSickLeaveForEntry } from '../lib/timeOffAccrual.js';

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

async function requireDirectReportAssociate(
  managerAssociateId: string | null | undefined,
  associateId: string,
): Promise<void> {
  if (!managerAssociateId) {
    throw new HttpError(
      403,
      'no_associate_link',
      'Your account is not linked to an associate record.',
    );
  }
  const target = await prisma.associate.findFirst({
    where: { id: associateId, managerId: managerAssociateId, deletedAt: null },
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

function managerScope(user: { associateId: string | null | undefined }) {
  return { managerId: user.associateId ?? '__none__', deletedAt: null };
}

// ----- Direct reports list -------------------------------------------------

teamRouter.get('/reports', VIEW, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.associateId) {
    res.json({ reports: [] });
    return;
  }
  const reports = await prisma.associate.findMany({
    take: 1000,
    where: managerScope(user),
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
  res.json({
    reports: reports.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      employmentType: r.employmentType,
      departmentName: r.department?.name ?? null,
      jobTitle: r.jobProfile?.title ?? null,
    })),
  });
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
    where: managerScope(user),
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
    where: managerScope(user),
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
    where: managerScope(user),
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
      payRate: r.payRate?.toString() ?? null,
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
    await requireDirectReportAssociate(user.associateId, entry.associateId);
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
    await requireDirectReportAssociate(user.associateId, entry.associateId);
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
    for (const id of ids) {
      try {
        const entry = await prisma.timeEntry.findUnique({ where: { id } });
        if (!entry) {
          skipped.push({ id, reason: 'not_found' });
          continue;
        }
        await requireDirectReportAssociate(user.associateId, entry.associateId);
        if (entry.status === 'ACTIVE') {
          skipped.push({ id, reason: 'still_active' });
          continue;
        }
        if (entry.status === 'APPROVED') {
          skipped.push({ id, reason: 'already_approved' });
          continue;
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
        approved++;
      } catch (err) {
        skipped.push({ id, reason: err instanceof HttpError ? err.code : 'error' });
      }
    }
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
    where: managerScope(user),
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
    await requireDirectReportAssociate(user.associateId, reqRow.associateId);
    try {
      await approveRequest(prisma, id, user.id, req.body?.note ?? null);
    } catch (err) {
      if (err instanceof IllegalStateError) {
        throw new HttpError(409, 'illegal_state', err.message);
      }
      throw err;
    }
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
    for (const id of ids) {
      try {
        const reqRow = await prisma.timeOffRequest.findUnique({ where: { id } });
        if (!reqRow) {
          skipped.push({ id, reason: 'not_found' });
          continue;
        }
        await requireDirectReportAssociate(user.associateId, reqRow.associateId);
        await approveRequest(prisma, id, user.id, null);
        approved++;
      } catch (err) {
        if (err instanceof IllegalStateError) {
          skipped.push({ id, reason: 'illegal_state' });
          continue;
        }
        skipped.push({ id, reason: err instanceof HttpError ? err.code : 'error' });
      }
    }
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
    await requireDirectReportAssociate(user.associateId, reqRow.associateId);
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
    res.json({ ok: true });
  },
);
