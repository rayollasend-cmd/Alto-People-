import { Router } from 'express';
import { Prisma, type BreakType } from '@prisma/client';
import {
  ActiveDashboardResponseSchema,
  ActiveTimeEntryResponseSchema,
  AdminCreateTimeEntryInputSchema,
  AdminEditTimeEntryInputSchema,
  BulkTimeApproveInputSchema,
  BulkTimeRejectInputSchema,
  ClockInInputV2Schema,
  ClockOutInputV2Schema,
  PayPeriodListResponseSchema,
  StartBreakInputSchema,
  TimeApproveInputSchema,
  TimeEntryListResponseSchema,
  TimeExportInputSchema,
  ExternalPayrollSheetInputSchema,
  TimesheetWeekInputSchema,
  TimesheetAssociateDetailInputSchema,
  TimeRejectInputSchema,
  ClockInRequestDenyInputSchema,
  ClockInRequestListResponseSchema,
  type ActiveDashboardEntry,
  type ActiveTimeEntryResponse,
  type BulkTimeResponse,
  type BulkTimeResultRow,
  type TimeAnomaly,
  type TimeEntry,
  type TimeEntryListResponse,
} from '@alto-people/shared';
import { csvCell as sharedCsvCell } from '@alto-people/shared';
import { prisma } from '../db.js';
import { bulkPiiExportLimiter } from '../middleware/rateLimit.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeTimeEntries, scopeShifts, effectiveClientIdFilter } from '../lib/scope.js';
import { runWithConcurrency } from '../lib/concurrency.js';
import { z } from 'zod';
import { enqueueAudit, recordTimeEvent, recordCriticalAudit } from '../lib/audit.js';
import { buildExternalPayrollSheet } from '../lib/externalPayrollSheet.js';
import { renderExternalPayrollSheetXlsx } from '../lib/externalPayrollSheetXlsx.js';
import { renderExternalPayrollSheetPdf } from '../lib/externalPayrollSheetPdf.js';
import { recomputeEntryAnomalies } from '../lib/recomputeEntryAnomalies.js';
import { checkGeofence } from '../lib/geo.js';
import { resolveAssociateGeofence } from '../lib/geofenceForAssociate.js';
import { matchShiftForPunch } from '../lib/matchShiftForPunch.js';
import { notifyAssociate } from '../lib/notify.js';
import { DEFAULT_TIMEZONE, formatDateInZone, formatTimeInZone, localDateKey } from '../lib/timezone.js';
import {
  detectAnomalies,
  endOfWeekUTC,
  netWorkedMinutes,
  startOfWeekUTC,
} from '../lib/timeAnomalies.js';
import {
  accrueSickLeaveForEntry,
  reverseSickLeaveForEntry,
} from '../lib/timeOffAccrual.js';
import { renderTimeReportPdf } from '../lib/timeReport.js';
import {
  buildPayrollSheet,
  type PayrollSheetInputRow,
} from '../lib/payrollSheet.js';
import {
  attachEarnings,
  type AssociatePayInfo,
} from '../lib/payrollSheetPay.js';
import { aggregatePayrollProjection } from '../lib/payrollAggregator.js';
import { renderPayrollSheetPdf } from '../lib/payrollSheetPdf.js';
import { renderPayrollSheetXlsx } from '../lib/payrollSheetXlsx.js';
import { listPayPeriods } from '../lib/payPeriods.js';
import {
  buildTimesheetWeek,
  buildAssociateTimesheetDetail,
  fileTimesheetWeek,
} from '../lib/timesheetWeek.js';
import { renderTimesheetXlsx, timesheetFilename } from '../lib/timesheetXlsx.js';

export const timeRouter = Router();

const MANAGE = requireCapability('manage:time');

type RawEntry = Prisma.TimeEntryGetPayload<{
  include: {
    associate: { select: { firstName: true; lastName: true } };
    approvedBy: { select: { email: true } };
    job: { select: { name: true } };
    breaks: true;
    shift: { select: { startsAt: true; endsAt: true; position: true } };
    location: { select: { timezone: true } };
  };
}>;

const ENTRY_INCLUDE = {
  associate: { select: { firstName: true, lastName: true } },
  approvedBy: { select: { email: true } },
  job: { select: { name: true } },
  breaks: true,
  shift: { select: { startsAt: true, endsAt: true, position: true } },
  // The worksite's clock, threaded to the client so punch times render in
  // the SITE zone rather than the reviewer's browser zone.
  location: { select: { timezone: true } },
} as const;

/**
 * Tell the associate their hours were decided. Rejections are
 * pay-affecting and were previously SILENT — the associate found out on
 * payday. Fire-and-forget (never fails the decision); bell + email +
 * push via the shared pipeline.
 */
function notifyEntryDecision(
  entry: { associateId: string; clockInAt: Date; clockOutAt: Date | null },
  decision:
    | { kind: 'approved'; minutes: number }
    | { kind: 'rejected'; reason: string },
): void {
  const tz = DEFAULT_TIMEZONE;
  const day = formatDateInZone(entry.clockInAt, tz);
  const range = `${formatTimeInZone(entry.clockInAt, tz)}–${
    entry.clockOutAt ? formatTimeInZone(entry.clockOutAt, tz) : '…'
  }`;
  if (decision.kind === 'approved') {
    void notifyAssociate(entry.associateId, {
      subject: 'Hours approved',
      body: `Your ${day} time entry (${range}) was approved — ${(decision.minutes / 60).toFixed(1)}h.`,
      category: 'time_entry',
      linkUrl: '/time-attendance',
    });
  } else {
    void notifyAssociate(entry.associateId, {
      subject: 'Time entry rejected',
      body: `Your ${day} time entry (${range}) was rejected: "${decision.reason}". Talk to your manager if this looks wrong.`,
      category: 'time_entry',
      linkUrl: '/time-attendance',
    });
  }
}

function minutesElapsed(row: { clockInAt: Date; clockOutAt: Date | null }): number {
  const end = row.clockOutAt ?? new Date();
  return Math.max(0, Math.floor((end.getTime() - row.clockInAt.getTime()) / 60_000));
}

// Recompute a completed entry's anomalies. Weekly-overtime detection needs
// the rest of the associate's week, so we sum it here (excluding this entry)
// exactly as the clock-out path does. Used by the admin create/edit routes.
async function recomputeAnomalies(params: {
  associateId: string;
  excludeEntryId: string | null;
  clockInAt: Date;
  clockOutAt: Date;
  breaks: { type: BreakType; startedAt: Date; endedAt: Date | null }[];
  state: string | null;
  geofenceInOk: boolean | null;
  geofenceOutOk: boolean | null;
  /** Linked shift window, when the entry has one — drives
   *  EARLY_OUT / OUTSIDE_SHIFT_WINDOW. */
  matchedShift?: { startsAt: Date; endsAt: Date } | null;
}): Promise<TimeAnomaly[]> {
  const weekStart = startOfWeekUTC(params.clockInAt);
  const weekEnd = endOfWeekUTC(params.clockInAt);
  const weekly = await prisma.timeEntry.findMany({
    take: 100,
    where: {
      associateId: params.associateId,
      clockInAt: { gte: weekStart, lt: weekEnd },
      ...(params.excludeEntryId ? { id: { not: params.excludeEntryId } } : {}),
    },
    include: { breaks: true },
  });
  const weeklySoFar = weekly.reduce(
    (sum, e) => sum + netWorkedMinutes(e, e.breaks),
    0,
  );
  const thisMinutes = netWorkedMinutes(
    { clockInAt: params.clockInAt, clockOutAt: params.clockOutAt },
    params.breaks,
  );
  return detectAnomalies({
    entry: {
      clockInAt: params.clockInAt,
      clockOutAt: params.clockOutAt,
      geofenceInOk: params.geofenceInOk,
      geofenceOutOk: params.geofenceOutOk,
    },
    breaks: params.breaks.map((b) => ({
      type: b.type,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
    })),
    weeklyMinutesIncludingThis: weeklySoFar + thisMinutes,
    matchedShift: params.matchedShift ?? undefined,
    state: params.state,
  });
}

async function loadClientName(clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
  return c?.name ?? null;
}

// TimeEntry.clientId is denormalized without a Prisma relation, so client
// names need their own lookup. For LISTS, do it once per request — toEntry
// used to run loadClientName PER ROW, turning a 500-row admin list into
// ~501 queries and a 5000-row export into ~5001.
async function clientNameMap(
  rows: Array<{ clientId: string | null }>,
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.clientId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const clients = await prisma.client.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(clients.map((c) => [c.id, c.name]));
}

async function toEntries(rows: RawEntry[]): Promise<TimeEntry[]> {
  const names = await clientNameMap(rows);
  return rows.map((row) =>
    buildEntry(row, row.clientId ? (names.get(row.clientId) ?? null) : null),
  );
}

async function toEntry(row: RawEntry): Promise<TimeEntry> {
  return buildEntry(row, await loadClientName(row.clientId));
}

