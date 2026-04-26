import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  ActiveDashboardResponseSchema,
  ActiveTimeEntryResponseSchema,
  ClockInInputV2Schema,
  ClockOutInputV2Schema,
  StartBreakInputSchema,
  TimeApproveInputSchema,
  TimeEntryListResponseSchema,
  TimeRejectInputSchema,
  type ActiveDashboardEntry,
  type ActiveTimeEntryResponse,
  type TimeAnomaly,
  type TimeEntry,
  type TimeEntryListResponse,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeTimeEntries } from '../lib/scope.js';
import { recordTimeEvent } from '../lib/audit.js';
import { checkGeofence } from '../lib/geo.js';
import {
  detectAnomalies,
  endOfWeekUTC,
  netWorkedMinutes,
  startOfWeekUTC,
} from '../lib/timeAnomalies.js';
import { accrueSickLeaveForEntry } from '../lib/timeOffAccrual.js';

export const timeRouter = Router();

const MANAGE = requireCapability('manage:time');

type RawEntry = Prisma.TimeEntryGetPayload<{
  include: {
    associate: { select: { firstName: true; lastName: true } };
    approvedBy: { select: { email: true } };
    job: { select: { name: true } };
    breaks: true;
  };
}>;

const ENTRY_INCLUDE = {
  associate: { select: { firstName: true, lastName: true } },
  approvedBy: { select: { email: true } },
  job: { select: { name: true } },
  breaks: true,
} as const;

function minutesElapsed(row: { clockInAt: Date; clockOutAt: Date | null }): number {
  const end = row.clockOutAt ?? new Date();
  return Math.max(0, Math.floor((end.getTime() - row.clockInAt.getTime()) / 60_000));
}

async function loadClientName(clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
  return c?.name ?? null;
}

async function toEntry(row: RawEntry): Promise<TimeEntry> {
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    clientId: row.clientId,
    clientName: await loadClientName(row.clientId),
    clockInAt: row.clockInAt.toISOString(),
    clockOutAt: row.clockOutAt ? row.clockOutAt.toISOString() : null,
    status: row.status,
    notes: row.notes,
    rejectionReason: row.rejectionReason,
    approvedById: row.approvedById,
    approverEmail: row.approvedBy?.email ?? null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    minutesElapsed: minutesElapsed(row),
    jobId: row.jobId,
    jobName: row.job?.name ?? null,
    payRate: row.payRate ? Number(row.payRate) : null,
    clockInLat: row.clockInLat ? Number(row.clockInLat) : null,
    clockInLng: row.clockInLng ? Number(row.clockInLng) : null,
    clockOutLat: row.clockOutLat ? Number(row.clockOutLat) : null,
    clockOutLng: row.clockOutLng ? Number(row.clockOutLng) : null,
    anomalies: Array.isArray(row.anomalies) ? (row.anomalies as string[]) : [],
  };
}

/* ===== ASSOCIATE-FACING (/me) =========================================== */

