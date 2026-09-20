import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { randomUUID, createHash } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { UPLOAD_MAX_BYTES, hasCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { effectiveClientIdFilter } from '../lib/scope.js';
import { enqueueAudit } from '../lib/audit.js';
import { getBlobStore } from '../lib/blobStore.js';
import { sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';
import { notifyAllAdmins, notifyUser } from '../lib/notify.js';
import { orgDateKey, startOfWeekUTC, utcInstantOfLocalMidnight } from '../lib/timeAnomalies.js';
import {
  OPS_DEPARTMENTS,
  departmentForPosition,
  ensureOpsSeed,
  periodForPosition,
} from '../lib/opsSops.js';
import { createOpsShift } from '../lib/storeShiftSop.js';
import { isDueTime } from '../lib/sopDue.js';
import { currentStoreWindows } from '../lib/shiftWindows.js';
import { personName, validLead } from '../lib/floorLeads.js';

/**
 * Store Operations — the shift supervisor's floor tool and the leadership
 * chain's oversight of it.
 *
 * Design rules carried through every route:
 *  - Associates never appear as actors. The only runner is the signed-in
 *    supervisor; associates are tagged as "who did the physical work"
 *    from the kiosk clocked-in list.
 *  - Everything auto-populates that CAN auto-populate: store, department
 *    and period (derived from the Alto scheduling position), scheduled
 *    headcount (schedule), actual headcount (kiosk), timestamps and
 *    identities (session).
 *  - The record is evidence: checklists are snapshotted from the library
 *    at open (template edits never rewrite a run shift), closes are
 *    stamped with completion counts, and out-of-range temperatures alert
 *    the moment they're recorded — not at review time.
 */

export const opsRouter = Router();

const RUN = requireCapability('run:ops-shifts');
// The floor supervisor's way in: check items off on their shift's SOP, and
// run it only while it's theirs (covering) — assertMayWork narrows each.
const RUN_OR_ASSIST = requireAnyCapability('run:ops-shifts', 'assist:ops-shifts');
const VIEW = requireAnyCapability('view:ops', 'run:ops-shifts', 'assist:ops-shifts');
const BOARD = requireCapability('view:ops');
const LIB_READ = requireAnyCapability('manage:ops-library', 'view:ops', 'run:ops-shifts');
const LIB = requireCapability('manage:ops-library');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES },
});

const PHOTO_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const DAY_MS = 24 * 3_600_000;

/** Cached org-local hour lookup (period fallback when a position name
 *  doesn't say morning/evening/overnight). */
const HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  hour12: false,
});
function orgHour(d: Date): number {
  return Number(HOUR_FMT.format(d));
}

/** Bounded roles (SHIFT_SUPERVISOR) are locked to their own client. */
function resolveClientId(req: Request, requested?: string): string {
  const clamped = effectiveClientIdFilter(req.user!, requested);
  if (clamped === null) {
    throw new HttpError(403, 'no_client', 'Your account is not assigned to a client.');
  }
  const clientId = clamped ?? requested;
  if (!clientId) {
    throw new HttpError(400, 'client_required', 'clientId is required.');
  }
  return clientId;
}

/** How far back an undecided handover note still blocks a submit. */
const UNREAD_HANDOVER_WINDOW_MS = 36 * 3_600_000;

/** Which earlier shifts hand over to this one: the same store for a
 *  store-shift SOP, the same department for a hand-opened shift. */
function handoverScope(shift: { locationId: string | null; department: string }) {
  return shift.locationId ? { locationId: shift.locationId } : { department: shift.department };
}

async function loadShiftScoped(req: Request, shiftId: string) {
  const shift = await prisma.opsShift.findUnique({ where: { id: shiftId } });
  if (!shift) throw new HttpError(404, 'shift_not_found', 'Ops shift not found');
  const clamped = effectiveClientIdFilter(req.user!, undefined);
  if (clamped !== undefined && clamped !== shift.clientId) {
    throw new HttpError(403, 'forbidden', 'This shift belongs to another client.');
  }
  return shift;
}

/**
 * What a floor supervisor (assist:ops-shifts, no run:ops-shifts) may do on
 * a shift:
 *   'run'  — they're running it (covering for their shift supervisor)
 *   'help' — their lead's store-shift SOP, or one on a shift they work:
 *            check items off, note, photograph
 *   null   — not theirs; hand-opened department shifts never are
 * Anyone holding run:ops-shifts runs any shift of their client, as before.
 */
type OpsAccess = 'run' | 'help' | null;

async function opsAccess(
  req: Request,
  shift: { openedById: string; coveringForId: string | null; locationId: string | null; windowLabel: string | null },
): Promise<OpsAccess> {
  const user = req.user!;
  if (hasCapability(user.role, 'run:ops-shifts')) return 'run';
  if (!hasCapability(user.role, 'assist:ops-shifts')) return null;
  if (shift.openedById === user.id) return 'run';
  if (!shift.locationId || !shift.windowLabel) return null;
  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { leadUserId: true, clientId: true },
  });
  const lead = me ? await validLead(prisma, me) : null;
  if (lead && (shift.openedById === lead.id || shift.coveringForId === lead.id)) return 'help';
  const works = await prisma.supervisorShiftWindow.count({
    where: { userId: user.id, locationId: shift.locationId, label: shift.windowLabel },
  });
  return works > 0 ? 'help' : null;
}

async function assertMayWork(
  req: Request,
  shift: Parameters<typeof opsAccess>[1],
  need: 'help' | 'run',
): Promise<void> {
  const access = await opsAccess(req, shift);
  if (access === 'run' || (need === 'help' && access === 'help')) return;
  throw new HttpError(
    403,
    access === 'help' ? 'not_running' : 'not_your_shift',
    access === 'help'
      ? 'Only the supervisor running this SOP can do that — you can check items off.'
      : "This isn't your shift's SOP.",
  );
}

const taskSelect = {
  id: true,
  source: true,
  section: true,
  order: true,
  title: true,
  instructions: true,
  priority: true,
  status: true,
  responseType: true,
  required: true,
  photoRequired: true,
  tempLabel: true,
  tempMin: true,
  tempMax: true,
  metricKey: true,
  unit: true,
  parentTaskId: true,
  answerChoice: true,
  answerNumber: true,
  answerText: true,
  tempOutOfRange: true,
  note: true,
  blockedReason: true,
  completedAt: true,
  dueAt: true,
  doneAssociate: { select: { id: true, firstName: true, lastName: true } },
  photos: { select: { id: true, filename: true, createdAt: true } },
} satisfies Prisma.OpsTaskSelect;

