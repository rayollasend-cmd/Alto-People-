import { Router } from 'express';
import {
  TimeOffAdminListQuerySchema,
  TimeOffEntitlementListResponseSchema,
  TimeOffEntitlementUpsertInputSchema,
  TimeOffMyBalanceResponseSchema,
  TimeOffRequestCreateInputSchema,
  TimeOffRequestDecisionInputSchema,
  TimeOffRequestDenyInputSchema,
  TimeOffRequestListResponseSchema,
  TimeOffRequestResponseSchema,
  type TimeOffBalance,
  type TimeOffEntitlement as TimeOffEntitlementDTO,
  type TimeOffLedgerEntry,
  type TimeOffRequest as TimeOffRequestDTO,
} from '@alto-people/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { notifyAllAdmins, notifyManager } from '../lib/notify.js';
import { timeOffRequestTemplate } from '../lib/emailTemplates.js';
import { env } from '../config/env.js';
import {
  approveRequest,
  formatDateUTC,
  hoursToMinutes,
  IllegalStateError,
  InsufficientBalanceError,
  parseDateUTC,
} from '../lib/timeOffRequests.js';
import { ensureEntitlementApplied } from '../lib/timeOffEntitlement.js';

export const timeOffRouter = Router();

const MANAGE = requireCapability('manage:time');

type RawRequest = Prisma.TimeOffRequestGetPayload<{
  include: {
    associate: { select: { firstName: true; lastName: true } };
    reviewer: { select: { email: true } };
  };
}>;