timeRouter.get('/me/active', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      // Non-associate roles legitimately have no active entry.
      const empty: ActiveTimeEntryResponse = { active: null };
      res.json(empty);
      return;
    }
    const row = await prisma.timeEntry.findFirst({
      where: { associateId: user.associateId, status: 'ACTIVE' },
      include: ENTRY_INCLUDE,
    });
    const payload = ActiveTimeEntryResponseSchema.parse({
      active: row ? await toEntry(row) : null,
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

timeRouter.get('/me/entries', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      const payload: TimeEntryListResponse = { entries: [] };
      res.json(payload);
      return;
    }
    const rows = await prisma.timeEntry.findMany({
      where: { associateId: user.associateId },
      orderBy: { clockInAt: 'desc' },
      take: 50,
      include: ENTRY_INCLUDE,
    });
    const entries = await Promise.all(rows.map(toEntry));
    const payload = TimeEntryListResponseSchema.parse({ entries });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/me/clock-in', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can clock in');
    }
    const parsed = ClockInInputV2Schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { notes, jobId, geo } = parsed.data;

    let clientId = user.clientId;
    let payRate: number | null = null;
    if (jobId) {
      const job = await prisma.job.findFirst({
        where: { id: jobId, deletedAt: null, isActive: true },
      });
      if (!job) throw new HttpError(404, 'job_not_found', 'Job not found or inactive');
      clientId = job.clientId;
      payRate = job.payRate ? Number(job.payRate) : null;
    }

    let geofenceOk: boolean | null = null;
    if (clientId) {
      const c = await prisma.client.findUnique({
        where: { id: clientId },
        select: { latitude: true, longitude: true, geofenceRadiusMeters: true },
      });
      if (c) {
        const result = checkGeofence(
          {
            latitude: c.latitude ? Number(c.latitude) : null,
            longitude: c.longitude ? Number(c.longitude) : null,
            radiusMeters: c.geofenceRadiusMeters,
          },
          geo ?? null
        );
        geofenceOk = result.inside;
      }
    }

    let entry;
    try {
      entry = await prisma.timeEntry.create({
        data: {
          associateId: user.associateId,
          clientId,
          jobId: jobId ?? null,
          clockInAt: new Date(),
          clockInLat: geo?.lat ?? null,
          clockInLng: geo?.lng ?? null,
          payRate,
          notes: notes ?? null,
          status: 'ACTIVE',
          anomalies: geofenceOk === false ? ['GEOFENCE_VIOLATION_IN'] : [],
        },
        include: ENTRY_INCLUDE,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(409, 'already_clocked_in', 'You are already clocked in');
      }
      throw err;
    }

    await recordTimeEvent({
      actorUserId: user.id,
      action: 'time.clock_in',
      timeEntryId: entry.id,
      associateId: entry.associateId,
      clientId: entry.clientId,
      metadata: { jobId: jobId ?? null, geofenceOk, hasGeo: !!geo },
      req,
    });

    res.status(201).json(await toEntry(entry));
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/me/clock-out', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can clock out');
    }
    const parsed = ClockOutInputV2Schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { notes, geo } = parsed.data;

    const active = await prisma.timeEntry.findFirst({
      where: { associateId: user.associateId, status: 'ACTIVE' },
      include: { breaks: true, associate: { select: { state: true } } },
    });
    if (!active) {
      throw new HttpError(409, 'not_clocked_in', 'No active time entry to close');
    }

    // Auto-close any open break — associate clocked out without ending it.
    const openBreak = active.breaks.find((b) => !b.endedAt);
    const now = new Date();
    if (openBreak) {
      await prisma.breakEntry.update({
        where: { id: openBreak.id },
        data: { endedAt: now },
      });
    }

    // Geofence check on clock-out coords.
    let geofenceOutOk: boolean | null = null;
    if (active.clientId) {
      const c = await prisma.client.findUnique({
        where: { id: active.clientId },
        select: { latitude: true, longitude: true, geofenceRadiusMeters: true },
      });
      if (c) {
        const result = checkGeofence(
          {
            latitude: c.latitude ? Number(c.latitude) : null,
            longitude: c.longitude ? Number(c.longitude) : null,
            radiusMeters: c.geofenceRadiusMeters,
          },
          geo ?? null
        );
        geofenceOutOk = result.inside;
      }
    }

    // Sum weekly worked minutes (ACTIVE+COMPLETED+APPROVED) for OT detection,
    // excluding the current entry (we'll add it back with the about-to-be net).
    const weekStart = startOfWeekUTC(active.clockInAt);
    const weekEnd = endOfWeekUTC(active.clockInAt);
    const weeklyEntries = await prisma.timeEntry.findMany({
      where: {
        associateId: active.associateId,
        clockInAt: { gte: weekStart, lt: weekEnd },
        id: { not: active.id },
      },
      include: { breaks: true },
    });
    const weeklyMinutesSoFar = weeklyEntries.reduce(
      (sum, e) => sum + netWorkedMinutes(e, e.breaks),
      0
    );
    const refreshedBreaks = openBreak
      ? active.breaks.map((b) => (b.id === openBreak.id ? { ...b, endedAt: now } : b))
      : active.breaks;
    const thisEntryMinutes = netWorkedMinutes(
      { clockInAt: active.clockInAt, clockOutAt: now },
      refreshedBreaks
    );
    const weeklyTotal = weeklyMinutesSoFar + thisEntryMinutes;

    // Compute geofence-in retroactively from the existing flag in anomalies.
    const existingAnoms: TimeAnomaly[] = Array.isArray(active.anomalies)
      ? (active.anomalies as TimeAnomaly[])
      : [];
    const geofenceInOk = existingAnoms.includes('GEOFENCE_VIOLATION_IN')
      ? false
      : null;

    const detected = detectAnomalies({
      entry: {
        clockInAt: active.clockInAt,
        clockOutAt: now,
        geofenceInOk,
        geofenceOutOk,
      },
      breaks: refreshedBreaks.map((b) => ({
        type: b.type,
        startedAt: b.startedAt,
        endedAt: b.endedAt,
      })),
      weeklyMinutesIncludingThis: weeklyTotal,
      state: active.associate?.state ?? null,
    });

    const updated = await prisma.timeEntry.update({
      where: { id: active.id },
      data: {
        clockOutAt: now,
        clockOutLat: geo?.lat ?? null,
        clockOutLng: geo?.lng ?? null,
        status: 'COMPLETED',
        notes: notes ?? active.notes,
        anomalies: detected,
      },
      include: ENTRY_INCLUDE,
    });

    await recordTimeEvent({
      actorUserId: user.id,
      action: 'time.clock_out',
      timeEntryId: updated.id,
      associateId: updated.associateId,
      clientId: updated.clientId,
      metadata: {
        minutes: minutesElapsed(updated),
        netMinutes: thisEntryMinutes,
        weeklyMinutes: weeklyTotal,
        anomalies: detected,
      },
      req,
    });

    res.json(await toEntry(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== Breaks =========================================================== */

timeRouter.post('/me/break/start', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can start a break');
    }
    const parsed = StartBreakInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const active = await prisma.timeEntry.findFirst({
      where: { associateId: user.associateId, status: 'ACTIVE' },
      include: { breaks: true },
    });
    if (!active) {
      throw new HttpError(409, 'not_clocked_in', 'You must be clocked in to start a break');
    }
    if (active.breaks.some((b) => !b.endedAt)) {
      throw new HttpError(409, 'break_in_progress', 'You already have an open break');
    }
    const created = await prisma.breakEntry.create({
      data: {
        timeEntryId: active.id,
        type: parsed.data.type,
        startedAt: new Date(),
      },
    });
    await recordTimeEvent({
      actorUserId: user.id,
      action: 'time.break_started',
      timeEntryId: active.id,
      associateId: active.associateId,
      clientId: active.clientId,
      metadata: { breakId: created.id, type: created.type },
      req,
    });
    res.status(201).json({
      id: created.id,
      timeEntryId: created.timeEntryId,
      type: created.type,
      startedAt: created.startedAt.toISOString(),
      endedAt: null,
      minutes: 0,
    });
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/me/break/end', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can end a break');
    }
    const active = await prisma.timeEntry.findFirst({
      where: { associateId: user.associateId, status: 'ACTIVE' },
      include: { breaks: { where: { endedAt: null } } },
    });
    if (!active || active.breaks.length === 0) {
      throw new HttpError(409, 'no_open_break', 'You have no open break to end');
    }
    const open = active.breaks[0];
    const ended = await prisma.breakEntry.update({
      where: { id: open.id },
      data: { endedAt: new Date() },
    });
    await recordTimeEvent({
      actorUserId: user.id,
      action: 'time.break_ended',
      timeEntryId: active.id,
      associateId: active.associateId,
      clientId: active.clientId,
      metadata: {
        breakId: ended.id,
        type: ended.type,
        minutes: Math.floor(
          ((ended.endedAt!.getTime() - ended.startedAt.getTime()) / 60_000)
        ),
      },
      req,
    });
    const minutes = Math.max(
      0,
      Math.floor((ended.endedAt!.getTime() - ended.startedAt.getTime()) / 60_000)
    );
    res.json({
      id: ended.id,
      timeEntryId: ended.timeEntryId,
      type: ended.type,
      startedAt: ended.startedAt.toISOString(),
      endedAt: ended.endedAt!.toISOString(),
      minutes,
    });
  } catch (err) {
    next(err);
  }
});