function toTask(t: Prisma.OpsTaskGetPayload<{ select: typeof taskSelect }>) {
  return {
    id: t.id,
    source: t.source,
    section: t.section,
    order: t.order,
    title: t.title,
    instructions: t.instructions,
    priority: t.priority,
    status: t.status,
    responseType: t.responseType,
    required: t.required,
    photoRequired: t.photoRequired,
    tempLabel: t.tempLabel,
    tempMin: t.tempMin != null ? Number(t.tempMin) : null,
    tempMax: t.tempMax != null ? Number(t.tempMax) : null,
    metricKey: t.metricKey,
    unit: t.unit,
    parentTaskId: t.parentTaskId,
    answerChoice: t.answerChoice,
    answerNumber: t.answerNumber != null ? Number(t.answerNumber) : null,
    answerText: t.answerText,
    tempOutOfRange: t.tempOutOfRange,
    note: t.note,
    blockedReason: t.blockedReason,
    completedAt: t.completedAt?.toISOString() ?? null,
    dueAt: t.dueAt?.toISOString() ?? null,
    doneAssociate: t.doneAssociate
      ? {
          id: t.doneAssociate.id,
          name: `${t.doneAssociate.firstName} ${t.doneAssociate.lastName}`,
        }
      : null,
    photos: t.photos.map((p) => ({
      id: p.id,
      filename: p.filename,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

const handoverSelect = {
  id: true,
  kind: true,
  body: true,
  priority: true,
  status: true,
  createdAt: true,
  decidedAt: true,
  fromShift: {
    select: { id: true, position: true, period: true, dateKey: true },
  },
  decidedBy: { select: { email: true } },
} satisfies Prisma.OpsHandoverItemSelect;

function toHandover(h: Prisma.OpsHandoverItemGetPayload<{ select: typeof handoverSelect }>) {
  return {
    id: h.id,
    kind: h.kind,
    body: h.body,
    priority: h.priority,
    status: h.status,
    createdAt: h.createdAt.toISOString(),
    decidedAt: h.decidedAt?.toISOString() ?? null,
    from: {
      shiftId: h.fromShift.id,
      position: h.fromShift.position,
      period: h.fromShift.period,
      dateKey: h.fromShift.dateKey,
    },
    decidedByEmail: h.decidedBy?.email ?? null,
  };
}

function shiftHeader(s: {
  id: string;
  clientId: string;
  department: string;
  period: string;
  position: string;
  dateKey: string;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  scheduledHeadcount: number;
  actualHeadcount: number;
  templateName: string | null;
  sopTotal: number;
  sopDone: number;
  taskTotal: number;
  taskDone: number;
  closedIncomplete: boolean;
  tempAlerts: number;
  closingSummary: string | null;
  windowLabel?: string | null;
  locationId?: string | null;
  dueAt?: Date | null;
  incompleteReason?: string | null;
  handoverNone?: boolean;
}) {
  return {
    id: s.id,
    clientId: s.clientId,
    department: s.department,
    period: s.period,
    position: s.position,
    dateKey: s.dateKey,
    status: s.status,
    openedAt: s.openedAt.toISOString(),
    closedAt: s.closedAt?.toISOString() ?? null,
    scheduledHeadcount: s.scheduledHeadcount,
    actualHeadcount: s.actualHeadcount,
    templateName: s.templateName,
    sopTotal: s.sopTotal,
    sopDone: s.sopDone,
    taskTotal: s.taskTotal,
    taskDone: s.taskDone,
    closedIncomplete: s.closedIncomplete,
    tempAlerts: s.tempAlerts,
    closingSummary: s.closingSummary,
    // Store-shift SOP (opened at clock-in): its window, and when it's due.
    windowLabel: s.windowLabel ?? null,
    locationId: s.locationId ?? null,
    dueAt: s.dueAt?.toISOString() ?? null,
    incompleteReason: s.incompleteReason ?? null,
    handoverNone: s.handoverNone ?? false,
  };
}

/** Live counts for an ACTIVE shift (closed shifts trust their stamps). */
async function liveCounts(shiftId: string) {
  const rows = await prisma.opsTask.groupBy({
    by: ['source', 'status'],
    where: { opsShiftId: shiftId },
    _count: { _all: true },
  });
  let sopTotal = 0;
  let sopDone = 0;
  let taskTotal = 0;
  let taskDone = 0;
  for (const r of rows) {
    const n = r._count._all;
    taskTotal += n;
    if (r.status === 'DONE') taskDone += n;
    if (r.source === 'SOP') {
      sopTotal += n;
      if (r.status === 'DONE') sopDone += n;
    }
  }
  return { sopTotal, sopDone, taskTotal, taskDone };
}

/* ===== SOP library ======================================================= */

opsRouter.get('/library', LIB_READ, async (_req, res, next) => {
  try {
    await ensureOpsSeed(prisma);
    const templates = await prisma.opsSopTemplate.findMany({
      where: { retiredAt: null },
      orderBy: [{ department: 'asc' }, { period: 'asc' }, { name: 'asc' }],
      include: { tasks: { orderBy: { order: 'asc' } } },
    });
    // Standard → execution: how often each SOP ran in the last 28 days
    // and how completely (closed shifts only — their stamps are final).
    const since = new Date(Date.now() - 28 * DAY_MS);
    const usage = await prisma.opsShift.groupBy({
      by: ['templateId'],
      where: { templateId: { not: null }, status: 'CLOSED', closedAt: { gte: since } },
      _count: { _all: true },
      _sum: { sopDone: true, sopTotal: true },
    });
    const usageByTemplate = new Map(
      usage.map((u) => [
        u.templateId!,
        {
          runs28d: u._count._all,
          avgSopPct:
            (u._sum.sopTotal ?? 0) > 0
              ? Math.round(((u._sum.sopDone ?? 0) / (u._sum.sopTotal ?? 1)) * 100)
              : null,
        },
      ]),
    );
    // Task-level truth: how each LINE of the standard performs in practice
    // (28 days of run instances, keyed by the snapshot's templateTaskId).
    const taskIds = templates.flatMap((t) => t.tasks.map((x) => x.id));
    const [statusAgg, choiceAgg, oorAgg] =
      taskIds.length > 0
        ? await Promise.all([
            prisma.opsTask.groupBy({
              by: ['templateTaskId', 'status'],
              where: { templateTaskId: { in: taskIds }, createdAt: { gte: since } },
              _count: { _all: true },
            }),
            prisma.opsTask.groupBy({
              by: ['templateTaskId', 'answerChoice'],
              where: {
                templateTaskId: { in: taskIds },
                createdAt: { gte: since },
                answerChoice: { not: null },
              },
              _count: { _all: true },
            }),
            prisma.opsTask.groupBy({
              by: ['templateTaskId'],
              where: {
                templateTaskId: { in: taskIds },
                createdAt: { gte: since },
                tempOutOfRange: true,
              },
              _count: { _all: true },
            }),
          ])
        : [[], [], []];
    const taskStats = new Map<
      string,
      { runs: number; done: number; noCount: number; partialCount: number; outOfRange: number }
    >();
    const stat = (id: string) => {
      const row = taskStats.get(id) ?? {
        runs: 0,
        done: 0,
        noCount: 0,
        partialCount: 0,
        outOfRange: 0,
      };
      taskStats.set(id, row);
      return row;
    };
    for (const r of statusAgg) {
      const row = stat(r.templateTaskId!);
      row.runs += r._count._all;
      if (r.status === 'DONE') row.done += r._count._all;
    }
    for (const r of choiceAgg) {
      const row = stat(r.templateTaskId!);
      if (r.answerChoice === 'NO') row.noCount += r._count._all;
      if (r.answerChoice === 'PARTIAL') row.partialCount += r._count._all;
    }
    for (const r of oorAgg) {
      stat(r.templateTaskId!).outOfRange += r._count._all;
    }
    res.json({
      departments: OPS_DEPARTMENTS,
      templates: templates.map((tpl) => ({
        runs28d: usageByTemplate.get(tpl.id)?.runs28d ?? 0,
        avgSopPct: usageByTemplate.get(tpl.id)?.avgSopPct ?? null,
        id: tpl.id,
        name: tpl.name,
        department: tpl.department,
        period: tpl.period,
        description: tpl.description,
        active: tpl.active,
        taskCount: tpl.tasks.length,
        tasks: tpl.tasks.map((task) => ({
          id: task.id,
          section: task.section,
          order: task.order,
          title: task.title,
          instructions: task.instructions,
          responseType: task.responseType,
          required: task.required,
          photoRequired: task.photoRequired,
          tempLabel: task.tempLabel,
          tempMin: task.tempMin != null ? Number(task.tempMin) : null,
          tempMax: task.tempMax != null ? Number(task.tempMax) : null,
          metricKey: task.metricKey,
          unit: task.unit,
          followUpOn: task.followUpOn,
          dueTime: task.dueTime,
          stats: taskStats.get(task.id) ?? {
            runs: 0,
            done: 0,
            noCount: 0,
            partialCount: 0,
            outOfRange: 0,
          },
        })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

const TemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  department: z.string().trim().min(1).max(80),
  period: z.enum(['MORNING', 'EVENING', 'CLOSING', 'OVERNIGHT']),
  description: z.string().trim().max(500).optional(),
});

opsRouter.post('/library/templates', LIB, async (req, res, next) => {
  try {
    const parsed = TemplateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const created = await prisma.opsSopTemplate.create({
      data: { ...parsed.data, createdById: req.user!.id },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'ops.sop_template_created',
        entityType: 'OpsSopTemplate',
        entityId: created.id,
        metadata: { name: created.name, department: created.department, period: created.period },
      },
      'ops.library',
    );
    res.status(201).json({ id: created.id });
  } catch (err) {
    next(err);
  }
});

opsRouter.patch('/library/templates/:id', LIB, async (req, res, next) => {
  try {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        active: z.boolean().optional(),
        // "Delete" = retire — history keeps its snapshots.
        retire: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const tpl = await prisma.opsSopTemplate.findUnique({ where: { id: req.params.id } });
    if (!tpl) throw new HttpError(404, 'not_found', 'Template not found');
    await prisma.opsSopTemplate.update({
      where: { id: tpl.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description }
          : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
        ...(parsed.data.retire ? { retiredAt: new Date(), active: false } : {}),
      },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: parsed.data.retire ? 'ops.sop_template_retired' : 'ops.sop_template_updated',
        entityType: 'OpsSopTemplate',
        entityId: tpl.id,
        metadata: { name: tpl.name },
      },
      'ops.library',
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** "HH:MM", 24-hour — when the task's block is due at the store. */
const DueTime = z.string().refine(isDueTime, 'Use HH:MM, 24-hour.');

const TemplateTaskInputSchema = z.object({
  section: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(300),
  instructions: z.string().trim().max(1000).optional(),
  responseType: z
    .enum(['CHECK', 'YES_NO', 'YES_NO_PARTIAL', 'TEXT', 'NUMBER', 'TEMPERATURE', 'PHOTO'])
    .default('CHECK'),
  required: z.boolean().default(true),
  photoRequired: z.boolean().default(false),
  tempLabel: z.string().trim().max(80).optional(),
  tempMin: z.number().optional(),
  tempMax: z.number().optional(),
  metricKey: z.string().trim().max(60).optional(),
  unit: z.string().trim().max(30).optional(),
  followUpOn: z.enum(['NO', 'NO_OR_PARTIAL', 'OUT_OF_RANGE']).nullable().optional(),
  followUpRequirePhoto: z.boolean().optional(),
  followUpTaskTitle: z.string().trim().max(300).optional(),
  dueTime: DueTime.nullable().optional(),
});

opsRouter.post('/library/templates/:id/tasks', LIB, async (req, res, next) => {
  try {
    const parsed = TemplateTaskInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const tpl = await prisma.opsSopTemplate.findUnique({
      where: { id: req.params.id },
      include: { tasks: { orderBy: { order: 'desc' }, take: 1 } },
    });
    if (!tpl) throw new HttpError(404, 'not_found', 'Template not found');
    // A task added to a timed block is due with it.
    const blockDue =
      parsed.data.dueTime === undefined
        ? await prisma.opsSopTemplateTask.findFirst({
            where: { templateId: tpl.id, section: parsed.data.section, dueTime: { not: null } },
            select: { dueTime: true },
          })
        : null;
    const created = await prisma.opsSopTemplateTask.create({
      data: {
        templateId: tpl.id,
        order: (tpl.tasks[0]?.order ?? -1) + 1,
        section: parsed.data.section,
        title: parsed.data.title,
        instructions: parsed.data.instructions ?? null,
        responseType: parsed.data.responseType,
        required: parsed.data.required,
        photoRequired: parsed.data.photoRequired,
        tempLabel: parsed.data.tempLabel ?? null,
        tempMin: parsed.data.tempMin ?? null,
        tempMax: parsed.data.tempMax ?? null,
        metricKey: parsed.data.metricKey ?? null,
        unit: parsed.data.unit ?? null,
        followUpOn: parsed.data.followUpOn ?? null,
        followUpRequirePhoto: parsed.data.followUpRequirePhoto ?? false,
        followUpTaskTitle: parsed.data.followUpTaskTitle ?? null,
        dueTime: parsed.data.dueTime ?? blockDue?.dueTime ?? null,
      },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'ops.sop_task_added',
        entityType: 'OpsSopTemplate',
        entityId: tpl.id,
        metadata: { taskId: created.id, title: created.title },
      },
      'ops.library',
    );
    res.status(201).json({ id: created.id });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /ops/library/tasks/:id — edit a task in the standard. Safe by
 * construction: run shifts snapshot task content at open, so editing the
 * template never rewrites a shift already run.
 */
opsRouter.patch('/library/tasks/:id', LIB, async (req, res, next) => {
  try {
    const parsed = z
      .object({
        section: z.string().trim().min(1).max(80).optional(),
        title: z.string().trim().min(1).max(300).optional(),
        instructions: z.string().trim().max(1000).nullable().optional(),
        responseType: z
          .enum(['CHECK', 'YES_NO', 'YES_NO_PARTIAL', 'TEXT', 'NUMBER', 'TEMPERATURE', 'PHOTO'])
          .optional(),
        required: z.boolean().optional(),
        photoRequired: z.boolean().optional(),
        tempLabel: z.string().trim().max(80).nullable().optional(),
        tempMin: z.number().nullable().optional(),
        tempMax: z.number().nullable().optional(),
        metricKey: z.string().trim().max(60).nullable().optional(),
        unit: z.string().trim().max(30).nullable().optional(),
        followUpOn: z.enum(['NO', 'NO_OR_PARTIAL', 'OUT_OF_RANGE']).nullable().optional(),
        followUpRequirePhoto: z.boolean().optional(),
        followUpTaskTitle: z.string().trim().max(300).nullable().optional(),
        dueTime: DueTime.nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const task = await prisma.opsSopTemplateTask.findUnique({ where: { id: req.params.id } });
    if (!task) throw new HttpError(404, 'not_found', 'Task not found');
    await prisma.opsSopTemplateTask.update({
      where: { id: task.id },
      data: parsed.data,
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'ops.sop_task_updated',
        entityType: 'OpsSopTemplate',
        entityId: task.templateId,
        metadata: { taskId: task.id, title: parsed.data.title ?? task.title },
      },
      'ops.library',
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /ops/library/templates/:id/sections — time a whole block at once:
 * { section, dueTime | null } sets when every task in it is due.
 */
opsRouter.patch('/library/templates/:id/sections', LIB, async (req, res, next) => {
  try {
    const parsed = z
      .object({ section: z.string().trim().min(1).max(80), dueTime: DueTime.nullable() })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const tpl = await prisma.opsSopTemplate.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!tpl) throw new HttpError(404, 'not_found', 'Template not found');
    const { count } = await prisma.opsSopTemplateTask.updateMany({
      where: { templateId: tpl.id, section: parsed.data.section },
      data: { dueTime: parsed.data.dueTime },
    });
    if (count === 0) throw new HttpError(404, 'section_not_found', 'No such section in this SOP.');
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'ops.sop_section_timed',
        entityType: 'OpsSopTemplate',
        entityId: tpl.id,
        metadata: { section: parsed.data.section, dueTime: parsed.data.dueTime },
      },
      'ops.library',
    );
    res.json({ ok: true, updated: count });
  } catch (err) {
    next(err);
  }
});

opsRouter.delete('/library/tasks/:id', LIB, async (req, res, next) => {
  try {
    const task = await prisma.opsSopTemplateTask.findUnique({ where: { id: req.params.id } });
    if (!task) throw new HttpError(404, 'not_found', 'Task not found');
    // Hard delete is safe HERE: run shifts snapshot task content into
    // OpsTask rows, so removing a template task never touches history.
    await prisma.opsSopTemplateTask.delete({ where: { id: task.id } });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'ops.sop_task_deleted',
        entityType: 'OpsSopTemplate',
        entityId: task.templateId,
        metadata: { title: task.title },
      },
      'ops.library',
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== Open / run / close ================================================ */

/** What the supervisor can open right now: today's positions at their
 *  client, with department/period derivation and any resumable shift. */
opsRouter.get('/open-options', RUN, async (req, res, next) => {
  try {
    const clientId = resolveClientId(req, req.query.clientId?.toString());
    const now = new Date();
    const dateKey = orgDateKey(now);
    const dayStart = utcInstantOfLocalMidnight(dateKey, 'America/New_York');
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const [shifts, mine] = await Promise.all([
      prisma.shift.groupBy({
        by: ['position'],
        where: {
          clientId,
          status: { not: 'CANCELLED' },
          startsAt: { gte: dayStart, lt: dayEnd },
        },
        _count: { _all: true },
      }),
      prisma.opsShift.findFirst({
        where: { openedById: req.user!.id, status: 'ACTIVE' },
        select: { id: true, position: true, department: true },
      }),
    ]);
    res.json({
      clientId,
      dateKey,
      resumeShift: mine,
      positions: shifts
        .map((s) => ({
          position: s.position,
          scheduledCount: s._count._all,
          department: departmentForPosition(s.position),
          period: periodForPosition(s.position, orgHour(now)),
        }))
        .sort((a, b) => a.position.localeCompare(b.position)),
      departments: OPS_DEPARTMENTS,
    });
  } catch (err) {
    next(err);
  }
});

const OpenShiftSchema = z.object({
  clientId: z.string().uuid().optional(),
  position: z.string().trim().min(1).max(120),
  /** Explicit override when the position name doesn't say which. */
  department: z.string().trim().max(80).optional(),
});

opsRouter.post('/shifts/open', RUN, async (req, res, next) => {
  try {
    const parsed = OpenShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const clientId = resolveClientId(req, parsed.data.clientId);
    await ensureOpsSeed(prisma);

    // One live shift per supervisor: opening again resumes.
    const existing = await prisma.opsShift.findFirst({
      where: { openedById: req.user!.id, status: 'ACTIVE' },
      select: { id: true },
    });
    if (existing) {
      res.json({ shiftId: existing.id, resumed: true });
      return;
    }

    const now = new Date();
    const dateKey = orgDateKey(now);
    const department =
      parsed.data.department || departmentForPosition(parsed.data.position);
    if (!department) {
      throw new HttpError(
        400,
        'department_unknown',
        'This position name does not say which department it is — pick one.',
      );
    }
    const period = periodForPosition(parsed.data.position, orgHour(now));

    // Auto-populated header facts + the checklist, snapshotted from today's
    // library (lib/storeShiftSop — the clock-in opens shifts the same way).
    const dayStart = utcInstantOfLocalMidnight(dateKey, 'America/New_York');
    const shift = await createOpsShift(prisma, {
      clientId,
      openedById: req.user!.id,
      department,
      period,
      position: parsed.data.position,
      scheduledBetween: { from: dayStart, to: new Date(dayStart.getTime() + DAY_MS) },
      scheduledPosition: parsed.data.position,
      now,
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId,
        action: 'ops.shift_opened',
        entityType: 'OpsShift',
        entityId: shift.id,
        metadata: { department, period, position: parsed.data.position, dateKey },
      },
      'ops.shifts',
    );
    res.status(201).json({ shiftId: shift.id, resumed: false });
  } catch (err) {
    next(err);
  }
});

opsRouter.get('/shifts/:id', VIEW, async (req, res, next) => {
  try {
    const shift = await loadShiftScoped(req, req.params.id);
    // A floor supervisor reads the SOPs they work on; the board roles and
    // supervisors read any of their client's.
    const access = await opsAccess(req, shift);
    if (!access && !hasCapability(req.user!.role, 'view:ops')) {
      throw new HttpError(403, 'not_your_shift', "This isn't your shift's SOP.");
    }
    const people = await prisma.user.findMany({
      where: { id: { in: [shift.openedById, ...(shift.coveringForId ? [shift.coveringForId] : [])] } },
      select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } },
    });
    const nameOf = (id: string | null) => {
      const u = id ? people.find((p) => p.id === id) : null;
      return u ? { id: u.id, name: personName(u) } : null;
    };
    const [tasks, handoverOut, pendingIn, clockedIn, client] = await Promise.all([
      prisma.opsTask.findMany({
        where: { opsShiftId: shift.id },
        orderBy: [{ source: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
        select: taskSelect,
      }),
      prisma.opsHandoverItem.findMany({
        where: { fromShiftId: shift.id },
        orderBy: { createdAt: 'asc' },
        select: handoverSelect,
      }),
      // Undecided items from EARLIER shifts — the "from the previous
      // shift" panel. A store-shift SOP hands over store to store (Morning
      // → Swing → Overnight); a hand-opened shift, department to department.
      shift.status === 'ACTIVE'
        ? prisma.opsHandoverItem.findMany({
            where: {
              status: 'PENDING',
              fromShift: {
                is: {
                  clientId: shift.clientId,
                  ...handoverScope(shift),
                  status: 'CLOSED',
                  id: { not: shift.id },
                },
              },
            },
            orderBy: { createdAt: 'asc' },
            take: 50,
            select: handoverSelect,
          })
        : Promise.resolve([]),
      prisma.timeEntry.findMany({
        where: { clientId: shift.clientId, status: 'ACTIVE' },
        select: {
          associate: { select: { id: true, firstName: true, lastName: true } },
        },
        take: 200,
      }),
      prisma.client.findUnique({
        where: { id: shift.clientId },
        select: { name: true },
      }),
    ]);
    const location = shift.locationId
      ? await prisma.location.findUnique({ where: { id: shift.locationId }, select: { name: true } })
      : null;
    const counts =
      shift.status === 'ACTIVE'
        ? await liveCounts(shift.id)
        : {
            sopTotal: shift.sopTotal,
            sopDone: shift.sopDone,
            taskTotal: shift.taskTotal,
            taskDone: shift.taskDone,
          };
    res.json({
      shift: {
        ...shiftHeader(shift),
        ...counts,
        clientName: client?.name ?? null,
        locationName: location?.name ?? null,
        // Who runs it (must submit it), and who they're covering for.
        runBy: nameOf(shift.openedById),
        coveringFor: nameOf(shift.coveringForId),
      },
      // What the caller may do here: run it, help on it, or only read it.
      access: access ?? 'view',
      tasks: tasks.map(toTask),
      handoverOut: handoverOut.map(toHandover),
      handoverIn: pendingIn.map(toHandover),
      clockedIn: clockedIn.map((e) => ({
        id: e.associate.id,
        name: `${e.associate.firstName} ${e.associate.lastName}`,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const AdhocTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  instructions: z.string().trim().max(1000).optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
  responseType: z
    .enum(['CHECK', 'YES_NO', 'YES_NO_PARTIAL', 'TEXT', 'NUMBER', 'TEMPERATURE', 'PHOTO'])
    .default('CHECK'),
});

opsRouter.post('/shifts/:id/tasks', RUN_OR_ASSIST, async (req, res, next) => {
  try {
    const shift = await loadShiftScoped(req, req.params.id);
    if (shift.status !== 'ACTIVE') {
      throw new HttpError(409, 'shift_closed', 'This shift is closed.');
    }
    await assertMayWork(req, shift, 'run');
    const parsed = AdhocTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const created = await prisma.opsTask.create({
      data: {
        opsShiftId: shift.id,
        source: 'ADHOC',
        section: 'Ad-hoc',
        order: 9000,
        title: parsed.data.title,
        instructions: parsed.data.instructions ?? null,
        priority: parsed.data.priority,
        responseType: parsed.data.responseType,
        required: true,
        createdById: req.user!.id,
      },
      select: taskSelect,
    });
    res.status(201).json({ task: toTask(created) });
  } catch (err) {
    next(err);
  }
});

const TaskPatchSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'BLOCKED']).optional(),
  answerChoice: z.enum(['YES', 'NO', 'PARTIAL']).nullable().optional(),
  answerNumber: z.number().finite().nullable().optional(),
  answerText: z.string().trim().max(2000).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  blockedReason: z.string().trim().max(500).nullable().optional(),
  doneAssociateId: z.string().uuid().nullable().optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
});

opsRouter.patch('/tasks/:id', RUN_OR_ASSIST, async (req, res, next) => {
  try {
    const task = await prisma.opsTask.findUnique({
      where: { id: req.params.id },
      include: {
        opsShift: {
          select: {
            id: true,
            clientId: true,
            status: true,
            position: true,
            openedById: true,
            coveringForId: true,
            locationId: true,
            windowLabel: true,
          },
        },
        photos: { select: { id: true }, take: 1 },
      },
    });
    if (!task) throw new HttpError(404, 'task_not_found', 'Task not found');
    const clamped = effectiveClientIdFilter(req.user!, undefined);
    if (clamped !== undefined && clamped !== task.opsShift.clientId) {
      throw new HttpError(403, 'forbidden', 'This task belongs to another client.');
    }
    if (task.opsShift.status !== 'ACTIVE') {
      throw new HttpError(409, 'shift_closed', 'This shift is closed — the record is final.');
    }
    await assertMayWork(req, task.opsShift, 'help');
    const parsed = TaskPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;

    // Evidence gate: a photo-required task can't be DONE undocumented.
    if (
      input.status === 'DONE' &&
      (task.photoRequired || task.responseType === 'PHOTO') &&
      task.photos.length === 0
    ) {
      throw new HttpError(
        409,
        'photo_required',
        'This task requires a photo before it can be completed.',
      );
    }

    // Temperature bounds: flag + alert THE MOMENT it's recorded.
    let tempOutOfRange = task.tempOutOfRange;
    let newAlert = false;
    if (task.responseType === 'TEMPERATURE' && input.answerNumber != null) {
      const min = task.tempMin != null ? Number(task.tempMin) : null;
      const max = task.tempMax != null ? Number(task.tempMax) : null;
      const out =
        (min != null && input.answerNumber < min) ||
        (max != null && input.answerNumber > max);
      newAlert = out && !task.tempOutOfRange;
      tempOutOfRange = out;
    }

    const becameDone = input.status === 'DONE' && task.status !== 'DONE';
    const updated = await prisma.opsTask.update({
      where: { id: task.id },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.answerChoice !== undefined ? { answerChoice: input.answerChoice } : {}),
        ...(input.answerNumber !== undefined ? { answerNumber: input.answerNumber } : {}),
        ...(input.answerText !== undefined ? { answerText: input.answerText } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason } : {}),
        ...(input.doneAssociateId !== undefined
          ? { doneAssociateId: input.doneAssociateId }
          : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        tempOutOfRange,
        ...(becameDone
          ? { completedById: req.user!.id, completedAt: new Date() }
          : input.status !== undefined && input.status !== 'DONE'
            ? { completedById: null, completedAt: null }
            : {}),
      },
      select: taskSelect,
    });

    if (newAlert) {
      await prisma.opsShift.update({
        where: { id: task.opsShift.id },
        data: { tempAlerts: { increment: 1 } },
      });
      // Food safety doesn't wait for shift review.
      await notifyAllAdmins({
        subject: `Temperature out of range — ${task.opsShift.position}`,
        body: `${task.tempLabel ?? 'A reading'} came back ${input.answerNumber}°F on "${task.title}" (allowed ${task.tempMin ?? '—'}–${task.tempMax ?? '—'}°F). Recorded by ${req.user!.email}. Check the equipment now.`,
        category: 'ops.temp_alert',
        linkUrl: '/ops',
      });
    }

    // ---- Closed loop: detect → explain → correct → verify -----------------
    // A triggering answer spawns ONE corrective child task on the same
    // shift (deduped per parent): out-of-range temps re-verify with the
    // same bounds; No/Partial compliance answers demand an explanation
    // (or photo proof when the rule says so). The child is required, so
    // an unresolved loop shows up in close-incomplete and handover like
    // any other unfinished work.
    let followUp: ReturnType<typeof toTask> | null = null;
    const triggered =
      (task.followUpOn === 'OUT_OF_RANGE' && newAlert) ||
      (task.followUpOn === 'NO' && input.answerChoice === 'NO') ||
      (task.followUpOn === 'NO_OR_PARTIAL' &&
        (input.answerChoice === 'NO' || input.answerChoice === 'PARTIAL'));
    if (triggered) {
      const existingChild = await prisma.opsTask.findFirst({
        where: { parentTaskId: task.id },
        select: { id: true },
      });
      if (!existingChild) {
        const isTemp = task.responseType === 'TEMPERATURE';
        const child = await prisma.opsTask.create({
          data: {
            opsShiftId: task.opsShift.id,
            source: 'FOLLOWUP',
            parentTaskId: task.id,
            section: task.section,
            order: task.order,
            title:
              task.followUpTaskTitle ??
              (isTemp
                ? `Re-check — ${task.tempLabel ?? task.title}`
                : `Explain & correct — ${task.title}`),
            instructions: isTemp
              ? 'The last reading was out of range. Fix the cause, then record a fresh reading.'
              : 'The answer flagged a problem. Say what was wrong and what was done about it.',
            priority: 'HIGH',
            responseType: isTemp
              ? 'TEMPERATURE'
              : task.followUpRequirePhoto
                ? 'PHOTO'
                : 'TEXT',
            required: true,
            photoRequired: !isTemp && task.followUpRequirePhoto,
            ...(isTemp
              ? { tempLabel: task.tempLabel, tempMin: task.tempMin, tempMax: task.tempMax }
              : {}),
            createdById: req.user!.id,
          },
          select: taskSelect,
        });
        followUp = toTask(child);
      }
    }

    res.json({ task: toTask(updated), followUp });
  } catch (err) {
    next(err);
  }
});

opsRouter.post(
  '/tasks/:id/photos',
  RUN_OR_ASSIST,
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await prisma.opsTask.findUnique({
        where: { id: req.params.id },
        include: {
          opsShift: {
            select: {
              clientId: true,
              status: true,
              openedById: true,
              coveringForId: true,
              locationId: true,
              windowLabel: true,
            },
          },
        },
      });
      if (!task) throw new HttpError(404, 'task_not_found', 'Task not found');
      const clamped = effectiveClientIdFilter(req.user!, undefined);
      if (clamped !== undefined && clamped !== task.opsShift.clientId) {
        throw new HttpError(403, 'forbidden', 'This task belongs to another client.');
      }
      if (task.opsShift.status !== 'ACTIVE') {
        throw new HttpError(409, 'shift_closed', 'This shift is closed.');
      }
      await assertMayWork(req, task.opsShift, 'help');
      if (!req.file) {
        throw new HttpError(400, 'no_file', 'A "file" multipart field is required');
      }
      if (!PHOTO_MIMES.has(req.file.mimetype)) {
        throw new HttpError(400, 'invalid_type', 'Photos must be PNG, JPEG, or WebP.');
      }
      const magicError = verifyFileMagic(req.file.buffer, req.file.mimetype);
      if (magicError) throw new HttpError(400, 'invalid_file_contents', magicError);
      const cleanName = sanitizeUploadFilename(req.file.originalname || 'photo.jpg');
      const sha = createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const key = `ops-photos/${randomUUID()}-${sha}${extname(cleanName).toLowerCase() || '.jpg'}`;
      await getBlobStore().put(key, req.file.buffer, req.file.mimetype);
      const photo = await prisma.opsTaskPhoto.create({
        data: {
          taskId: task.id,
          s3Key: key,
          filename: cleanName,
          mimeType: req.file.mimetype,
          size: req.file.size,
          uploadedById: req.user!.id,
        },
      });
      // For PHOTO-response tasks the photo IS the completion — landing one
      // finishes the task in the same gesture (supplementary photos on
      // other task types never auto-complete anything).
      let autoCompleted = false;
      if (task.responseType === 'PHOTO' && task.status !== 'DONE') {
        await prisma.opsTask.update({
          where: { id: task.id },
          data: { status: 'DONE', completedById: req.user!.id, completedAt: new Date() },
        });
        autoCompleted = true;
      }
      res.status(201).json({
        photo: { id: photo.id, filename: photo.filename, createdAt: photo.createdAt.toISOString() },
        autoCompleted,
      });
    } catch (err) {
      next(err);
    }
  },
);

opsRouter.get('/photos/:id', VIEW, async (req, res, next) => {
  try {
    const photo = await prisma.opsTaskPhoto.findUnique({
      where: { id: req.params.id },
      include: { task: { select: { opsShift: { select: { clientId: true } } } } },
    });
    if (!photo) throw new HttpError(404, 'not_found', 'Photo not found');
    const clamped = effectiveClientIdFilter(req.user!, undefined);
    if (clamped !== undefined && clamped !== photo.task.opsShift.clientId) {
      throw new HttpError(403, 'forbidden', 'This photo belongs to another client.');
    }
    const buf = await getBlobStore().get(photo.s3Key);
    if (!buf) throw new HttpError(404, 'blob_missing', 'Photo file is missing.');
    res.setHeader('Content-Type', photo.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

/* ===== Handover ========================================================== */

const HandoverItemsSchema = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum([
          'NOTE',
          'UNFINISHED_TASK',
          'SPECIAL_ORDER',
          'COACH_COMPLAINT',
          'EQUIPMENT',
          'STOCKING',
        ]),
        body: z.string().trim().min(1).max(1000),
        priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
      }),
    )
    .min(1)
    .max(50),
});

opsRouter.post('/shifts/:id/handover', RUN_OR_ASSIST, async (req, res, next) => {
  try {
    const shift = await loadShiftScoped(req, req.params.id);
    if (shift.status !== 'ACTIVE') {
      throw new HttpError(409, 'shift_closed', 'This shift is closed.');
    }
    await assertMayWork(req, shift, 'run');
    const parsed = HandoverItemsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    await prisma.opsHandoverItem.createMany({
      data: parsed.data.items.map((i) => ({
        fromShiftId: shift.id,
        kind: i.kind,
        body: i.body,
        priority: i.priority,
      })),
    });
    // Client-relationship and maintenance signals don't wait for the next
    // shift: coach complaints, equipment problems, and anything HIGH
    // escalate to leadership the moment they're written down. The item
    // still flows to the next shift's handover as designed.
    const urgent = parsed.data.items.filter(
      (i) => i.kind === 'COACH_COMPLAINT' || i.kind === 'EQUIPMENT' || i.priority === 'HIGH',
    );
    if (urgent.length > 0) {
      const client = await prisma.client.findUnique({
        where: { id: shift.clientId },
        select: { name: true },
      });
      const kindLabel: Record<string, string> = {
        COACH_COMPLAINT: 'Walmart coach complaint',
        EQUIPMENT: 'Equipment problem',
        STOCKING: 'Stocking issue',
        SPECIAL_ORDER: 'Special order',
        UNFINISHED_TASK: 'Unfinished task',
        NOTE: 'Note',
      };
      await notifyAllAdmins({
        subject: `Floor escalation — ${client?.name ?? 'store'} · ${shift.department}`,
        body:
          urgent
            .map((i) => `${kindLabel[i.kind]}${i.priority === 'HIGH' ? ' (HIGH)' : ''}: ${i.body}`)
            .join('\n') +
          `\n\nLogged by ${req.user!.email} on the ${shift.position} shift (${shift.dateKey}). Also queued for the next shift's handover.`,
        category: 'ops.handover_alert',
        linkUrl: '/ops',
      });
    }
    res.status(201).json({ added: parsed.data.items.length });
  } catch (err) {
    next(err);
  }
});

opsRouter.post('/handover/:id/decide', RUN_OR_ASSIST, async (req, res, next) => {
  try {
    const parsed = z
      .object({
        action: z.enum(['CARRY', 'DISMISS', 'REVIEW']),
        shiftId: z.string().uuid(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const item = await prisma.opsHandoverItem.findUnique({
      where: { id: req.params.id },
      include: { fromShift: { select: { clientId: true, department: true, locationId: true } } },
    });
    if (!item) throw new HttpError(404, 'not_found', 'Handover item not found');
    if (item.status !== 'PENDING') {
      throw new HttpError(409, 'already_decided', `This item is already ${item.status}.`);
    }
    const target = await loadShiftScoped(req, parsed.data.shiftId);
    if (target.status !== 'ACTIVE') {
      throw new HttpError(409, 'shift_closed', 'The receiving shift is closed.');
    }
    await assertMayWork(req, target, 'run');
    const sameLine = target.locationId
      ? item.fromShift.locationId === target.locationId
      : item.fromShift.department === target.department;
    if (target.clientId !== item.fromShift.clientId || !sameLine) {
      throw new HttpError(
        409,
        'wrong_shift',
        target.locationId
          ? 'Handover items can only be decided by the same store.'
          : 'Handover items can only be decided by the same store department.',
      );
    }

    let carriedTaskId: string | null = null;
    if (parsed.data.action === 'CARRY') {
      const carried = await prisma.opsTask.create({
        data: {
          opsShiftId: target.id,
          source: 'CARRYOVER',
          section: 'Carried over',
          order: 8000,
          title: item.body.slice(0, 300),
          priority: item.priority,
          responseType: 'CHECK',
          required: true,
          createdById: req.user!.id,
        },
        select: { id: true },
      });
      carriedTaskId = carried.id;
    }
    await prisma.opsHandoverItem.update({
      where: { id: item.id },
      data: {
        status:
          parsed.data.action === 'CARRY'
            ? 'CARRIED'
            : parsed.data.action === 'DISMISS'
              ? 'DISMISSED'
              : 'REVIEWED',
        decidedById: req.user!.id,
        decidedAt: new Date(),
        decidedInShiftId: target.id,
        carriedTaskId,
      },
    });
    res.json({ ok: true, carriedTaskId });
  } catch (err) {
    next(err);
  }
});

/* ===== Store-shift SOPs ================================================== */

/** The running store-shift SOP a floor supervisor helps on: their shift
 *  supervisor's (or one covering for them), else one on a shift they work. */
async function helpingSop(userId: string) {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { leadUserId: true, clientId: true },
  });
  if (!me?.clientId) return null;
  const lead = await validLead(prisma, me);
  const windows = await prisma.supervisorShiftWindow.findMany({
    where: { userId },
    select: { locationId: true, label: true },
  });
  const or: Prisma.OpsShiftWhereInput[] = [
    ...(lead ? [{ openedById: lead.id }, { coveringForId: lead.id }] : []),
    ...windows.map((w) => ({ locationId: w.locationId, windowLabel: w.label })),
  ];
  if (or.length === 0) return null;
  const sops = await prisma.opsShift.findMany({
    where: { clientId: me.clientId, status: 'ACTIVE', windowLabel: { not: null }, OR: or },
    orderBy: { openedAt: 'desc' },
    take: 5,
    include: {
      location: { select: { name: true } },
      openedBy: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
    },
  });
  // Their lead's first; then their own shift's.
  const pick =
    sops.find((x) => lead && (x.openedById === lead.id || x.coveringForId === lead.id)) ?? sops[0];
  if (!pick) return null;
  const counts = await liveCounts(pick.id);
  return {
    id: pick.id,
    windowLabel: pick.windowLabel,
    position: pick.position,
    locationName: pick.location?.name ?? null,
    dueAt: pick.dueAt?.toISOString() ?? null,
    sopDone: counts.sopDone,
    sopTotal: counts.sopTotal,
    runBy: { id: pick.openedBy.id, name: personName(pick.openedBy) },
  };
}

/**
 * GET /ops/my-sop — the SOP the caller has open (opened at their clock-in
 * or by hand), with progress — the "finish your SOP" banner and the
 * clock-out guard read this. null when nothing is open.
 */
opsRouter.get('/my-sop', RUN_OR_ASSIST, async (req, res, next) => {
  try {
    const shift = await prisma.opsShift.findFirst({
      where: { openedById: req.user!.id, status: 'ACTIVE' },
      orderBy: { openedAt: 'desc' },
      include: {
        location: { select: { name: true } },
        coveringFor: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
      },
    });
    // A floor supervisor not running one: the SOP they help on — their
    // shift supervisor's, or one running on a shift they work.
    const helping =
      !shift && !hasCapability(req.user!.role, 'run:ops-shifts')
        ? await helpingSop(req.user!.id)
        : null;
    if (!shift) {
      // Nothing open: say what they last submitted, if it's this shift's —
      // the end-of-shift screen reads "submitted · clock out", not "start".
      const last = await prisma.opsShift.findFirst({
        where: {
          openedById: req.user!.id,
          status: 'CLOSED',
          closedAt: { gte: new Date(Date.now() - 16 * 3_600_000) },
        },
        orderBy: { closedAt: 'desc' },
        select: { id: true, windowLabel: true, position: true, closedAt: true, closedIncomplete: true },
      });
      res.json({
        sop: null,
        helping,
        submitted: last
          ? {
              id: last.id,
              windowLabel: last.windowLabel,
              position: last.position,
              closedAt: last.closedAt!.toISOString(),
              closedIncomplete: last.closedIncomplete,
            }
          : null,
      });
      return;
    }
    const now = new Date();
    const [counts, handoverCount, requiredOpen, overdue, nextDue] = await Promise.all([
      liveCounts(shift.id),
      prisma.opsHandoverItem.count({ where: { fromShiftId: shift.id } }),
      prisma.opsTask.count({ where: { opsShiftId: shift.id, required: true, status: { not: 'DONE' } } }),
      prisma.opsTask.count({ where: { opsShiftId: shift.id, status: { not: 'DONE' }, dueAt: { lt: now } } }),
      // The block to work now: the earliest one with anything still open.
      prisma.opsTask.findFirst({
        where: { opsShiftId: shift.id, status: { not: 'DONE' }, dueAt: { not: null } },
        orderBy: [{ dueAt: 'asc' }, { order: 'asc' }],
        select: { section: true, dueAt: true },
      }),
    ]);
    const block = nextDue
      ? {
          section: nextDue.section,
          dueAt: nextDue.dueAt!.toISOString(),
          open: await prisma.opsTask.count({
            where: { opsShiftId: shift.id, status: { not: 'DONE' }, section: nextDue.section, dueAt: nextDue.dueAt },
          }),
        }
      : null;
    res.json({
      sop: {
        id: shift.id,
        windowLabel: shift.windowLabel,
        position: shift.position,
        locationName: shift.location?.name ?? null,
        dueAt: shift.dueAt?.toISOString() ?? null,
        openedAt: shift.openedAt.toISOString(),
        sopDone: counts.sopDone,
        sopTotal: counts.sopTotal,
        requiredOpen,
        handoverCount,
        overdue,
        block,
        coveringFor: shift.coveringFor
          ? { id: shift.coveringFor.id, name: personName(shift.coveringFor) }
          : null,
      },
      helping: null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /ops/store-shifts?clientId= — each store's named shift windows and
 * the SOP assigned to each (what a supervisor's clock-in opens there).
 * PUT /ops/store-shifts — assign (or clear) one: { locationId, label,
 * templateId | null }.
 */
opsRouter.get('/store-shifts', LIB_READ, async (req, res, next) => {
  try {
    const clientId = resolveClientId(req, req.query.clientId?.toString());
    await ensureOpsSeed(prisma);
    const stores = await prisma.location.findMany({
      where: { clientId, deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const [defs, assigned, templates] = await Promise.all([
      currentStoreWindows(prisma, stores.map((st) => st.id)),
      prisma.storeShiftSop.findMany({
        where: { locationId: { in: stores.map((st) => st.id) } },
        select: { locationId: true, label: true, templateId: true },
      }),
      prisma.opsSopTemplate.findMany({
        where: { active: true, retiredAt: null },
        select: { id: true, name: true, department: true, period: true, _count: { select: { tasks: true } } },
        orderBy: [{ department: 'asc' }, { name: 'asc' }],
      }),
    ]);
    // A window carries one SOP per department now, so this is a list.
    const byKey = new Map<string, string[]>();
    for (const a of assigned) {
      const key = `${a.locationId}|${a.label}`;
      const list = byKey.get(key);
      if (list) list.push(a.templateId);
      else byKey.set(key, [a.templateId]);
    }
    res.json({
      stores: stores.map((st) => ({
        locationId: st.id,
        locationName: st.name,
        windows: [...defs.values()]
          .filter((w) => w.locationId === st.id)
          .sort((a, b) => a.startMinute - b.startMinute)
          .map((w) => ({
            label: w.label,
            startMinute: w.startMinute,
            endMinute: w.endMinute,
            templateIds: byKey.get(`${st.id}|${w.label}`) ?? [],
            /** The first, so an older client keeps working. */
            templateId: byKey.get(`${st.id}|${w.label}`)?.[0] ?? null,
          })),
      })),
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        department: t.department,
        period: t.period,
        taskCount: t._count.tasks,
      })),
    });
  } catch (err) {
    next(err);
  }
});

opsRouter.put('/store-shifts', LIB, async (req, res, next) => {
  try {
    const parsed = z
      .object({
        locationId: z.string().uuid(),
        label: z.string().trim().min(1).max(80),
        templateId: z.string().uuid().nullable(),
        /** Drop ONE department's SOP. `templateId: null` still clears the
         *  whole window — both are wanted, and they are not the same act. */
        removeTemplateId: z.string().uuid().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { locationId, label, templateId, removeTemplateId } = parsed.data;
    const store = await prisma.location.findFirst({
      where: { id: locationId, deletedAt: null },
      select: { id: true, clientId: true },
    });
    if (!store) throw new HttpError(404, 'not_found', 'Store not found');
    const defs = await currentStoreWindows(prisma, [locationId]);
    if (!defs.has(`${locationId}|${label}`)) {
      throw new HttpError(400, 'window_not_found', "That isn't one of this store's shift windows.");
    }
    if (removeTemplateId) {
      await prisma.storeShiftSop.deleteMany({
        where: { locationId, label, templateId: removeTemplateId },
      });
    } else if (templateId === null) {
      // Null still clears the window — the "no SOP here" case.
      await prisma.storeShiftSop.deleteMany({ where: { locationId, label } });
    } else {
      const template = await prisma.opsSopTemplate.findFirst({
        where: { id: templateId, active: true, retiredAt: null },
        select: { id: true, department: true },
      });
      if (!template) throw new HttpError(400, 'template_not_found', 'Pick an active SOP from the library.');
      // A window carries one SOP PER DEPARTMENT. Assigning a second
      // department's SOP used to overwrite the first, because the row was
      // unique on (locationId, label) alone — which is how a store where
      // Alto staffs three departments ended up running one checklist.
      // Replacing within a department still replaces.
      const sameDepartment = await prisma.storeShiftSop.findMany({
        where: { locationId, label, template: { department: template.department } },
        select: { id: true },
      });
      if (sameDepartment.length > 0) {
        await prisma.storeShiftSop.deleteMany({
          where: { id: { in: sameDepartment.map((r) => r.id) } },
        });
      }
      await prisma.storeShiftSop.upsert({
        where: { locationId_label_templateId: { locationId, label, templateId } },
        create: { locationId, label, templateId, updatedById: req.user!.id },
        update: { updatedById: req.user!.id },
      });
    }
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId: store.clientId,
        action: 'ops.store_shift_sop_set',
        entityType: 'Location',
        entityId: locationId,
        metadata: { label, templateId, ...(removeTemplateId ? { removed: removeTemplateId } : {}) },
      },
      'ops.library',
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ===== Close ============================================================= */

opsRouter.post('/shifts/:id/close', RUN_OR_ASSIST, async (req, res, next) => {
  try {
    const shift = await loadShiftScoped(req, req.params.id);
    if (shift.status !== 'ACTIVE') {
      throw new HttpError(409, 'shift_closed', 'This shift is already closed.');
    }
    await assertMayWork(req, shift, 'run');
    const parsed = z
      .object({
        summary: z.string().trim().max(2000).optional(),
        /** "Nothing to hand over" — the explicit alternative to a note. */
        handoverNone: z.boolean().optional(),
        /** Why required items are still open — submitting incomplete. */
        incompleteReason: z.string().trim().max(1000).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const [counts, requiredOpen, actualHeadcount, handoverCount] = await Promise.all([
      liveCounts(shift.id),
      prisma.opsTask.count({
        where: { opsShiftId: shift.id, required: true, status: { not: 'DONE' } },
      }),
      prisma.timeEntry.count({
        where: {
          clientId: shift.clientId,
          ...(shift.locationId ? { locationId: shift.locationId } : {}),
          status: 'ACTIVE',
        },
      }),
      prisma.opsHandoverItem.count({ where: { fromShiftId: shift.id } }),
    ]);
    // The handover loop closes both ways: the notes the previous shift left
    // are acknowledged before this one is submitted. Recent ones only — a
    // backlog nobody decided last week never blocks tonight's submit.
    const unread = await prisma.opsHandoverItem.count({
      where: {
        status: 'PENDING',
        createdAt: { gte: new Date(Date.now() - UNREAD_HANDOVER_WINDOW_MS) },
        fromShift: {
          is: { clientId: shift.clientId, ...handoverScope(shift), status: 'CLOSED', id: { not: shift.id } },
        },
      },
    });
    if (unread > 0) {
      throw new HttpError(
        400,
        'handover_unread',
        `Acknowledge the ${unread} note${unread === 1 ? '' : 's'} from the previous shift before you submit.`,
      );
    }
    // Every submit hands over: a note for the next shift, or an explicit
    // "nothing to hand over" — never silence.
    if (handoverCount === 0 && !parsed.data.handoverNone) {
      throw new HttpError(
        400,
        'handover_required',
        'Write a handover note for the next shift, or mark that there is nothing to hand over.',
      );
    }
    const closedIncomplete = requiredOpen > 0;
    // Submitting with required items open is the way out when a shift
    // can't be finished — never a silent one: it takes a reason.
    const incompleteReason = parsed.data.incompleteReason?.trim() ?? '';
    if (closedIncomplete && incompleteReason.length < 5) {
      throw new HttpError(
        400,
        'reason_required',
        `${requiredOpen} required item${requiredOpen === 1 ? ' is' : 's are'} still open — say why before submitting it incomplete.`,
      );
    }
    const now = new Date();
    const updated = await prisma.opsShift.update({
      where: { id: shift.id },
      data: {
        status: 'CLOSED',
        closedById: req.user!.id,
        closedAt: now,
        closingSummary: parsed.data.summary || null,
        incompleteReason: closedIncomplete ? incompleteReason : null,
        handoverNone: handoverCount === 0,
        actualHeadcount,
        sopTotal: counts.sopTotal,
        sopDone: counts.sopDone,
        taskTotal: counts.taskTotal,
        taskDone: counts.taskDone,
        closedIncomplete,
      },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId: shift.clientId,
        action: 'ops.shift_closed',
        entityType: 'OpsShift',
        entityId: shift.id,
        metadata: {
          department: shift.department,
          period: shift.period,
          sop: `${counts.sopDone}/${counts.sopTotal}`,
          tasks: `${counts.taskDone}/${counts.taskTotal}`,
          closedIncomplete,
          tempAlerts: updated.tempAlerts,
        },
      },
      'ops.shifts',
    );
    // Covering for their shift supervisor: the record says so, and the
    // shift supervisor hears how their shift went.
    const coveredLead = shift.coveringForId
      ? await prisma.user.findUnique({
          where: { id: shift.coveringForId },
          select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } },
        })
      : null;
    const submitter = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { email: true, associate: { select: { firstName: true, lastName: true } } },
    });
    const submittedBy = `${submitter ? personName(submitter) : req.user!.email}${
      coveredLead ? `, covering for ${personName(coveredLead)}` : ''
    }`;
    if (closedIncomplete) {
      await notifyAllAdmins({
        subject: `Ops shift closed incomplete — ${shift.position}`,
        body: `${shift.windowLabel ? `${shift.windowLabel} SOP` : shift.department} (${shift.dateKey}) submitted with ${requiredOpen} required item${requiredOpen === 1 ? '' : 's'} unfinished. SOP ${counts.sopDone}/${counts.sopTotal}, tasks ${counts.taskDone}/${counts.taskTotal}. Submitted by ${submittedBy}. Reason: ${incompleteReason}`,
        category: 'ops.incomplete_close',
        linkUrl: '/ops',
      });
    }
    if (coveredLead && coveredLead.id !== req.user!.id) {
      const label = shift.windowLabel ? `${shift.windowLabel} SOP` : 'SOP';
      await notifyUser(coveredLead.id, {
        subject: `${submitter ? personName(submitter) : 'Your floor supervisor'} submitted your ${label}`,
        body:
          `${shift.dateKey}: ${counts.sopDone} of ${counts.sopTotal} done` +
          (closedIncomplete ? `, submitted incomplete — ${incompleteReason}` : '') +
          `. ${handoverCount === 0 ? 'Nothing handed over.' : `${handoverCount} note${handoverCount === 1 ? '' : 's'} handed over to the next shift.`}`,
        category: 'ops.sop',
        linkUrl: `/ops?tab=shift&record=${shift.id}`,
      });
    }
    res.json({ shift: shiftHeader(updated) });
  } catch (err) {
    next(err);
  }
});

/* ===== Oversight board + scorecard ====================================== */

opsRouter.get('/shifts', VIEW, async (req, res, next) => {
  try {
    const clamped = effectiveClientIdFilter(req.user!, req.query.clientId?.toString());
    const clientId = clamped === null ? '00000000-0000-0000-0000-000000000000' : clamped;
    const status = req.query.status?.toString();
    const dateKey = req.query.dateKey?.toString();
    const rows = await prisma.opsShift.findMany({
      where: {
        ...(clientId ? { clientId } : {}),
        ...(status === 'ACTIVE' || status === 'CLOSED' ? { status } : {}),
        ...(dateKey ? { dateKey } : {}),
      },
      orderBy: { openedAt: 'desc' },
      take: 200,
      include: {
        client: { select: { name: true } },
        openedBy: { select: { email: true } },
        coveringFor: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
      },
    });
    res.json({
      shifts: rows.map((s) => ({
        ...shiftHeader(s),
        clientName: s.client.name,
        openedByEmail: s.openedBy.email,
        coveringForName: s.coveringFor ? personName(s.coveringFor) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

opsRouter.get('/board', BOARD, async (_req, res, next) => {
  try {
    const now = new Date();
    const todayKey = orgDateKey(now);
    const [active, closedToday] = await Promise.all([
      prisma.opsShift.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { openedAt: 'asc' },
        take: 100,
        include: {
          client: { select: { name: true } },
          openedBy: { select: { email: true } },
          coveringFor: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
        },
      }),
      prisma.opsShift.findMany({
        where: { status: 'CLOSED', dateKey: todayKey },
        orderBy: { closedAt: 'desc' },
        take: 100,
        include: {
          client: { select: { name: true } },
          openedBy: { select: { email: true } },
          coveringFor: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
        },
      }),
    ]);
    const activeWithCounts = await Promise.all(
      active.map(async (s) => ({
        ...shiftHeader(s),
        ...(await liveCounts(s.id)),
        clientName: s.client.name,
        openedByEmail: s.openedBy.email,
        coveringForName: s.coveringFor ? personName(s.coveringFor) : null,
      })),
    );
    res.json({
      dateKey: todayKey,
      active: activeWithCounts,
      closedToday: closedToday.map((s) => ({
        ...shiftHeader(s),
        clientName: s.client.name,
        openedByEmail: s.openedBy.email,
        coveringForName: s.coveringFor ? personName(s.coveringFor) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /ops/insights — the chairman's window, drawn: per-store live
 * snapshots, the 24h temperature picture with safe bands, today's
 * activity rhythm by hour, the 7-day SOP trend, and today's recorded
 * production volume. Everything a walk of all four stores would tell
 * you, on one screen.
 */
opsRouter.get('/insights', BOARD, async (_req, res, next) => {
  try {
    const now = new Date();
    const todayKey = orgDateKey(now);
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

    const [activeShifts, todayShifts, tempTasks, todayDone, weekClosed, floorEntries] =
      await Promise.all([
        prisma.opsShift.findMany({
          where: { status: 'ACTIVE' },
          select: {
            clientId: true,
            department: true,
            actualHeadcount: true,
            scheduledHeadcount: true,
            tempAlerts: true,
            client: { select: { name: true } },
          },
          take: 100,
        }),
        prisma.opsShift.findMany({
          where: { dateKey: todayKey },
          select: {
            clientId: true,
            status: true,
            sopDone: true,
            sopTotal: true,
            tempAlerts: true,
            closedIncomplete: true,
            client: { select: { name: true } },
          },
          take: 200,
        }),
        prisma.opsTask.findMany({
          where: {
            responseType: 'TEMPERATURE',
            answerNumber: { not: null },
            completedAt: { gte: dayAgo },
          },
          orderBy: { completedAt: 'asc' },
          take: 200,
          select: {
            completedAt: true,
            answerNumber: true,
            tempMin: true,
            tempMax: true,
            tempOutOfRange: true,
            tempLabel: true,
            opsShift: { select: { client: { select: { name: true } } } },
          },
        }),
        prisma.opsTask.findMany({
          where: {
            completedAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
          },
          select: {
            completedAt: true,
            responseType: true,
            answerNumber: true,
            metricKey: true,
            unit: true,
          },
          take: 2000,
        }),
        prisma.opsShift.findMany({
          where: { status: 'CLOSED', closedAt: { gte: weekAgo } },
          select: { dateKey: true, sopDone: true, sopTotal: true },
          take: 1000,
        }),
        prisma.timeEntry.groupBy({
          by: ['clientId'],
          where: { status: 'ACTIVE' },
          _count: { _all: true },
        }),
      ]);

    // Per-store windows: live counts + today's SOP so far.
    const floorByClient = new Map(floorEntries.map((f) => [f.clientId, f._count._all]));
    const storeMap = new Map<
      string,
      {
        name: string;
        liveShifts: number;
        departments: string[];
        floor: number;
        tempAlertsToday: number;
        sopDone: number;
        sopTotal: number;
        incompleteToday: number;
      }
    >();
    const touch = (clientId: string, name: string) => {
      const row = storeMap.get(clientId) ?? {
        name,
        liveShifts: 0,
        departments: [],
        floor: floorByClient.get(clientId) ?? 0,
        tempAlertsToday: 0,
        sopDone: 0,
        sopTotal: 0,
        incompleteToday: 0,
      };
      storeMap.set(clientId, row);
      return row;
    };
    for (const s of activeShifts) {
      const row = touch(s.clientId, s.client.name);
      row.liveShifts += 1;
      if (!row.departments.includes(s.department)) row.departments.push(s.department);
    }
    for (const s of todayShifts) {
      const row = touch(s.clientId, s.client.name);
      row.tempAlertsToday += s.tempAlerts;
      row.sopDone += s.sopDone;
      row.sopTotal += s.sopTotal;
      if (s.closedIncomplete) row.incompleteToday += 1;
    }

    // 24h activity rhythm by org-local hour.
    const hourFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: true,
    });
    const rhythm = new Map<string, number>();
    for (const t of todayDone) {
      if (!t.completedAt) continue;
      const label = hourFmt.format(t.completedAt);
      rhythm.set(label, (rhythm.get(label) ?? 0) + 1);
    }
    // Chronological order: walk the last 24 hours hour by hour.
    const hourly: { hour: string; count: number }[] = [];
    for (let i = 23; i >= 0; i--) {
      const label = hourFmt.format(new Date(now.getTime() - i * 3_600_000));
      hourly.push({ hour: label, count: rhythm.get(label) ?? 0 });
    }

    // 7-day SOP trend from closed shifts.
    const trendMap = new Map<string, { done: number; total: number }>();
    for (const s of weekClosed) {
      const row = trendMap.get(s.dateKey) ?? { done: 0, total: 0 };
      row.done += s.sopDone;
      row.total += s.sopTotal;
      trendMap.set(s.dateKey, row);
    }
    const sopTrend = [...trendMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateKey, r]) => ({
        dateKey,
        pct: r.total > 0 ? Math.round((r.done / r.total) * 100) : null,
      }));

    // Production, by NAMED metric — cases stocked is not items discarded.
    const metricMap = new Map<string, { unit: string | null; total: number; readings: number }>();
    for (const t of todayDone) {
      if (t.responseType !== 'NUMBER' || t.answerNumber == null) continue;
      const key = t.metricKey ?? 'recorded';
      const row = metricMap.get(key) ?? { unit: t.unit, total: 0, readings: 0 };
      row.total += Number(t.answerNumber);
      row.readings += 1;
      metricMap.set(key, row);
    }
    const metrics = [...metricMap.entries()]
      .map(([metricKey, r]) => ({ metricKey, ...r }))
      .sort((a, b) => b.total - a.total);
    const production = metrics.reduce(
      (acc, m) => ({ readings: acc.readings + m.readings, units: acc.units + m.total }),
      { readings: 0, units: 0 },
    );

    res.json({
      stores: [...storeMap.values()]
        .map((s) => ({
          ...s,
          sopPct: s.sopTotal > 0 ? Math.round((s.sopDone / s.sopTotal) * 100) : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      tempSeries: tempTasks.map((t) => ({
        at: t.completedAt!.toISOString(),
        value: Number(t.answerNumber),
        min: t.tempMin != null ? Number(t.tempMin) : null,
        max: t.tempMax != null ? Number(t.tempMax) : null,
        out: t.tempOutOfRange,
        label: t.tempLabel,
        store: t.opsShift.client.name,
      })),
      hourly,
      sopTrend,
      production,
      metrics,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /ops/feed — the live pulse of every floor. The most recent task
 * completions, temperature readings, photos, opens/closes and handover
 * notes across all stores, merged newest-first: what an executive would
 * see standing in the store, without standing in the store.
 */
opsRouter.get('/feed', BOARD, async (_req, res, next) => {
  try {
    const since = new Date(Date.now() - 36 * 3_600_000);
    const [tasks, photos, shifts] = await Promise.all([
      prisma.opsTask.findMany({
        where: { completedAt: { gte: since } },
        orderBy: { completedAt: 'desc' },
        take: 40,
        select: {
          id: true,
          title: true,
          responseType: true,
          answerNumber: true,
          answerChoice: true,
          tempLabel: true,
          tempOutOfRange: true,
          completedAt: true,
          doneAssociate: { select: { firstName: true, lastName: true } },
          completedBy: { select: { email: true } },
          opsShift: {
            select: {
              department: true,
              client: { select: { name: true } },
            },
          },
        },
      }),
      prisma.opsTaskPhoto.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: {
          id: true,
          createdAt: true,
          task: {
            select: {
              title: true,
              opsShift: {
                select: { department: true, client: { select: { name: true } } },
              },
            },
          },
        },
      }),
      prisma.opsShift.findMany({
        where: {
          OR: [{ openedAt: { gte: since } }, { closedAt: { gte: since } }],
        },
        orderBy: { openedAt: 'desc' },
        take: 30,
        select: {
          id: true,
          department: true,
          period: true,
          status: true,
          openedAt: true,
          closedAt: true,
          closedIncomplete: true,
          sopDone: true,
          sopTotal: true,
          client: { select: { name: true } },
          openedBy: { select: { email: true } },
        },
      }),
    ]);

    type FeedEvent = {
      at: string;
      kind: 'task' | 'temp' | 'photo' | 'open' | 'close';
      store: string;
      department: string;
      headline: string;
      detail: string | null;
      alert: boolean;
      photoId: string | null;
    };
    const events: FeedEvent[] = [];
    for (const t of tasks) {
      const who = t.doneAssociate
        ? `${t.doneAssociate.firstName} ${t.doneAssociate.lastName}`
        : (t.completedBy?.email ?? null);
      if (t.responseType === 'TEMPERATURE' && t.answerNumber != null) {
        events.push({
          at: t.completedAt!.toISOString(),
          kind: 'temp',
          store: t.opsShift.client.name,
          department: t.opsShift.department,
          headline: `${t.tempLabel ?? 'Temperature'}: ${Number(t.answerNumber)}°F`,
          detail: t.tempOutOfRange ? 'OUT OF RANGE — alerted' : 'in range',
          alert: t.tempOutOfRange,
          photoId: null,
        });
      } else {
        events.push({
          at: t.completedAt!.toISOString(),
          kind: 'task',
          store: t.opsShift.client.name,
          department: t.opsShift.department,
          headline: t.title,
          detail: [
            t.answerNumber != null ? `count ${Number(t.answerNumber)}` : null,
            t.answerChoice ?? null,
            who ? `by ${who}` : null,
          ]
            .filter(Boolean)
            .join(' · ') || null,
          alert: false,
          photoId: null,
        });
      }
    }
    for (const p of photos) {
      events.push({
        at: p.createdAt.toISOString(),
        kind: 'photo',
        store: p.task.opsShift.client.name,
        department: p.task.opsShift.department,
        headline: p.task.title,
        detail: 'photo from the floor',
        alert: false,
        photoId: p.id,
      });
    }
    for (const s of shifts) {
      events.push({
        at: s.openedAt.toISOString(),
        kind: 'open',
        store: s.client.name,
        department: s.department,
        headline: `${s.department} shift opened`,
        detail: s.openedBy.email,
        alert: false,
        photoId: null,
      });
      if (s.closedAt) {
        events.push({
          at: s.closedAt.toISOString(),
          kind: 'close',
          store: s.client.name,
          department: s.department,
          headline: `${s.department} shift closed — SOP ${s.sopDone}/${s.sopTotal}`,
          detail: s.closedIncomplete ? 'closed incomplete' : 'complete',
          alert: s.closedIncomplete,
          photoId: null,
        });
      }
    }
    events.sort((a, b) => b.at.localeCompare(a.at));
    res.json({
      events: events.slice(0, 60),
      photos: photos.map((p) => ({
        id: p.id,
        at: p.createdAt.toISOString(),
        store: p.task.opsShift.client.name,
        department: p.task.opsShift.department,
        title: p.task.title,
      })),
    });
  } catch (err) {
    next(err);
  }
});

opsRouter.get('/scorecard', BOARD, async (req, res, next) => {
  try {
    const weeks = Math.min(12, Math.max(1, Number(req.query.weeks) || 4));
    const since = new Date(Date.now() - weeks * 7 * DAY_MS);
    const shifts = await prisma.opsShift.findMany({
      where: { status: 'CLOSED', closedAt: { gte: since } },
      select: {
        clientId: true,
        department: true,
        sopTotal: true,
        sopDone: true,
        taskTotal: true,
        taskDone: true,
        closedIncomplete: true,
        tempAlerts: true,
        client: { select: { name: true } },
      },
      take: 3000,
    });
    const tempChecks = await prisma.opsTask.groupBy({
      by: ['tempOutOfRange'],
      where: {
        responseType: 'TEMPERATURE',
        answerNumber: { not: null },
        opsShift: { is: { status: 'CLOSED', closedAt: { gte: since } } },
      },
      _count: { _all: true },
    });
    const handover = await prisma.opsHandoverItem.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    // Weekly named-metric series — where the metric keys pay compound
    // interest: cases stocked / discards / out-of-stocks per org week.
    const metricRows = await prisma.opsTask.findMany({
      where: {
        responseType: 'NUMBER',
        metricKey: { not: null },
        answerNumber: { not: null },
        completedAt: { gte: since },
      },
      select: { metricKey: true, unit: true, answerNumber: true, completedAt: true },
      take: 5000,
    });
    // Continuous week buckets across the window (zero-filled).
    const weekKeys: string[] = [];
    for (let w = weeks - 1; w >= 0; w--) {
      weekKeys.push(
        orgDateKey(startOfWeekUTC(new Date(Date.now() - w * 7 * DAY_MS))),
      );
    }
    const byMetric = new Map<
      string,
      { unit: string | null; total: number; weeks: Map<string, number> }
    >();
    for (const r of metricRows) {
      const wk = orgDateKey(startOfWeekUTC(r.completedAt!));
      const row = byMetric.get(r.metricKey!) ?? {
        unit: r.unit,
        total: 0,
        weeks: new Map<string, number>(),
      };
      const v = Number(r.answerNumber);
      row.total += v;
      row.weeks.set(wk, (row.weeks.get(wk) ?? 0) + v);
      byMetric.set(r.metricKey!, row);
    }
    const metricTrends = [...byMetric.entries()]
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, 4)
      .map(([metricKey, r]) => ({
        metricKey,
        unit: r.unit,
        total: r.total,
        weeks: weekKeys.map((weekKey) => ({
          weekKey,
          total: r.weeks.get(weekKey) ?? 0,
        })),
      }));

    const byKey = new Map<
      string,
      {
        clientName: string;
        department: string;
        shifts: number;
        sopDone: number;
        sopTotal: number;
        incomplete: number;
        tempAlerts: number;
      }
    >();
    for (const s of shifts) {
      const key = `${s.clientId}|${s.department}`;
      const row = byKey.get(key) ?? {
        clientName: s.client.name,
        department: s.department,
        shifts: 0,
        sopDone: 0,
        sopTotal: 0,
        incomplete: 0,
        tempAlerts: 0,
      };
      row.shifts += 1;
      row.sopDone += s.sopDone;
      row.sopTotal += s.sopTotal;
      if (s.closedIncomplete) row.incomplete += 1;
      row.tempAlerts += s.tempAlerts;
      byKey.set(key, row);
    }
    const inRange = tempChecks.find((r) => !r.tempOutOfRange)?._count._all ?? 0;
    const outOfRange = tempChecks.find((r) => r.tempOutOfRange)?._count._all ?? 0;
    const handoverCounts = Object.fromEntries(
      handover.map((h) => [h.status, h._count._all]),
    ) as Record<string, number>;

    res.json({
      weeks,
      rows: [...byKey.values()]
        .map((r) => ({
          ...r,
          sopPct: r.sopTotal > 0 ? Math.round((r.sopDone / r.sopTotal) * 100) : null,
        }))
        .sort(
          (a, b) =>
            a.clientName.localeCompare(b.clientName) ||
            a.department.localeCompare(b.department),
        ),
      totals: {
        shifts: shifts.length,
        tempChecks: inRange + outOfRange,
        tempOutOfRange: outOfRange,
        handoverCreated:
          (handoverCounts.PENDING ?? 0) +
          (handoverCounts.CARRIED ?? 0) +
          (handoverCounts.DISMISSED ?? 0) +
          (handoverCounts.REVIEWED ?? 0),
        handoverCarried: handoverCounts.CARRIED ?? 0,
      },
      metricTrends,
    });
  } catch (err) {
    next(err);
  }
});