function buildEntry(row: RawEntry, clientName: string | null): TimeEntry {
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    clientId: row.clientId,
    clientName,
    clockInAt: row.clockInAt.toISOString(),
    clockOutAt: row.clockOutAt ? row.clockOutAt.toISOString() : null,
    status: row.status,
    notes: row.notes,
    rejectionReason: row.rejectionReason,
    approvedById: row.approvedById,
    approverEmail: row.approvedBy?.email ?? null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    minutesElapsed: minutesElapsed(row),
    locationTimezone: row.location?.timezone ?? null,
    jobId: row.jobId,
    jobName: row.job?.name ?? null,
    payRate: row.payRate ? Number(row.payRate) : null,
    clockInLat: row.clockInLat ? Number(row.clockInLat) : null,
    clockInLng: row.clockInLng ? Number(row.clockInLng) : null,
    clockOutLat: row.clockOutLat ? Number(row.clockOutLat) : null,
    clockOutLng: row.clockOutLng ? Number(row.clockOutLng) : null,
    anomalies: Array.isArray(row.anomalies) ? (row.anomalies as string[]) : [],
    // Punch↔shift link — lets reviewers compare actual vs scheduled
    // (late chip, coverage reconciliation) without a second fetch.
    shiftId: row.shiftId,
    shiftStartsAt: row.shift?.startsAt ? row.shift.startsAt.toISOString() : null,
    shiftEndsAt: row.shift?.endsAt ? row.shift.endsAt.toISOString() : null,
    shiftPosition: row.shift?.position ?? null,
    // Server-derived so the clock widget survives a refresh mid-break
    // (the UI used to track this in component state and forget it).
    onBreak:
      row.status === 'ACTIVE' && row.breaks.some((b) => b.endedAt === null),
    // Net-of-breaks worked time — what payroll/OT/accrual actually use.
    // Reviewers approving the gross figure (minutesElapsed) couldn't see
    // why payroll paid less.
    netMinutes: netWorkedMinutes(
      { clockInAt: row.clockInAt, clockOutAt: row.clockOutAt },
      row.breaks,
    ),
    breaks: row.breaks.map((b) => {
      const end = b.endedAt ?? row.clockOutAt ?? new Date();
      return {
        id: b.id,
        type: b.type,
        startedAt: b.startedAt.toISOString(),
        endedAt: b.endedAt ? b.endedAt.toISOString() : null,
        minutes: Math.max(
          0,
          Math.floor((end.getTime() - b.startedAt.getTime()) / 60_000),
        ),
      };
    }),
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

// Display cap for an associate's own history.
const ME_ENTRY_CAP = 200;

timeRouter.get('/me/entries', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      const payload: TimeEntryListResponse = { entries: [] };
      res.json(payload);
      return;
    }
    // Phase 65 — date range. When neither from nor to is supplied we keep
    // the old "recent activity" behavior: last 30 days, capped at 200 rows.
    const fromStr = req.query.from?.toString();
    const toStr = req.query.to?.toString();
    const hasRange = !!fromStr || !!toStr;
    const defaultFrom = hasRange ? null : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await prisma.timeEntry.findMany({
      where: {
        associateId: user.associateId,
        ...(hasRange
          ? {
              clockInAt: {
                ...(fromStr ? { gte: new Date(fromStr) } : {}),
                ...(toStr ? { lt: new Date(toStr) } : {}),
              },
            }
          : defaultFrom
            ? { clockInAt: { gte: defaultFrom } }
            : {}),
      },
      orderBy: { clockInAt: 'desc' },
      // +1 probe: fetch one past the display cap so we can TELL the caller
      // the list was cut rather than presenting a partial history as
      // complete. The admin sibling has always done this.
      take: ME_ENTRY_CAP + 1,
      include: ENTRY_INCLUDE,
    });
    const truncated = rows.length > ME_ENTRY_CAP;
    const entries = await toEntries(rows.slice(0, ME_ENTRY_CAP));
    const payload = TimeEntryListResponseSchema.parse({ entries, truncated });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Hourly associates clock in via the kiosk (PIN + selfie) at the worksite —
// not from their personal phones. The web/app /me/clock-in path is for
// managers and other salaried roles whose time we still track.
type SelfClockUser = NonNullable<Express.Request['user']>;
function assertCanSelfClock(
  user: SelfClockUser,
): asserts user is SelfClockUser & { associateId: string } {
  if (user.role === 'ASSOCIATE') {
    throw new HttpError(
      403,
      'use_kiosk',
      'Hourly associates clock in at the worksite kiosk with their 4-digit PIN. The clock-in/out buttons in the web app are reserved for managers.',
    );
  }
  if (!user.associateId) {
    throw new HttpError(
      403,
      'no_associate_record',
      'Your user account is not linked to an associate record yet — ask HR to provision one before you can clock in.',
    );
  }
}

timeRouter.post('/me/clock-in', async (req, res, next) => {
  try {
    const user = req.user!;
    assertCanSelfClock(user);
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

    // Phase 131 — resolve geofence from the associate's open
    // AssociateAssignment's Location first, falling back to the
    // legacy Client geofence. Same helper stamps locationId onto
    // the new TimeEntry so historical reports stay correct.
    const resolved = await resolveAssociateGeofence(
      prisma,
      user.associateId,
      clientId,
    );
    if (resolved.clientId && !clientId) clientId = resolved.clientId;
    const geofenceResult = checkGeofence(resolved.geofence, geo ?? null);
    const geofenceOk: boolean | null = geofenceResult.inside;

    const clockInAt = new Date();
    const shiftId = await matchShiftForPunch(prisma, user.associateId, clockInAt);

    let entry;
    try {
      entry = await prisma.timeEntry.create({
        data: {
          associateId: user.associateId,
          clientId,
          locationId: resolved.locationId,
          jobId: jobId ?? null,
          shiftId,
          clockInAt,
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
    assertCanSelfClock(user);
    const parsed = ClockOutInputV2Schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { notes, geo } = parsed.data;

    const active = await prisma.timeEntry.findFirst({
      where: { associateId: user.associateId, status: 'ACTIVE' },
      include: {
        breaks: true,
        associate: { select: { state: true } },
        shift: { select: { startsAt: true, endsAt: true } },
      },
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

    // Geofence check on clock-out coords. Same Phase 131 resolution
    // as clock-in: open Location first, Client fallback.
    const resolvedOut = await resolveAssociateGeofence(
      prisma,
      active.associateId,
      active.clientId,
    );
    const geofenceOutOk: boolean | null = checkGeofence(
      resolvedOut.geofence,
      geo ?? null,
    ).inside;

    // Sum weekly worked minutes (ACTIVE+COMPLETED+APPROVED) for OT detection,
    // excluding the current entry (we'll add it back with the about-to-be net).
    const weekStart = startOfWeekUTC(active.clockInAt);
    const weekEnd = endOfWeekUTC(active.clockInAt);
    const weeklyEntries = await prisma.timeEntry.findMany({
      take: 100,
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
      // Punch↔shift link: enables EARLY_OUT / OUTSIDE_SHIFT_WINDOW
      // against the scheduled window.
      matchedShift: active.shift ?? undefined,
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
    assertCanSelfClock(user);
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
    assertCanSelfClock(user);
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
    // Tenant clamp FIRST (same bug class as scheduling /shifts): spreading
    // the raw query param after scopeTimeEntries would let a bounded
    // caller (SHIFT_SUPERVISOR holds manage:time) override the clamp's
    // clientId key and watch any client's live floor. null (bounded, no
    // client on file) maps to undefined so the scope's fail-closed
    // NO_CLIENT clamp stays in charge.
    const clientId =
      effectiveClientIdFilter(req.user!, req.query.clientId?.toString()) ??
      undefined;
    const locationId = req.query.locationId?.toString();
    const where: Prisma.TimeEntryWhereInput = {
      ...scopeTimeEntries(req.user!),
      status: 'ACTIVE',
      ...(clientId ? { clientId } : {}),
      ...(locationId ? { locationId } : {}),
    };
    const rows = await prisma.timeEntry.findMany({
      take: 100,
      where,
      orderBy: { clockInAt: 'asc' },
      include: {
        associate: { select: { firstName: true, lastName: true } },
        job: { select: { name: true } },
        breaks: { where: { endedAt: null } },
        // Matched shift bounds — the live board's shift-window filter
        // groups on these the same way the approval queue does.
        shift: { select: { startsAt: true, endsAt: true } },
      },
    });
    const clientIds = Array.from(new Set(rows.map((r) => r.clientId).filter(Boolean) as string[]));
    const locationIds = Array.from(
      new Set(rows.map((r) => r.locationId).filter(Boolean) as string[]),
    );
    const [clients, locations] = await Promise.all([
      // Client name only — geofence moved to Location in Phase 131.
      prisma.client.findMany({
        take: 1000,
        where: { id: { in: clientIds } },
        select: { id: true, name: true },
      }),
      // Phase 131 — Location geofence is the source. Rows without a
      // stamped locationId (pre-Phase-131 history) get no geofence
      // check on the dashboard; it'll show as "?" rather than green/red.
      prisma.location.findMany({
        take: 1000,
        where: { id: { in: locationIds } },
        select: { id: true, latitude: true, longitude: true, geofenceRadiusMeters: true, timezone: true },
      }),
    ]);
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const locationById = new Map(locations.map((l) => [l.id, l]));

    const now = Date.now();
    const entries: ActiveDashboardEntry[] = rows.map((r) => {
      const c = r.clientId ? clientById.get(r.clientId) : undefined;
      const l = r.locationId ? locationById.get(r.locationId) : undefined;
      let geofenceOk: boolean | null = null;
      if (l) {
        const result = checkGeofence(
          {
            latitude: l.latitude ? Number(l.latitude) : null,
            longitude: l.longitude ? Number(l.longitude) : null,
            radiusMeters: l.geofenceRadiusMeters,
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
        locationTimezone: l?.timezone ?? null,
        shiftStartsAt: r.shift?.startsAt ? r.shift.startsAt.toISOString() : null,
        shiftEndsAt: r.shift?.endsAt ? r.shift.endsAt.toISOString() : null,
      };
    });
    res.json(ActiveDashboardResponseSchema.parse({ entries }));
  } catch (err) {
    next(err);
  }
});

/* ===== HR/Ops (/admin) =================================================== */

/**
 * Free-text associate-name filter, shared by the admin queue and the exports
 * so a narrowed screen and its download can't disagree.
 *
 * Per-term AND across (first OR last) so a full-name search works: "Maria
 * Lopez" → Maria must hit first/last AND Lopez must hit first/last. A single
 * OR over the whole string matched neither field and returned nothing.
 *
 * Returns clauses rather than a `{ AND: [...] }` object: callers merge these
 * with other clause producers into one AND array. Two helpers each spreading
 * their own `AND` key into the same where object would silently drop the
 * first — object spread keeps only the last.
 */
function associateNameSearchClauses(
  search: string | undefined,
): Prisma.TimeEntryWhereInput[] {
  const trimmed = search?.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).map((term) => ({
    associate: {
      OR: [
        { firstName: { contains: term, mode: 'insensitive' as const } },
        { lastName: { contains: term, mode: 'insensitive' as const } },
      ],
    },
  }));
}

/**
 * "Anomalies only" — entries carrying at least one flag (missed punch,
 * geofence violation, forgotten clock-out…).
 *
 * `anomalies` is a stored `Json?` column, so this is a real query rather than
 * a post-filter: the export can apply it across the whole range instead of
 * only the page the screen happened to fetch. Both the SQL NULL (older rows
 * predating the column) and the empty array have to be excluded.
 */
function anomaliesOnlyClauses(on: boolean | undefined): Prisma.TimeEntryWhereInput[] {
  if (!on) return [];
  return [
    { anomalies: { not: Prisma.DbNull } },
    { NOT: { anomalies: { equals: [] } } },
  ];
}

// Selectable pay-period windows for the review picker — derived from the
// active payroll schedule's cadence plus actual run history.
timeRouter.get('/admin/pay-periods', MANAGE, async (_req, res, next) => {
  try {
    const periods = await listPayPeriods(prisma);
    res.json(PayPeriodListResponseSchema.parse({ periods }));
  } catch (err) {
    next(err);
  }
});

// Cheap COUNT for the "Pending review" KPI — the UI used to fetch up to
// 500 full rows (serializer and all) just to read .length, and the KPI
// could never show more than the cap.
timeRouter.get('/admin/entries/count', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    // Optional client/site scoping so the pending-review badge can follow
    // the page's filters — an org-wide "47 pending" over a client-filtered
    // queue showing 3 read as a bug. Deliberately still all-time: the KPI
    // is the total backlog, not the visible date window. Clamped (tenant
    // clamp FIRST) — the spread below would let a bounded caller override
    // scopeTimeEntries' clientId key.
    const clientId =
      effectiveClientIdFilter(req.user!, req.query.clientId?.toString()) ??
      undefined;
    const locationId = req.query.locationId?.toString();
    const count = await prisma.timeEntry.count({
      where: {
        ...scopeTimeEntries(req.user!),
        ...(status ? { status: status as Prisma.TimeEntryWhereInput['status'] } : {}),
        ...(clientId ? { clientId } : {}),
        ...(locationId ? { locationId } : {}),
      },
    });
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

timeRouter.get('/admin/entries', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const associateId = req.query.associateId?.toString();
    // Tenant clamp FIRST — the spread below would let a bounded caller
    // override scopeTimeEntries' clientId key and read any client's queue.
    const clientId =
      effectiveClientIdFilter(req.user!, req.query.clientId?.toString()) ??
      undefined;
    // Narrow to one work-site within the client (cascading filter, same
    // as scheduling). locationId is denormalized on TimeEntry.
    const locationId = req.query.locationId?.toString();
    // Phase 65 — date range + free-text associate search.
    const fromStr = req.query.from?.toString();
    const toStr = req.query.to?.toString();
    const search = req.query.search?.toString().trim();

    const where: Prisma.TimeEntryWhereInput = {
      ...scopeTimeEntries(req.user!),
      ...(status ? { status: status as Prisma.TimeEntryWhereInput['status'] } : {}),
      ...(associateId ? { associateId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(fromStr || toStr
        ? {
            clockInAt: {
              ...(fromStr ? { gte: new Date(fromStr) } : {}),
              ...(toStr ? { lt: new Date(toStr) } : {}),
            },
          }
        : {}),
      AND: associateNameSearchClauses(search),
    };

    // Fetch cap+1 so the response can SAY it was cut — a partial list that
    // looks complete silently breaks "select all → bulk approve".
    const PAGE_CAP = 500;
    const rows = await prisma.timeEntry.findMany({
      where,
      orderBy: { clockInAt: 'desc' },
      take: PAGE_CAP + 1,
      include: ENTRY_INCLUDE,
    });
    const truncated = rows.length > PAGE_CAP;
    const page = truncated ? rows.slice(0, PAGE_CAP) : rows;
    const entries = await toEntries(page);
    const payload = TimeEntryListResponseSchema.parse({ entries, truncated });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/* ===== Attendance points ================================================= *
 * Rolling 90-day reliability score. Events auto-accrue from the kiosk
 * clock-out hook and the no-show sweep (lib/attendance.ts); these routes
 * read the record and let supervisors excuse an event (attributed,
 * points zeroed at read time, row kept for the audit trail).
 * ========================================================================= */

function toAttendanceEvent(r: {
  id: string;
  associateId: string;
  shiftId: string | null;
  kind: string;
  points: unknown;
  occurredOn: Date;
  source: string;
  note: string | null;
  excusedAt: Date | null;
  excusedBy: { email: string } | null;
}) {
  return {
    id: r.id,
    associateId: r.associateId,
    shiftId: r.shiftId,
    kind: r.kind,
    points: Number(r.points),
    occurredOn: r.occurredOn.toISOString().slice(0, 10),
    source: r.source,
    note: r.note,
    excused: r.excusedAt !== null,
    excusedByEmail: r.excusedBy?.email ?? null,
  };
}

timeRouter.get('/admin/attendance', MANAGE, async (req, res, next) => {
  try {
    const associateId = req.query.associateId?.toString();
    if (!associateId) {
      throw new HttpError(400, 'invalid_query', 'associateId is required');
    }
    // Tenant clamp: bounded callers only see events at their own client.
    const clamp = clockInRequestClientClamp(req.user!);
    const rows = await prisma.attendanceEvent.findMany({
      where: {
        associateId,
        ...clamp,
        // Show half a year of history; the score below still uses 90 days.
        occurredOn: { gte: new Date(Date.now() - 180 * 24 * 3_600_000) },
      },
      orderBy: { occurredOn: 'desc' },
      take: 200,
      include: { excusedBy: { select: { email: true } } },
    });
    const inWindow = rows.filter(
      (r) =>
        r.excusedAt === null &&
        r.occurredOn >= new Date(Date.now() - 90 * 24 * 3_600_000),
    );
    res.json({
      events: rows.map(toAttendanceEvent),
      score: inWindow.reduce((s, r) => s + Number(r.points), 0),
      windowDays: 90,
    });
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/admin/attendance/:id/excuse', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : null;
    const clamp = clockInRequestClientClamp(user);
    const event = await prisma.attendanceEvent.findFirst({
      where: { id: req.params.id, ...clamp },
    });
    if (!event) throw new HttpError(404, 'not_found', 'Attendance event not found.');
    if (event.excusedAt) {
      throw new HttpError(409, 'already_excused', 'This event was already excused.');
    }
    await prisma.attendanceEvent.update({
      where: { id: event.id },
      data: {
        excusedById: user.id,
        excusedAt: new Date(),
        ...(note ? { note: event.note ? `${event.note} — ${note}` : note } : {}),
      },
    });
    enqueueAudit(
      {
        actorUserId: user.id,
        clientId: event.clientId,
        action: 'time.attendance_excused',
        entityType: 'AttendanceEvent',
        entityId: event.id,
        metadata: { associateId: event.associateId, kind: event.kind, note },
      },
      'time.attendance_excused',
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ===== Walk-in clock-in requests (schedule gate) ========================= *
 * Kiosk punches the schedule gate refused, parked for a decision. Approval
 * clocks the associate in from the ORIGINAL punch instant; denial notifies
 * them. Mirrors the shift-swap decision flow; MANAGE (manage:time) reaches
 * SHIFT_SUPERVISOR, clamped to their own client below.
 * ========================================================================= */

// Fail-closed sentinel for a bounded caller with no client on file.
const NO_CLIENT_SENTINEL = '00000000-0000-0000-0000-000000000000';

function clockInRequestClientClamp(user: NonNullable<Express.Request['user']>) {
  const clamped = effectiveClientIdFilter(user, undefined);
  if (clamped === null) return { clientId: NO_CLIENT_SENTINEL };
  return clamped ? { clientId: clamped } : {};
}

// Approving a stale request would materialize an ACTIVE entry that has
// silently accrued for hours (or days). Past this window the honest tool
// is a manual time entry with explicit in/out times.
const CLOCK_IN_REQUEST_MAX_AGE_MS = 14 * 3_600_000;

timeRouter.get('/admin/clock-in-requests', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString() ?? 'PENDING';
    if (!['PENDING', 'APPROVED', 'DENIED', 'ALL'].includes(status)) {
      throw new HttpError(400, 'invalid_query', 'status must be PENDING | APPROVED | DENIED | ALL');
    }
    const rows = await prisma.clockInRequest.findMany({
      where: {
        ...clockInRequestClientClamp(req.user!),
        ...(status === 'ALL' ? {} : { status: status as 'PENDING' | 'APPROVED' | 'DENIED' }),
      },
      orderBy: { requestedAt: 'desc' },
      take: 200,
      include: {
        associate: { select: { firstName: true, lastName: true } },
        decidedBy: { select: { email: true } },
      },
    });
    const clientIds = [...new Set(rows.map((r) => r.clientId))];
    const locationIds = [
      ...new Set(rows.map((r) => r.locationId).filter((id): id is string => !!id)),
    ];
    const [clients, locations] = await Promise.all([
      prisma.client.findMany({
        where: { id: { in: clientIds } },
        select: { id: true, name: true },
      }),
      prisma.location.findMany({
        where: { id: { in: locationIds } },
        select: { id: true, name: true },
      }),
    ]);
    const clientName = new Map(clients.map((c) => [c.id, c.name]));
    const locationName = new Map(locations.map((l) => [l.id, l.name]));
    res.json(
      ClockInRequestListResponseSchema.parse({
        requests: rows.map((r) => ({
          id: r.id,
          associateId: r.associateId,
          associateName: `${r.associate.firstName} ${r.associate.lastName}`,
          clientId: r.clientId,
          clientName: clientName.get(r.clientId) ?? null,
          locationId: r.locationId,
          locationName: r.locationId ? locationName.get(r.locationId) ?? null : null,
          requestedAt: r.requestedAt.toISOString(),
          status: r.status,
          decidedAt: r.decidedAt?.toISOString() ?? null,
          deciderEmail: r.decidedBy?.email ?? null,
          denyReason: r.denyReason,
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/admin/clock-in-requests/:id/approve', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const request = await prisma.clockInRequest.findFirst({
      where: { id: req.params.id, ...clockInRequestClientClamp(user) },
    });
    if (!request) {
      throw new HttpError(404, 'not_found', 'Clock-in request not found.');
    }
    if (request.status !== 'PENDING') {
      throw new HttpError(409, 'already_decided', 'This request was already decided.');
    }
    if (Date.now() - request.requestedAt.getTime() > CLOCK_IN_REQUEST_MAX_AGE_MS) {
      throw new HttpError(
        409,
        'too_old',
        'This request is too old to approve — the entry would have been running for hours. Add a manual time entry with explicit times instead.',
      );
    }
    const open = await prisma.timeEntry.findFirst({
      where: { associateId: request.associateId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (open) {
      throw new HttpError(
        409,
        'already_clocked_in',
        'This associate is already clocked in — nothing to approve.',
      );
    }

    const entry = await prisma.$transaction(async (tx) => {
      const created = await tx.timeEntry.create({
        data: {
          associateId: request.associateId,
          clientId: request.clientId,
          locationId: request.locationId,
          // Backdated to the refused punch — waiting on the decision never
          // shorts the associate. Re-match in case the supervisor also
          // scheduled them since.
          shiftId: await matchShiftForPunch(tx, request.associateId, request.requestedAt),
          clockInAt: request.requestedAt,
          status: 'ACTIVE',
        },
      });
      await tx.clockInRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          decidedById: user.id,
          decidedAt: new Date(),
          timeEntryId: created.id,
        },
      });
      return created;
    });

    await recordTimeEvent({
      actorUserId: user.id,
      action: 'time.clock_in_request_approved',
      timeEntryId: entry.id,
      associateId: request.associateId,
      metadata: { clockInRequestId: request.id, backdatedTo: request.requestedAt.toISOString() },
      req,
    });
    void notifyAssociate(request.associateId, {
      subject: "You're clocked in",
      body: `Your supervisor approved your clock-in — you are on the clock as of ${formatTimeInZone(request.requestedAt, DEFAULT_TIMEZONE)}. No need to punch again; clock out at the kiosk as usual.`,
      category: 'time_entry',
      linkUrl: '/time-attendance',
    });
    res.json({ ok: true, timeEntryId: entry.id });
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/admin/clock-in-requests/:id/deny', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = ClockInRequestDenyInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const request = await prisma.clockInRequest.findFirst({
      where: { id: req.params.id, ...clockInRequestClientClamp(user) },
    });
    if (!request) {
      throw new HttpError(404, 'not_found', 'Clock-in request not found.');
    }
    if (request.status !== 'PENDING') {
      throw new HttpError(409, 'already_decided', 'This request was already decided.');
    }
    await prisma.clockInRequest.update({
      where: { id: request.id },
      data: {
        status: 'DENIED',
        decidedById: user.id,
        decidedAt: new Date(),
        denyReason: parsed.data.reason?.trim() || null,
      },
    });
    enqueueAudit(
      {
        actorUserId: user.id,
        clientId: request.clientId,
        action: 'time.clock_in_request_denied',
        entityType: 'ClockInRequest',
        entityId: request.id,
        metadata: {
          associateId: request.associateId,
          reason: parsed.data.reason ?? null,
        },
      },
      'time.clock_in_request_denied',
    );
    void notifyAssociate(request.associateId, {
      subject: 'Clock-in not approved',
      body: `Your supervisor did not approve your clock-in${parsed.data.reason ? `: "${parsed.data.reason.trim()}"` : ''}. Talk to them if this looks wrong.`,
      category: 'time_entry',
      linkUrl: '/time-attendance',
    });
    res.json({ ok: true });
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

    notifyEntryDecision(updated, {
      kind: 'approved',
      minutes: netWorkedMinutes(updated, updated.breaks),
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

    // Rejecting a previously-APPROVED entry voids a shift whose sick-leave
    // accrual already posted — pull those minutes back out of the balance.
    const reversal =
      existing.status === 'APPROVED'
        ? await reverseSickLeaveForEntry(prisma, existing.id)
        : { reversed: false, minutes: 0 };

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
      metadata: {
        reason: parsed.data.reason,
        ...(reversal.reversed
          ? { sickAccrualReversedMinutes: reversal.minutes }
          : {}),
      },
      req,
    });

    notifyEntryDecision(updated, { kind: 'rejected', reason: parsed.data.reason });

    res.json(await toEntry(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== Admin clock-in/out + edit on behalf of an associate ============= */

// Create an entry for an associate — HR fixes a missed kiosk punch or logs
// a shift after the fact. No clockOutAt → an ACTIVE entry ("clock them in",
// bypassing the kiosk-only rule since this is admin-initiated); with one →
// a COMPLETED shift. Anomalies computed for completed entries.
timeRouter.post('/admin/entries', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = AdminCreateTimeEntryInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { associateId, jobId, notes } = parsed.data;
    const clockInAt = new Date(parsed.data.clockInAt);
    const clockOutAt = parsed.data.clockOutAt ? new Date(parsed.data.clockOutAt) : null;
    if (clockOutAt && clockOutAt.getTime() <= clockInAt.getTime()) {
      throw new HttpError(400, 'invalid_range', 'Clock-out must be after clock-in.');
    }

    const associate = await prisma.associate.findUnique({
      where: { id: associateId },
      select: { id: true, state: true },
    });
    if (!associate) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found.');
    }

    let clientId: string | null = null;
    let payRate: number | null = null;
    if (jobId) {
      const job = await prisma.job.findFirst({
        where: { id: jobId, deletedAt: null, isActive: true },
      });
      if (!job) throw new HttpError(404, 'job_not_found', 'Job not found or inactive');
      clientId = job.clientId;
      payRate = job.payRate ? Number(job.payRate) : null;
    }
    // Explicit rate wins over the job-derived one (recorded on the entry for
    // reporting; payroll pays from the shift/comp record).
    if (parsed.data.payRate !== undefined) payRate = parsed.data.payRate;
    // Resolve client/location from the associate's open assignment when no
    // job pinned it, so the entry is denormalized the same as a self/kiosk
    // clock-in (history + scoping stay correct).
    const resolved = await resolveAssociateGeofence(prisma, associateId, clientId);
    if (resolved.clientId && !clientId) clientId = resolved.clientId;

    // Client-bounded roles (SHIFT_SUPERVISOR) can only add time tied to their
    // own client — the entry's resolved clientId must match theirs.
    const bounded = effectiveClientIdFilter(user, undefined);
    if (bounded !== undefined && clientId !== bounded) {
      throw new HttpError(403, 'forbidden', 'You can only add time for your assigned client.');
    }

    const status: 'ACTIVE' | 'COMPLETED' = clockOutAt ? 'COMPLETED' : 'ACTIVE';
    const anomalies: TimeAnomaly[] = clockOutAt
      ? await recomputeAnomalies({
          associateId,
          excludeEntryId: null,
          clockInAt,
          clockOutAt,
          breaks: [],
          state: associate.state ?? null,
          geofenceInOk: null,
          geofenceOutOk: null,
        })
      : [];

    let entry;
    try {
      entry = await prisma.timeEntry.create({
        data: {
          associateId,
          clientId,
          locationId: resolved.locationId,
          jobId: jobId ?? null,
          clockInAt,
          clockOutAt,
          payRate,
          notes: notes ?? null,
          status,
          anomalies,
        },
        include: ENTRY_INCLUDE,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(
          409,
          'already_clocked_in',
          'That associate already has an open (active) entry — clock them out or edit it instead.',
        );
      }
      throw err;
    }

    await recordTimeEvent({
      actorUserId: user.id,
      action: 'time.admin_created',
      timeEntryId: entry.id,
      associateId: entry.associateId,
      clientId: entry.clientId,
      metadata: { onBehalf: true, status, hasClockOut: !!clockOutAt, jobId: jobId ?? null },
      req,
    });

    res.status(201).json(await toEntry(entry));
  } catch (err) {
    next(err);
  }
});

// Edit an entry: fix clock times, re-tag a job, attach notes, or clock an
// associate out (supply clockOutAt on an ACTIVE entry → it becomes
// COMPLETED). APPROVED entries are editable too — payroll corrections
// surface days later ("the kiosk clock was wrong all Tuesday") and the
// old reject→edit→re-approve dance left a misleading REJECTED event in
// the audit trail. Editing an approved entry keeps it APPROVED, reverses
// and re-accrues its sick leave from the corrected hours, and notifies
// the associate (their approved pay basis just changed).
timeRouter.patch('/admin/entries/:id', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = AdminEditTimeEntryInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }

    const existing = await prisma.timeEntry.findFirst({
      where: { id: req.params.id, ...scopeTimeEntries(user) },
      include: { breaks: true, associate: { select: { state: true } } },
    });
    if (!existing) {
      throw new HttpError(404, 'time_entry_not_found', 'Time entry not found');
    }

    const clockInAt = parsed.data.clockInAt
      ? new Date(parsed.data.clockInAt)
      : existing.clockInAt;
    const clockOutAt =
      parsed.data.clockOutAt !== undefined
        ? parsed.data.clockOutAt
          ? new Date(parsed.data.clockOutAt)
          : null
        : existing.clockOutAt;
    if (clockOutAt && clockOutAt.getTime() <= clockInAt.getTime()) {
      throw new HttpError(400, 'invalid_range', 'Clock-out must be after clock-in.');
    }
    // A non-ACTIVE entry must keep a clock-out — don't let an edit strip it
    // and leave a "completed" row with no end time.
    if (!clockOutAt && existing.status !== 'ACTIVE') {
      throw new HttpError(
        400,
        'clockout_required',
        'A completed entry must keep a clock-out time.',
      );
    }

    // Supplying a clock-out on an ACTIVE entry = admin clocking them out.
    const becomingCompleted = existing.status === 'ACTIVE' && !!clockOutAt;
    const status = becomingCompleted ? 'COMPLETED' : existing.status;

    // Approved-entry corrections: the hours changing means the posted
    // sick-leave accrual is stale — pull it back out before the update
    // and re-accrue from the corrected times after (same reverse/accrue
    // cycle the reject→re-approve path uses, proven cycle-safe).
    const timesChanged =
      clockInAt.getTime() !== existing.clockInAt.getTime() ||
      (clockOutAt?.getTime() ?? null) !== (existing.clockOutAt?.getTime() ?? null);
    const approvedCorrection = existing.status === 'APPROVED' && timesChanged;
    if (approvedCorrection) {
      await reverseSickLeaveForEntry(prisma, existing.id);
    }

    // Clocking out an ACTIVE entry must close any still-open break — same as
    // self clock-out. Otherwise the break stays open on a COMPLETED row and
    // netWorkedMinutes counts it as running to "now", skewing paid time.
    const openBreak = becomingCompleted
      ? existing.breaks.find((b) => !b.endedAt)
      : undefined;
    if (openBreak && clockOutAt) {
      await prisma.breakEntry.update({
        where: { id: openBreak.id },
        data: { endedAt: clockOutAt },
      });
    }
    // Anomaly math below should see the now-closed break.
    const effectiveBreaks =
      openBreak && clockOutAt
        ? existing.breaks.map((b) =>
            b.id === openBreak.id ? { ...b, endedAt: clockOutAt } : b,
          )
        : existing.breaks;

    // A job change re-snapshots payRate + clientId from the new job.
    let jobUpdate: { jobId?: string | null; payRate?: number | null; clientId?: string | null } = {};
    if (parsed.data.jobId !== undefined) {
      if (parsed.data.jobId) {
        const job = await prisma.job.findFirst({
          where: { id: parsed.data.jobId, deletedAt: null, isActive: true },
        });
        if (!job) throw new HttpError(404, 'job_not_found', 'Job not found or inactive');
        jobUpdate = {
          jobId: job.id,
          payRate: job.payRate ? Number(job.payRate) : null,
          clientId: job.clientId,
        };
      } else {
        jobUpdate = { jobId: null };
      }
    }

    // Recompute anomalies whenever there's a clock-out time. Admin edits
    // carry no fresh GPS, so we preserve any geofence flags already on the
    // entry rather than clearing them.
    let anomalies: TimeAnomaly[] = Array.isArray(existing.anomalies)
      ? (existing.anomalies as TimeAnomaly[])
      : [];
    if (clockOutAt) {
      anomalies = await recomputeAnomalies({
        associateId: existing.associateId,
        excludeEntryId: existing.id,
        clockInAt,
        clockOutAt,
        breaks: effectiveBreaks,
        state: existing.associate?.state ?? null,
        geofenceInOk: anomalies.includes('GEOFENCE_VIOLATION_IN') ? false : null,
        geofenceOutOk: anomalies.includes('GEOFENCE_VIOLATION_OUT') ? false : null,
        matchedShift: existing.shiftId
          ? await prisma.shift.findUnique({
              where: { id: existing.shiftId },
              select: { startsAt: true, endsAt: true },
            })
          : null,
      });
    }

    const updated = await prisma.timeEntry.update({
      where: { id: existing.id },
      data: {
        clockInAt,
        clockOutAt,
        status,
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        ...jobUpdate,
        ...(parsed.data.payRate !== undefined ? { payRate: parsed.data.payRate } : {}),
        anomalies,
      },
      include: ENTRY_INCLUDE,
    });

    // Re-post the accrual from the corrected hours, and tell the
    // associate — an after-the-fact change to APPROVED hours moves
    // their pay basis and must never be silent.
    if (approvedCorrection) {
      await accrueSickLeaveForEntry(prisma, updated.id);
      const tz = DEFAULT_TIMEZONE;
      const day = formatDateInZone(updated.clockInAt, tz);
      const range = `${formatTimeInZone(updated.clockInAt, tz)}–${
        updated.clockOutAt ? formatTimeInZone(updated.clockOutAt, tz) : '…'
      }`;
      void notifyAssociate(updated.associateId, {
        subject: 'Approved hours adjusted',
        body: `Your approved ${day} time entry was corrected by an admin — it now reads ${range} (${(netWorkedMinutes(updated, updated.breaks) / 60).toFixed(1)}h). Talk to your manager if this looks wrong.`,
        category: 'time_entry',
        linkUrl: '/time-attendance',
      });
    }

    await recordTimeEvent({
      actorUserId: user.id,
      action: becomingCompleted ? 'time.admin_clock_out' : 'time.admin_edited',
      timeEntryId: updated.id,
      associateId: updated.associateId,
      clientId: updated.clientId,
      metadata: {
        onBehalf: true,
        fromStatus: existing.status,
        toStatus: status,
        editedFields: Object.keys(parsed.data),
        ...(approvedCorrection ? { approvedCorrection: true } : {}),
      },
      req,
    });

    res.json(await toEntry(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== Admin break editing ============================================== */
// Breaks are first-class in the edit drawer: the same admin who fixes
// clock times can add the meal an associate never punched, adjust a
// mislogged one, or delete a bogus row. Every mutation revalidates
// against the entry's bounds, recomputes anomalies, and — on APPROVED
// entries — runs the same reverse/re-accrue sick-leave cycle as a time
// correction, because net minutes are the pay basis.

const AdminBreakCreateSchema = z.object({
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  type: z.enum(['MEAL', 'REST']).optional(),
});
const AdminBreakPatchSchema = z.object({
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
});

function assertBreakFits(
  entry: { clockInAt: Date; clockOutAt: Date | null },
  otherBreaks: Array<{ startedAt: Date; endedAt: Date | null }>,
  startedAt: Date,
  endedAt: Date,
) {
  if (endedAt.getTime() <= startedAt.getTime()) {
    throw new HttpError(400, 'invalid_range', 'Break end must be after its start.');
  }
  // ACTIVE entries have no clock-out yet — the break just can't run
  // into the future.
  const upper = entry.clockOutAt ?? new Date();
  if (
    startedAt.getTime() < entry.clockInAt.getTime() ||
    endedAt.getTime() > upper.getTime()
  ) {
    throw new HttpError(
      400,
      'break_out_of_bounds',
      'Break must fall inside the clock-in / clock-out window.',
    );
  }
  for (const b of otherBreaks) {
    const bEnd = b.endedAt ?? upper;
    if (startedAt.getTime() < bEnd.getTime() && endedAt.getTime() > b.startedAt.getTime()) {
      throw new HttpError(409, 'break_overlap', 'Break overlaps another break on this entry.');
    }
  }
}

// Shared load + guard for all three break routes. Rejected entries are
// resubmitted by the associate, not edited around — mutating their
// breaks would change hours nobody is going to pay.
async function loadEntryForBreakEdit(user: TimeUser, entryId: string) {
  const entry = await prisma.timeEntry.findFirst({
    where: { id: entryId, ...scopeTimeEntries(user) },
    include: { breaks: true },
  });
  if (!entry) {
    throw new HttpError(404, 'time_entry_not_found', 'Time entry not found');
  }
  if (entry.status === 'REJECTED') {
    throw new HttpError(409, 'entry_rejected', 'Rejected entries are resubmitted, not edited.');
  }
  return entry;
}

// After the break row changed: re-accrue (approved entries only — the
// pay basis moved), refresh anomaly flags, audit, notify, and return
// the full updated entry so the drawer can re-render from one response.
async function finishBreakMutation(opts: {
  user: TimeUser;
  req: import('express').Request;
  entry: {
    id: string;
    associateId: string;
    clientId: string | null;
    status: string;
    clockOutAt: Date | null;
  };
  action: string;
  metadata: Record<string, unknown>;
}) {
  const { user, req, entry, action, metadata } = opts;
  if (entry.status === 'APPROVED') {
    await accrueSickLeaveForEntry(prisma, entry.id);
    void notifyAssociate(entry.associateId, {
      subject: 'Approved hours adjusted',
      body: 'An admin adjusted the break time on one of your approved entries, which changes your paid hours. Talk to your manager if this looks wrong.',
      category: 'time_entry',
      linkUrl: '/time-attendance',
    });
  }
  if (entry.clockOutAt) await recomputeEntryAnomalies(prisma, entry.id);
  await recordTimeEvent({
    actorUserId: user.id,
    action,
    timeEntryId: entry.id,
    associateId: entry.associateId,
    clientId: entry.clientId,
    metadata: { onBehalf: true, ...metadata },
    req,
  });
  const updated = await prisma.timeEntry.findFirst({
    where: { id: entry.id },
    include: ENTRY_INCLUDE,
  });
  return toEntry(updated!);
}

timeRouter.post('/admin/entries/:id/breaks', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = AdminBreakCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const entry = await loadEntryForBreakEdit(user, req.params.id);
    const startedAt = new Date(parsed.data.startedAt);
    const endedAt = new Date(parsed.data.endedAt);
    assertBreakFits(entry, entry.breaks, startedAt, endedAt);
    if (entry.status === 'APPROVED') await reverseSickLeaveForEntry(prisma, entry.id);
    const created = await prisma.breakEntry.create({
      data: {
        timeEntryId: entry.id,
        type: parsed.data.type ?? 'MEAL',
        startedAt,
        endedAt,
      },
    });
    res.status(201).json(
      await finishBreakMutation({
        user,
        req,
        entry,
        action: 'time.break_added',
        metadata: { breakId: created.id, minutes: Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000) },
      }),
    );
  } catch (err) {
    next(err);
  }
});

timeRouter.patch('/admin/breaks/:breakId', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = AdminBreakPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const br = await prisma.breakEntry.findUnique({ where: { id: req.params.breakId } });
    if (!br) throw new HttpError(404, 'break_not_found', 'Break not found');
    const entry = await loadEntryForBreakEdit(user, br.timeEntryId);
    const startedAt = parsed.data.startedAt ? new Date(parsed.data.startedAt) : br.startedAt;
    // A still-open break (ACTIVE entry, associate on break now) keeps its
    // null end unless the edit explicitly supplies one — validation just
    // treats "now" as its provisional end.
    const endedAt =
      parsed.data.endedAt !== undefined ? new Date(parsed.data.endedAt) : br.endedAt;
    assertBreakFits(
      entry,
      entry.breaks.filter((b) => b.id !== br.id),
      startedAt,
      endedAt ?? new Date(),
    );
    if (entry.status === 'APPROVED') await reverseSickLeaveForEntry(prisma, entry.id);
    await prisma.breakEntry.update({
      where: { id: br.id },
      data: {
        startedAt,
        ...(parsed.data.endedAt !== undefined ? { endedAt: new Date(parsed.data.endedAt) } : {}),
      },
    });
    res.json(
      await finishBreakMutation({
        user,
        req,
        entry,
        action: 'time.break_edited',
        metadata: {
          breakId: br.id,
          minutes: endedAt
            ? Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000)
            : null,
        },
      }),
    );
  } catch (err) {
    next(err);
  }
});

timeRouter.delete('/admin/breaks/:breakId', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const br = await prisma.breakEntry.findUnique({ where: { id: req.params.breakId } });
    if (!br) throw new HttpError(404, 'break_not_found', 'Break not found');
    const entry = await loadEntryForBreakEdit(user, br.timeEntryId);
    if (entry.status === 'APPROVED') await reverseSickLeaveForEntry(prisma, entry.id);
    await prisma.breakEntry.delete({ where: { id: br.id } });
    res.json(
      await finishBreakMutation({
        user,
        req,
        entry,
        action: 'time.break_removed',
        metadata: { breakId: br.id, type: br.type },
      }),
    );
  } catch (err) {
    next(err);
  }
});

/* ===== Phase 64 — bulk approve / bulk reject ============================ */
// Mirrors the bulk-invite pattern from onboarding Phase 58: per-row try/catch,
// stable error codes, response with succeeded/failed counts + per-row results.

type TimeUser = NonNullable<import('express').Request['user']>;

async function approveOneEntry(
  user: TimeUser,
  entryId: string,
  req: import('express').Request,
): Promise<{ associateId: string; minutes: number } | null> {
  const existing = await prisma.timeEntry.findFirst({
    where: { id: entryId, ...scopeTimeEntries(user) },
  });
  if (!existing) {
    throw new HttpError(404, 'time_entry_not_found', 'Time entry not found');
  }
  if (existing.status === 'ACTIVE') {
    throw new HttpError(409, 'still_active', 'Cannot approve an entry that has not been clocked out');
  }
  if (existing.status === 'APPROVED') {
    return null; // idempotent — no state change, no notification
  }

  const updated = await prisma.timeEntry.update({
    where: { id: existing.id },
    data: {
      status: 'APPROVED',
      approvedById: user.id,
      approvedAt: new Date(),
      rejectionReason: null,
    },
    include: ENTRY_INCLUDE,
  });

  const accrual = await accrueSickLeaveForEntry(prisma, updated.id);

  await recordTimeEvent({
    actorUserId: user.id,
    action: 'time.approved',
    timeEntryId: updated.id,
    associateId: updated.associateId,
    clientId: updated.clientId,
    metadata: {
      minutes: minutesElapsed(updated),
      bulk: true,
      ...(accrual.accrued
        ? { sickAccrualMinutes: accrual.earnedMinutes, state: accrual.state }
        : {}),
    },
    req,
  });

  return {
    associateId: updated.associateId,
    minutes: netWorkedMinutes(updated, updated.breaks),
  };
}

async function rejectOneEntry(
  user: TimeUser,
  entryId: string,
  reason: string,
  req: import('express').Request,
): Promise<{ associateId: string } | null> {
  const existing = await prisma.timeEntry.findFirst({
    where: { id: entryId, ...scopeTimeEntries(user) },
  });
  if (!existing) {
    throw new HttpError(404, 'time_entry_not_found', 'Time entry not found');
  }
  if (existing.status === 'ACTIVE') {
    throw new HttpError(409, 'still_active', 'Cannot reject an entry that has not been clocked out');
  }
  if (existing.status === 'REJECTED') {
    return null; // idempotent — no state change, no notification
  }

  // Mirror the single-reject path: voiding an APPROVED shift pulls its
  // posted sick-leave accrual back out of the balance.
  const reversal =
    existing.status === 'APPROVED'
      ? await reverseSickLeaveForEntry(prisma, existing.id)
      : { reversed: false, minutes: 0 };

  const updated = await prisma.timeEntry.update({
    where: { id: existing.id },
    data: {
      status: 'REJECTED',
      rejectionReason: reason,
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
    metadata: {
      reason,
      bulk: true,
      ...(reversal.reversed
        ? { sickAccrualReversedMinutes: reversal.minutes }
        : {}),
    },
    req,
  });

  return { associateId: updated.associateId };
}

timeRouter.post('/admin/bulk-approve', MANAGE, async (req, res, next) => {
  try {
    const parsed = BulkTimeApproveInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const user = req.user!;
    let succeeded = 0;
    let failed = 0;
    // One SUMMARY notification per associate, not one per entry — a
    // Friday bulk-approve of 40 entries must not buzz a phone 5 times.
    const approvedByAssociate = new Map<string, { count: number; minutes: number }>();
    // PERF: bounded parallelism — each entry costs several queries
    // (scope check, update, accrual); fully-serial was ~5 round-trips ×
    // 500 ids per request. Results are index-addressed so response order
    // stays stable under concurrency.
    const results: BulkTimeResultRow[] = new Array(parsed.data.entryIds.length);
    await runWithConcurrency(parsed.data.entryIds, 6, async (entryId, i) => {
      try {
        const done = await approveOneEntry(user, entryId, req);
        if (done) {
          const agg = approvedByAssociate.get(done.associateId) ?? { count: 0, minutes: 0 };
          agg.count += 1;
          agg.minutes += done.minutes;
          approvedByAssociate.set(done.associateId, agg);
        }
        results[i] = { entryId, ok: true, errorCode: null, errorMessage: null };
        succeeded++;
      } catch (err) {
        const errorCode = err instanceof HttpError ? err.code : 'approve_failed';
        const errorMessage = err instanceof Error ? err.message : String(err);
        results[i] = { entryId, ok: false, errorCode, errorMessage };
        failed++;
      }
    });
    for (const [associateId, agg] of approvedByAssociate) {
      void notifyAssociate(associateId, {
        subject: 'Hours approved',
        body: `${agg.count} time ${agg.count === 1 ? 'entry' : 'entries'} approved — ${(agg.minutes / 60).toFixed(1)}h total.`,
        category: 'time_entry',
        linkUrl: '/time-attendance',
      });
    }
    const response: BulkTimeResponse = { succeeded, failed, results };
    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/admin/bulk-reject', MANAGE, async (req, res, next) => {
  try {
    const parsed = BulkTimeRejectInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const user = req.user!;
    const { entryIds, reason } = parsed.data;
    let succeeded = 0;
    let failed = 0;
    const rejectedByAssociate = new Map<string, number>();
    // PERF: bounded parallelism, order-stable results (see bulk-approve).
    const results: BulkTimeResultRow[] = new Array(entryIds.length);
    await runWithConcurrency(entryIds, 6, async (entryId, i) => {
      try {
        const done = await rejectOneEntry(user, entryId, reason, req);
        if (done) {
          rejectedByAssociate.set(
            done.associateId,
            (rejectedByAssociate.get(done.associateId) ?? 0) + 1,
          );
        }
        results[i] = { entryId, ok: true, errorCode: null, errorMessage: null };
        succeeded++;
      } catch (err) {
        const errorCode = err instanceof HttpError ? err.code : 'reject_failed';
        const errorMessage = err instanceof Error ? err.message : String(err);
        results[i] = { entryId, ok: false, errorCode, errorMessage };
        failed++;
      }
    });
    for (const [associateId, count] of rejectedByAssociate) {
      void notifyAssociate(associateId, {
        subject: 'Time entries rejected',
        body: `${count} time ${count === 1 ? 'entry was' : 'entries were'} rejected: "${reason}". Talk to your manager if this looks wrong.`,
        category: 'time_entry',
        linkUrl: '/time-attendance',
      });
    }
    const response: BulkTimeResponse = { succeeded, failed, results };
    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
});

/* ===== Bulk standard-break application =================================== */

// Most associates never punch their meal break, so 6h+ shifts pile up in
// review flagged NO_BREAK. This lets a reviewer select those entries and
// book the site's standard unpaid meal — 1 hour, centered mid-shift — in
// one action. Deliberately an explicit reviewer action, never automatic:
// hours are docked only when a human chose to.
const APPLIED_BREAK_MINUTES = 60;
// Only shifts long enough that the NO_BREAK flag fires (6h) qualify;
// docking an hour from a short shift is a payroll error, not a cleanup.
const APPLY_BREAK_MIN_SHIFT_HOURS = 6;

const BulkApplyBreakSchema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(500),
});

timeRouter.post('/admin/bulk-apply-break', MANAGE, async (req, res, next) => {
  try {
    const parsed = BulkApplyBreakSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const user = req.user!;
    let succeeded = 0;
    let failed = 0;
    // PERF: one batched scope+breaks read for the whole id set, then
    // bounded-parallel writes (was ~5 serial queries × up to 500 ids).
    const preloaded = await prisma.timeEntry.findMany({
      where: { id: { in: parsed.data.entryIds }, ...scopeTimeEntries(user) },
      include: { breaks: true },
    });
    const entryById = new Map(preloaded.map((e) => [e.id, e]));
    const results: BulkTimeResultRow[] = new Array(parsed.data.entryIds.length);
    await runWithConcurrency(parsed.data.entryIds, 6, async (entryId, i) => {
      try {
        const entry = entryById.get(entryId);
        if (!entry) {
          throw new HttpError(404, 'not_found', 'Entry not found.');
        }
        // COMPLETED only — the break changes paid hours, so it must land
        // before approval, never rewrite an approved (or rejected) entry.
        if (entry.status !== 'COMPLETED' || !entry.clockOutAt) {
          throw new HttpError(409, 'not_pending', 'Only completed entries awaiting review can take a standard break.');
        }
        if (entry.breaks.some((b) => b.type === 'MEAL')) {
          throw new HttpError(409, 'already_has_break', 'Entry already has a meal break.');
        }
        const grossMin =
          (entry.clockOutAt.getTime() - entry.clockInAt.getTime()) / 60_000;
        if (grossMin < APPLY_BREAK_MIN_SHIFT_HOURS * 60) {
          throw new HttpError(409, 'shift_too_short', `Shift under ${APPLY_BREAK_MIN_SHIFT_HOURS}h — no standard break to deduct.`);
        }
        const midMs =
          (entry.clockInAt.getTime() + entry.clockOutAt.getTime()) / 2;
        const halfBreakMs = (APPLIED_BREAK_MINUTES / 2) * 60_000;
        await prisma.breakEntry.create({
          data: {
            timeEntryId: entry.id,
            type: 'MEAL',
            startedAt: new Date(midMs - halfBreakMs),
            endedAt: new Date(midMs + halfBreakMs),
          },
        });
        // Break changes net minutes → NO_BREAK clears, OT flags may move.
        // Fire-and-forget per its own contract (the helper's doc says
        // callers should void it) — the anomaly chips are advisory.
        void recomputeEntryAnomalies(prisma, entry.id);
        await recordTimeEvent({
          actorUserId: user.id,
          action: 'time.break_applied',
          timeEntryId: entry.id,
          associateId: entry.associateId,
          clientId: entry.clientId,
          metadata: { minutes: APPLIED_BREAK_MINUTES, standard: true },
          req,
        });
        results[i] = { entryId, ok: true, errorCode: null, errorMessage: null };
        succeeded++;
      } catch (err) {
        const errorCode = err instanceof HttpError ? err.code : 'apply_break_failed';
        const errorMessage = err instanceof Error ? err.message : String(err);
        results[i] = { entryId, ok: false, errorCode, errorMessage };
        failed++;
      }
    });
    const response: BulkTimeResponse = { succeeded, failed, results };
    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
});

/* ===== Phase 65 — exports (CSV + PDF) ==================================== */

// Hard cap on time exports. Each row pulls a TimeEntry + associate +
// client (via ENTRY_INCLUDE), ~500 bytes serialized; 5000 rows is
// ~2.5 MB working set per request — fine for one concurrent caller,
// stays under the ~10 MB envelope before Node's default heap pressure.
// Past this, callers get the truncated rows + X-Truncated header so
// the UI can show "showing first 5000 of N+" rather than silently
// hiding entries.
const TIME_EXPORT_MAX_ROWS = 5000;

// Delegates to the shared escaper: RFC-4180 quoting PLUS formula-injection
// guarding (a cell starting with =, +, -, @ executes on open in Excel, and
// these exports carry associate-controlled names and notes).
function csvEscape(v: string): string {
  return sharedCsvCell(v);
}

// Site-local minutes-from-midnight for a shift boundary. Must produce the
// exact same key the queue computes in the browser (AdminTimeView's
// siteMinutes): tz falls back to UTC, bad tz strings fall back to UTC.
function siteLocalMinutes(d: Date, tz: string | null): number {
  const opts = {
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  } as const;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz ?? 'UTC' }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).formatToParts(d);
  }
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (h % 24) * 60 + m;
}

/**
 * The queue's "Shift" filter is a client-side lens over the loaded page, but
 * exports cover the whole range server-side — so the same window key is
 * re-derived here per row. Post-filter (not SQL): the key depends on the
 * matched shift's time-of-day in the site's timezone.
 */
function matchesShiftWindow(
  row: { shift: { startsAt: Date; endsAt: Date } | null; location: { timezone: string | null } | null },
  shiftWindow: string | undefined,
): boolean {
  if (!shiftWindow) return true;
  if (shiftWindow === 'none') return row.shift === null;
  if (!row.shift) return false;
  const tz = row.location?.timezone ?? null;
  const key = `${siteLocalMinutes(row.shift.startsAt, tz)}-${siteLocalMinutes(row.shift.endsAt, tz)}`;
  return key === shiftWindow;
}

async function loadExportRows(
  user: TimeUser,
  input: import('@alto-people/shared').TimeExportInput,
) {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new HttpError(400, 'invalid_range', 'from / to must be ISO timestamps');
  }
  if (to <= from) {
    throw new HttpError(400, 'invalid_range', 'to must be after from');
  }
  // Tenant clamp FIRST — same bug class as the list routes: a bounded
  // caller's requested clientId must never override scopeTimeEntries.
  const exportClientId = effectiveClientIdFilter(user, input.clientId) ?? undefined;
  const where: Prisma.TimeEntryWhereInput = {
    ...scopeTimeEntries(user),
    clockInAt: { gte: from, lt: to },
    ...(input.status ? { status: input.status } : {}),
    ...(exportClientId ? { clientId: exportClientId } : {}),
    ...(input.locationId ? { locationId: input.locationId } : {}),
    ...(input.associateId ? { associateId: input.associateId } : {}),
    AND: [
      ...associateNameSearchClauses(input.search),
      ...anomaliesOnlyClauses(input.anomaliesOnly),
    ],
  };
  const fetched = await prisma.timeEntry.findMany({
    where,
    orderBy: { clockInAt: 'asc' },
    include: ENTRY_INCLUDE,
    take: TIME_EXPORT_MAX_ROWS,
  });
  const rows = input.shiftWindow
    ? fetched.filter((r) => matchesShiftWindow(r, input.shiftWindow))
    : fetched;
  return { from, to, rows, truncated: fetched.length === TIME_EXPORT_MAX_ROWS };
}

// Federal weekly overtime threshold (40h) — matches payrollAggregator's
// regular/OT split so the summary reconciles with payroll.
const WEEK_REGULAR_CAP_MIN = 40 * 60;
const TIME_SUMMARY_MAX_ROWS = 20000;

// Per-associate payroll-prep summary: regular vs overtime hours + pay rate,
// scoped to a facility (Location) over a date range. APPROVED time only —
// that's what payroll pays.
timeRouter.post('/admin/export-summary.csv', MANAGE, async (req, res, next) => {
  try {
    const parsed = TimeExportInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      throw new HttpError(400, 'invalid_range', 'from / to must be valid, to after from');
    }

    // Tenant clamp FIRST — bounded callers must not override the scope.
    const summaryClientId =
      effectiveClientIdFilter(req.user!, parsed.data.clientId) ?? undefined;
    const where: Prisma.TimeEntryWhereInput = {
      ...scopeTimeEntries(req.user!),
      status: 'APPROVED',
      clockInAt: { gte: from, lt: to },
      ...(parsed.data.locationId ? { locationId: parsed.data.locationId } : {}),
      ...(summaryClientId ? { clientId: summaryClientId } : {}),
      ...(parsed.data.associateId ? { associateId: parsed.data.associateId } : {}),
    };
    // Same filters, COMPLETED instead of APPROVED: anything still pending
    // review in this window means the weekly OT split below is computed on
    // a partial week — a 45h week with 5h unapproved exports as 40 regular
    // / 0 OT and looks final. Count them and say so.
    const [rows, pendingCount] = await Promise.all([
      prisma.timeEntry.findMany({
        where,
        orderBy: { clockInAt: 'asc' },
        include: {
          associate: { select: { firstName: true, lastName: true } },
          breaks: true,
        },
        take: TIME_SUMMARY_MAX_ROWS,
      }),
      prisma.timeEntry.count({
        where: { ...where, status: 'COMPLETED' },
      }),
    ]);
    if (rows.length === TIME_SUMMARY_MAX_ROWS) {
      res.setHeader('X-Truncated', 'true');
    }
    if (pendingCount > 0) {
      res.setHeader('X-Pending', String(pendingCount));
    }

    // Accumulate net worked minutes per associate per ISO week (OT is a
    // weekly concept, so we split each week then sum across weeks).
    type Acc = { name: string; weeks: Map<string, number>; shifts: number };
    const byAssoc = new Map<string, Acc>();
    for (const r of rows) {
      const acc =
        byAssoc.get(r.associateId) ?? {
          name: `${r.associate.firstName} ${r.associate.lastName}`,
          weeks: new Map<string, number>(),
          shifts: 0,
        };
      const wk = String(startOfWeekUTC(r.clockInAt).getTime());
      acc.weeks.set(wk, (acc.weeks.get(wk) ?? 0) + netWorkedMinutes(r, r.breaks));
      acc.shifts += 1;
      byAssoc.set(r.associateId, acc);
    }

    // Current pay rate per associate (open CompensationRecord).
    const associateIds = Array.from(byAssoc.keys());
    const rateMap = new Map<string, { amount: number; payType: string }>();
    if (associateIds.length > 0) {
      const comps = await prisma.compensationRecord.findMany({
        where: { associateId: { in: associateIds }, effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
        select: { associateId: true, amount: true, payType: true },
      });
      for (const c of comps) {
        if (!rateMap.has(c.associateId)) {
          rateMap.set(c.associateId, { amount: Number(c.amount), payType: c.payType });
        }
      }
    }

    // Facility label for the header.
    let facility = 'All locations';
    if (parsed.data.locationId) {
      const loc = await prisma.location.findUnique({
        where: { id: parsed.data.locationId },
        select: { name: true, client: { select: { name: true } } },
      });
      facility = loc
        ? `${loc.client?.name ? loc.client.name + ' · ' : ''}${loc.name}`
        : 'Location';
    } else if (parsed.data.clientId) {
      facility = (await loadClientName(parsed.data.clientId)) ?? 'Client';
    }

    const dayStr = (d: Date) => d.toISOString().slice(0, 10);
    const fname = `time-summary-${dayStr(from)}-to-${dayStr(new Date(to.getTime() - 1))}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);

    res.write(`Time summary,${csvEscape(facility)}\n`);
    res.write(`Range,${dayStr(from)} to ${dayStr(new Date(to.getTime() - 1))}\n`);
    res.write(`Status,APPROVED only\n`);
    res.write(`Overtime rule,Over 40 hours per week (federal)\n`);
    res.write(
      `Rate note,"Current rate" is today's compensation record — not necessarily the rate when the hours were worked\n`,
    );
    if (pendingCount > 0) {
      res.write(
        `WARNING,${pendingCount} entr${pendingCount === 1 ? 'y is' : 'ies are'} still pending review in this range — hours and the regular/overtime split are PROVISIONAL until the queue is cleared\n`,
      );
    }
    res.write('\n');
    res.write('Associate,Pay type,Current rate,Regular hours,Overtime hours,Total hours,Shifts\n');

    const fmtH = (min: number) => (min / 60).toFixed(2);
    const sorted = Array.from(byAssoc.entries()).sort((a, b) =>
      a[1].name.localeCompare(b[1].name),
    );
    let totReg = 0;
    let totOt = 0;
    let totShifts = 0;
    for (const [associateId, acc] of sorted) {
      let regMin = 0;
      let otMin = 0;
      for (const wkMin of acc.weeks.values()) {
        regMin += Math.min(wkMin, WEEK_REGULAR_CAP_MIN);
        otMin += Math.max(0, wkMin - WEEK_REGULAR_CAP_MIN);
      }
      totReg += regMin;
      totOt += otMin;
      totShifts += acc.shifts;
      const rate = rateMap.get(associateId);
      res.write(
        [
          acc.name,
          rate?.payType ?? '',
          rate ? rate.amount.toFixed(2) : '',
          fmtH(regMin),
          fmtH(otMin),
          fmtH(regMin + otMin),
          String(acc.shifts),
        ]
          .map(csvEscape)
          .join(',') + '\n',
      );
    }
    res.write(
      ['TOTAL', '', '', fmtH(totReg), fmtH(totOt), fmtH(totReg + totOt), String(totShifts)]
        .map(csvEscape)
        .join(',') + '\n',
    );
    res.end();
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/admin/export.csv', MANAGE, async (req, res, next) => {
  try {
    const parsed = TimeExportInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { from, to, rows, truncated } = await loadExportRows(req.user!, parsed.data);
    if (truncated) {
      res.setHeader('X-Truncated', 'true');
      res.setHeader('X-Truncated-Limit', String(TIME_EXPORT_MAX_ROWS));
    }

    const fname = `time-${from.toISOString().slice(0, 10)}-to-${new Date(to.getTime() - 1)
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);

    // grossMinutes = clock-in → clock-out; netMinutes = what payroll pays
    // (breaks subtracted). Both, explicitly named — the old single
    // "minutes" column was gross and never reconciled with the summary
    // export, which is net.
    //
    // Punches come in TWO forms: site-local wall time + a timezone column
    // (what every screen shows — the old UTC-only export contradicted the
    // queue by the full zone offset) AND the raw UTC instants for machine
    // consumers.
    res.write(
      'clockInLocal,clockOutLocal,timezone,clockInUtc,clockOutUtc,grossMinutes,netMinutes,breakMinutes,associate,client,job,status,rejectionReason\n'
    );
    // Pre-fetch client names so we don't issue one SELECT per row.
    const clientIds = Array.from(
      new Set(rows.map((r) => r.clientId).filter((x): x is string => !!x)),
    );
    const clientMap = new Map<string, string>();
    if (clientIds.length > 0) {
      const cs = await prisma.client.findMany({
        take: 1000,
        where: { id: { in: clientIds } },
        select: { id: true, name: true },
      });
      for (const c of cs) clientMap.set(c.id, c.name);
    }
    for (const r of rows) {
      const gross = minutesElapsed(r);
      const net = netWorkedMinutes(
        { clockInAt: r.clockInAt, clockOutAt: r.clockOutAt },
        r.breaks,
      );
      const tz = r.location?.timezone ?? DEFAULT_TIMEZONE;
      const local = (d: Date) =>
        `${localDateKey(d, tz)} ${formatTimeInZone(d, tz)}`;
      const cols = [
        local(r.clockInAt),
        r.clockOutAt ? local(r.clockOutAt) : '',
        tz,
        r.clockInAt.toISOString(),
        r.clockOutAt ? r.clockOutAt.toISOString() : '',
        String(gross),
        String(net),
        String(Math.max(0, gross - net)),
        `${r.associate.firstName} ${r.associate.lastName}`,
        r.clientId ? clientMap.get(r.clientId) ?? '' : '',
        r.job?.name ?? '',
        r.status,
        r.rejectionReason ?? '',
      ].map(csvEscape);
      res.write(cols.join(',') + '\n');
    }
    res.end();
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/admin/export.pdf', MANAGE, async (req, res, next) => {
  try {
    const parsed = TimeExportInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { from, to, rows, truncated } = await loadExportRows(req.user!, parsed.data);
    if (truncated) {
      res.setHeader('X-Truncated', 'true');
      res.setHeader('X-Truncated-Limit', String(TIME_EXPORT_MAX_ROWS));
    }

    let clientName: string | null = null;
    if (parsed.data.clientId) {
      const c = await prisma.client.findFirst({
        where: { id: parsed.data.clientId, deletedAt: null },
        select: { name: true },
      });
      clientName = c?.name ?? null;
    }
    let associateName: string | null = null;
    if (parsed.data.associateId) {
      const a = await prisma.associate.findFirst({
        where: { id: parsed.data.associateId },
        select: { firstName: true, lastName: true },
      });
      associateName = a ? `${a.firstName} ${a.lastName}` : null;
    }

    const clientIds = Array.from(
      new Set(rows.map((r) => r.clientId).filter((x): x is string => !!x)),
    );
    const clientMap = new Map<string, string>();
    if (clientIds.length > 0) {
      const cs = await prisma.client.findMany({
        take: 1000,
        where: { id: { in: clientIds } },
        select: { id: true, name: true },
      });
      for (const c of cs) clientMap.set(c.id, c.name);
    }

    const pdf = await renderTimeReportPdf({
      rangeFrom: from,
      rangeTo: to,
      generatedAt: new Date(),
      filters: {
        clientName,
        associateName,
        status: parsed.data.status ?? null,
      },
      entries: rows.map((r) => ({
        clockInAt: r.clockInAt,
        clockOutAt: r.clockOutAt,
        // Renderer formats punches on the SITE's wall clock, matching the
        // queue — it used to toLocale* on the UTC server.
        timezone: r.location?.timezone ?? DEFAULT_TIMEZONE,
        associateName: `${r.associate.firstName} ${r.associate.lastName}`,
        clientName: r.clientId ? clientMap.get(r.clientId) ?? null : null,
        jobName: r.job?.name ?? null,
        status: r.status,
        minutes: minutesElapsed(r),
        rejectionReason: r.rejectionReason,
      })),
    });

    const fname = `time-${from.toISOString().slice(0, 10)}-to-${new Date(to.getTime() - 1)
      .toISOString()
      .slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

/* ===== Payroll-ready sheet (PDF + XLSX) ================================== */

// Shared loader for the payroll sheet: APPROVED time only (that's what
// payroll pays), scoped to the caller + an optional client, aggregated into
// per-associate dates-worked + regular/overtime totals. Also counts entries
// still pending review so the renderers can flag provisional totals.
async function loadPayrollSheet(
  user: TimeUser,
  input: import('@alto-people/shared').TimeExportInput,
) {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw new HttpError(400, 'invalid_range', 'from / to must be valid, to after from');
  }
  // Tenant clamp FIRST — bounded callers must not override the scope.
  const sheetClientId = effectiveClientIdFilter(user, input.clientId) ?? undefined;
  const where: Prisma.TimeEntryWhereInput = {
    ...scopeTimeEntries(user),
    status: 'APPROVED',
    clockInAt: { gte: from, lt: to },
    ...(sheetClientId ? { clientId: sheetClientId } : {}),
    ...(input.locationId ? { locationId: input.locationId } : {}),
    ...(input.associateId ? { associateId: input.associateId } : {}),
  };
  const [rows, pendingCount, noClientCount] = await Promise.all([
    prisma.timeEntry.findMany({
      where,
      orderBy: { clockInAt: 'asc' },
      include: {
        // state drives the OT thresholds (see PayrollSheetInputRow.state).
        associate: { select: { firstName: true, lastName: true, state: true } },
        breaks: true,
      },
      take: TIME_SUMMARY_MAX_ROWS,
    }),
    prisma.timeEntry.count({ where: { ...where, status: 'COMPLETED' } }),
    // Approved time with no client is invisible to every client-scoped
    // sheet — a manually added entry lands clientless when the associate
    // has no open assignment and no job was picked. Count them so the
    // caller can say "N approved entries were left out" instead of the
    // sheet silently reading as complete.
    sheetClientId
      ? prisma.timeEntry.count({
          where: {
            ...scopeTimeEntries(user),
            status: 'APPROVED',
            clockInAt: { gte: from, lt: to },
            clientId: null,
            ...(input.associateId ? { associateId: input.associateId } : {}),
          },
        })
      : Promise.resolve(0),
  ]);

  const inputRows: PayrollSheetInputRow[] = rows.map((r) => ({
    associateId: r.associateId,
    associateName: `${r.associate.firstName} ${r.associate.lastName}`,
    clockInAt: r.clockInAt,
    clockOutAt: r.clockOutAt,
    breaks: r.breaks,
    state: r.associate.state,
  }));
  const hoursSheet = buildPayrollSheet(inputRows);

  // ---- Scheduled vs actual --------------------------------------------------
  // Sum of assigned-shift minutes per associate in the same window, so the
  // sheet shows worked hours NEXT TO what the schedule planned — the gap is
  // uncovered shifts, unscheduled work, or early-out drift.
  if (hoursSheet.associates.length > 0) {
    const periodShifts = await prisma.shift.findMany({
      where: {
        assignedAssociateId: { in: hoursSheet.associates.map((a) => a.associateId) },
        status: { in: ['ASSIGNED', 'COMPLETED'] },
        startsAt: { gte: from, lt: to },
        ...(sheetClientId ? { clientId: sheetClientId } : {}),
        ...(input.locationId ? { locationId: input.locationId } : {}),
      },
      select: { assignedAssociateId: true, startsAt: true, endsAt: true },
    });
    const scheduledBy = new Map<string, number>();
    for (const s of periodShifts) {
      const min = Math.max(
        0,
        Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000),
      );
      scheduledBy.set(
        s.assignedAssociateId!,
        (scheduledBy.get(s.assignedAssociateId!) ?? 0) + min,
      );
    }
    let totalScheduled = 0;
    for (const a of hoursSheet.associates) {
      a.scheduledMinutes = scheduledBy.get(a.associateId) ?? 0;
      totalScheduled += a.scheduledMinutes;
    }
    hoursSheet.totalScheduledMinutes = totalScheduled;
  }

  // ---- Earnings (rate / gross / taxes / net) --------------------------------
  // Gross is driven by each associate's current compensation-record wage; net
  // comes from the same engine real payroll runs use, with state income tax
  // resolved from the client's work-site state (Florida → $0).
  const associateIds = hoursSheet.associates.map((a) => a.associateId);
  const [client, comps] = await Promise.all([
    input.clientId
      ? prisma.client.findUnique({
          where: { id: input.clientId },
          select: { name: true, state: true },
        })
      : Promise.resolve(null),
    associateIds.length
      ? prisma.compensationRecord.findMany({
          where: { associateId: { in: associateIds }, effectiveTo: null },
          orderBy: { effectiveFrom: 'desc' },
          select: { associateId: true, amount: true, payType: true },
        })
      : Promise.resolve([]),
  ]);

  const rateOverride = new Map<string, number>();
  const payInfoById = new Map<string, AssociatePayInfo>();
  for (const c of comps) {
    if (payInfoById.has(c.associateId)) continue; // keep most-recent only
    payInfoById.set(c.associateId, { payType: c.payType });
    if (c.payType === 'HOURLY') {
      rateOverride.set(c.associateId, Number(c.amount));
    }
  }

  const projection = await aggregatePayrollProjection(prisma, {
    periodStart: from,
    periodEndExclusive: to,
    clientId: input.clientId ?? null,
    defaultRate: 0,
    hourlyRateOverride: rateOverride,
    // Apply the client's work-site state to everyone on the sheet so Florida
    // resolves to $0 SIT even when a per-associate state is unset.
    ...(client?.state ? { stateOverride: client.state } : {}),
  });
  const itemById = new Map(projection.items.map((it) => [it.associateId, it]));

  const sheet = attachEarnings(hoursSheet, itemById, payInfoById);
  const clientName = client?.name ?? null;
  return {
    sheet,
    clientName,
    from,
    to,
    pendingCount,
    noClientCount,
    truncated: rows.length === TIME_SUMMARY_MAX_ROWS,
  };
}

/* ===== External payroll sheet ============================================= *
 *
 * The handoff file for an outside payroll bureau: one row per worker with
 * full SSN, full bank account + routing number, DOB and home address.
 *
 * Gated on `export:payroll-pii`, NOT the `MANAGE` (manage:time) guard the
 * rest of this router uses — SHIFT_SUPERVISOR holds manage:time, and reusing
 * it here would have handed every floor supervisor their client's identity
 * documents. The capability sits with HR_ADMINISTRATOR alone.
 *
 * Generation is audited critically (record-then-send, aborting the download
 * if the audit insert fails), on the same reasoning as payroll disbursement:
 * a file this sensitive must never leave without a durable record of who
 * took it, over what range, and how many people were in it.
 * ========================================================================== */

const EXPORT_PII = requireCapability('export:payroll-pii');

async function loadExternalSheet(
  req: import('express').Request,
  format: 'xlsx' | 'pdf',
) {
  const parsed = ExternalPayrollSheetInputSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
  }
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw new HttpError(400, 'invalid_range', 'from / to must be valid, to after from');
  }

  const user = req.user!;
  const data = await buildExternalPayrollSheet(
    prisma,
    scopeTimeEntries(user),
    parsed.data,
  );

  // Record BEFORE the bytes go out. A throw here aborts the download, which
  // is the intended trade: no silent export of SSNs and bank accounts.
  await recordCriticalAudit(
    {
      actorUserId: user.id,
      clientId: parsed.data.clientId ?? null,
      action: 'payroll.external_sheet_exported',
      // Free-form entityId (not a uuid column), so an org-wide export gets a
      // stable key instead of dropping out of the entity timeline.
      entityType: 'ExternalPayrollSheet',
      entityId: parsed.data.clientId ?? 'ALL_CLIENTS',
      metadata: {
        format,
        from: parsed.data.from,
        to: parsed.data.to,
        locationId: parsed.data.locationId ?? null,
        associateId: parsed.data.associateId ?? null,
        employeeCount: data.rows.length,
        includedFullSsn: data.rows.filter((r) => r.ssn !== '').length,
        includedBankAccounts: data.rows.filter((r) => r.accountNumber !== '').length,
        gaps: data.gaps,
        truncated: data.truncated,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      },
    },
    'externalPayrollSheet',
  );

  return data;
}

/** Gap counts ride back as headers so the UI can warn without a second call. */
function setExternalSheetHeaders(
  res: import('express').Response,
  data: Awaited<ReturnType<typeof buildExternalPayrollSheet>>,
): void {
  res.setHeader('X-Employee-Count', String(data.rows.length));
  res.setHeader('X-Sheet-Gaps', JSON.stringify(data.gaps));
  if (data.truncated) res.setHeader('X-Truncated', 'true');
  // This file should never sit in a shared cache or a browser's disk cache.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
}

function externalSheetFilename(from: Date, to: Date, ext: string): string {
  const dayStr = (d: Date) => d.toISOString().slice(0, 10);
  return `external-payroll-${dayStr(from)}-to-${dayStr(new Date(to.getTime() - 1))}.${ext}`;
}

timeRouter.post('/admin/external-payroll-sheet.xlsx', EXPORT_PII, bulkPiiExportLimiter, async (req, res, next) => {
  try {
    const data = await loadExternalSheet(req, 'xlsx');
    const xlsx = await renderExternalPayrollSheetXlsx(data, new Date());
    setExternalSheetHeaders(res, data);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${externalSheetFilename(data.from, data.to, 'xlsx')}"`,
    );
    res.send(xlsx);
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/admin/external-payroll-sheet.pdf', EXPORT_PII, bulkPiiExportLimiter, async (req, res, next) => {
  try {
    const data = await loadExternalSheet(req, 'pdf');
    const pdf = await renderExternalPayrollSheetPdf(data, new Date());
    setExternalSheetHeaders(res, data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${externalSheetFilename(data.from, data.to, 'pdf')}"`,
    );
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

function payrollSheetFilename(from: Date, to: Date, ext: string): string {
  const dayStr = (d: Date) => d.toISOString().slice(0, 10);
  return `payroll-sheet-${dayStr(from)}-to-${dayStr(new Date(to.getTime() - 1))}.${ext}`;
}

timeRouter.post('/admin/payroll-sheet.pdf', MANAGE, async (req, res, next) => {
  try {
    const parsed = TimeExportInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { sheet, clientName, from, to, pendingCount, noClientCount, truncated } =
      await loadPayrollSheet(req.user!, parsed.data);
    if (truncated) res.setHeader('X-Truncated', 'true');
    if (pendingCount > 0) res.setHeader('X-Pending', String(pendingCount));
    if (noClientCount > 0) res.setHeader('X-No-Client', String(noClientCount));

    const pdf = await renderPayrollSheetPdf({
      sheet,
      clientName,
      rangeFrom: from,
      rangeTo: to,
      generatedAt: new Date(),
      pendingCount,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${payrollSheetFilename(from, to, 'pdf')}"`,
    );
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

timeRouter.post('/admin/payroll-sheet.xlsx', MANAGE, async (req, res, next) => {
  try {
    const parsed = TimeExportInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { sheet, clientName, from, to, pendingCount, noClientCount, truncated } =
      await loadPayrollSheet(req.user!, parsed.data);
    if (truncated) res.setHeader('X-Truncated', 'true');
    if (pendingCount > 0) res.setHeader('X-Pending', String(pendingCount));
    if (noClientCount > 0) res.setHeader('X-No-Client', String(noClientCount));

    const xlsx = await renderPayrollSheetXlsx({
      sheet,
      clientName,
      rangeFrom: from,
      rangeTo: to,
      generatedAt: new Date(),
      pendingCount,
    });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${payrollSheetFilename(from, to, 'xlsx')}"`,
    );
    res.send(xlsx);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /time/admin/timesheets
 * Body: { weekStart: ISO, clientId? }
 *
 * Fieldglass-shaped weekly timesheet (Saturday→Friday) — one row per worker
 * per week, net approved hours in the "Others" bucket, keyed by the week-
 * ending Friday. Powers the Timesheets page HR reads/copies into Fieldglass.
 */
/**
 * Clamp the timesheet clientId to the caller's tenant.
 *
 * The filing artifact (TimesheetFiling) is keyed on the REQUEST's clientId
 * while the row data is scoped per-user — and `manage:time`, this router's
 * guard, reaches down to SHIFT_SUPERVISOR. Without the clamp, a supervisor
 * omitting clientId hit the org-wide (clientId=null) filing in both
 * directions: filing overwrote HR's org-wide snapshot with one site's
 * workers, and reading computed drift of HR's all-client snapshot against
 * their scoped rows — leaking every other client's worker names and hours
 * as "filed X, current 0" drift rows. The web UI pins bounded users to
 * their client, but the API is the boundary, not the UI.
 */
function timesheetClientId(
  user: NonNullable<import('express').Request['user']>,
  requested: string | undefined,
): string | undefined {
  const clamped = effectiveClientIdFilter(user, requested);
  if (clamped === null) {
    // Tenant-bounded caller with no client on file — fail closed rather
    // than fall through to the org-wide filing.
    throw new HttpError(
      403,
      'client_required',
      'Your account has no client assigned — ask an administrator to set one.',
    );
  }
  return clamped;
}

timeRouter.post('/admin/timesheets', MANAGE, async (req, res, next) => {
  try {
    const parsed = TimesheetWeekInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const result = await buildTimesheetWeek(prisma, {
      weekStart: new Date(parsed.data.weekStart),
      clientId: timesheetClientId(req.user!, parsed.data.clientId),
      scopeWhere: scopeTimeEntries(req.user!),
      shiftScopeWhere: scopeShifts(req.user!),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /time/admin/timesheets.xlsx
 * Same input as above; streams the Fieldglass-mirroring workbook.
 */
timeRouter.post('/admin/timesheets.xlsx', MANAGE, async (req, res, next) => {
  try {
    const parsed = TimesheetWeekInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const result = await buildTimesheetWeek(prisma, {
      weekStart: new Date(parsed.data.weekStart),
      clientId: timesheetClientId(req.user!, parsed.data.clientId),
      scopeWhere: scopeTimeEntries(req.user!),
      shiftScopeWhere: scopeShifts(req.user!),
    });
    if (result.pendingCount > 0) res.setHeader('X-Pending', String(result.pendingCount));

    const xlsx = await renderTimesheetXlsx(result);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${timesheetFilename(result.weekEndIso)}"`,
    );
    res.send(xlsx);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /time/admin/timesheets/file
 * Body: { weekStart: ISO, clientId? }
 *
 * Records (or re-records) a Fieldglass filing for the week — snapshots each
 * worker's hours so later edits show up as drift. Returns the filed week.
 */
timeRouter.post('/admin/timesheets/file', MANAGE, async (req, res, next) => {
  try {
    const parsed = TimesheetWeekInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const result = await fileTimesheetWeek(
      prisma,
      {
        weekStart: new Date(parsed.data.weekStart),
        clientId: timesheetClientId(req.user!, parsed.data.clientId),
        scopeWhere: scopeTimeEntries(req.user!),
        shiftScopeWhere: scopeShifts(req.user!),
      },
      req.user!.id,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /time/admin/timesheets/associate
 * Body: { associateId, weekStart: ISO, clientId? }
 *
 * The Fieldglass individual-timesheet drill-down: one associate's Sat→Fri
 * week as a day-by-day Time In / Meal Break / Time Out / Total grid.
 */
timeRouter.post('/admin/timesheets/associate', MANAGE, async (req, res, next) => {
  try {
    const parsed = TimesheetAssociateDetailInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const result = await buildAssociateTimesheetDetail(prisma, {
      associateId: parsed.data.associateId,
      weekStart: new Date(parsed.data.weekStart),
      clientId: timesheetClientId(req.user!, parsed.data.clientId),
      scopeWhere: scopeTimeEntries(req.user!),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