/* ===== Real-time clocked-in dashboard (HR/Ops) ========================== */

timeRouter.get('/admin/active', MANAGE, async (req, res, next) => {
  try {
    const clientId = req.query.clientId?.toString();
    const where: Prisma.TimeEntryWhereInput = {
      ...scopeTimeEntries(req.user!),
      status: 'ACTIVE',
      ...(clientId ? { clientId } : {}),
    };
    const rows = await prisma.timeEntry.findMany({
      where,
      orderBy: { clockInAt: 'asc' },
      include: {
        associate: { select: { firstName: true, lastName: true } },
        job: { select: { name: true } },
        breaks: { where: { endedAt: null } },
      },
    });
    const clientIds = Array.from(new Set(rows.map((r) => r.clientId).filter(Boolean) as string[]));
    const clients = await prisma.client.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, name: true, latitude: true, longitude: true, geofenceRadiusMeters: true },
    });
    const clientById = new Map(clients.map((c) => [c.id, c]));

    const now = Date.now();
    const entries: ActiveDashboardEntry[] = rows.map((r) => {
      const c = r.clientId ? clientById.get(r.clientId) : undefined;
      let geofenceOk: boolean | null = null;
      if (c) {
        const result = checkGeofence(
          {
            latitude: c.latitude ? Number(c.latitude) : null,
            longitude: c.longitude ? Number(c.longitude) : null,
            radiusMeters: c.geofenceRadiusMeters,
          },
          r.clockInLat && r.clockInLng
            ? { lat: Number(r.clockInLat), lng: Number(r.clockInLng) }
            : null
        );
        geofenceOk = result.inside;
      }
      return {
        id: r.id,
        associateId: r.associateId,
        associateName: `${r.associate.firstName} ${r.associate.lastName}`,
        clientId: r.clientId,
        clientName: c?.name ?? null,
        jobId: r.jobId,
        jobName: r.job?.name ?? null,
        clockInAt: r.clockInAt.toISOString(),
        minutesElapsed: Math.max(
          0,
          Math.floor((now - r.clockInAt.getTime()) / 60_000)
        ),
        onBreak: r.breaks.length > 0,
        geofenceOk,
        clockInLat: r.clockInLat ? Number(r.clockInLat) : null,
        clockInLng: r.clockInLng ? Number(r.clockInLng) : null,
      };
    });
    res.json(ActiveDashboardResponseSchema.parse({ entries }));
  } catch (err) {
    next(err);
  }
});

