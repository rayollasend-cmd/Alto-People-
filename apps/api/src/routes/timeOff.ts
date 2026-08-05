import { Router } from 'express';
import { z } from 'zod';
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
import { idempotent } from '../middleware/idempotency.js';
import { requireCapability } from '../middleware/auth.js';
import { notifyAllAdmins, notifyAssociate, notifyManager } from '../lib/notify.js';
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
import { scopeTimeOffRequests } from '../lib/scope.js';
import { emitWebhookEvent } from '../lib/webhookDispatch.js';

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
      take: 500,
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
        take: 500,
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
timeOffRouter.post('/me/requests', idempotent, async (req, res, next) => {
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

    // Outbound webhooks — ids + dates only, no reason text (free-form
    // prose from the associate stays out of third-party payloads).
    void emitWebhookEvent('time_off.requested', {
      requestId: created.id,
      associateId: created.associateId,
      category: created.category,
      startDate: input.startDate,
      endDate: input.endDate,
      requestedMinutes,
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
    // The site's shift supervisor can approve this but holds no admin role
    // and is rarely the managerId — resolve the associate's client and copy
    // them in. Fire-and-forget; a lookup failure must not fail the request.
    void (async () => {
      try {
        const assignment = await prisma.associateAssignment.findFirst({
          where: { associateId: user.associateId!, endedAt: null },
          orderBy: { startedAt: 'desc' },
          select: { location: { select: { clientId: true } } },
        });
        const clientId =
          assignment?.location.clientId ??
          (
            await prisma.application.findFirst({
              where: {
                associateId: user.associateId!,
                status: 'APPROVED',
                deletedAt: null,
              },
              orderBy: { createdAt: 'desc' },
              select: { clientId: true },
            })
          )?.clientId;
        const { notifyClientSupervisors } = await import('../lib/notify.js');
        await notifyClientSupervisors(clientId, {
          ...opts,
          linkUrl: '/approvals',
          excludeUserId: user.id,
        });
      } catch (err) {
        console.warn('[time-off] supervisor fan-out failed:', err);
      }
    })();

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
    const where = {
      ...scopeTimeOffRequests(req.user!),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.timeOffRequest.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 200,
        include: REQUEST_INCLUDE,
      }),
      prisma.timeOffRequest.count({ where }),
    ]);
    // Attach each associate's current balance for the requested category so
    // the approver sees "24h requested · 16h available" before clicking —
    // over-draw used to surface only as a 409 after the fact.
    // PERF: two IN filters instead of a 200-clause OR (which Postgres
    // can't index-scan efficiently); the cross-product surplus is
    // discarded by the Map lookup below.
    const balances =
      rows.length > 0
        ? await prisma.timeOffBalance.findMany({
            where: {
              associateId: { in: [...new Set(rows.map((r) => r.associateId))] },
              category: { in: [...new Set(rows.map((r) => r.category))] },
            },
            select: { associateId: true, category: true, balanceMinutes: true },
          })
        : [];
    const balanceKey = (associateId: string, category: string) =>
      `${associateId}:${category}`;
    const balanceMap = new Map(
      balances.map((b) => [balanceKey(b.associateId, b.category), b.balanceMinutes]),
    );
    res.json(
      TimeOffRequestListResponseSchema.parse({
        requests: rows.map((r) => ({
          ...toRequestDTO(r),
          balanceMinutes:
            balanceMap.get(balanceKey(r.associateId, r.category)) ?? null,
        })),
        total,
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Bulk decide — clearing a Monday-morning queue of 40 requests should be
 * one click, not 40 round-trips. Each id is decided independently; partial
 * failure returns per-id results rather than aborting the batch.
 */
timeOffRouter.post('/admin/requests/bulk-decide', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const input = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(200),
        decision: z.enum(['APPROVE', 'DENY']),
        // Required for DENY (mirrors the single-row rule), optional for APPROVE.
        note: z.string().trim().max(1000).optional(),
      })
      .superRefine((v, ctx) => {
        if (v.decision === 'DENY' && !v.note) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['note'],
            message: 'A note is required when denying.',
          });
        }
      })
      .parse(req.body);

    // PERF: one batched scope+detail read for the whole id set (this used
    // to be up to four queries per id, one of them a pure duplicate).
    const scopedRows = await prisma.timeOffRequest.findMany({
      where: { ...scopeTimeOffRequests(user), id: { in: input.ids } },
      select: {
        id: true,
        status: true,
        associateId: true,
        category: true,
        startDate: true,
        endDate: true,
      },
    });
    const rowById = new Map(scopedRows.map((r) => [r.id, r]));

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of input.ids) {
      try {
        const row = rowById.get(id);
        if (!row) throw new IllegalStateError('Request not found');
        if (input.decision === 'APPROVE') {
          // approveRequest owns the balance CAS — stays per-id.
          await approveRequest(prisma, id, user.id, input.note ?? null);
        } else {
          if (row.status !== 'PENDING') {
            throw new IllegalStateError(`Cannot deny a ${row.status} request`);
          }
          await prisma.timeOffRequest.update({
            where: { id },
            data: {
              status: 'DENIED',
              reviewerUserId: user.id,
              reviewerNote: input.note,
              decidedAt: new Date(),
            },
          });
          void emitWebhookEvent('time_off.denied', {
            requestId: id,
            associateId: row.associateId,
            category: row.category,
            startDate: formatDateUTC(row.startDate),
            endDate: formatDateUTC(row.endDate),
          });
        }
        const verb = input.decision === 'APPROVE' ? 'approved' : 'denied';
        void notifyAssociate(row.associateId, {
          subject: `Time off ${verb}: ${formatDateUTC(row.startDate)} – ${formatDateUTC(row.endDate)}`,
          body:
            `Your ${row.category.toLowerCase().replace(/_/g, ' ')} request for ` +
            `${formatDateUTC(row.startDate)} – ${formatDateUTC(row.endDate)} was ${verb}.` +
            (input.note ? `\n\nReviewer note: ${input.note}` : ''),
          category: 'time-off',
          linkUrl: '/time-off',
          emailFallback: true,
        });
        results.push({ id, ok: true });
      } catch (err) {
        const msg =
          err instanceof InsufficientBalanceError || err instanceof IllegalStateError
            ? err.message
            : 'Failed to decide request.';
        results.push({ id, ok: false, error: msg });
      }
    }
    res.json({
      decided: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
    });
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

    // Tenant boundary: 404 (not 403) when the request isn't within the
    // caller's scope, so existence isn't leaked across clients.
    const inScope = await prisma.timeOffRequest.findFirst({
      where: { ...scopeTimeOffRequests(user), id },
      select: { id: true },
    });
    if (!inScope) throw new HttpError(404, 'not_found', 'Request not found');

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
    // The associate hears the decision the moment it's made — before this,
    // approvals were only discoverable by re-opening the page.
    void notifyAssociate(updated.associateId, {
      subject: `Time off approved: ${formatDateUTC(updated.startDate)} – ${formatDateUTC(updated.endDate)}`,
      body:
        `Your ${updated.category.toLowerCase().replace(/_/g, ' ')} request for ` +
        `${formatDateUTC(updated.startDate)} – ${formatDateUTC(updated.endDate)} was approved.` +
        (input.note ? `\n\nReviewer note: ${input.note}` : ''),
      category: 'time-off',
      linkUrl: '/time-off',
      emailFallback: true,
    });
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
    const row = await prisma.timeOffRequest.findFirst({
      where: { ...scopeTimeOffRequests(user), id },
    });
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
    void emitWebhookEvent('time_off.denied', {
      requestId: updated.id,
      associateId: updated.associateId,
      category: updated.category,
      startDate: formatDateUTC(updated.startDate),
      endDate: formatDateUTC(updated.endDate),
    });
    void notifyAssociate(updated.associateId, {
      subject: `Time off request denied: ${formatDateUTC(updated.startDate)} – ${formatDateUTC(updated.endDate)}`,
      body:
        `Your ${updated.category.toLowerCase().replace(/_/g, ' ')} request for ` +
        `${formatDateUTC(updated.startDate)} – ${formatDateUTC(updated.endDate)} was denied.` +
        `\n\nReason: ${input.note}`,
      category: 'time-off',
      linkUrl: '/time-off',
      emailFallback: true,
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
      take: 500,
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
