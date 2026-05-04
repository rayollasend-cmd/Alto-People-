import { Router } from 'express';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
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

teamRouter.get('/dashboard', VIEW, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.associateId) {
    res.json({
      directReports: 0,
      pendingTimesheets: 0,
      pendingTimeOff: 0,
      onboardingInProgress: 0,
    });
    return;
  }
  const reportIdsRows = await prisma.associate.findMany({
    take: 1000,
    where: managerScope(user),
    select: { id: true },
  });
  const reportIds = reportIdsRows.map((r) => r.id);
  if (reportIds.length === 0) {
    res.json({
      directReports: 0,
      pendingTimesheets: 0,
      pendingTimeOff: 0,
      onboardingInProgress: 0,
    });
    return;
  }
  const [pendingTimesheets, pendingTimeOff, onboardingInProgress] =
    await Promise.all([
      prisma.timeEntry.count({
        where: { associateId: { in: reportIds }, status: 'COMPLETED' },
      }),
      prisma.timeOffRequest.count({
        where: { associateId: { in: reportIds }, status: 'PENDING' },
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
    onboardingInProgress,
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