/* ===== HR/Ops (/admin) =================================================== */

timeRouter.get('/admin/entries', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const associateId = req.query.associateId?.toString();
    const clientId = req.query.clientId?.toString();

    const where: Prisma.TimeEntryWhereInput = {
      ...scopeTimeEntries(req.user!),
      ...(status ? { status: status as Prisma.TimeEntryWhereInput['status'] } : {}),
      ...(associateId ? { associateId } : {}),
      ...(clientId ? { clientId } : {}),
    };

    const rows = await prisma.timeEntry.findMany({
      where,
      orderBy: { clockInAt: 'desc' },
      take: 200,
      include: ENTRY_INCLUDE,
    });
    const entries = await Promise.all(rows.map(toEntry));
    const payload = TimeEntryListResponseSchema.parse({ entries });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/admin/entries/:id/approve', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = TimeApproveInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }

    const existing = await prisma.timeEntry.findFirst({
      where: { id: req.params.id, ...scopeTimeEntries(user) },
    });
    if (!existing) {
      throw new HttpError(404, 'time_entry_not_found', 'Time entry not found');
    }
    if (existing.status === 'ACTIVE') {
      throw new HttpError(409, 'still_active', 'Cannot approve an entry that has not been clocked out');
    }
    if (existing.status === 'APPROVED') {
      // Idempotent re-approval — return as-is.
      const row = await prisma.timeEntry.findUniqueOrThrow({
        where: { id: existing.id },
        include: ENTRY_INCLUDE,
      });
      res.json(await toEntry(row));
      return;
    }

    const updated = await prisma.timeEntry.update({
      where: { id: existing.id },
      data: {
        status: 'APPROVED',
        approvedById: user.id,
        approvedAt: new Date(),
        rejectionReason: null,
        ...(parsed.data.clockInAt ? { clockInAt: new Date(parsed.data.clockInAt) } : {}),
        ...(parsed.data.clockOutAt ? { clockOutAt: new Date(parsed.data.clockOutAt) } : {}),
      },
      include: ENTRY_INCLUDE,
    });

    // Phase 26 — accrue state-driven sick leave on approval. Idempotent;
    // re-approving a never-clocks-out / 0-rate entry is a no-op.
    const accrual = await accrueSickLeaveForEntry(prisma, updated.id);

    await recordTimeEvent({
      actorUserId: user.id,
      action: 'time.approved',
      timeEntryId: updated.id,
      associateId: updated.associateId,
      clientId: updated.clientId,
      metadata: {
        minutes: minutesElapsed(updated),
        ...(accrual.accrued
          ? { sickAccrualMinutes: accrual.earnedMinutes, state: accrual.state }
          : {}),
      },
      req,
    });

    res.json(await toEntry(updated));
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/admin/entries/:id/reject', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = TimeRejectInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }

    const existing = await prisma.timeEntry.findFirst({
      where: { id: req.params.id, ...scopeTimeEntries(user) },
    });
    if (!existing) {
      throw new HttpError(404, 'time_entry_not_found', 'Time entry not found');
    }
    if (existing.status === 'ACTIVE') {
      throw new HttpError(409, 'still_active', 'Cannot reject an entry that has not been clocked out');
    }

    const updated = await prisma.timeEntry.update({
      where: { id: existing.id },
      data: {
        status: 'REJECTED',
        rejectionReason: parsed.data.reason,
        approvedById: user.id,
        approvedAt: new Date(),
      },
      include: ENTRY_INCLUDE,
    });

    await recordTimeEvent({
      actorUserId: user.id,
      action: 'time.rejected',
      timeEntryId: updated.id,
      associateId: updated.associateId,
      clientId: updated.clientId,
      metadata: { reason: parsed.data.reason },
      req,
    });

    res.json(await toEntry(updated));
  } catch (err) {
    next(err);
  }
});