function toRequestDTO(row: RawRequest): TimeOffRequestDTO {
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: row.associate
      ? `${row.associate.firstName} ${row.associate.lastName}`
      : null,
    category: row.category,
    startDate: formatDateUTC(row.startDate),
    endDate: formatDateUTC(row.endDate),
    requestedMinutes: row.requestedMinutes,
    reason: row.reason,
    status: row.status,
    reviewerUserId: row.reviewerUserId,
    reviewerEmail: row.reviewer?.email ?? null,
    reviewerNote: row.reviewerNote,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const REQUEST_INCLUDE = {
  associate: { select: { firstName: true, lastName: true, managerId: true } },
  reviewer: { select: { email: true } },
} as const;

/**
 * Phase 26 — read endpoint for an associate's accrued time-off balances
 * (today: SICK only, plus any USE/ADJUSTMENT lines once Phase 30 ships).
 * Scoped to req.user.associateId; HR-side queries land under /admin/*.
 */
timeOffRouter.get('/me/balance', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates have time-off balances');
    }

    // Phase 43 — fire annual lump-sum grants if the entitlement clock
    // has rolled over since the last read. Idempotent.
    const entitlements = await prisma.timeOffEntitlement.findMany({
      where: { associateId: user.associateId },
      select: { category: true },
    });
    if (entitlements.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const e of entitlements) {
          await ensureEntitlementApplied(tx, user.associateId!, e.category);
        }
      }, { timeout: 30_000 });
    }

    const [balances, ledger] = await Promise.all([
      prisma.timeOffBalance.findMany({
        where: { associateId: user.associateId },
        orderBy: { category: 'asc' },
      }),
      prisma.timeOffLedgerEntry.findMany({
        where: { associateId: user.associateId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const payload = TimeOffMyBalanceResponseSchema.parse({
      balances: balances.map<TimeOffBalance>((b) => ({
        category: b.category,
        balanceMinutes: b.balanceMinutes,
      })),
      recentLedger: ledger.map<TimeOffLedgerEntry>((l) => ({
        id: l.id,
        category: l.category,
        reason: l.reason,
        deltaMinutes: l.deltaMinutes,
        sourceTimeEntryId: l.sourceTimeEntryId,
        notes: l.notes,
        createdAt: l.createdAt.toISOString(),
      })),
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * Phase 30 — associate-facing request submission. Anyone with an
 * associate profile can submit; the approval gate is the balance check
 * inside `approveRequest`, so HR can decide whether to approve or deny.
 */
timeOffRouter.post('/me/requests', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can submit time-off requests');
    }

    const parsed = TimeOffRequestCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;
    const startDate = parseDateUTC(input.startDate);
    const endDate = parseDateUTC(input.endDate);
    const requestedMinutes = hoursToMinutes(input.hours);

    const created = await prisma.timeOffRequest.create({
      data: {
        associateId: user.associateId,
        category: input.category,
        startDate,
        endDate,
        requestedMinutes,
        reason: input.reason ?? null,
        status: 'PENDING',
      },
      include: REQUEST_INCLUDE,
    });

    // Manager-first routing: time-off is the manager's call. If the associate
    // has a direct manager assigned, only the manager is notified — admins
    // already have the request visible in the HR queue and don't need a ping
    // for every request. If there's no manager, fall through to all admins
    // so the request doesn't sit unowned. (Avoids the manager getting
    // duplicate notifications when their role also matches admin fan-out.)
    const who = `${created.associate.firstName} ${created.associate.lastName}`;
    const range =
      formatDateUTC(startDate) === formatDateUTC(endDate)
        ? formatDateUTC(startDate)
        : `${formatDateUTC(startDate)} → ${formatDateUTC(endDate)}`;
    const tpl = timeOffRequestTemplate({
      associateName: who,
      category: input.category,
      hours: input.hours,
      dateRange: range,
      reason: input.reason ?? null,
      submittedAt: new Date(created.createdAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      timeOffUrl: `${env.APP_BASE_URL}/admin/time-off`,
    });
    const opts = {
      subject: tpl.subject,
      body: tpl.text,
      html: tpl.html,
      category: 'time-off',
    };
    if (created.associate.managerId) {
      void notifyManager(user.associateId, opts);
    } else {
      void notifyAllAdmins({ ...opts, excludeUserId: user.id });
    }

    res.status(201).json(
      TimeOffRequestResponseSchema.parse({ request: toRequestDTO(created) })
    );
  } catch (err) {
    next(err);
  }
});

timeOffRouter.get('/me/requests', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates have time-off requests');
    }
    const rows = await prisma.timeOffRequest.findMany({
      where: { associateId: user.associateId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: REQUEST_INCLUDE,
    });
    res.json(
      TimeOffRequestListResponseSchema.parse({
        requests: rows.map(toRequestDTO),
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Associate withdraws a still-pending request. Once HR has approved or
 * denied, the request is locked and this returns 409.
 */
timeOffRouter.post('/me/requests/:id/cancel', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can cancel requests');
    }
    const id = req.params.id;
    const row = await prisma.timeOffRequest.findUnique({
      where: { id },
      include: REQUEST_INCLUDE,
    });
    // 404 (not 403) for cross-associate access — same existence-oracle
    // discipline as performance reviews.
    if (!row || row.associateId !== user.associateId) {
      throw new HttpError(404, 'not_found', 'Request not found');
    }
    if (row.status !== 'PENDING') {
      throw new HttpError(409, 'illegal_state', `Cannot cancel a ${row.status} request`);
    }
    const updated = await prisma.timeOffRequest.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
      include: REQUEST_INCLUDE,
    });
    res.json(
      TimeOffRequestResponseSchema.parse({ request: toRequestDTO(updated) })
    );
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- HR / Admin side ----------------------------- */

timeOffRouter.get('/admin/requests', MANAGE, async (req, res, next) => {
  try {
    const queryParsed = TimeOffAdminListQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      throw new HttpError(400, 'invalid_query', 'Invalid query', queryParsed.error.flatten());
    }
    const query = queryParsed.data;
    const rows = await prisma.timeOffRequest.findMany({
      where: query.status ? { status: query.status } : undefined,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
      include: REQUEST_INCLUDE,
    });
    res.json(
      TimeOffRequestListResponseSchema.parse({
        requests: rows.map(toRequestDTO),
      })
    );
  } catch (err) {
    next(err);
  }
});

timeOffRouter.post('/admin/requests/:id/approve', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const id = req.params.id;
    const parsed = TimeOffRequestDecisionInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;

    try {
      await approveRequest(prisma, id, user.id, input.note ?? null);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        throw new HttpError(409, 'insufficient_balance', err.message, {
          currentMinutes: err.currentMinutes,
          requestedMinutes: err.requestedMinutes,
        });
      }
      if (err instanceof IllegalStateError) {
        // "not found" / "already approved" → 409. The lookup inside
        // approveRequest handles both cases; we don't need to distinguish
        // them at the API surface.
        throw new HttpError(409, 'illegal_state', err.message);
      }
      throw err;
    }

    const updated = await prisma.timeOffRequest.findUnique({
      where: { id },
      include: REQUEST_INCLUDE,
    });
    if (!updated) throw new HttpError(404, 'not_found', 'Request not found after approve');
    res.json(
      TimeOffRequestResponseSchema.parse({ request: toRequestDTO(updated) })
    );
  } catch (err) {
    next(err);
  }
});

timeOffRouter.post('/admin/requests/:id/deny', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const id = req.params.id;
    const parsed = TimeOffRequestDenyInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;
    const row = await prisma.timeOffRequest.findUnique({ where: { id } });
    if (!row) throw new HttpError(404, 'not_found', 'Request not found');
    if (row.status !== 'PENDING') {
      throw new HttpError(409, 'illegal_state', `Cannot deny a ${row.status} request`);
    }
    const updated = await prisma.timeOffRequest.update({
      where: { id },
      data: {
        status: 'DENIED',
        reviewerUserId: user.id,
        reviewerNote: input.note,
        decidedAt: new Date(),
      },
      include: REQUEST_INCLUDE,
    });
    res.json(
      TimeOffRequestResponseSchema.parse({ request: toRequestDTO(updated) })
    );
  } catch (err) {
    next(err);
  }
});

/* ----------- Phase 43 — entitlements (annual lump-sum config) ----------- */

timeOffRouter.get('/admin/entitlements', MANAGE, async (req, res, next) => {
  try {
    const associateIdFilter =
      typeof req.query.associateId === 'string' ? req.query.associateId : undefined;
    const rows = await prisma.timeOffEntitlement.findMany({
      where: associateIdFilter ? { associateId: associateIdFilter } : undefined,
      orderBy: [{ associateId: 'asc' }, { category: 'asc' }],
      include: {
        associate: { select: { firstName: true, lastName: true } },
      },
    });
    const entitlements: TimeOffEntitlementDTO[] = rows.map((r) => ({
      id: r.id,
      associateId: r.associateId,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`,
      category: r.category,
      annualMinutes: r.annualMinutes,
      carryoverMaxMinutes: r.carryoverMaxMinutes,
      policyAnchorMonth: r.policyAnchorDate.getUTCMonth() + 1,
      policyAnchorDay: r.policyAnchorDate.getUTCDate(),
      lastGrantedAt: r.lastGrantedAt ? r.lastGrantedAt.toISOString() : null,
    }));
    res.json(
      TimeOffEntitlementListResponseSchema.parse({ entitlements })
    );
  } catch (err) {
    next(err);
  }
});

timeOffRouter.put('/admin/entitlements', MANAGE, async (req, res, next) => {
  try {
    const parsed = TimeOffEntitlementUpsertInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;
    const associate = await prisma.associate.findUnique({
      where: { id: input.associateId },
      select: { id: true },
    });
    if (!associate) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found');
    }
    const anchor = new Date(
      Date.UTC(2000, input.policyAnchorMonth - 1, input.policyAnchorDay)
    );
    const upserted = await prisma.timeOffEntitlement.upsert({
      where: {
        associateId_category: {
          associateId: input.associateId,
          category: input.category,
        },
      },
      create: {
        associateId: input.associateId,
        category: input.category,
        annualMinutes: input.annualMinutes,
        carryoverMaxMinutes: input.carryoverMaxMinutes,
        policyAnchorDate: anchor,
      },
      update: {
        annualMinutes: input.annualMinutes,
        carryoverMaxMinutes: input.carryoverMaxMinutes,
        policyAnchorDate: anchor,
      },
      include: { associate: { select: { firstName: true, lastName: true } } },
    });
    const dto: TimeOffEntitlementDTO = {
      id: upserted.id,
      associateId: upserted.associateId,
      associateName: `${upserted.associate.firstName} ${upserted.associate.lastName}`,
      category: upserted.category,
      annualMinutes: upserted.annualMinutes,
      carryoverMaxMinutes: upserted.carryoverMaxMinutes,
      policyAnchorMonth: upserted.policyAnchorDate.getUTCMonth() + 1,
      policyAnchorDay: upserted.policyAnchorDate.getUTCDate(),
      lastGrantedAt: upserted.lastGrantedAt
        ? upserted.lastGrantedAt.toISOString()
        : null,
    };
    res.json(dto);
  } catch (err) {
    next(err);
  }
});
