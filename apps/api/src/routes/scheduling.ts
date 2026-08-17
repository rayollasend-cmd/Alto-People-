import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  AdminOpenShiftClaimListResponseSchema,
  AssociateListResponseSchema,
  AutoFillResponseSchema,
  AutoScheduleWeekInputSchema,
  AutoScheduleWeekResponseSchema,
  AvailabilityOverviewResponseSchema,
  AvailabilityExceptionCreateInputSchema,
  AvailabilityExceptionListResponseSchema,
  AvailabilityListResponseSchema,
  AvailabilityReplaceInputSchema,
  BulkCreateShiftsInputSchema,
  BulkCreateShiftsResponseSchema,
  CalendarFeedUrlResponseSchema,
  CopyWeekInputSchema,
  MyShiftDetailResponseSchema,
  MyShiftHistoryResponseSchema,
  DedupeDraftsInputSchema,
  DedupeDraftsResponseSchema,
  LaborCostReportResponseSchema,
  FloorNowResponseSchema,
  StaffingTargetInputSchema,
  StaffingTargetsResponseSchema,
  OpenShiftClaimSchema,
  OpenShiftsResponseSchema,
  PublishWeekInputSchema,
  PublishWeekResponseSchema,
  ScheduleExportInputSchema,
  ShiftAssignInputSchema,
  ShiftCancelInputSchema,
  ShiftConflictsResponseSchema,
  ShiftCreateInputSchema,
  ShiftListResponseSchema,
  ShiftSwapListResponseSchema,
  ShiftTeamCreateInputSchema,
  ShiftTeamAssignHereResponseSchema,
  ShiftTeamDetailResponseSchema,
  ShiftTeamListResponseSchema,
  ShiftTeamMemberInputSchema,
  ShiftTeamUpdateInputSchema,
  ShiftRateDefaultInputSchema,
  ShiftRateDefaultListResponseSchema,
  ShiftTemplateApplyInputSchema,
  ShiftTemplateCreateInputSchema,
  ShiftTemplateListResponseSchema,
  ShiftUpdateInputSchema,
  SwapCandidateListResponseSchema,
  SwapCreateInputSchema,
  SwapDecideInputSchema,
  TradeOptionsResponseSchema,
  type AutoFillCandidate,
  type AutoScheduleSkip,
  type AutoScheduleWeekResponse,
  type BulkCreateShiftsResponse,
  type AvailabilityWindow,
  type CopyWeekResponse,
  type PublishWeekResponse,
  type PublishWeekSkip,
  type Shift,
  type ShiftConflict,
  type ShiftListResponse,
  type ShiftSwapRequest as ShiftSwapRequestDTO,
  type ShiftTeam as ShiftTeamDTO,
  type ShiftTemplate as ShiftTemplateDTO,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import {
  associatesOfClient,
  effectiveClientIdFilter,
  scopeShifts,
  scopeTimeEntries,
} from '../lib/scope.js';

// Impossible id used to fail a mis-provisioned client-bounded caller CLOSED.
const NO_MATCH_ID = '00000000-0000-0000-0000-000000000000';
import { firstLocationForClient } from '../lib/firstLocationForClient.js';
import { enqueueAudit, recordShiftEvent } from '../lib/audit.js';
import { formatShiftLine, notifyShift } from '../lib/notifyShift.js';
import { notifyAllAdmins, notifyClientSupervisors, notifyManager } from '../lib/notify.js';
import { shiftSwapManagerTemplate } from '../lib/emailTemplates.js';
import { netWorkedMinutes, startOfWeekUTC, endOfWeekUTC } from '../lib/timeAnomalies.js';
import {
  DEFAULT_TIMEZONE,
  addDaysInZone,
  localDateKey,
  zonedDayOfWeek,
  zonedMinutes,
  zonedWallTimeToUtcInstant,
} from '../lib/timezone.js';
import {
  evaluateShiftNotice,
  isPublishingTransition,
} from '../lib/predictiveScheduling.js';
import { renderSchedulePdf } from '../lib/scheduleReport.js';
import { mintCalendarToken } from '../lib/calendarFeed.js';
import { env } from '../config/env.js';

export const schedulingRouter = Router();

const MANAGE = requireCapability('manage:scheduling');

// Reported 2026-05-02: scheduling pickers were listing every Associate
// regardless of role or status, including managers (who use a separate
// system) and terminated/uninvited people. Schedulable pool requires:
//   1. User account ACTIVE with ASSOCIATE role (excludes MANAGER, OPS,
//      HR_*, CLIENT_PORTAL, plus INVITED-but-not-yet-accepted, DISABLED).
//   2. At least one APPROVED Application — i.e. the associate has been
//      onboarded and accepted by HR. Reported 2026-05-07: pickers were
//      still showing test/junk rows whose User was ACTIVE but whose
//      onboarding was either DRAFT or never completed; mirrors the
//      `DirectoryStatus = 'ACTIVE'` derivation in /people/directory.
// Phase 131 — schedulable if there's EITHER an approved Application
// (backward-compatible legacy gate) OR an open AssociateAssignment.
// The latter catches any future case where placement diverges from
// the original application (e.g. cross-client transfer that opens an
// Assignment without re-onboarding).
//
// Schedulability comes from EMPLOYMENT, not portal-login state. This used
// to require user.status === ACTIVE, which silently hid working associates
// from every roster, grid row, and shift picker whenever their account was
// INVITED — including fully-approved people who never set a password, whom
// the resend-invite flow demotes from ACTIVE back to INVITED (reported
// 2026-07-31: a team member vanished from the week grid). Whether someone
// can LOG IN says nothing about whether they work Tuesday's shift. Only a
// deliberately DISABLED account (offboarding) hides someone; associates
// linked to management-role accounts stay out of associate rosters as
// before, and an associate with no portal account at all is schedulable.
const SCHEDULABLE_USER_FILTER: Prisma.AssociateWhereInput = {
  OR: [
    { user: null },
    { user: { is: { role: 'ASSOCIATE', status: { not: 'DISABLED' } } } },
  ],
};

const ACTIVE_ASSOCIATE_FILTER: Prisma.AssociateWhereInput = {
  deletedAt: null,
  AND: [SCHEDULABLE_USER_FILTER],
  OR: [
    { applications: { some: { status: 'APPROVED' } } },
    { assignments: { some: { endedAt: null } } },
  ],
};

type RawShift = Prisma.ShiftGetPayload<{
  include: {
    client: { select: { name: true } };
    assignedAssociate: { select: { firstName: true; lastName: true } };
    locationRel: { select: { id: true; name: true; timezone: true } };
  };
}>;

function scheduledMinutes(row: { startsAt: Date; endsAt: Date }): number {
  return Math.max(0, Math.floor((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000));
}

/**
 * True if `associateId` already has a non-cancelled shift overlapping
 * [startsAt, endsAt), excluding `excludeShiftId`. The double-booking guard
 * for /assign and swap approval — run inside the caller's transaction so
 * the check + write are atomic against a concurrent assignment.
 */
async function associateHasOverlap(
  tx: Prisma.TransactionClient | typeof prisma,
  associateId: string,
  startsAt: Date,
  endsAt: Date,
  excludeShiftId: string,
): Promise<boolean> {
  return hasOverlapExcluding(tx, associateId, startsAt, endsAt, [excludeShiftId]);
}

/** Overlap check excluding SEVERAL shifts — trades hand off two shifts at
 *  once, so each party's own half must not count against them. */
async function hasOverlapExcluding(
  tx: Prisma.TransactionClient | typeof prisma,
  associateId: string,
  startsAt: Date,
  endsAt: Date,
  excludeShiftIds: string[],
): Promise<boolean> {
  const clash = await tx.shift.findFirst({
    where: {
      id: { notIn: excludeShiftIds },
      assignedAssociateId: associateId,
      status: { notIn: ['CANCELLED'] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { id: true },
  });
  return clash !== null;
}

/**
 * `effectivePayRate` is the resolved cost rate for labor numbers: the
 * shift's own payRate when set, else the (client, position) default the
 * caller looked up via `loadRateResolver`. Callers that don't pass it get
 * the explicit rate — correct for endpoints where no defaults were loaded.
 */
function toShift(row: RawShift, effectivePayRate?: number | null): Shift {
  const explicitPay = row.payRate ? Number(row.payRate) : null;
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.client?.name ?? null,
    position: row.position,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    location: row.location,
    hourlyRate: row.hourlyRate ? Number(row.hourlyRate) : null,
    payRate: explicitPay,
    effectivePayRate:
      effectivePayRate !== undefined ? effectivePayRate : explicitPay,
    status: row.status,
    notes: row.notes,
    // Structured work-site (Phase 131) — powers the cascading
    // client→location filter and per-shift location display.
    locationId: row.locationId,
    locationName: row.locationRel?.name ?? null,
    // IANA timezone of the work site — lets the calendar render every shift
    // in the STORE's wall-clock time, not the viewer's browser zone. Falls
    // back to the deployment default for shifts without a Location yet.
    timezone: row.locationRel?.timezone ?? DEFAULT_TIMEZONE,
    assignedAssociateId: row.assignedAssociateId,
    assignedAssociateName: row.assignedAssociate
      ? `${row.assignedAssociate.firstName} ${row.assignedAssociate.lastName}`
      : null,
    assignedAt: row.assignedAt ? row.assignedAt.toISOString() : null,
    cancellationReason: row.cancellationReason,
    scheduledMinutes: scheduledMinutes(row),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    lateNoticeReason: row.lateNoticeReason,
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
  };
}

// Separator for the (clientId, position) map key. Positions are free
// text, but clientId is a fixed-length UUID that never contains ':' —
// the prefix is unambiguous, so composite keys cannot collide. (The wip
// branch this is resurrected from used a literal NUL byte here, which is
// what corrupted its scheduling.ts. Don't.)
const RATE_KEY_SEP = ':';

// Schema qualifier for raw SQL. Prisma MODEL queries emit
// schema-qualified SQL from the datasource URL, but $queryRaw relies on
// the connection's search_path — which the pooled test connection does
// not preserve, so an unqualified "Shift" silently resolves against
// `public` under `?schema=alto_test`. Qualify explicitly instead.
// Identifier-sanitized because it interpolates as raw SQL.
const DB_SCHEMA = (() => {
  try {
    const s = new URL(env.DATABASE_URL).searchParams.get('schema') ?? 'public';
    return /^[A-Za-z0-9_]+$/.test(s) ? s : 'public';
  } catch {
    return 'public';
  }
})();
const SHIFT_TBL = Prisma.raw(`"${DB_SCHEMA}"."Shift"`);
const RATE_DEFAULT_TBL = Prisma.raw(`"${DB_SCHEMA}"."ShiftRateDefault"`);
const SHIFT_POSITION_TBL = Prisma.raw(`"${DB_SCHEMA}"."ShiftPosition"`);
// The enum TYPE lives in the same schema — an unqualified cast resolves
// against search_path and mismatches the column's qualified type.
const SHIFT_STATUS_ENUM = Prisma.raw(`"${DB_SCHEMA}"."ShiftStatus"`);

/**
 * Loads the (client, position) → payRate defaults for the given clients and
 * returns a resolver: explicit shift rate wins, else the default, else null.
 * One query for the whole result set. Resurrected from
 * wip/scheduling-pay-rates.
 */
async function loadRateResolver(
  clientIds: string[],
): Promise<(clientId: string, position: string, explicit: number | null) => number | null> {
  const unique = [...new Set(clientIds)];
  const rows =
    unique.length > 0
      ? await prisma.shiftRateDefault.findMany({
          where: { clientId: { in: unique } },
          select: { clientId: true, position: true, payRate: true },
        })
      : [];
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.clientId}${RATE_KEY_SEP}${r.position}`, Number(r.payRate));
  }
  return (clientId, position, explicit) =>
    explicit ?? map.get(`${clientId}${RATE_KEY_SEP}${position}`) ?? null;
}

/** Single-row variant for create/update responses: one indexed lookup so
 *  the grid's optimistic patch carries the resolved rate immediately. */
async function withEffectiveRate(row: RawShift): Promise<Shift> {
  const explicit = row.payRate ? Number(row.payRate) : null;
  if (explicit !== null) return toShift(row, explicit);
  const def = await prisma.shiftRateDefault.findUnique({
    where: { clientId_position: { clientId: row.clientId, position: row.position } },
    select: { payRate: true },
  });
  return toShift(row, def ? Number(def.payRate) : null);
}

/** "YYYY-MM-DD" of an instant as seen in `tz` — for comparing a shift's
 *  window against day-granular records (time off, availability exceptions). */
function dayKeyInZone(d: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Which of `associateIds` can't work [startsAt, endsAt) because an APPROVED
 * time-off request or a one-off availability exception covers a store-local
 * day the window touches. Day-granular records live as UTC-midnight dates,
 * so both sides compare as calendar days in the SHIFT's zone.
 */
async function blockedForWindow(
  associateIds: string[],
  startsAt: Date,
  endsAt: Date,
  tz: string,
  // Pass the transaction client to make check+write atomic (assignment
  // paths); defaults to the pool for advisory reads.
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Set<string>> {
  if (associateIds.length === 0) return new Set();
  const startDay = new Date(`${dayKeyInZone(startsAt, tz)}T00:00:00Z`);
  const endDay = new Date(`${dayKeyInZone(endsAt, tz)}T00:00:00Z`);
  const [pto, exceptions] = await Promise.all([
    db.timeOffRequest.findMany({
      where: {
        associateId: { in: associateIds },
        status: 'APPROVED',
        startDate: { lte: endDay },
        endDate: { gte: startDay },
      },
      select: { associateId: true },
    }),
    db.availabilityException.findMany({
      where: {
        associateId: { in: associateIds },
        date: { gte: startDay, lte: endDay },
      },
      select: { associateId: true },
    }),
  ]);
  return new Set([
    ...pto.map((r) => r.associateId),
    ...exceptions.map((r) => r.associateId),
  ]);
}

const SHIFT_INCLUDE = {
  client: { select: { name: true } },
  assignedAssociate: { select: { firstName: true, lastName: true } },
  locationRel: { select: { id: true, name: true, timezone: true } },
} as const;

/**
 * For each (associate, shift-window) pair: would TAKING that shift push
 * the associate past 40h scheduled in that shift's week? One batched
 * query for the whole list. Advisory — chips the admin swap/pickup review
 * rows; the auto-scheduler has its own hard 40h gate.
 */
async function wouldExceed40hFlags(
  items: {
    associateId: string;
    startsAt: Date;
    endsAt: Date;
    /** Shifts the associate would GIVE UP in the same action (trade legs). */
    excludeShiftIds?: string[];
  }[],
): Promise<boolean[]> {
  if (items.length === 0) return [];
  const ids = [...new Set(items.map((i) => i.associateId))];
  const minStart = new Date(
    Math.min(...items.map((i) => startOfWeekUTC(i.startsAt).getTime())),
  );
  const maxEnd = new Date(
    Math.max(...items.map((i) => endOfWeekUTC(i.startsAt).getTime())),
  );
  const rows = await prisma.shift.findMany({
    where: {
      assignedAssociateId: { in: ids },
      status: { notIn: ['CANCELLED'] },
      startsAt: { gte: minStart, lt: maxEnd },
    },
    select: { id: true, assignedAssociateId: true, startsAt: true, endsAt: true },
    take: 5000,
  });
  const byKey = new Map<string, { id: string; minutes: number }[]>();
  for (const r of rows) {
    const k = `${r.assignedAssociateId}:${startOfWeekUTC(r.startsAt).getTime()}`;
    const list = byKey.get(k) ?? [];
    list.push({ id: r.id, minutes: scheduledMinutes(r) });
    byKey.set(k, list);
  }
  return items.map((i) => {
    const k = `${i.associateId}:${startOfWeekUTC(i.startsAt).getTime()}`;
    const excl = new Set(i.excludeShiftIds ?? []);
    const existing = (byKey.get(k) ?? [])
      .filter((r) => !excl.has(r.id))
      .reduce((s, r) => s + r.minutes, 0);
    return existing + scheduledMinutes(i) > 40 * 60;
  });
}

// Hard cap on the PDF export. Each row pulls a shift row + client name
// + associate name, ~400 bytes serialized; at 5000 rows that's ~2 MB
// of working set per request, well within Railway's 512 MB-ish per-
// container budget but big enough that we don't want to remove the cap
// without thinking. Callers that hit the cap get the truncated set
// with an X-Truncated header so the UI can warn the user.
const SCHEDULE_PDF_MAX_ROWS = 5000;

/* ===== HR/Ops list + CRUD =============================================== */

/** Parse an optional ISO query param; garbage → 400 instead of letting
 *  Prisma choke on Invalid Date (500). */
function parseDateParam(raw: string | undefined, name: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new HttpError(400, 'invalid_range', `\`${name}\` must be an ISO datetime`);
  }
  return d;
}

schedulingRouter.get('/shifts', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    // Tenant clamp FIRST — same fix as /kpis. Spreading the raw query param
    // after scopeShifts let a bounded caller (SHIFT_SUPERVISOR) override
    // the clamp's clientId key and read any client's schedule, drafts and
    // rates included. effectiveClientIdFilter forces bounded callers onto
    // their own client; admins keep whatever they requested.
    const clampedClient = effectiveClientIdFilter(
      req.user!,
      req.query.clientId?.toString(),
    );
    const clientId = clampedClient === null ? NO_MATCH_ID : clampedClient;
    const locationId = req.query.locationId?.toString();
    const from = parseDateParam(req.query.from?.toString(), 'from');
    const to = parseDateParam(req.query.to?.toString(), 'to');

    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      ...(status ? { status: status as Prisma.ShiftWhereInput['status'] } : {}),
      ...(clientId ? { clientId } : {}),
      // Narrow to one work-site within the client (cascading filter).
      ...(locationId ? { locationId } : {}),
      ...(from || to
        ? {
            startsAt: {
              ...(from ? { gte: from } : {}),
              // Exclusive upper bound: the client sends the next period's start
              // (next midnight) as `to`. Using `lt` (not `lte`) keeps a shift
              // that starts exactly at that boundary in the NEXT period only,
              // instead of double-counting it in both adjacent windows.
              ...(to ? { lt: to } : {}),
            },
          }
        : {}),
    };

    // Fetch one past the cap so we can tell the client the list was truncated
    // (more shifts match than we returned) without an extra count query.
    // 500 comfortably covers a large site's week (40 people × 7 shifts);
    // the calendar views render a warning banner when even this trips.
    const SHIFT_PAGE_CAP = 500;
    const rows = await prisma.shift.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: SHIFT_PAGE_CAP + 1,
      include: SHIFT_INCLUDE,
    });
    const truncated = rows.length > SHIFT_PAGE_CAP;
    const page = rows.slice(0, SHIFT_PAGE_CAP);
    // Resolve (client, position) default rates in one query so the grid's
    // labor-cost footer lights up for shifts with no explicit rate.
    const resolveRate = await loadRateResolver(page.map((r) => r.clientId));
    const payload = ShiftListResponseSchema.parse({
      shifts: page.map((r) =>
        toShift(
          r,
          resolveRate(r.clientId, r.position, r.payRate ? Number(r.payRate) : null),
        ),
      ),
      truncated,
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/kpis?from=ISO&to=ISO[&clientId=UUID]
 *
 * Phase 50 — top-of-page signal strip. Defaults to the current
 * Sunday→Saturday calendar week if from/to are missing. Returns:
 *   - openShifts        — count of OPEN status (unfilled, published)
 *   - assignedShifts    — count of ASSIGNED + COMPLETED
 *   - totalShifts       — non-cancelled count in the window
 *   - fillRatePercent   — assigned ÷ (assigned + open), 0-100
 *   - totalScheduledMinutes — sum of (endsAt - startsAt) for non-cancelled
 *
 * groupBy keeps this O(1 query) regardless of the window size.
 */
schedulingRouter.get('/kpis', MANAGE, async (req, res, next) => {
  try {
    const clientId = req.query.clientId?.toString();
    const fromParam = req.query.from?.toString();
    const toParam = req.query.to?.toString();
    const now = new Date();
    // Default window: Sunday 00:00 → next Sunday 00:00 (local time).
    const defaultFrom = new Date(now);
    defaultFrom.setHours(0, 0, 0, 0);
    defaultFrom.setDate(defaultFrom.getDate() - defaultFrom.getDay());
    const defaultTo = new Date(defaultFrom);
    defaultTo.setDate(defaultTo.getDate() + 7);
    const from = parseDateParam(fromParam, 'from') ?? defaultFrom;
    const to = parseDateParam(toParam, 'to') ?? defaultTo;

    // Tenant clamp FIRST — the old spread let a bounded caller's clientId
    // query param override scopeShifts' clamp (cross-tenant KPI read).
    const kpiClientId = effectiveClientIdFilter(req.user!, clientId);
    const effectiveKpiClient = kpiClientId === null ? NO_MATCH_ID : kpiClientId;
    const scope = scopeShifts(req.user!);
    const where: Prisma.ShiftWhereInput = {
      ...scope,
      ...(effectiveKpiClient ? { clientId: effectiveKpiClient } : {}),
      startsAt: { gte: from, lt: to },
      status: { not: 'CANCELLED' },
    };

    // PERF: minutes + labor cost summed in SQL. The old rollup paged up to
    // 50k rows through the app (5–50 sequential batch queries per KPI-strip
    // render) to compute three numbers. Conditions mirror `where` exactly.
    // Columns are qualified with the `s` alias — the rate-default LEFT
    // JOIN below also carries a "clientId", which would otherwise make
    // the bare column ambiguous.
    const conds: Prisma.Sql[] = [
      Prisma.sql`s."startsAt" >= ${from}`,
      Prisma.sql`s."startsAt" < ${to}`,
      Prisma.sql`s."status" <> 'CANCELLED'::${SHIFT_STATUS_ENUM}`,
    ];
    if (effectiveKpiClient) {
      conds.push(Prisma.sql`s."clientId" = ${effectiveKpiClient}::uuid`);
    }
    // ASSOCIATE scope (published + own shifts) — mirrors scopeShifts.
    const assocScope = scope as { assignedAssociateId?: string; publishedAt?: unknown };
    if (assocScope.assignedAssociateId) {
      conds.push(Prisma.sql`s."assignedAssociateId" = ${assocScope.assignedAssociateId}::uuid`);
      conds.push(Prisma.sql`s."publishedAt" IS NOT NULL`);
    }

    const [grouped, [rollup]] = await Promise.all([
      prisma.shift.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      // Labor cost resolves each shift's rate as: explicit payRate, else
      // the (client, position) ShiftRateDefault, else the org-wide
      // standard ($15/hr associate, $18/hr lead by position flag).
      // Identical resolution to /labor-costs, so the strip and the report
      // agree. `norate` counts only shifts nothing covers (fallbacks
      // disabled via env = 0).
      prisma.$queryRaw<
        [{ minutes: bigint | null; cost: number | null; norate: bigint | null }]
      >(Prisma.sql`
        SELECT
          COALESCE(SUM(GREATEST(0, ROUND(EXTRACT(EPOCH FROM (s."endsAt" - s."startsAt")) / 60))), 0)::bigint AS minutes,
          COALESCE(SUM(
            CASE WHEN COALESCE(s."payRate", d."payRate",
                CASE WHEN COALESCE(p."isLead", false) THEN ${
                  env.DEFAULT_LEAD_PAY_RATE > 0 ? env.DEFAULT_LEAD_PAY_RATE : null
                }::numeric ELSE ${
                  env.DEFAULT_ASSOCIATE_PAY_RATE > 0 ? env.DEFAULT_ASSOCIATE_PAY_RATE : null
                }::numeric END
              ) IS NOT NULL
              THEN COALESCE(s."payRate", d."payRate",
                CASE WHEN COALESCE(p."isLead", false) THEN ${
                  env.DEFAULT_LEAD_PAY_RATE > 0 ? env.DEFAULT_LEAD_PAY_RATE : null
                }::numeric ELSE ${
                  env.DEFAULT_ASSOCIATE_PAY_RATE > 0 ? env.DEFAULT_ASSOCIATE_PAY_RATE : null
                }::numeric END
              ) * GREATEST(0, ROUND(EXTRACT(EPOCH FROM (s."endsAt" - s."startsAt")) / 60)) / 60
              ELSE 0 END
          ), 0)::float8 AS cost,
          COUNT(*) FILTER (WHERE COALESCE(s."payRate", d."payRate",
            CASE WHEN COALESCE(p."isLead", false) THEN ${
              env.DEFAULT_LEAD_PAY_RATE > 0 ? env.DEFAULT_LEAD_PAY_RATE : null
            }::numeric ELSE ${
              env.DEFAULT_ASSOCIATE_PAY_RATE > 0 ? env.DEFAULT_ASSOCIATE_PAY_RATE : null
            }::numeric END
          ) IS NULL)::bigint AS norate
        FROM ${SHIFT_TBL} s
        LEFT JOIN ${RATE_DEFAULT_TBL} d
          ON d."clientId" = s."clientId" AND d."position" = s."position"
        LEFT JOIN ${SHIFT_POSITION_TBL} p
          ON p."clientId" = s."clientId" AND p."name" = s."position" AND p."deletedAt" IS NULL
        WHERE ${Prisma.join(conds, ' AND ')}
      `),
    ]);
    const totalScheduledMinutes = Number(rollup?.minutes ?? 0);
    const shiftsWithoutRate = Number(rollup?.norate ?? 0);
    // Round to cents — JSON floats survive 2dp safely; the UI formats as $.
    const projectedLaborCost = Math.round(Number(rollup?.cost ?? 0) * 100) / 100;

    let openShifts = 0;
    let assignedShifts = 0;
    let draftShifts = 0;
    let completedShifts = 0;
    for (const g of grouped) {
      if (g.status === 'OPEN') openShifts = g._count._all;
      else if (g.status === 'ASSIGNED') assignedShifts = g._count._all;
      else if (g.status === 'DRAFT') draftShifts = g._count._all;
      else if (g.status === 'COMPLETED') completedShifts = g._count._all;
    }
    const filled = assignedShifts + completedShifts;
    const fillBase = filled + openShifts;
    const fillRatePercent = fillBase === 0 ? 0 : Math.round((filled / fillBase) * 100);

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      openShifts,
      assignedShifts,
      draftShifts,
      completedShifts,
      totalShifts: openShifts + assignedShifts + draftShifts + completedShifts,
      fillRatePercent,
      totalScheduledMinutes,
      projectedLaborCost,
      shiftsWithoutRate,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/labor-costs?from=ISO&to=ISO&clientId?&locationId?
 *
 * Day-by-day labor cost, one row per (site-local day, client, store):
 * the SCHEDULED side prices each non-cancelled shift at its explicit
 * payRate else the (client, position) rate default — identical resolution
 * to the KPI strip above — and the WORKED side prices each COMPLETED or
 * APPROVED time entry (net of breaks) at the payRate snapshotted at
 * clock-in. Rows with no resolvable rate are counted per bucket so a $0
 * cell reads as "rates missing", never as "free labor".
 *
 * MANAGE + the usual tenant clamp: supervisors get their own client only
 * (they already see per-shift rates), org roles see everything.
 */
schedulingRouter.get('/labor-costs', MANAGE, async (req, res, next) => {
  try {
    const from = parseDateParam(req.query.from?.toString(), 'from');
    const to = parseDateParam(req.query.to?.toString(), 'to');
    if (!from || !to || to <= from) {
      throw new HttpError(400, 'invalid_range', 'from and to (exclusive, after from) are required.');
    }
    if (to.getTime() - from.getTime() > 92 * 86_400_000) {
      throw new HttpError(400, 'range_too_wide', 'Limit the report to 92 days or fewer.');
    }
    const clamped = effectiveClientIdFilter(req.user!, req.query.clientId?.toString());
    const costClientId = clamped === null ? NO_MATCH_ID : clamped;
    const locationId = req.query.locationId?.toString();

    const SHIFT_CAP = 10_000;
    const PUNCH_CAP = 20_000;
    const [shiftRows, entryRows] = await Promise.all([
      prisma.shift.findMany({
        take: SHIFT_CAP + 1,
        where: {
          ...scopeShifts(req.user!),
          ...(costClientId ? { clientId: costClientId } : {}),
          ...(locationId ? { locationId } : {}),
          status: { not: 'CANCELLED' },
          startsAt: { gte: from, lt: to },
        },
        select: {
          clientId: true,
          locationId: true,
          position: true,
          startsAt: true,
          endsAt: true,
          payRate: true,
          // Bill rate for the revenue side — the create dialog labels
          // hourlyRate "Bill rate /hr".
          hourlyRate: true,
          assignedAssociateId: true,
          client: { select: { name: true } },
          locationRel: { select: { name: true, timezone: true } },
        },
      }),
      prisma.timeEntry.findMany({
        take: PUNCH_CAP + 1,
        where: {
          ...scopeTimeEntries(req.user!),
          ...(costClientId ? { clientId: costClientId } : {}),
          ...(locationId ? { locationId } : {}),
          status: { in: ['COMPLETED', 'APPROVED'] },
          clockInAt: { gte: from, lt: to },
        },
        select: {
          clientId: true,
          locationId: true,
          clockInAt: true,
          clockOutAt: true,
          payRate: true,
          breaks: { select: { startedAt: true, endedAt: true } },
        },
      }),
    ]);
    const truncated = shiftRows.length > SHIFT_CAP || entryRows.length > PUNCH_CAP;
    const shifts = shiftRows.slice(0, SHIFT_CAP);
    const entries = entryRows.slice(0, PUNCH_CAP);

    // Rate defaults for the scheduled fallback — pay (cost) AND bill
    // (revenue) sides — plus the positions' lead flags for the
    // lead-vs-associate split, and each store's effective staffing target.
    const shiftClientIds = [...new Set(shifts.map((s) => s.clientId))];
    const shiftLocationIds = [
      ...new Set(shifts.map((s) => s.locationId).filter((l): l is string => !!l)),
    ];
    const [rateDefaults, leadPositions, targetRows] = await Promise.all([
      shiftClientIds.length
        ? prisma.shiftRateDefault.findMany({
            where: { clientId: { in: shiftClientIds } },
            select: { clientId: true, position: true, payRate: true, billRate: true },
          })
        : Promise.resolve([]),
      shiftClientIds.length
        ? prisma.shiftPosition.findMany({
            where: { clientId: { in: shiftClientIds }, deletedAt: null, isLead: true },
            select: { clientId: true, name: true },
          })
        : Promise.resolve([]),
      shiftLocationIds.length
        ? prisma.staffingTarget.findMany({
            where: { locationId: { in: shiftLocationIds }, effectiveFrom: { lt: to } },
            orderBy: { effectiveFrom: 'desc' },
            select: { locationId: true, targetCount: true, effectiveFrom: true },
          })
        : Promise.resolve([]),
    ]);
    const defaultRate = new Map(
      rateDefaults.map((d) => [`${d.clientId}|${d.position}`, Number(d.payRate)]),
    );
    const defaultBillRate = new Map(
      rateDefaults
        .filter((d) => d.billRate != null)
        .map((d) => [`${d.clientId}|${d.position}`, Number(d.billRate)]),
    );
    const leadSet = new Set(leadPositions.map((p) => `${p.clientId}|${p.name}`));
    // Targets per location, newest-first — the effective target for a day
    // is the first row whose effectiveFrom (a plain date) is <= that day.
    const targetsByLocation = new Map<
      string,
      Array<{ from: string; count: number }>
    >();
    for (const t of targetRows) {
      const arr = targetsByLocation.get(t.locationId) ?? [];
      arr.push({ from: t.effectiveFrom.toISOString().slice(0, 10), count: t.targetCount });
      targetsByLocation.set(t.locationId, arr);
    }
    const targetFor = (locationId: string | null, date: string): number | null => {
      if (!locationId) return null;
      const arr = targetsByLocation.get(locationId);
      if (!arr) return null;
      const hit = arr.find((t) => t.from <= date);
      return hit ? hit.count : null;
    };

    // Names + timezones for the entries' clients/locations (shifts carry
    // their own joins).
    const entryClientIds = [...new Set(entries.map((e) => e.clientId).filter((c): c is string => !!c))];
    const entryLocationIds = [...new Set(entries.map((e) => e.locationId).filter((l): l is string => !!l))];
    const [entryClients, entryLocations] = await Promise.all([
      entryClientIds.length
        ? prisma.client.findMany({
            where: { id: { in: entryClientIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      entryLocationIds.length
        ? prisma.location.findMany({
            where: { id: { in: entryLocationIds } },
            select: { id: true, name: true, timezone: true },
          })
        : Promise.resolve([]),
    ]);
    const clientNameById = new Map(entryClients.map((c) => [c.id, c.name]));
    const locationById = new Map(entryLocations.map((l) => [l.id, l]));

    interface Bucket {
      date: string;
      clientId: string | null;
      clientName: string | null;
      locationId: string | null;
      locationName: string | null;
      scheduledShifts: number;
      scheduledMinutes: number;
      scheduledCost: number;
      scheduledNoRate: number;
      workedPunches: number;
      workedMinutes: number;
      workedCost: number;
      workedNoRate: number;
      heads: Set<string>;
      leadHeadIds: Set<string>;
      leadMinutes: number;
      leadCost: number;
      associateMinutes: number;
      associateCost: number;
      scheduledRevenue: number;
      revenueNoRate: number;
    }
    const buckets = new Map<string, Bucket>();
    const bucketFor = (
      date: string,
      clientId: string | null,
      clientName: string | null,
      locId: string | null,
      locName: string | null,
    ): Bucket => {
      const key = `${date}|${clientId ?? ''}|${locId ?? ''}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          date,
          clientId,
          clientName,
          locationId: locId,
          locationName: locName,
          scheduledShifts: 0,
          scheduledMinutes: 0,
          scheduledCost: 0,
          scheduledNoRate: 0,
          workedPunches: 0,
          workedMinutes: 0,
          workedCost: 0,
          workedNoRate: 0,
          heads: new Set<string>(),
          leadHeadIds: new Set<string>(),
          leadMinutes: 0,
          leadCost: 0,
          associateMinutes: 0,
          associateCost: 0,
          scheduledRevenue: 0,
          revenueNoRate: 0,
        };
        buckets.set(key, b);
      }
      return b;
    };

    for (const s of shifts) {
      const tz = s.locationRel?.timezone ?? DEFAULT_TIMEZONE;
      const b = bucketFor(
        localDateKey(s.startsAt, tz),
        s.clientId,
        s.client?.name ?? null,
        s.locationId,
        s.locationRel?.name ?? null,
      );
      const minutes = Math.max(
        0,
        Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000),
      );
      const posKey = `${s.clientId}|${s.position}`;
      const isLead = leadSet.has(posKey);
      // Resolution order: the shift's own rate → the (client, position)
      // default → the org-wide standards ($15/hr associate, $18/hr lead
      // pay; SOW bill rates $21.21 associate / $24.24 lead).
      const fallbackPay = isLead
        ? env.DEFAULT_LEAD_PAY_RATE
        : env.DEFAULT_ASSOCIATE_PAY_RATE;
      const rate =
        s.payRate != null
          ? Number(s.payRate)
          : defaultRate.get(posKey) ?? (fallbackPay > 0 ? fallbackPay : undefined);
      const fallbackBill = isLead
        ? env.DEFAULT_LEAD_BILL_RATE
        : env.DEFAULT_ASSOCIATE_BILL_RATE;
      const billRate =
        s.hourlyRate != null
          ? Number(s.hourlyRate)
          : defaultBillRate.get(posKey) ?? (fallbackBill > 0 ? fallbackBill : undefined);
      const cost = rate != null ? (minutes / 60) * rate : 0;
      b.scheduledShifts += 1;
      b.scheduledMinutes += minutes;
      if (rate != null) b.scheduledCost += cost;
      else b.scheduledNoRate += 1;
      if (billRate != null) b.scheduledRevenue += (minutes / 60) * billRate;
      else b.revenueNoRate += 1;
      if (isLead) {
        b.leadMinutes += minutes;
        b.leadCost += cost;
      } else {
        b.associateMinutes += minutes;
        b.associateCost += cost;
      }
      if (s.assignedAssociateId) {
        b.heads.add(s.assignedAssociateId);
        if (isLead) b.leadHeadIds.add(s.assignedAssociateId);
      }
    }

    for (const e of entries) {
      const loc = e.locationId ? locationById.get(e.locationId) : undefined;
      const tz = loc?.timezone ?? DEFAULT_TIMEZONE;
      const b = bucketFor(
        localDateKey(e.clockInAt, tz),
        e.clientId,
        e.clientId ? clientNameById.get(e.clientId) ?? null : null,
        e.locationId,
        loc?.name ?? null,
      );
      let minutes = 0;
      if (e.clockOutAt) {
        const end = e.clockOutAt.getTime();
        let ms = end - e.clockInAt.getTime();
        for (const br of e.breaks) {
          const brEnd = br.endedAt ? br.endedAt.getTime() : end;
          ms -= Math.max(0, brEnd - br.startedAt.getTime());
        }
        minutes = Math.max(0, Math.round(ms / 60_000));
      }
      b.workedPunches += 1;
      b.workedMinutes += minutes;
      if (e.payRate != null) b.workedCost += (minutes / 60) * Number(e.payRate);
      else b.workedNoRate += 1;
    }

    const rows = [...buckets.values()]
      .map(({ heads, leadHeadIds, ...b }) => ({
        ...b,
        scheduledCost: Math.round(b.scheduledCost * 100) / 100,
        workedCost: Math.round(b.workedCost * 100) / 100,
        leadCost: Math.round(b.leadCost * 100) / 100,
        associateCost: Math.round(b.associateCost * 100) / 100,
        scheduledRevenue: Math.round(b.scheduledRevenue * 100) / 100,
        scheduledHeads: heads.size,
        leadHeads: leadHeadIds.size,
        // "Lead if ANY of their day's shifts is a lead shift" — leadHeadIds
        // is a subset of heads, so the remainder are regular associates.
        associateHeads: heads.size - leadHeadIds.size,
        targetHeads: targetFor(b.locationId, b.date),
      }))
      .sort(
        (a, z) =>
          a.date.localeCompare(z.date) ||
          (a.clientName ?? '').localeCompare(z.clientName ?? '') ||
          (a.locationName ?? '').localeCompare(z.locationName ?? ''),
      );

    res.json(
      LaborCostReportResponseSchema.parse({
        rows,
        truncated,
        fallbacks: {
          associatePayRate:
            env.DEFAULT_ASSOCIATE_PAY_RATE > 0 ? env.DEFAULT_ASSOCIATE_PAY_RATE : null,
          leadPayRate: env.DEFAULT_LEAD_PAY_RATE > 0 ? env.DEFAULT_LEAD_PAY_RATE : null,
          associateBillRate:
            env.DEFAULT_ASSOCIATE_BILL_RATE > 0 ? env.DEFAULT_ASSOCIATE_BILL_RATE : null,
          leadBillRate:
            env.DEFAULT_LEAD_BILL_RATE > 0 ? env.DEFAULT_LEAD_BILL_RATE : null,
        },
      }),
    );
  } catch (err) {
    next(err);
  }
});

/* ===== Staffing targets (expected floor headcount per store) ============ */

/**
 * GET /scheduling/staffing-targets
 * Every in-scope store with its CURRENT effective target (null when never
 * set). Bounded roles see their own client's stores only.
 */
schedulingRouter.get('/staffing-targets', MANAGE, async (req, res, next) => {
  try {
    const clamped = effectiveClientIdFilter(req.user!, req.query.clientId?.toString());
    const stClientId = clamped === null ? NO_MATCH_ID : clamped;
    const locations = await prisma.location.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        ...(stClientId ? { clientId: stClientId } : {}),
      },
      select: { id: true, name: true, clientId: true, client: { select: { name: true } } },
      orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
      take: 500,
    });
    const targets = locations.length
      ? await prisma.staffingTarget.findMany({
          where: {
            locationId: { in: locations.map((l) => l.id) },
            effectiveFrom: { lte: new Date() },
          },
          orderBy: { effectiveFrom: 'desc' },
          select: {
            locationId: true,
            targetCount: true,
            effectiveFrom: true,
            label: true,
            startMinute: true,
            endMinute: true,
          },
        })
      : [];
    // Effective-dating applies PER LABEL (null label = the total floor
    // target): rows arrive newest-first, first hit per (location, label)
    // wins.
    const currentByLocation = new Map<string, { targetCount: number; effectiveFrom: string }>();
    const windowsByLocation = new Map<
      string,
      Map<string, { label: string; startMinute: number; endMinute: number; targetCount: number; effectiveFrom: string }>
    >();
    for (const t of targets) {
      const ymdFrom = t.effectiveFrom.toISOString().slice(0, 10);
      if (t.label === null) {
        if (!currentByLocation.has(t.locationId)) {
          currentByLocation.set(t.locationId, {
            targetCount: t.targetCount,
            effectiveFrom: ymdFrom,
          });
        }
      } else if (t.startMinute !== null && t.endMinute !== null) {
        const m = windowsByLocation.get(t.locationId) ?? new Map();
        if (!m.has(t.label)) {
          m.set(t.label, {
            label: t.label,
            startMinute: t.startMinute,
            endMinute: t.endMinute,
            targetCount: t.targetCount,
            effectiveFrom: ymdFrom,
          });
        }
        windowsByLocation.set(t.locationId, m);
      }
    }
    res.json(
      StaffingTargetsResponseSchema.parse({
        locations: locations.map((l) => ({
          locationId: l.id,
          locationName: l.name,
          clientId: l.clientId,
          clientName: l.client.name,
          targetCount: currentByLocation.get(l.id)?.targetCount ?? null,
          effectiveFrom: currentByLocation.get(l.id)?.effectiveFrom ?? null,
          windows: [...(windowsByLocation.get(l.id)?.values() ?? [])].sort(
            (a, b) => a.startMinute - b.startMinute,
          ),
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/staffing-targets
 * Records a NEW effective-dated target row — never edits history, so past
 * days keep being judged by the target that applied then, and the row
 * trail is the audit of when coverage expectations changed.
 */
schedulingRouter.post('/staffing-targets', MANAGE, async (req, res, next) => {
  try {
    const parsed = StaffingTargetInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const clamped = effectiveClientIdFilter(req.user!, undefined);
    const location = await prisma.location.findFirst({
      where: {
        id: parsed.data.locationId,
        deletedAt: null,
        ...(clamped !== undefined
          ? { clientId: clamped ?? NO_MATCH_ID }
          : {}),
      },
      select: { id: true, clientId: true, name: true },
    });
    if (!location) throw new HttpError(404, 'location_not_found', 'Location not found');

    const effectiveFrom = parsed.data.effectiveFrom
      ? new Date(`${parsed.data.effectiveFrom}T00:00:00.000Z`)
      : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const created = await prisma.staffingTarget.create({
      data: {
        locationId: location.id,
        targetCount: parsed.data.targetCount,
        effectiveFrom,
        label: parsed.data.label ?? null,
        startMinute: parsed.data.startMinute ?? null,
        endMinute: parsed.data.endMinute ?? null,
        note: parsed.data.note ?? null,
        createdById: req.user!.id,
      },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId: location.clientId,
        action: 'scheduling.staffing_target_set',
        entityType: 'StaffingTarget',
        entityId: created.id,
        metadata: {
          locationId: location.id,
          locationName: location.name,
          targetCount: created.targetCount,
          ...(created.label
            ? {
                window: created.label,
                startMinute: created.startMinute,
                endMinute: created.endMinute,
              }
            : {}),
          effectiveFrom: created.effectiveFrom.toISOString().slice(0, 10),
        },
      },
      'scheduling.staffing_target_set',
    );
    res.status(201).json({
      id: created.id,
      locationId: created.locationId,
      targetCount: created.targetCount,
      effectiveFrom: created.effectiveFrom.toISOString().slice(0, 10),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/floor-now
 *
 * The live comparison the targets exist for: how many people are clocked
 * in at each store RIGHT NOW (ACTIVE time entries) versus the expected
 * headcount — the shift window covering the store's local time when one
 * is defined, else the total floor target. Tenant-clamped like everything
 * else here.
 */
schedulingRouter.get('/floor-now', MANAGE, async (req, res, next) => {
  try {
    const clamped = effectiveClientIdFilter(req.user!, req.query.clientId?.toString());
    const fnClientId = clamped === null ? NO_MATCH_ID : clamped;
    const locations = await prisma.location.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        ...(fnClientId ? { clientId: fnClientId } : {}),
      },
      select: {
        id: true,
        name: true,
        clientId: true,
        timezone: true,
        client: { select: { name: true } },
      },
      orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
      take: 500,
    });
    if (locations.length === 0) {
      res.json(
        FloorNowResponseSchema.parse({ rows: [], generatedAt: new Date().toISOString() }),
      );
      return;
    }
    const ids = locations.map((l) => l.id);
    const now = new Date();
    const [activeEntries, targets] = await Promise.all([
      prisma.timeEntry.findMany({
        where: {
          status: 'ACTIVE',
          locationId: { in: ids },
          ...scopeTimeEntries(req.user!),
        },
        select: {
          associateId: true,
          locationId: true,
          clockInAt: true,
          payRate: true,
          breaks: { select: { startedAt: true, endedAt: true } },
        },
        take: 2000,
      }),
      prisma.staffingTarget.findMany({
        where: { locationId: { in: ids }, effectiveFrom: { lte: now } },
        orderBy: { effectiveFrom: 'desc' },
        select: {
          locationId: true,
          targetCount: true,
          label: true,
          startMinute: true,
          endMinute: true,
        },
      }),
    ]);

    /* Live labor accrual. Elapsed minutes per clocked-in person (net of
     * breaks, open break counted to now) × their snapshotted pay rate
     * (else the org standard), with OT at 1.5×. The OT check is WEEKLY
     * and CROSS-CLIENT on purpose — the classic trap: Destin Mon–Wed +
     * PCB Thu–Sat puts Saturday in OT wherever it's worked, so week-to-
     * date sums every site's hours, deliberately unclamped by tenant
     * (it only feeds a multiplier; no other tenant's data is exposed).
     * Billing uses the associate SOW rate (live punches carry no
     * position, so lead billing upside is understated, never overstated);
     * OT bills at 1.5× too ($31.82 on $21.21). */
    const netElapsedMinutes = (e: {
      clockInAt: Date;
      clockOutAt?: Date | null;
      breaks: Array<{ startedAt: Date; endedAt: Date | null }>;
    }): number => {
      const end = (e.clockOutAt ?? now).getTime();
      let ms = end - e.clockInAt.getTime();
      for (const b of e.breaks) {
        const bEnd = b.endedAt ? b.endedAt.getTime() : end;
        ms -= Math.max(0, bEnd - b.startedAt.getTime());
      }
      return Math.max(0, ms / 60_000);
    };
    const activeAssociateIds = [...new Set(activeEntries.map((e) => e.associateId))];
    const weekEntries = activeAssociateIds.length
      ? await prisma.timeEntry.findMany({
          where: {
            associateId: { in: activeAssociateIds },
            status: { in: ['ACTIVE', 'COMPLETED', 'APPROVED'] },
            clockInAt: { gte: startOfWeekUTC(now) },
          },
          select: {
            associateId: true,
            clockInAt: true,
            clockOutAt: true,
            breaks: { select: { startedAt: true, endedAt: true } },
          },
          take: 20_000,
        })
      : [];
    const weekMinutes = new Map<string, number>();
    for (const e of weekEntries) {
      weekMinutes.set(
        e.associateId,
        (weekMinutes.get(e.associateId) ?? 0) + netElapsedMinutes(e),
      );
    }
    const OT_THRESHOLD_MIN = 40 * 60;
    const burdenMult = 1 + env.LABOR_BURDEN_PERCENT / 100;
    const overhead = env.LABOR_OVERHEAD_PER_HOUR;

    interface LiveAgg {
      count: number;
      wagePerHour: number;
      billedPerHour: number;
      wageSoFar: number;
      billedSoFar: number;
      elapsedHours: number;
      otHeads: number;
    }
    const liveByLocation = new Map<string, LiveAgg>();
    for (const e of activeEntries) {
      if (!e.locationId) continue;
      const agg = liveByLocation.get(e.locationId) ?? {
        count: 0,
        wagePerHour: 0,
        billedPerHour: 0,
        wageSoFar: 0,
        billedSoFar: 0,
        elapsedHours: 0,
        otHeads: 0,
      };
      const elapsed = netElapsedMinutes(e);
      const wtd = weekMinutes.get(e.associateId) ?? elapsed;
      // The tail of THIS punch that sits past the weekly threshold.
      const otMin = Math.max(0, Math.min(elapsed, wtd - OT_THRESHOLD_MIN));
      const regMin = elapsed - otMin;
      const rate =
        e.payRate != null
          ? Number(e.payRate)
          : env.DEFAULT_ASSOCIATE_PAY_RATE > 0
            ? env.DEFAULT_ASSOCIATE_PAY_RATE
            : 0;
      const billRate =
        env.DEFAULT_ASSOCIATE_BILL_RATE > 0 ? env.DEFAULT_ASSOCIATE_BILL_RATE : 0;
      const inOtNow = wtd >= OT_THRESHOLD_MIN;
      agg.count += 1;
      agg.elapsedHours += elapsed / 60;
      agg.wageSoFar += (regMin / 60) * rate + (otMin / 60) * rate * 1.5;
      agg.billedSoFar += (regMin / 60) * billRate + (otMin / 60) * billRate * 1.5;
      agg.wagePerHour += rate * (inOtNow ? 1.5 : 1);
      agg.billedPerHour += billRate * (inOtNow ? 1.5 : 1);
      if (inOtNow) agg.otHeads += 1;
      liveByLocation.set(e.locationId, agg);
    }
    const clockedByLocation = new Map(
      [...liveByLocation.entries()].map(([k, v]) => [k, v.count]),
    );
    const totalByLocation = new Map<string, number>();
    const windowsByLocation = new Map<
      string,
      Map<string, { label: string; startMinute: number; endMinute: number; targetCount: number }>
    >();
    for (const t of targets) {
      if (t.label === null) {
        if (!totalByLocation.has(t.locationId)) {
          totalByLocation.set(t.locationId, t.targetCount);
        }
      } else if (t.startMinute !== null && t.endMinute !== null) {
        const m = windowsByLocation.get(t.locationId) ?? new Map();
        if (!m.has(t.label)) {
          m.set(t.label, {
            label: t.label,
            startMinute: t.startMinute,
            endMinute: t.endMinute,
            targetCount: t.targetCount,
          });
        }
        windowsByLocation.set(t.locationId, m);
      }
    }
    // end <= start wraps past midnight (ShiftTemplate convention).
    const inWindow = (
      minute: number,
      w: { startMinute: number; endMinute: number },
    ): boolean =>
      w.endMinute > w.startMinute
        ? minute >= w.startMinute && minute < w.endMinute
        : minute >= w.startMinute || minute < w.endMinute;

    const rows = locations
      .map((l) => {
        const minute = zonedMinutes(now, l.timezone ?? DEFAULT_TIMEZONE);
        const windows = [...(windowsByLocation.get(l.id)?.values() ?? [])].sort(
          (a, b) => a.startMinute - b.startMinute,
        );
        const hit = windows.find((w) => inWindow(minute, w)) ?? null;
        const total = totalByLocation.get(l.id) ?? null;
        const live = liveByLocation.get(l.id);
        const round2 = (v: number) => Math.round(v * 100) / 100;
        return {
          locationId: l.id,
          locationName: l.name,
          clientId: l.clientId,
          clientName: l.client.name,
          clockedIn: clockedByLocation.get(l.id) ?? 0,
          expected: hit ? hit.targetCount : total,
          windowLabel: hit ? hit.label : null,
          totalTarget: total,
          wagePerHour: round2(live?.wagePerHour ?? 0),
          loadedPerHour: round2(
            (live?.wagePerHour ?? 0) * burdenMult + overhead * (live?.count ?? 0),
          ),
          billedPerHour: round2(live?.billedPerHour ?? 0),
          wageSoFar: round2(live?.wageSoFar ?? 0),
          loadedSoFar: round2(
            (live?.wageSoFar ?? 0) * burdenMult + overhead * (live?.elapsedHours ?? 0),
          ),
          billedSoFar: round2(live?.billedSoFar ?? 0),
          otHeads: live?.otHeads ?? 0,
        };
      })
      // Quiet stores with no expectation and nobody in stay off the board.
      .filter((r) => r.clockedIn > 0 || r.expected !== null);
    res.json(
      FloorNowResponseSchema.parse({
        rows,
        generatedAt: now.toISOString(),
        burden: {
          percent: env.LABOR_BURDEN_PERCENT,
          overheadPerHour: env.LABOR_OVERHEAD_PER_HOUR,
        },
      }),
    );
  } catch (err) {
    next(err);
  }
});

/* ===== Pay-rate defaults per (client, position) ========================= */

/**
 * GET /scheduling/rate-defaults?clientId=UUID
 *
 * The (client, position) → rate table the labor-cost numbers resolve
 * from, plus the client's position catalog so the editor can offer a row
 * per known position. Bounded callers (SHIFT_SUPERVISOR) are clamped to
 * their own client.
 */
schedulingRouter.get('/rate-defaults', MANAGE, async (req, res, next) => {
  try {
    const requested = req.query.clientId?.toString();
    if (!requested) {
      throw new HttpError(400, 'client_required', 'clientId is required.');
    }
    const clamped = effectiveClientIdFilter(req.user!, requested);
    const clientId = clamped === null ? NO_MATCH_ID : (clamped ?? requested);
    const [defaults, positions] = await Promise.all([
      prisma.shiftRateDefault.findMany({
        where: { clientId },
        orderBy: { position: 'asc' },
      }),
      prisma.shiftPosition.findMany({
        where: { clientId, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
        select: { name: true },
      }),
    ]);
    res.json(
      ShiftRateDefaultListResponseSchema.parse({
        rateDefaults: defaults.map((d) => ({
          id: d.id,
          clientId: d.clientId,
          position: d.position,
          payRate: Number(d.payRate),
          billRate: d.billRate ? Number(d.billRate) : null,
        })),
        positions: positions.map((p) => p.name),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /scheduling/rate-defaults — upsert one (client, position) rate.
 * Bounded callers may only write their own client; anything else is a
 * 404 (not 403) so client ids can't be probed.
 */
schedulingRouter.put('/rate-defaults', MANAGE, async (req, res, next) => {
  try {
    const input = ShiftRateDefaultInputSchema.parse(req.body);
    const clamp = effectiveClientIdFilter(req.user!, input.clientId);
    if (clamp !== undefined && clamp !== input.clientId) {
      throw new HttpError(404, 'client_not_found', 'Client not found.');
    }
    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
      select: { id: true },
    });
    if (!client) {
      throw new HttpError(404, 'client_not_found', 'Client not found.');
    }
    const position = input.position.trim();
    const saved = await prisma.shiftRateDefault.upsert({
      where: { clientId_position: { clientId: input.clientId, position } },
      create: {
        clientId: input.clientId,
        position,
        payRate: input.payRate,
        billRate: input.billRate ?? null,
      },
      update: {
        payRate: input.payRate,
        billRate: input.billRate ?? null,
      },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'scheduling.rate_default_upserted',
        entityType: 'ShiftRateDefault',
        entityId: saved.id,
        metadata: {
          clientId: saved.clientId,
          position: saved.position,
          payRate: Number(saved.payRate),
          billRate: saved.billRate ? Number(saved.billRate) : null,
        },
      },
      'scheduling.rate_default_upserted',
    );
    res.json({
      id: saved.id,
      clientId: saved.clientId,
      position: saved.position,
      payRate: Number(saved.payRate),
      billRate: saved.billRate ? Number(saved.billRate) : null,
    });
  } catch (err) {
    next(err);
  }
});

/** DELETE /scheduling/rate-defaults/:id — remove a default (shifts with
 *  explicit rates keep them; rate-less shifts go back to $0). */
schedulingRouter.delete('/rate-defaults/:id', MANAGE, async (req, res, next) => {
  try {
    const row = await prisma.shiftRateDefault.findUnique({
      where: { id: req.params.id },
    });
    if (!row) {
      throw new HttpError(404, 'rate_default_not_found', 'Rate default not found.');
    }
    const clamp = effectiveClientIdFilter(req.user!, row.clientId);
    if (clamp !== undefined && clamp !== row.clientId) {
      throw new HttpError(404, 'rate_default_not_found', 'Rate default not found.');
    }
    await prisma.shiftRateDefault.delete({ where: { id: row.id } });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'scheduling.rate_default_deleted',
        entityType: 'ShiftRateDefault',
        entityId: row.id,
        metadata: { clientId: row.clientId, position: row.position },
      },
      'scheduling.rate_default_deleted',
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/associates
 *
 * Phase 53 — slim list of associates the caller is allowed to schedule
 * for. Drives the row axis of the pivot week view (rows=people × cols=days).
 * Gated to manage:scheduling, so only HR/Ops reach this endpoint.
 */
schedulingRouter.get('/associates', MANAGE, async (req, res, next) => {
  try {
    let clientId = req.query.clientId?.toString();
    let locationId = req.query.locationId?.toString();
    const teamId = req.query.teamId?.toString();

    // Client-bounded roles (SHIFT_SUPERVISOR) can only ever see their own
    // client's roster: clamp clientId to theirs and drop any location filter
    // that could reach across the boundary. Fail closed if unassigned.
    const bounded = effectiveClientIdFilter(req.user!, undefined);
    if (bounded !== undefined) {
      if (!bounded) {
        res.json(AssociateListResponseSchema.parse({ associates: [] }));
        return;
      }
      clientId = bounded;
      locationId = undefined;
    }

    // Scope the roster to the selected work-site so the grid rows + the
    // create-dialog picker show only people who actually work there. An
    // associate "belongs" to a client/location via an APPROVED application
    // or an open assignment there. Falls back to the org-wide schedulable
    // set when nothing is selected. Login status deliberately does NOT
    // gate any branch — see SCHEDULABLE_USER_FILTER.
    let where: Prisma.AssociateWhereInput;
    if (teamId) {
      // Tightest scope: a standing shift crew. Membership already implies
      // the client/location, but the team must sit inside the caller's
      // client boundary.
      const team = await prisma.shiftTeam.findFirst({
        where: {
          id: teamId,
          deletedAt: null,
          ...(bounded ? { clientId: bounded } : {}),
        },
        select: { id: true },
      });
      if (!team) {
        res.json(AssociateListResponseSchema.parse({ associates: [] }));
        return;
      }
      where = {
        deletedAt: null,
        AND: [SCHEDULABLE_USER_FILTER],
        teamMemberships: { some: { teamId } },
      };
    } else if (locationId) {
      where = {
        deletedAt: null,
        AND: [SCHEDULABLE_USER_FILTER],
        OR: [
          { applications: { some: { status: 'APPROVED', locationId } } },
          { assignments: { some: { endedAt: null, locationId } } },
        ],
      };
    } else if (clientId) {
      where = {
        deletedAt: null,
        AND: [SCHEDULABLE_USER_FILTER],
        OR: [
          { applications: { some: { status: 'APPROVED', clientId } } },
          { assignments: { some: { endedAt: null, location: { clientId } } } },
        ],
      };
    } else {
      where = ACTIVE_ASSOCIATE_FILTER;
    }

    // Over-fetch by one so a full page can be reported as truncated rather
    // than silently cut. This list is the grid's row axis — dropping people
    // without saying so makes an incomplete schedule look complete.
    const ROSTER_PAGE = 500;
    const rows = await prisma.associate.findMany({
      where,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, email: true },
      take: ROSTER_PAGE + 1,
    });
    const truncated = rows.length > ROSTER_PAGE;
    res.json(
      AssociateListResponseSchema.parse({
        associates: truncated ? rows.slice(0, ROSTER_PAGE) : rows,
        truncated,
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/shifts', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;

    // Client-bounded roles (SHIFT_SUPERVISOR) can only create shifts for their
    // own client — the read scopes don't cover create (clientId comes from the
    // body, not a scoped query).
    const bounded = effectiveClientIdFilter(req.user!, undefined);
    if (bounded !== undefined && input.clientId !== bounded) {
      throw new HttpError(403, 'forbidden', 'You can only manage shifts for your assigned client.');
    }

    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');

    // Phase 131 — every Shift gets a Location. Use the explicit
    // locationId from the picker when provided; otherwise fall back
    // to the client's first active Location. The free-text `location`
    // field below stays for optional sub-zone labels ("Bar", "Patio",
    // "Floor 2 — Beauty").
    let location: { id: string };
    if (input.locationId) {
      const picked = await prisma.location.findFirst({
        where: { id: input.locationId, clientId: client.id, deletedAt: null, isActive: true },
        select: { id: true },
      });
      if (!picked) {
        throw new HttpError(
          400,
          'location_mismatch',
          'Location does not belong to the chosen client.',
        );
      }
      location = picked;
    } else {
      location = await firstLocationForClient(prisma, client.id);
    }

    const status = input.status ?? 'OPEN';
    const isPublishing = isPublishingTransition(undefined, status);
    const now = new Date();
    let lateNoticeReason: string | null = null;
    let publishedAt: Date | null = null;
    if (isPublishing) {
      const evaluation = evaluateShiftNotice({
        state: client.state,
        startsAt: new Date(input.startsAt),
        publishAt: now,
      });
      if (evaluation.requiresReason && !input.lateNoticeReason) {
        throw new HttpError(
          400,
          'late_notice_reason_required',
          `Publishing a shift inside the 14-day notice window in ${evaluation.state} requires lateNoticeReason`
        );
      }
      lateNoticeReason = input.lateNoticeReason ?? null;
      publishedAt = now;
    }

    const created = await prisma.shift.create({
      data: {
        clientId: input.clientId,
        locationId: location.id,
        position: input.position,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        location: input.location ?? null,
        hourlyRate: input.hourlyRate ?? null,
        payRate: input.payRate ?? null,
        notes: input.notes ?? null,
        status,
        createdById: req.user!.id,
        publishedAt,
        lateNoticeReason,
      },
      include: SHIFT_INCLUDE,
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.created',
      shiftId: created.id,
      clientId: created.clientId,
      metadata: {
        position: created.position,
        status: created.status,
        ...(lateNoticeReason ? { lateNoticeReason, lateNotice: true } : {}),
      },
      req,
    });

    res.status(201).json(await withEffectiveRate(created));
  } catch (err) {
    next(err);
  }
});

// Bulk create-and-assign — define one shift and stamp a copy onto many
// employees at once (each gets their own instance in their row), plus
// optional unassigned "open slot" copies. One transaction; employees who
// already have an overlapping shift are skipped and reported rather than
// double-booked.
schedulingRouter.post('/shifts/bulk', MANAGE, async (req, res, next) => {
  try {
    const parsed = BulkCreateShiftsInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;

    // Client-bounded roles (SHIFT_SUPERVISOR) can only create shifts for their
    // own client — the read scopes don't cover create (clientId comes from the
    // body, not a scoped query).
    const bounded = effectiveClientIdFilter(req.user!, undefined);
    if (bounded !== undefined && input.clientId !== bounded) {
      throw new HttpError(403, 'forbidden', 'You can only manage shifts for your assigned client.');
    }

    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');

    // Resolve the work-site (explicit pick or the client's first Location).
    let location: { id: string; timezone: string };
    if (input.locationId) {
      const picked = await prisma.location.findFirst({
        where: { id: input.locationId, clientId: client.id, deletedAt: null, isActive: true },
        select: { id: true, timezone: true },
      });
      if (!picked) {
        throw new HttpError(
          400,
          'location_mismatch',
          'Location does not belong to the chosen client.',
        );
      }
      location = picked;
    } else {
      const first = await firstLocationForClient(prisma, client.id);
      const full = await prisma.location.findUniqueOrThrow({
        where: { id: first.id },
        select: { id: true, timezone: true },
      });
      location = full;
    }

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const status = input.status ?? 'OPEN';
    const isPublishing = isPublishingTransition(undefined, status);
    const now = new Date();
    let lateNoticeReason: string | null = null;
    let publishedAt: Date | null = null;
    if (isPublishing) {
      const evaluation = evaluateShiftNotice({
        state: client.state,
        startsAt,
        publishAt: now,
      });
      if (evaluation.requiresReason && !input.lateNoticeReason) {
        throw new HttpError(
          400,
          'late_notice_reason_required',
          `Publishing a shift inside the 14-day notice window in ${evaluation.state} requires lateNoticeReason`,
        );
      }
      lateNoticeReason = input.lateNoticeReason ?? null;
      publishedAt = now;
    }

    const associateIds = [...new Set(input.associateIds)];
    // Names for the skip report + notifications, and a validity check.
    const associates = await prisma.associate.findMany({
      where: { id: { in: associateIds }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    const nameById = new Map(
      associates.map((a) => [a.id, `${a.firstName} ${a.lastName}`]),
    );

    // Employees that don't resolve to a real associate are skipped up front;
    // the overlap conflict check happens INSIDE the transaction (below) so it
    // and the createMany are atomic — otherwise a concurrent assign between a
    // pre-check and the insert could slip a double-booking through.
    const candidateIds = associateIds.filter((id) => nameById.has(id));
    const notFoundSkips = associateIds
      .filter((id) => !nameById.has(id))
      .map((id) => ({ associateId: id, associateName: 'Unknown', reason: 'not_found' }));

    const baseData = {
      clientId: input.clientId,
      locationId: location.id,
      position: input.position,
      startsAt,
      endsAt,
      location: input.location ?? null,
      hourlyRate: input.hourlyRate ?? null,
      payRate: input.payRate ?? null,
      notes: input.notes ?? null,
      status,
      createdById: req.user!.id,
      publishedAt,
      lateNoticeReason,
    };
    const openCount = input.openCount ?? 0;

    // Associates who declared this day unavailable (approved time off or a
    // one-off day off) are skipped like conflicts — a bulk assign must not
    // steamroll a day someone said they can't work.
    const unavailableIds = await blockedForWindow(
      candidateIds,
      startsAt,
      endsAt,
      location.timezone ?? DEFAULT_TIMEZONE,
    );

    // Conflict-check + create everything atomically.
    const { createdIds, toAssign, conflictedSkips } = await prisma.$transaction(
      async (tx) => {
        const conflictRows =
          candidateIds.length > 0
            ? await tx.shift.findMany({
                where: {
                  assignedAssociateId: { in: candidateIds },
                  status: { notIn: ['CANCELLED'] },
                  startsAt: { lt: endsAt },
                  endsAt: { gt: startsAt },
                },
                select: { assignedAssociateId: true },
              })
            : [];
        const conflicted = new Set(conflictRows.map((r) => r.assignedAssociateId));
        const toAssign = candidateIds.filter(
          (id) => !conflicted.has(id) && !unavailableIds.has(id),
        );
        const conflictedSkips = candidateIds
          .filter((id) => conflicted.has(id) || unavailableIds.has(id))
          .map((id) => ({
            associateId: id,
            associateName: nameById.get(id)!,
            reason: conflicted.has(id) ? 'already_scheduled' : 'day_unavailable',
          }));

        if (toAssign.length > 0) {
          await tx.shift.createMany({
            data: toAssign.map((associateId) => ({
              ...baseData,
              assignedAssociateId: associateId,
              assignedAt: now,
            })),
          });
        }
        if (openCount > 0) {
          await tx.shift.createMany({
            data: Array.from({ length: openCount }, () => ({ ...baseData })),
          });
        }
        // Pull the ids we just made (this manager, this exact window +
        // position) so the audit log references them.
        const rows = await tx.shift.findMany({
          where: {
            createdById: req.user!.id,
            clientId: input.clientId,
            locationId: location.id,
            position: input.position,
            startsAt,
            endsAt,
            createdAt: { gte: now },
          },
          select: { id: true },
        });
        return { createdIds: rows.map((r) => r.id), toAssign, conflictedSkips };
      },
      // This transaction does a conflict scan + up to two createMany + an id
      // fetch; the default 5s interactive-transaction window is tight for a
      // large bulk on a cold pool, so give it room.
      { timeout: 20_000 },
    );

    const skipped = [...notFoundSkips, ...conflictedSkips];
    const createdCount = toAssign.length + openCount;
    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.bulk_created',
      shiftId: createdIds[0] ?? 'bulk',
      clientId: input.clientId,
      metadata: {
        position: input.position,
        status,
        assigned: toAssign.length,
        openSlots: openCount,
        skipped: skipped.length,
        ...(lateNoticeReason ? { lateNoticeReason, lateNotice: true } : {}),
      },
      req,
    });

    // Notify each assigned associate only if the shift is already published
    // (drafts stay private until the week is published).
    if (publishedAt) {
      const line = formatShiftLine({
        position: input.position,
        clientName: client.name,
        startsAt,
        endsAt,
        timezone: location.timezone,
      });
      for (const associateId of toAssign) {
        void notifyShift(prisma, {
          associateId,
          subject: 'New shift',
          body: `You've been assigned: ${line}`,
          category: 'shift_assigned',
          senderUserId: req.user!.id,
        });
      }
    }

    const payload: BulkCreateShiftsResponse = { created: createdCount, skipped };
    res.status(201).json(BulkCreateShiftsResponseSchema.parse(payload));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.patch('/shifts/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }

    const existing = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
      include: { client: { select: { state: true } } },
    });
    if (!existing) throw new HttpError(404, 'shift_not_found', 'Shift not found');

    // A finished or cancelled shift is a historical record — block edits so
    // its times/status can't drift after the fact (an analytics query that
    // re-derives hours from startsAt/endsAt would otherwise read wrong).
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new HttpError(
        409,
        'shift_not_editable',
        `A ${existing.status.toLowerCase()} shift can't be edited. Delete it instead, or create a new one.`,
      );
    }

    const data: Prisma.ShiftUpdateInput = {};
    const i = parsed.data;
    if (i.position !== undefined) data.position = i.position;
    if (i.startsAt !== undefined) data.startsAt = new Date(i.startsAt);
    if (i.endsAt !== undefined) data.endsAt = new Date(i.endsAt);
    if (i.location !== undefined) data.location = i.location;
    if (i.hourlyRate !== undefined) data.hourlyRate = i.hourlyRate;
    if (i.payRate !== undefined) data.payRate = i.payRate;
    if (i.notes !== undefined) data.notes = i.notes;
    if (i.status !== undefined) data.status = i.status;

    // Phase 25 — predictive scheduling enforcement on a DRAFT→OPEN/ASSIGNED
    // transition. Re-publishing or other status changes don't re-evaluate.
    if (i.status !== undefined && isPublishingTransition(existing.status, i.status)) {
      const now = new Date();
      const newStartsAt = i.startsAt ? new Date(i.startsAt) : existing.startsAt;
      const evaluation = evaluateShiftNotice({
        state: existing.client.state,
        startsAt: newStartsAt,
        publishAt: now,
      });
      if (evaluation.requiresReason && !i.lateNoticeReason) {
        throw new HttpError(
          400,
          'late_notice_reason_required',
          `Publishing a shift inside the 14-day notice window in ${evaluation.state} requires lateNoticeReason`
        );
      }
      data.publishedAt = now;
      data.lateNoticeReason = i.lateNoticeReason ?? null;
    } else if (
      i.startsAt !== undefined &&
      i.status === undefined &&
      existing.publishedAt &&
      existing.status !== 'DRAFT'
    ) {
      // Already-published shift whose START is being moved (no status
      // change). Pulling it earlier could drag it inside the 14-day notice
      // window — re-evaluate so this path can't bypass fair-workweek.
      const evaluation = evaluateShiftNotice({
        state: existing.client.state,
        startsAt: new Date(i.startsAt),
        publishAt: new Date(),
      });
      if (evaluation.requiresReason && !i.lateNoticeReason) {
        throw new HttpError(
          400,
          'late_notice_reason_required',
          `Moving a published shift inside the 14-day notice window in ${evaluation.state} requires lateNoticeReason`,
        );
      }
      if (i.lateNoticeReason) data.lateNoticeReason = i.lateNoticeReason;
    }

    // Un-publish: moving a published shift back to DRAFT makes it private
    // again — clear the publish stamp + late-notice reason so a later
    // re-publish re-evaluates the fair-workweek notice window fresh.
    if (i.status === 'DRAFT' && existing.status !== 'DRAFT') {
      data.publishedAt = null;
      data.lateNoticeReason = null;
    }

    // June audit P0: editing an assigned shift's times (or promoting it to
    // ASSIGNED) had no double-booking guard — moving a shift onto another
    // of the same associate's shifts silently double-booked them. Check
    // inside the same transaction as the write so a concurrent /assign
    // can't slip in between.
    const timesChanged = i.startsAt !== undefined || i.endsAt !== undefined;
    const assigneeAfter =
      existing.assignedAssociateId && (i.status ?? existing.status) === 'ASSIGNED'
        ? existing.assignedAssociateId
        : null;
    const newStarts = i.startsAt ? new Date(i.startsAt) : existing.startsAt;
    const newEnds = i.endsAt ? new Date(i.endsAt) : existing.endsAt;
    // The schema's endsAt>startsAt refine only fires when BOTH are in the
    // body — a startsAt-only patch could invert the window against the
    // EXISTING end (July review): overlap checks then match nothing and a
    // negative-duration shift gets written. Validate the effective pair.
    if (timesChanged && newEnds <= newStarts) {
      throw new HttpError(
        400,
        'invalid_range',
        'endsAt must be after startsAt (check the field you did not change).',
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (assigneeAfter && (timesChanged || i.status === 'ASSIGNED')) {
        if (
          await associateHasOverlap(tx, assigneeAfter, newStarts, newEnds, existing.id)
        ) {
          throw new HttpError(
            409,
            'associate_double_booked',
            'These times overlap another shift already assigned to this associate.',
          );
        }
      }
      return tx.shift.update({
        where: { id: existing.id },
        data,
        include: SHIFT_INCLUDE,
      });
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.updated',
      shiftId: updated.id,
      clientId: updated.clientId,
      metadata: {
        fields: Object.keys(data),
        ...(updated.lateNoticeReason && data.publishedAt
          ? { lateNoticeReason: updated.lateNoticeReason, lateNotice: true }
          : {}),
      },
      req,
    });

    // Notify the assignee on a DRAFT→OPEN/ASSIGNED publish transition.
    // We don't notify on every PATCH — that would spam associates with
    // "your shift was edited" for trivial location/notes tweaks.
    if (data.publishedAt && updated.assignedAssociateId) {
      void notifyShift(prisma, {
        associateId: updated.assignedAssociateId,
        subject: 'Shift published',
        body: `Now on your schedule: ${formatShiftLine({
          position: updated.position,
          clientName: updated.client?.name ?? null,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          timezone: updated.locationRel?.timezone ?? null,
        })}`,
        category: 'shift_published',
        senderUserId: req.user!.id,
      });
    }

    res.json(await withEffectiveRate(updated));
  } catch (err) {
    next(err);
  }
});

// Hard delete — removes the shift outright (vs. cancel, which keeps a
// CANCELLED record). Intended for cleaning up drafts and mistaken shifts.
// Cascades to the shift's swap requests, qualification requirements, and
// open-shift claims (all onDelete: Cascade). The confirm lives client-side;
// the audit log keeps the trail even though the row is gone.
schedulingRouter.delete('/shifts/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
      select: {
        id: true,
        clientId: true,
        position: true,
        status: true,
        assignedAssociateId: true,
      },
    });
    if (!existing) throw new HttpError(404, 'shift_not_found', 'Shift not found');

    await prisma.shift.delete({ where: { id: existing.id } });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.deleted',
      shiftId: existing.id,
      clientId: existing.clientId,
      metadata: {
        position: existing.position,
        status: existing.status,
        wasAssigned: existing.assignedAssociateId !== null,
      },
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== Assignment ======================================================= */

schedulingRouter.post('/shifts/:id/assign', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftAssignInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }

    const shift = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
      include: { locationRel: { select: { timezone: true } } },
    });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    if (shift.status === 'CANCELLED') {
      throw new HttpError(409, 'shift_cancelled', 'Cannot assign a cancelled shift');
    }
    if (shift.status === 'COMPLETED') {
      throw new HttpError(409, 'shift_completed', 'Cannot assign a completed shift');
    }

    const associate = await prisma.associate.findFirst({
      where: { id: parsed.data.associateId, deletedAt: null },
    });
    if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');

    // Conflict + unavailability checks + write in one transaction so two
    // managers can't assign the same associate to overlapping shifts at
    // the same instant, and a day-off/PTO approved between check and write
    // can't be steamrolled (July review: the unavailability check used to
    // run outside the transaction).
    const updated = await prisma.$transaction(async (tx) => {
      // Approved time off and one-off days off BLOCK assignment by
      // default — an associate declaring a day unavailable means exactly
      // that. Admins can push through with overrideUnavailability
      // (audited below); an explicit per-assignment decision, never silent.
      if (!parsed.data.overrideUnavailability) {
        const blocked = await blockedForWindow(
          [associate.id],
          shift.startsAt,
          shift.endsAt,
          shift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
          tx,
        );
        if (blocked.size > 0) {
          throw new HttpError(
            409,
            'associate_unavailable',
            `${associate.firstName} ${associate.lastName} has approved time off or a declared day off covering this shift.`,
          );
        }
      }
      if (
        await associateHasOverlap(
          tx,
          associate.id,
          shift.startsAt,
          shift.endsAt,
          shift.id,
        )
      ) {
        throw new HttpError(
          409,
          'associate_double_booked',
          `${associate.firstName} ${associate.lastName} already has an overlapping shift.`,
        );
      }
      return tx.shift.update({
        where: { id: shift.id },
        data: {
          assignedAssociateId: associate.id,
          assignedAt: new Date(),
          status: 'ASSIGNED',
        },
        include: SHIFT_INCLUDE,
      });
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.assigned',
      shiftId: updated.id,
      clientId: updated.clientId,
      metadata: {
        associateId: associate.id,
        ...(parsed.data.overrideUnavailability
          ? { overrodeUnavailability: true }
          : {}),
      },
      req,
    });

    // Only notify if the shift is already published — otherwise the
    // manager is pre-assigning a draft that the associate isn't supposed
    // to see yet. The publish PATCH route will fire its own notification
    // when the schedule actually goes out.
    if (updated.publishedAt) {
      void notifyShift(prisma, {
        associateId: associate.id,
        subject: 'New shift assigned',
        body: `You've been assigned: ${formatShiftLine({
          position: updated.position,
          clientName: updated.client?.name ?? null,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          timezone: updated.locationRel?.timezone ?? null,
        })}`,
        category: 'shift_assigned',
        senderUserId: req.user!.id,
      });
    }

    res.json(await withEffectiveRate(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/shifts/:id/unassign', MANAGE, async (req, res, next) => {
  try {
    const shift = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
    });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    if (!shift.assignedAssociateId) {
      throw new HttpError(409, 'not_assigned', 'Shift is not currently assigned');
    }

    const previousAssociateId = shift.assignedAssociateId;
    const updated = await prisma.shift.update({
      where: { id: shift.id },
      data: {
        assignedAssociateId: null,
        assignedAt: null,
        status: shift.status === 'ASSIGNED' ? 'OPEN' : shift.status,
      },
      include: SHIFT_INCLUDE,
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.unassigned',
      shiftId: updated.id,
      clientId: updated.clientId,
      metadata: { previousAssociateId },
      req,
    });

    // Only notify if the shift was visible to the associate. Removing
    // someone from a draft shift is invisible — they never knew they were
    // on it.
    if (shift.publishedAt) {
      void notifyShift(prisma, {
        associateId: previousAssociateId,
        subject: 'Shift removed from your schedule',
        body: `Removed: ${formatShiftLine({
          position: updated.position,
          clientName: updated.client?.name ?? null,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          timezone: updated.locationRel?.timezone ?? null,
        })}`,
        category: 'shift_unassigned',
        senderUserId: req.user!.id,
      });
    }

    res.json(await withEffectiveRate(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/shifts/:id/cancel', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftCancelInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const shift = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
    });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    if (shift.status === 'COMPLETED') {
      throw new HttpError(409, 'shift_completed', 'Cannot cancel a completed shift');
    }

    const updated = await prisma.shift.update({
      where: { id: shift.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: parsed.data.reason,
      },
      include: SHIFT_INCLUDE,
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.cancelled',
      shiftId: updated.id,
      clientId: updated.clientId,
      metadata: { reason: parsed.data.reason },
      req,
    });

    // Cancel any in-flight swap requests for this shift — there's nothing
    // left to swap. Otherwise a PENDING_PEER/PEER_ACCEPTED swap sits in the
    // queue forever and the counterparty could still "accept" a dead shift.
    const liveSwaps = await prisma.shiftSwapRequest.findMany({
      where: {
        shiftId: shift.id,
        status: { in: ['PENDING_PEER', 'PEER_ACCEPTED'] },
      },
      select: {
        id: true,
        requesterAssociateId: true,
        counterpartyAssociateId: true,
      },
    });
    if (liveSwaps.length > 0) {
      await prisma.shiftSwapRequest.updateMany({
        where: { id: { in: liveSwaps.map((s) => s.id) } },
        data: { status: 'CANCELLED' },
      });
      const swapLine = formatShiftLine({
        position: updated.position,
        clientName: updated.client?.name ?? null,
        startsAt: updated.startsAt,
        endsAt: updated.endsAt,
        timezone: updated.locationRel?.timezone ?? null,
      });
      const notified = new Set<string>();
      for (const sw of liveSwaps) {
        for (const aid of [sw.requesterAssociateId, sw.counterpartyAssociateId]) {
          if (aid && !notified.has(aid)) {
            notified.add(aid);
            void notifyShift(prisma, {
              associateId: aid,
              subject: 'Swap cancelled',
              body: `A swap you were part of is off — the shift was cancelled. ${swapLine}`,
              category: 'swap_manager_rejected',
              senderUserId: req.user!.id,
            });
          }
        }
      }
    }

    // Same draft rule as unassign — cancelling a never-published shift
    // is invisible to the associate, so no notification.
    if (shift.assignedAssociateId && shift.publishedAt) {
      void notifyShift(prisma, {
        associateId: shift.assignedAssociateId,
        subject: 'Shift cancelled',
        body: `Cancelled: ${formatShiftLine({
          position: updated.position,
          clientName: updated.client?.name ?? null,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          timezone: updated.locationRel?.timezone ?? null,
        })}\nReason: ${parsed.data.reason}`,
        category: 'shift_cancelled',
        senderUserId: req.user!.id,
      });
    }

    res.json(await withEffectiveRate(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== Associate-facing /me ============================================ */

const MY_SHIFTS_CAP = 100;

/**
 * The admin `toShift` payload minus the money fields. `hourlyRate` is the
 * CLIENT BILL rate (revenue side) — paired with `payRate` it exposes the
 * staffing margin, so neither belongs in an associate-facing response.
 * Nulled rather than omitted so the shared ShiftSchema still parses.
 */
function toAssociateShift(row: Parameters<typeof toShift>[0]): Shift {
  return {
    ...toShift(row),
    hourlyRate: null,
    payRate: null,
    // Resolved-from-default rate is money-side too — same redaction.
    effectivePayRate: null,
  };
}

schedulingRouter.get('/me/shifts', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      // No linked Associate row — the middleware's email auto-link already
      // tried and found no unambiguous match, so this account genuinely
      // cannot be resolved to an employment record. Say so: a silent empty
      // list here reads as "no shifts" and hides the provisioning fault
      // (reported 2026-08-13 — published shifts "invisible" to associates
      // whose logins weren't linked).
      const empty: ShiftListResponse = { shifts: [], unlinked: true };
      res.json(empty);
      return;
    }
    // Bound the past so the `take` cap can't be exhausted by months of
    // history and push a long-tenured associate's UPCOMING shifts off the
    // end. 30 days back keeps recent worked shifts visible (the app's "My
    // schedule" splits these into a Recent section) while guaranteeing all
    // future shifts fit; the calendar feed has its own wider window.
    const pastHorizon = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.shift.findMany({
      where: {
        assignedAssociateId: user.associateId,
        // Associates only see published shifts. `publishedAt` is stamped
        // the first time a shift transitions out of DRAFT, so a non-null
        // value is the canonical "the manager has shown this to people"
        // signal — matches Sling/Deputy/7shifts conventions and keeps the
        // schedule editable in draft form without leaking to associates.
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
        startsAt: { gte: pastHorizon },
      },
      orderBy: { startsAt: 'asc' },
      // Over-fetch one row so truncation is detectable — ascending order
      // means the FURTHEST-FUTURE shifts are the ones that fall off, which
      // must never read as "no more shifts".
      take: MY_SHIFTS_CAP + 1,
      include: SHIFT_INCLUDE,
    });
    const truncated = rows.length > MY_SHIFTS_CAP;
    res.json({
      shifts: rows.slice(0, MY_SHIFTS_CAP).map(toAssociateShift),
      truncated,
    } satisfies ShiftListResponse);
  } catch (err) {
    next(err);
  }
});

const HISTORY_PAGE = 50;

/**
 * GET /scheduling/me/shifts/history?before=<ISO>
 *
 * Older published shifts, newest-first, 50 a page. `before` defaults to the
 * main list's 30-day horizon so the first page picks up exactly where the
 * Recent section ends. Registered BEFORE /me/shifts/:id so the literal
 * "history" segment isn't swallowed as an id.
 */
schedulingRouter.get('/me/shifts/history', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(MyShiftHistoryResponseSchema.parse({ shifts: [], nextBefore: null }));
      return;
    }
    const raw = req.query.before?.toString();
    const parsed = raw ? new Date(raw) : null;
    if (raw && Number.isNaN(parsed!.getTime())) {
      throw new HttpError(400, 'invalid_before', '`before` must be an ISO datetime');
    }
    const before =
      parsed ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.shift.findMany({
      where: {
        assignedAssociateId: user.associateId,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
        startsAt: { lt: before },
      },
      orderBy: { startsAt: 'desc' },
      take: HISTORY_PAGE + 1,
      include: SHIFT_INCLUDE,
    });
    const page = rows.slice(0, HISTORY_PAGE);
    res.json(
      MyShiftHistoryResponseSchema.parse({
        shifts: page.map(toAssociateShift),
        nextBefore:
          rows.length > HISTORY_PAGE
            ? page[page.length - 1]!.startsAt.toISOString()
            : null,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/me/shifts/:id
 *
 * Detail for ONE of the caller's own published shifts, plus everyone whose
 * published shift overlaps it at the same work site — the "who am I working
 * with" panel (Sling-style). Teammates scope to the same location when the
 * shift has one, otherwise the same client, and expose only name/position/
 * times/sub-zone (names are already associate-visible via /directory).
 */
schedulingRouter.get('/me/shifts/:id', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'shift_not_found', 'Shift not found');
    }
    const shift = await prisma.shift.findFirst({
      where: {
        id: req.params.id,
        assignedAssociateId: user.associateId,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
      },
      include: SHIFT_INCLUDE,
    });
    // Same 404 whether the shift doesn't exist or belongs to someone else —
    // don't confirm foreign shift ids to a probing client.
    if (!shift) {
      throw new HttpError(404, 'shift_not_found', 'Shift not found');
    }

    const overlapping = await prisma.shift.findMany({
      where: {
        id: { not: shift.id },
        clientId: shift.clientId,
        ...(shift.locationId ? { locationId: shift.locationId } : {}),
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
        AND: [
          { assignedAssociateId: { not: null } },
          { assignedAssociateId: { not: user.associateId } },
        ],
        startsAt: { lt: shift.endsAt },
        endsAt: { gt: shift.startsAt },
      },
      orderBy: { startsAt: 'asc' },
      take: 50,
      include: { assignedAssociate: { select: { firstName: true, lastName: true } } },
    });
    // One row per person — back-to-back split shifts would otherwise list
    // the same teammate twice.
    const seen = new Set<string>();
    const teammates = overlapping.flatMap((s) => {
      if (!s.assignedAssociateId || !s.assignedAssociate || seen.has(s.assignedAssociateId)) {
        return [];
      }
      seen.add(s.assignedAssociateId);
      return [
        {
          associateId: s.assignedAssociateId,
          name: `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}`,
          position: s.position,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          location: s.location,
        },
      ];
    });

    res.json(
      MyShiftDetailResponseSchema.parse({
        shift: toAssociateShift(shift),
        teammates,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/me/shifts/:id/swap-candidates
 *
 * Who the caller can offer this shift to: the schedulable pool (ACTIVE
 * ASSOCIATE-role, onboarded) minus themselves, each flagged `busy` when
 * they already have a shift overlapping this one. Advisory — the swap
 * POST and manager approval remain the enforcement points.
 */
schedulingRouter.get('/me/shifts/:id/swap-candidates', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'shift_not_found', 'Shift not found');
    }
    const shift = await prisma.shift.findFirst({
      where: {
        id: req.params.id,
        assignedAssociateId: user.associateId,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
      },
      select: {
        id: true,
        clientId: true,
        startsAt: true,
        endsAt: true,
        locationRel: { select: { timezone: true } },
      },
    });
    if (!shift) {
      throw new HttpError(404, 'shift_not_found', 'Shift not found');
    }

    // Schedulable pool ∩ placed at THIS client — offering a Publix shift
    // to someone who has never worked Publix is a dead-on-arrival request.
    // AND-composed because ACTIVE_ASSOCIATE_FILTER carries its own OR;
    // spreading a second OR key would silently overwrite the first.
    const pool = await prisma.associate.findMany({
      where: {
        AND: [
          ACTIVE_ASSOCIATE_FILTER,
          { id: { not: user.associateId } },
          {
            OR: [
              { applications: { some: { clientId: shift.clientId, status: 'APPROVED' } } },
              {
                assignments: {
                  some: { endedAt: null, location: { is: { clientId: shift.clientId } } },
                },
              },
            ],
          },
        ],
      },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: 200,
    });
    const poolIds = pool.map((a) => a.id);
    const [clashes, dayBlocked] = await Promise.all([
      prisma.shift.findMany({
        where: {
          id: { not: shift.id },
          assignedAssociateId: { in: poolIds },
          status: { notIn: ['CANCELLED'] },
          startsAt: { lt: shift.endsAt },
          endsAt: { gt: shift.startsAt },
        },
        select: { assignedAssociateId: true },
      }),
      // Approved time off + one-off days off count as busy too — a request
      // to someone on vacation dies at manager review anyway.
      blockedForWindow(
        poolIds,
        shift.startsAt,
        shift.endsAt,
        shift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
      ),
    ]);
    const busyIds = new Set([
      ...clashes.map((c) => c.assignedAssociateId as string),
      ...dayBlocked,
    ]);

    res.json(
      SwapCandidateListResponseSchema.parse({
        candidates: pool.map((a) => ({
          associateId: a.id,
          name: `${a.firstName} ${a.lastName}`,
          busy: busyIds.has(a.id),
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/me/calendar-url
 *
 * Returns the personal iCal subscription URL for the signed-in associate.
 * Token is HMAC-derived (deterministic per CALENDAR_FEED_SECRET +
 * associateId), so successive calls return the same URL — calendar
 * clients can subscribe once and keep getting updates.
 *
 * The webcal:// variant triggers Apple Calendar's subscribe handler on
 * macOS/iOS without an extra step; the https:// URL works for Google
 * Calendar's "Add by URL" flow and Outlook.
 */
/**
 * POST /scheduling/me/shifts/:id/acknowledge
 *
 * "I'll be there." Idempotent — the guarded update only stamps the first
 * tap, and re-acknowledging returns the shift unchanged. Admins see
 * acknowledgedAt on every shift payload and can chase the silent ones.
 */
schedulingRouter.post('/me/shifts/:id/acknowledge', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'shift_not_found', 'Shift not found');
    }
    const owned = await prisma.shift.findFirst({
      where: {
        id: req.params.id,
        assignedAssociateId: user.associateId,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
      },
      select: { id: true },
    });
    if (!owned) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    await prisma.shift.updateMany({
      where: { id: owned.id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date() },
    });
    const fresh = await prisma.shift.findUniqueOrThrow({
      where: { id: owned.id },
      include: SHIFT_INCLUDE,
    });
    res.json(toAssociateShift(fresh));
  } catch (err) {
    next(err);
  }
});

/* ===== One-off availability exceptions ("can't work July 15") ========== */

const exceptionDayString = (d: Date) => d.toISOString().slice(0, 10);

schedulingRouter.get('/me/availability/exceptions', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(AvailabilityExceptionListResponseSchema.parse({ exceptions: [] }));
      return;
    }
    // From yesterday forward — past exceptions are noise in the editor.
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await prisma.availabilityException.findMany({
      where: { associateId: user.associateId, date: { gte: from } },
      orderBy: { date: 'asc' },
      take: 100,
    });
    res.json(
      AvailabilityExceptionListResponseSchema.parse({
        exceptions: rows.map((r) => ({
          id: r.id,
          date: exceptionDayString(r.date),
          note: r.note,
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/me/availability/exceptions', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates set availability');
    }
    const parsed = AvailabilityExceptionCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const date = new Date(`${parsed.data.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
      throw new HttpError(400, 'invalid_date', 'Invalid date');
    }
    // Upsert on the (associateId, date) unique key — re-adding the same
    // day just refreshes the note instead of erroring.
    const row = await prisma.availabilityException.upsert({
      where: { associateId_date: { associateId: user.associateId, date } },
      create: {
        associateId: user.associateId,
        date,
        note: parsed.data.note?.trim() || null,
      },
      update: { note: parsed.data.note?.trim() || null },
    });
    res.status(201).json({
      id: row.id,
      date: exceptionDayString(row.date),
      note: row.note,
    });
  } catch (err) {
    next(err);
  }
});

schedulingRouter.delete('/me/availability/exceptions/:id', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
    const gone = await prisma.availabilityException.deleteMany({
      where: { id: req.params.id, associateId: user.associateId },
    });
    if (gone.count === 0) throw new HttpError(404, 'not_found', 'Not found');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== Open-shift pickup (Phase 85 claims, finally wired) =============== */

/** ClientIds where the associate is placed — approved application or an
 *  open assignment. Open shifts outside these clients aren't offered. */
async function placedClientIds(associateId: string): Promise<string[]> {
  const [apps, assignments] = await Promise.all([
    prisma.application.findMany({
      where: { associateId, status: 'APPROVED' },
      select: { clientId: true },
    }),
    prisma.associateAssignment.findMany({
      where: { associateId, endedAt: null },
      select: { location: { select: { clientId: true } } },
    }),
  ]);
  return Array.from(
    new Set([
      ...apps.map((a) => a.clientId),
      ...assignments.map((a) => a.location.clientId),
    ]),
  );
}

schedulingRouter.get('/me/open-shifts', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(OpenShiftsResponseSchema.parse({ shifts: [] }));
      return;
    }
    const clientIds = await placedClientIds(user.associateId);
    if (clientIds.length === 0) {
      res.json(OpenShiftsResponseSchema.parse({ shifts: [] }));
      return;
    }
    const rows = await prisma.shift.findMany({
      where: {
        clientId: { in: clientIds },
        status: 'OPEN',
        assignedAssociateId: null,
        publishedAt: { not: null },
        startsAt: { gt: new Date() },
      },
      orderBy: { startsAt: 'asc' },
      take: 50,
      include: SHIFT_INCLUDE,
    });

    // Hide shifts the associate couldn't actually take: overlapping their
    // own schedule, or on a day they're off (PTO / exception). One batched
    // fetch of their schedule + blocking rows, then in-memory filtering —
    // the per-shift blockedForWindow loop here was a 100-query N+1 (July
    // review).
    const horizon = rows.length
      ? new Date(Math.max(...rows.map((s) => s.endsAt.getTime())))
      : new Date();
    const [mine, ptoRows, exceptionRows] = await Promise.all([
      prisma.shift.findMany({
        where: {
          assignedAssociateId: user.associateId,
          status: { notIn: ['CANCELLED'] },
          endsAt: { gt: new Date() },
        },
        select: { startsAt: true, endsAt: true },
      }),
      prisma.timeOffRequest.findMany({
        where: {
          associateId: user.associateId,
          status: 'APPROVED',
          startDate: { lte: horizon },
          endDate: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        select: { startDate: true, endDate: true },
      }),
      prisma.availabilityException.findMany({
        where: {
          associateId: user.associateId,
          date: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
            lte: horizon,
          },
        },
        select: { date: true },
      }),
    ]);
    const dayOfRow = (d: Date) => d.toISOString().slice(0, 10);
    const eligible = rows.filter((s) => {
      const overlaps = mine.some(
        (m) => m.startsAt < s.endsAt && m.endsAt > s.startsAt,
      );
      if (overlaps) return false;
      const tz = s.locationRel?.timezone ?? DEFAULT_TIMEZONE;
      const startKey = dayKeyInZone(s.startsAt, tz);
      const endKey = dayKeyInZone(s.endsAt, tz);
      const ptoBlocked = ptoRows.some(
        (r) => dayOfRow(r.startDate) <= endKey && dayOfRow(r.endDate) >= startKey,
      );
      if (ptoBlocked) return false;
      return !exceptionRows.some((x) => {
        const k = dayOfRow(x.date);
        return k >= startKey && k <= endKey;
      });
    });

    const claims = await prisma.openShiftClaim.findMany({
      where: {
        associateId: user.associateId,
        shiftId: { in: eligible.map((s) => s.id) },
        status: 'PENDING',
      },
      select: { id: true, shiftId: true, status: true },
    });
    const claimByShift = new Map(claims.map((c) => [c.shiftId, c]));

    res.json(
      OpenShiftsResponseSchema.parse({
        shifts: eligible.map((s) => ({
          ...toAssociateShift(s),
          myClaimStatus: claimByShift.get(s.id)?.status ?? null,
          myClaimId: claimByShift.get(s.id)?.id ?? null,
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/me/open-shifts/:id/claim', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can pick up shifts');
    }
    const shift = await prisma.shift.findFirst({
      where: {
        id: req.params.id,
        status: 'OPEN',
        assignedAssociateId: null,
        publishedAt: { not: null },
        startsAt: { gt: new Date() },
      },
      include: SHIFT_INCLUDE,
    });
    if (!shift) {
      throw new HttpError(404, 'shift_not_available', 'This shift is no longer open');
    }
    const clientIds = await placedClientIds(user.associateId);
    if (!clientIds.includes(shift.clientId)) {
      throw new HttpError(403, 'not_placed_at_client', 'You are not placed at this client');
    }
    if (
      await associateHasOverlap(prisma, user.associateId, shift.startsAt, shift.endsAt, shift.id)
    ) {
      throw new HttpError(409, 'overlaps_your_schedule', 'This shift overlaps one of yours');
    }
    const tz = shift.locationRel?.timezone ?? DEFAULT_TIMEZONE;
    const blocked = await blockedForWindow([user.associateId], shift.startsAt, shift.endsAt, tz);
    if (blocked.size > 0) {
      throw new HttpError(409, 'day_unavailable', 'You have time off or a day off then');
    }
    const existing = await prisma.openShiftClaim.findFirst({
      where: { shiftId: shift.id, associateId: user.associateId, status: 'PENDING' },
      select: { id: true },
    });
    if (existing) {
      throw new HttpError(409, 'already_requested', 'You already requested this shift');
    }

    let claim;
    try {
      claim = await prisma.openShiftClaim.create({
        data: { shiftId: shift.id, associateId: user.associateId, status: 'PENDING' },
      });
    } catch (err) {
      // Partial unique index (shiftId, associateId) WHERE PENDING — the DB
      // arbitrates the double-tap race the findFirst above can't close.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new HttpError(409, 'already_requested', 'You already requested this shift');
      }
      throw err;
    }
    await recordShiftEvent({
      actorUserId: user.id,
      action: 'shift.pickup_requested',
      shiftId: shift.id,
      clientId: shift.clientId,
      metadata: { associateId: user.associateId, claimId: claim.id },
      req,
    });
    const me = await prisma.associate.findUnique({
      where: { id: user.associateId },
      select: { firstName: true, lastName: true },
    });
    const pickupNotice = {
      subject: 'Open-shift pickup request',
      body: `${me?.firstName ?? 'An associate'} ${me?.lastName ?? ''} wants to pick up: ${formatShiftLine({
        position: shift.position,
        clientName: shift.client?.name ?? null,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        timezone: tz,
      })}\nApprove or reject it from the Scheduling page.`,
      category: 'scheduling',
      linkUrl: '/approvals',
      excludeUserId: user.id,
    };
    void notifyAllAdmins(pickupNotice);
    // The supervisor whose floor this shift is on hears about it too —
    // they hold the approve capability but no admin role.
    void notifyClientSupervisors(shift.clientId, pickupNotice);

    res.status(201).json(
      OpenShiftClaimSchema.parse({
        id: claim.id,
        shiftId: claim.shiftId,
        status: claim.status,
        createdAt: claim.createdAt.toISOString(),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/me/open-shift-claims/:id/withdraw', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) throw new HttpError(404, 'not_found', 'Not found');
    // Guarded transition: only a still-PENDING claim of mine can withdraw.
    const cas = await prisma.openShiftClaim.updateMany({
      where: { id: req.params.id, associateId: user.associateId, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'not_pending', 'This request was already decided');
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const CLAIM_INCLUDE = {
  associate: { select: { firstName: true, lastName: true } },
  shift: {
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  },
} as const;

schedulingRouter.get('/open-shift-claims', MANAGE, async (req, res, next) => {
  try {
    const rows = await prisma.openShiftClaim.findMany({
      where: { status: 'PENDING', shift: { is: scopeShifts(req.user!) } },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: CLAIM_INCLUDE,
    });
    const otFlags = await wouldExceed40hFlags(
      rows.map((c) => ({
        associateId: c.associateId,
        startsAt: c.shift.startsAt,
        endsAt: c.shift.endsAt,
      })),
    );
    res.json(
      AdminOpenShiftClaimListResponseSchema.parse({
        claims: rows.map((c, i) => ({
          id: c.id,
          status: c.status,
          associateId: c.associateId,
          associateName: `${c.associate.firstName} ${c.associate.lastName}`,
          shiftId: c.shiftId,
          shiftPosition: c.shift.position,
          shiftClientName: c.shift.client?.name ?? null,
          shiftStartsAt: c.shift.startsAt.toISOString(),
          shiftEndsAt: c.shift.endsAt.toISOString(),
          shiftTimezone: c.shift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
          wouldExceed40h: otFlags[i],
          createdAt: c.createdAt.toISOString(),
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/open-shift-claims/:id/approve', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const claim = await prisma.openShiftClaim.findFirst({
      where: { id: req.params.id, shift: { is: scopeShifts(req.user!) } },
      include: CLAIM_INCLUDE,
    });
    if (!claim) throw new HttpError(404, 'claim_not_found', 'Pickup request not found');
    if (claim.status !== 'PENDING') {
      throw new HttpError(409, 'not_pending', `Request is ${claim.status}`);
    }

    // Atomic: CAS the claim, guarded-claim the shift (it must STILL be
    // open+unassigned — mirrors the auto-scheduler's TOCTOU guard), verify
    // the associate didn't get double-booked since requesting.
    await prisma.$transaction(async (tx) => {
      const cas = await tx.openShiftClaim.updateMany({
        where: { id: claim.id, status: 'PENDING' },
        data: { status: 'APPROVED', decidedById: user.id, decidedAt: new Date() },
      });
      if (cas.count === 0) {
        throw new HttpError(409, 'not_pending', 'Request was already decided');
      }
      if (
        await associateHasOverlap(
          tx,
          claim.associateId,
          claim.shift.startsAt,
          claim.shift.endsAt,
          claim.shiftId,
        )
      ) {
        throw new HttpError(
          409,
          'associate_double_booked',
          'They picked up another overlapping shift in the meantime',
        );
      }
      // Day off / PTO approved AFTER they requested the pickup wins —
      // same re-check the swap approval does.
      const nowBlocked = await blockedForWindow(
        [claim.associateId],
        claim.shift.startsAt,
        claim.shift.endsAt,
        claim.shift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
        tx,
      );
      if (nowBlocked.size > 0) {
        throw new HttpError(
          409,
          'associate_unavailable',
          'They now have time off or a day off covering this shift.',
        );
      }
      const took = await tx.shift.updateMany({
        where: { id: claim.shiftId, status: 'OPEN', assignedAssociateId: null },
        data: {
          status: 'ASSIGNED',
          assignedAssociateId: claim.associateId,
          assignedAt: new Date(),
        },
      });
      if (took.count === 0) {
        throw new HttpError(409, 'shift_gone', 'Shift was filled or changed already');
      }
      // Everyone else waiting on this shift loses automatically.
      await tx.openShiftClaim.updateMany({
        where: { shiftId: claim.shiftId, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          decidedById: user.id,
          decidedAt: new Date(),
          decisionNote: 'Shift was filled',
        },
      });
    });

    await recordShiftEvent({
      actorUserId: user.id,
      action: 'shift.pickup_approved',
      shiftId: claim.shiftId,
      clientId: claim.shift.clientId,
      metadata: { associateId: claim.associateId, claimId: claim.id },
      req,
    });
    const line = formatShiftLine({
      position: claim.shift.position,
      clientName: claim.shift.client?.name ?? null,
      startsAt: claim.shift.startsAt,
      endsAt: claim.shift.endsAt,
      timezone: claim.shift.locationRel?.timezone ?? null,
    });
    void notifyShift(prisma, {
      associateId: claim.associateId,
      subject: 'Pickup approved — shift is yours',
      body: `You're on: ${line}`,
      category: 'shift_pickup_approved',
      senderUserId: user.id,
    });
    // Notify the associates whose pending requests just auto-lost.
    const losers = await prisma.openShiftClaim.findMany({
      where: {
        shiftId: claim.shiftId,
        status: 'REJECTED',
        decisionNote: 'Shift was filled',
        decidedAt: { gte: new Date(Date.now() - 60_000) },
        NOT: { associateId: claim.associateId },
      },
      select: { associateId: true },
      distinct: ['associateId'],
    });
    for (const l of losers) {
      void notifyShift(prisma, {
        associateId: l.associateId,
        subject: 'Open shift filled',
        body: `That open shift went to someone else: ${line}`,
        category: 'shift_pickup_rejected',
        senderUserId: user.id,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/open-shift-claims/:id/reject', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const claim = await prisma.openShiftClaim.findFirst({
      where: { id: req.params.id, shift: { is: scopeShifts(req.user!) } },
      include: CLAIM_INCLUDE,
    });
    if (!claim) throw new HttpError(404, 'claim_not_found', 'Pickup request not found');
    const cas = await prisma.openShiftClaim.updateMany({
      where: { id: claim.id, status: 'PENDING' },
      data: { status: 'REJECTED', decidedById: user.id, decidedAt: new Date() },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'not_pending', `Request is ${claim.status}`);
    }
    void notifyShift(prisma, {
      associateId: claim.associateId,
      subject: 'Pickup request declined',
      body: `Your pickup request wasn't approved: ${formatShiftLine({
        position: claim.shift.position,
        clientName: claim.shift.client?.name ?? null,
        startsAt: claim.shift.startsAt,
        endsAt: claim.shift.endsAt,
        timezone: claim.shift.locationRel?.timezone ?? null,
      })}`,
      category: 'shift_pickup_rejected',
      senderUserId: user.id,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function buildCalendarFeedUrls(associateId: string, version: number) {
  const token = mintCalendarToken(associateId, version);
  // APP_BASE_URL is the web app origin in dev; in prod the API and SPA
  // share an origin (Railway single-service setup), so this works for
  // both. The `/api/calendar/v1/...` prefix matches the prod proxy path
  // — in dev the SPA proxies `/api/*` to the API.
  const base = env.APP_BASE_URL.replace(/\/$/, '');
  const url = `${base}/api/calendar/v1/${associateId}/${token}.ics`;
  const webcalUrl = url.replace(/^https?:\/\//, 'webcal://');
  return CalendarFeedUrlResponseSchema.parse({ url, webcalUrl });
}

schedulingRouter.get('/me/calendar-url', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'no_associate', 'No associate profile linked');
    }
    const associate = await prisma.associate.findUnique({
      where: { id: user.associateId },
      select: { calendarFeedVersion: true },
    });
    if (!associate) {
      throw new HttpError(404, 'no_associate', 'No associate profile linked');
    }
    res.json(
      buildCalendarFeedUrls(user.associateId, associate.calendarFeedVersion),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/me/calendar-url/rotate
 *
 * Invalidates the caller's current iCal URL (leaked link, ex-roommate's
 * laptop, ...) by bumping their calendarFeedVersion, and returns the new
 * URL. Only affects THIS associate — everyone else's subscriptions keep
 * working. Every calendar app subscribed to the old URL goes dark until
 * the new one is added, so the UI confirms before calling.
 */
schedulingRouter.post('/me/calendar-url/rotate', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'no_associate', 'No associate profile linked');
    }
    const associate = await prisma.associate.update({
      where: { id: user.associateId },
      data: { calendarFeedVersion: { increment: 1 } },
      select: { calendarFeedVersion: true },
    });
    enqueueAudit(
      {
        actorUserId: user.id,
        action: 'scheduling.calendar_feed_rotated',
        entityType: 'Associate',
        entityId: user.associateId,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          version: associate.calendarFeedVersion,
        },
      },
      'scheduling.calendar_feed_rotated'
    );
    res.json(
      buildCalendarFeedUrls(user.associateId, associate.calendarFeedVersion),
    );
  } catch (err) {
    next(err);
  }
});

/* ===== Conflict detection (HR/Ops) ===================================== */

/**
 * Returns existing assigned shifts that overlap the given target shift's
 * time window for the proposed associate. Used by the assign UI to warn
 * before clobbering. Shift overlaps here are advisory (/assign re-checks
 * transactionally); time off + declared days off are shown because
 * /assign HARD-BLOCKS on them unless overrideUnavailability is sent.
 */
schedulingRouter.get('/shifts/:id/conflicts', MANAGE, async (req, res, next) => {
  try {
    const associateId = req.query.associateId?.toString();
    const target = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
      include: { locationRel: { select: { timezone: true } } },
    });
    if (!target) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    if (!associateId) {
      res.json(ShiftConflictsResponseSchema.parse({ conflicts: [] }));
      return;
    }

    // Day-bound the target in the STORE's zone so this advisory matches
    // what /assign actually enforces (blockedForWindow). UTC flooring here
    // was off by one day for evening shifts at stores west of UTC.
    const conflictTz = target.locationRel?.timezone ?? DEFAULT_TIMEZONE;
    const targetStartDate = new Date(
      `${dayKeyInZone(target.startsAt, conflictTz)}T00:00:00Z`,
    );
    const targetEndDate = new Date(
      `${dayKeyInZone(target.endsAt, conflictTz)}T00:00:00Z`,
    );

    const [overlaps, ptoOverlaps, exceptionDays] = await Promise.all([
      prisma.shift.findMany({
        take: 100,
        where: {
          assignedAssociateId: associateId,
          id: { not: target.id },
          status: { notIn: ['CANCELLED', 'COMPLETED'] },
          // Standard overlap: existing.starts < target.ends AND existing.ends > target.starts
          startsAt: { lt: target.endsAt },
          endsAt: { gt: target.startsAt },
        },
        include: { client: { select: { name: true } } },
      }),
      // Phase 52 — APPROVED time-off that intersects the shift's day range.
      prisma.timeOffRequest.findMany({
        take: 100,
        where: {
          associateId,
          status: 'APPROVED',
          startDate: { lte: targetEndDate },
          endDate: { gte: targetStartDate },
        },
      }),
      // One-off "can't work this day" declarations on the shift's day(s) —
      // these HARD-BLOCK /assign unless the admin overrides, so the dialog
      // must show them before submit.
      prisma.availabilityException.findMany({
        take: 10,
        where: {
          associateId,
          date: { gte: targetStartDate, lte: targetEndDate },
        },
      }),
    ]);

    const conflicts: ShiftConflict[] = overlaps.map((s) => ({
      conflictingShiftId: s.id,
      conflictingStartsAt: s.startsAt.toISOString(),
      conflictingEndsAt: s.endsAt.toISOString(),
      conflictingClientName: s.client?.name ?? null,
      conflictingPosition: s.position,
    }));
    const timeOffConflicts = ptoOverlaps.map((r) => ({
      requestId: r.id,
      category: r.category,
      startDate: r.startDate.toISOString().slice(0, 10),
      endDate: r.endDate.toISOString().slice(0, 10),
    }));
    const unavailableDays = exceptionDays.map((x) => ({
      date: x.date.toISOString().slice(0, 10),
      note: x.note,
    }));
    res.json(
      ShiftConflictsResponseSchema.parse({ conflicts, timeOffConflicts, unavailableDays }),
    );
  } catch (err) {
    next(err);
  }
});

/* ===== Auto-fill candidate ranking (HR/Ops) ============================ */

/**
 * Rank associates by suitability for an OPEN shift. Ranking heuristic:
 *   - +0.5 if a posted availability window covers the shift
 *   - +0.3 if no scheduling conflict
 *   - +0.2 if their weekly scheduled hours leave room before 40h OT
 * Returns the top 25.
 */
schedulingRouter.get('/shifts/:id/auto-fill', MANAGE, async (req, res, next) => {
  try {
    const target = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
      include: { locationRel: { select: { timezone: true } } },
    });
    if (!target) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    // Availability is wall-clock at the STORE, so convert the shift's UTC
    // instant to the location's local day-of-week + minutes before matching.
    const targetTz = target.locationRel?.timezone ?? DEFAULT_TIMEZONE;

    // Day-bound the target in the store's zone so the ranking's PTO flag
    // agrees with the /assign hard block (same fix as /conflicts).
    const targetDayStart = new Date(
      `${dayKeyInZone(target.startsAt, targetTz)}T00:00:00Z`,
    );
    const targetDayEnd = new Date(
      `${dayKeyInZone(target.endsAt, targetTz)}T00:00:00Z`,
    );

    const [associates, ptoRows, exceptionRows] = await Promise.all([
      prisma.associate.findMany({
        where: ACTIVE_ASSOCIATE_FILTER,
        include: {
          assignedShifts: {
            where: {
              status: { notIn: ['CANCELLED', 'COMPLETED'] },
              startsAt: { gte: startOfWeekUTC(target.startsAt), lt: endOfWeekUTC(target.startsAt) },
            },
          },
          timeEntries: {
            where: {
              clockInAt: { gte: startOfWeekUTC(target.startsAt), lt: endOfWeekUTC(target.startsAt) },
            },
            include: { breaks: true },
          },
          availability: true,
        },
        take: 500,
      }),
      // Phase 52 — APPROVED PTO covering the shift's day window. One query
      // for the whole pool; we bucket by associateId in memory.
      prisma.timeOffRequest.findMany({
        take: 100,
        where: {
          status: 'APPROVED',
          startDate: { lte: targetDayEnd },
          endDate: { gte: targetDayStart },
        },
        select: { associateId: true },
      }),
      // One-off days off — same treatment as PTO in the ranking.
      prisma.availabilityException.findMany({
        take: 200,
        where: { date: { gte: targetDayStart, lte: targetDayEnd } },
        select: { associateId: true },
      }),
    ]);

    const ptoAssociateIds = new Set([
      ...ptoRows.map((r) => r.associateId),
      ...exceptionRows.map((r) => r.associateId),
    ]);

    const targetDOW = zonedDayOfWeek(target.startsAt, targetTz);
    const startMin = zonedMinutes(target.startsAt, targetTz);
    const endMin = zonedMinutes(target.endsAt, targetTz);

    const candidates: AutoFillCandidate[] = associates.map((a) => {
      const matchesAvailability = a.availability.some(
        (w) =>
          w.dayOfWeek === targetDOW &&
          w.startMinute <= startMin &&
          w.endMinute >= endMin
      );
      const noConflict = !a.assignedShifts.some(
        (s) => s.startsAt < target.endsAt && s.endsAt > target.startsAt
      );
      const onApprovedTimeOff = ptoAssociateIds.has(a.id);
      const weeklyMinutesScheduled = a.assignedShifts.reduce(
        (sum, s) => sum + Math.floor((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000),
        0
      );
      const weeklyMinutesActual = a.timeEntries.reduce(
        (sum, e) => sum + netWorkedMinutes(e, e.breaks),
        0
      );
      const targetMinutes = Math.floor(
        (target.endsAt.getTime() - target.startsAt.getTime()) / 60_000
      );
      const wouldExceed40 = weeklyMinutesActual + targetMinutes > 40 * 60;

      let score = 0;
      if (matchesAvailability) score += 0.5;
      if (noConflict) score += 0.3;
      if (!wouldExceed40) score += 0.2;
      // PTO is a deliberate plan — force these to the bottom of the list
      // regardless of availability or weekly hours.
      if (onApprovedTimeOff) score = 0;

      return {
        associateId: a.id,
        associateName: `${a.firstName} ${a.lastName}`,
        weeklyMinutesScheduled,
        weeklyMinutesActual,
        matchesAvailability,
        noConflict,
        onApprovedTimeOff,
        score,
      };
    });

    candidates.sort((x, y) => y.score - x.score);
    res.json(AutoFillResponseSchema.parse({ candidates: candidates.slice(0, 25) }));
  } catch (err) {
    next(err);
  }
});

/* ===== Associate availability ========================================== */

schedulingRouter.get('/me/availability', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(AvailabilityListResponseSchema.parse({ windows: [] }));
      return;
    }
    const rows = await prisma.associateAvailability.findMany({
      take: 500,
      where: { associateId: user.associateId },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    });
    const windows: AvailabilityWindow[] = rows.map((w) => ({
      id: w.id,
      associateId: w.associateId,
      dayOfWeek: w.dayOfWeek,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
    }));
    res.json(AvailabilityListResponseSchema.parse({ windows }));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.put('/me/availability', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can set availability');
    }
    const parsed = AvailabilityReplaceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }

    await prisma.$transaction([
      prisma.associateAvailability.deleteMany({
        where: { associateId: user.associateId },
      }),
      prisma.associateAvailability.createMany({
        data: parsed.data.windows.map((w) => ({
          associateId: user.associateId!,
          dayOfWeek: w.dayOfWeek,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
        })),
      }),
    ]);

    const rows = await prisma.associateAvailability.findMany({
      take: 500,
      where: { associateId: user.associateId },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    });
    const windows: AvailabilityWindow[] = rows.map((w) => ({
      id: w.id,
      associateId: w.associateId,
      dayOfWeek: w.dayOfWeek,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
    }));
    res.json(AvailabilityListResponseSchema.parse({ windows }));
  } catch (err) {
    next(err);
  }
});

/* ===== Shift swap marketplace ========================================== */

type RawSwap = Prisma.ShiftSwapRequestGetPayload<{
  include: {
    shift: {
      include: {
        client: { select: { name: true } };
        locationRel: { select: { timezone: true } };
      };
    };
    counterpartShift: {
      include: {
        client: { select: { name: true } };
        locationRel: { select: { timezone: true } };
      };
    };
    requester: { select: { firstName: true; lastName: true } };
    counterparty: { select: { firstName: true; lastName: true } };
  };
}>;

const SWAP_INCLUDE = {
  shift: {
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  },
  counterpartShift: {
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  },
  requester: { select: { firstName: true, lastName: true } },
  counterparty: { select: { firstName: true, lastName: true } },
} as const;

function toSwap(row: RawSwap): ShiftSwapRequestDTO {
  return {
    id: row.id,
    shiftId: row.shiftId,
    shiftStartsAt: row.shift.startsAt.toISOString(),
    shiftEndsAt: row.shift.endsAt.toISOString(),
    shiftTimezone: row.shift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
    shiftPosition: row.shift.position,
    shiftClientName: row.shift.client?.name ?? null,
    inExchange: row.counterpartShift
      ? {
          shiftId: row.counterpartShift.id,
          position: row.counterpartShift.position,
          clientName: row.counterpartShift.client?.name ?? null,
          startsAt: row.counterpartShift.startsAt.toISOString(),
          endsAt: row.counterpartShift.endsAt.toISOString(),
          timezone: row.counterpartShift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
        }
      : null,
    requesterAssociateId: row.requesterAssociateId,
    requesterName: `${row.requester.firstName} ${row.requester.lastName}`,
    counterpartyAssociateId: row.counterpartyAssociateId,
    counterpartyName: `${row.counterparty.firstName} ${row.counterparty.lastName}`,
    status: row.status,
    note: row.note,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Associate creates a swap request — they own the shift and propose
 *  someone else takes it. Counterparty must be qualified (HR can still
 *  reject). */
schedulingRouter.post('/swap-requests', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can request swaps');
    }
    const parsed = SwapCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { shiftId, counterpartyAssociateId, note, counterpartShiftId } = parsed.data;

    if (counterpartyAssociateId === user.associateId) {
      throw new HttpError(400, 'self_swap', 'You cannot swap a shift with yourself');
    }
    const shift = await prisma.shift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    if (shift.assignedAssociateId !== user.associateId) {
      throw new HttpError(403, 'not_your_shift', 'You can only swap shifts assigned to you');
    }
    if (shift.status !== 'ASSIGNED') {
      throw new HttpError(409, 'shift_not_assigned', 'Shift is not in an assignable state');
    }
    const counterparty = await prisma.associate.findFirst({
      where: { id: counterpartyAssociateId, deletedAt: null },
    });
    if (!counterparty) throw new HttpError(404, 'counterparty_not_found', 'Counterparty associate not found');

    // Trade half: the exchange shift must be a real, upcoming, published
    // shift OF THE COUNTERPARTY — otherwise this degrades into a lever for
    // grabbing arbitrary shifts. Deeper checks (double-booking both ways)
    // run at manager-approve time, when they're actually decisive.
    if (counterpartShiftId) {
      if (counterpartShiftId === shiftId) {
        throw new HttpError(400, 'same_shift', 'Exchange shift must differ from yours');
      }
      const exchange = await prisma.shift.findUnique({ where: { id: counterpartShiftId } });
      if (
        !exchange ||
        exchange.assignedAssociateId !== counterpartyAssociateId ||
        exchange.status !== 'ASSIGNED' ||
        !exchange.publishedAt ||
        exchange.startsAt <= new Date()
      ) {
        throw new HttpError(
          409,
          'invalid_exchange_shift',
          "The exchange shift must be one of the counterparty's upcoming shifts",
        );
      }
    }

    const created = await prisma.shiftSwapRequest.create({
      data: {
        shiftId,
        requesterAssociateId: user.associateId,
        counterpartyAssociateId,
        counterpartShiftId: counterpartShiftId ?? null,
        note: note ?? null,
        status: 'PENDING_PEER',
      },
      include: SWAP_INCLUDE,
    });

    void notifyShift(prisma, {
      associateId: counterpartyAssociateId,
      subject: 'New swap request',
      body: `${created.requester.firstName} ${created.requester.lastName} is asking you to take their shift: ${formatShiftLine(
        {
          position: created.shift.position,
          clientName: created.shift.client?.name ?? null,
          startsAt: created.shift.startsAt,
          endsAt: created.shift.endsAt,
        }
      )}${note ? `\nNote: ${note}` : ''}`,
      category: 'swap_peer_request',
      senderUserId: req.user!.id,
    });
    // Manager copy: the requester's manager should know a swap is in flight
    // so they can intervene if the peer rejects. No-op if no manager.
    const mgrSwapTpl = shiftSwapManagerTemplate({
      requesterName: `${created.requester.firstName} ${created.requester.lastName}`,
      counterpartyName: `${counterparty.firstName} ${counterparty.lastName}`,
      position: created.shift.position,
      clientName: created.shift.client?.name ?? 'the client',
      shiftDate: created.shift.startsAt.toISOString().slice(0, 10),
      startsAt: created.shift.startsAt.toISOString().slice(11, 16) + ' UTC',
      endsAt: created.shift.endsAt.toISOString().slice(11, 16) + ' UTC',
    });
    void notifyManager(user.associateId, {
      subject: mgrSwapTpl.subject,
      body: mgrSwapTpl.text,
      html: mgrSwapTpl.html,
      category: 'scheduling',
    });
    // The site's shift supervisor approves swaps but is rarely anyone's
    // managerId — route them a copy keyed on the shift's client.
    void notifyClientSupervisors(created.shift.clientId, {
      subject: mgrSwapTpl.subject,
      body: mgrSwapTpl.text,
      html: mgrSwapTpl.html,
      category: 'scheduling',
      linkUrl: '/approvals',
    });

    res.status(201).json(toSwap(created));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/me/trade-options?counterpartyId=<uuid>
 *
 * The counterparty's upcoming published shifts — what the requester can
 * ask for in exchange. Position/times only, same exposure rationale as
 * the teammates panel.
 */
schedulingRouter.get('/me/trade-options', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Forbidden');
    }
    const counterpartyId = req.query.counterpartyId?.toString();
    if (
      !counterpartyId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        counterpartyId,
      )
    ) {
      throw new HttpError(400, 'invalid_counterparty', 'counterpartyId required');
    }
    const rows = await prisma.shift.findMany({
      where: {
        assignedAssociateId: counterpartyId,
        status: 'ASSIGNED',
        publishedAt: { not: null },
        startsAt: { gt: new Date() },
      },
      orderBy: { startsAt: 'asc' },
      take: 20,
      include: {
        client: { select: { name: true } },
        locationRel: { select: { timezone: true } },
      },
    });
    res.json(
      TradeOptionsResponseSchema.parse({
        options: rows.map((s) => ({
          shiftId: s.id,
          position: s.position,
          clientName: s.client?.name ?? null,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          timezone: s.locationRel?.timezone ?? DEFAULT_TIMEZONE,
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.get('/swap-requests/me/incoming', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(ShiftSwapListResponseSchema.parse({ requests: [] }));
      return;
    }
    const rows = await prisma.shiftSwapRequest.findMany({
      take: 500,
      where: { counterpartyAssociateId: user.associateId },
      orderBy: { createdAt: 'desc' },
      include: SWAP_INCLUDE,
    });
    res.json(ShiftSwapListResponseSchema.parse({ requests: rows.map(toSwap) }));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.get('/swap-requests/me/outgoing', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(ShiftSwapListResponseSchema.parse({ requests: [] }));
      return;
    }
    const rows = await prisma.shiftSwapRequest.findMany({
      take: 500,
      where: { requesterAssociateId: user.associateId },
      orderBy: { createdAt: 'desc' },
      include: SWAP_INCLUDE,
    });
    res.json(ShiftSwapListResponseSchema.parse({ requests: rows.map(toSwap) }));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/swap-requests/:id/peer-accept', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only the counterparty associate can accept');
    }
    const swap = await prisma.shiftSwapRequest.findUnique({ where: { id: req.params.id } });
    if (!swap) throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    if (swap.counterpartyAssociateId !== user.associateId) {
      throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    }
    if (swap.status !== 'PENDING_PEER') {
      throw new HttpError(409, 'invalid_state', `Swap is in ${swap.status}, cannot accept`);
    }
    // Atomic compare-and-set so a double-tap can't accept twice (which would
    // fire the HR-approval notification twice and race the manager flow).
    const cas = await prisma.shiftSwapRequest.updateMany({
      where: { id: swap.id, status: 'PENDING_PEER' },
      data: { status: 'PEER_ACCEPTED' },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'invalid_state', 'This swap was already resolved.');
    }
    const updated = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: swap.id },
      include: SWAP_INCLUDE,
    });

    void notifyShift(prisma, {
      associateId: updated.requesterAssociateId,
      subject: 'Swap accepted — pending HR approval',
      body: `${updated.counterparty.firstName} ${updated.counterparty.lastName} accepted your swap request. Waiting on HR sign-off: ${formatShiftLine(
        {
          position: updated.shift.position,
          clientName: updated.shift.client?.name ?? null,
          startsAt: updated.shift.startsAt,
          endsAt: updated.shift.endsAt,
          timezone: updated.shift.locationRel?.timezone ?? null,
        }
      )}`,
      category: 'swap_peer_accepted',
      senderUserId: req.user!.id,
    });

    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/swap-requests/:id/peer-decline', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only the counterparty associate can decline');
    }
    const swap = await prisma.shiftSwapRequest.findUnique({ where: { id: req.params.id } });
    if (!swap || swap.counterpartyAssociateId !== user.associateId) {
      throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    }
    if (swap.status !== 'PENDING_PEER') {
      throw new HttpError(409, 'invalid_state', `Swap is in ${swap.status}, cannot decline`);
    }
    // CAS, same as peer-accept — a decline racing an accept must lose to
    // whichever landed first instead of overwriting it.
    const cas = await prisma.shiftSwapRequest.updateMany({
      where: { id: swap.id, status: 'PENDING_PEER' },
      data: { status: 'PEER_DECLINED' },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'invalid_state', 'This swap was already resolved.');
    }
    const updated = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: swap.id },
      include: SWAP_INCLUDE,
    });

    void notifyShift(prisma, {
      associateId: updated.requesterAssociateId,
      subject: 'Swap declined',
      body: `${updated.counterparty.firstName} ${updated.counterparty.lastName} declined your swap request for ${formatShiftLine(
        {
          position: updated.shift.position,
          clientName: updated.shift.client?.name ?? null,
          startsAt: updated.shift.startsAt,
          endsAt: updated.shift.endsAt,
          timezone: updated.shift.locationRel?.timezone ?? null,
        }
      )}`,
      category: 'swap_peer_declined',
      senderUserId: req.user!.id,
    });

    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/swap-requests/:id/cancel', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Forbidden');
    }
    const swap = await prisma.shiftSwapRequest.findUnique({ where: { id: req.params.id } });
    if (!swap || swap.requesterAssociateId !== user.associateId) {
      throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    }
    if (swap.status === 'MANAGER_APPROVED' || swap.status === 'CANCELLED') {
      throw new HttpError(409, 'invalid_state', `Swap is in ${swap.status}, cannot cancel`);
    }
    // Guarded write: re-assert "not yet approved" AT WRITE TIME. Without
    // this, a cancel racing manager-approve could stamp CANCELLED over an
    // approved swap whose assignment already moved (June audit P0).
    const cas = await prisma.shiftSwapRequest.updateMany({
      where: {
        id: swap.id,
        status: { notIn: ['MANAGER_APPROVED', 'CANCELLED'] },
      },
      data: { status: 'CANCELLED' },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'invalid_state', 'This swap was already resolved.');
    }
    const updated = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: swap.id },
      include: SWAP_INCLUDE,
    });
    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.get('/swap-requests/admin', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const where: Prisma.ShiftSwapRequestWhereInput = {
      // Scope to swaps for shifts the caller can see (a CLIENT_PORTAL admin
      // must not read other clients' swap activity). scopeShifts is {} for
      // full admins, so this is a no-op for them.
      shift: { is: scopeShifts(req.user!) },
      ...(status ? { status: status as Prisma.ShiftSwapRequestWhereInput['status'] } : {}),
    };
    const rows = await prisma.shiftSwapRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: SWAP_INCLUDE,
    });
    // Advisory OT chip: would the counterparty cross 40h by taking this
    // shift (net of the leg they'd hand off on a trade)?
    const otFlags = await wouldExceed40hFlags(
      rows.map((r) => ({
        associateId: r.counterpartyAssociateId,
        startsAt: r.shift.startsAt,
        endsAt: r.shift.endsAt,
        excludeShiftIds: r.counterpartShiftId ? [r.counterpartShiftId] : [],
      })),
    );
    res.json(
      ShiftSwapListResponseSchema.parse({
        requests: rows.map((r, i) => ({ ...toSwap(r), wouldExceed40h: otFlags[i] })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/swap-requests/:id/manager-approve', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = SwapDecideInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    // Scope to a swap whose shift the caller can manage — a CLIENT_PORTAL
    // admin must not approve another client's swap by guessing the id.
    const swap = await prisma.shiftSwapRequest.findFirst({
      where: { id: req.params.id, shift: { is: scopeShifts(req.user!) } },
      include: {
        shift: { include: { locationRel: { select: { timezone: true } } } },
        counterpartShift: { include: { locationRel: { select: { timezone: true } } } },
      },
    });
    if (!swap) throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    if (swap.status !== 'PEER_ACCEPTED') {
      throw new HttpError(
        409,
        'not_peer_accepted',
        'Counterparty must accept the swap before HR approval'
      );
    }

    // Declared unavailability blocks the receiving side of each leg — PTO
    // approved (or a day off added) AFTER the peer accepted must not get
    // steamrolled by the approval. Independent reads, so both legs check
    // in parallel.
    const [cptBlocked, reqBlocked] = await Promise.all([
      blockedForWindow(
        [swap.counterpartyAssociateId],
        swap.shift.startsAt,
        swap.shift.endsAt,
        swap.shift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
      ),
      swap.counterpartShift
        ? blockedForWindow(
            [swap.requesterAssociateId],
            swap.counterpartShift.startsAt,
            swap.counterpartShift.endsAt,
            swap.counterpartShift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
          )
        : Promise.resolve(new Set<string>()),
    ]);
    if (cptBlocked.size > 0) {
      throw new HttpError(
        409,
        'counterparty_unavailable',
        'The counterparty now has time off or a day off covering this shift.',
      );
    }
    if (reqBlocked.size > 0) {
      throw new HttpError(
        409,
        'requester_unavailable',
        'The requester now has time off or a day off covering the exchange shift.',
      );
    }

    // Execute atomically: CAS the swap status, verify neither party is
    // double-booked by the leg they're taking, then move the assignment(s)
    // with WRITE-TIME preconditions — the shift must still be ASSIGNED to
    // the expected person (June audit P0: an approve racing a shift
    // cancel/unassign used to resurrect the assignment blindly). Trades
    // move both legs or none. Any throw rolls the whole thing back.
    const isTrade = !!swap.counterpartShiftId && !!swap.counterpartShift;
    const excludeIds = isTrade
      ? [swap.shiftId, swap.counterpartShiftId!]
      : [swap.shiftId];
    await prisma.$transaction(async (tx) => {
      const cas = await tx.shiftSwapRequest.updateMany({
        where: { id: swap.id, status: 'PEER_ACCEPTED' },
        data: { status: 'MANAGER_APPROVED', decidedById: user.id, decidedAt: new Date() },
      });
      if (cas.count === 0) {
        throw new HttpError(409, 'invalid_state', 'This swap was already decided.');
      }
      if (
        await hasOverlapExcluding(
          tx,
          swap.counterpartyAssociateId,
          swap.shift.startsAt,
          swap.shift.endsAt,
          excludeIds,
        )
      ) {
        throw new HttpError(
          409,
          'counterparty_double_booked',
          'The counterparty now has another shift overlapping this one — they can’t take it.',
        );
      }
      if (
        isTrade &&
        (await hasOverlapExcluding(
          tx,
          swap.requesterAssociateId,
          swap.counterpartShift!.startsAt,
          swap.counterpartShift!.endsAt,
          excludeIds,
        ))
      ) {
        throw new HttpError(
          409,
          'requester_double_booked',
          'The requester now has another shift overlapping the exchange shift.',
        );
      }
      const main = await tx.shift.updateMany({
        where: {
          id: swap.shiftId,
          status: 'ASSIGNED',
          assignedAssociateId: swap.requesterAssociateId,
        },
        data: {
          assignedAssociateId: swap.counterpartyAssociateId,
          assignedAt: new Date(),
          // New owner hasn't confirmed anything — reset the ack.
          acknowledgedAt: null,
        },
      });
      if (main.count === 0) {
        throw new HttpError(
          409,
          'shift_changed',
          'The shift was cancelled or reassigned while this swap was pending.',
        );
      }
      if (isTrade) {
        const leg = await tx.shift.updateMany({
          where: {
            id: swap.counterpartShiftId!,
            status: 'ASSIGNED',
            assignedAssociateId: swap.counterpartyAssociateId,
          },
          data: {
            assignedAssociateId: swap.requesterAssociateId,
            assignedAt: new Date(),
            acknowledgedAt: null,
          },
        });
        if (leg.count === 0) {
          throw new HttpError(
            409,
            'exchange_shift_changed',
            'The exchange shift was cancelled or reassigned while this swap was pending.',
          );
        }
      }
    });

    await recordShiftEvent({
      actorUserId: user.id,
      action: 'shift.swapped',
      shiftId: swap.shiftId,
      clientId: swap.shift.clientId,
      metadata: {
        from: swap.requesterAssociateId,
        to: swap.counterpartyAssociateId,
        swapRequestId: swap.id,
        trade: isTrade,
      },
      req,
    });
    if (isTrade) {
      await recordShiftEvent({
        actorUserId: user.id,
        action: 'shift.swapped',
        shiftId: swap.counterpartShiftId!,
        clientId: swap.counterpartShift!.clientId,
        metadata: {
          from: swap.counterpartyAssociateId,
          to: swap.requesterAssociateId,
          swapRequestId: swap.id,
          trade: true,
        },
        req,
      });
    }

    const updated = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: swap.id },
      include: SWAP_INCLUDE,
    });

    // Both parties get notified — the new owner needs to know it's now
    // theirs, and the original owner needs to know they're off the hook.
    const shiftLine = formatShiftLine({
      position: updated.shift.position,
      clientName: updated.shift.client?.name ?? null,
      startsAt: updated.shift.startsAt,
      endsAt: updated.shift.endsAt,
      timezone: updated.shift.locationRel?.timezone ?? null,
    });
    const exchangeLine = updated.counterpartShift
      ? formatShiftLine({
          position: updated.counterpartShift.position,
          clientName: updated.counterpartShift.client?.name ?? null,
          startsAt: updated.counterpartShift.startsAt,
          endsAt: updated.counterpartShift.endsAt,
          timezone: updated.counterpartShift.locationRel?.timezone ?? null,
        })
      : null;
    void notifyShift(prisma, {
      associateId: updated.counterpartyAssociateId,
      subject: 'Swap approved — shift is yours',
      body:
        `HR approved the swap. You're now scheduled for: ${shiftLine}` +
        (exchangeLine ? `\nYou handed off: ${exchangeLine}` : ''),
      category: 'swap_manager_approved',
      senderUserId: req.user!.id,
    });
    void notifyShift(prisma, {
      associateId: updated.requesterAssociateId,
      subject: 'Swap approved — shift handed off',
      body:
        `HR approved your swap with ${updated.counterparty.firstName} ${updated.counterparty.lastName}. You're off this shift: ${shiftLine}` +
        (exchangeLine ? `\nIn exchange you're now on: ${exchangeLine}` : ''),
      category: 'swap_manager_approved',
      senderUserId: req.user!.id,
    });

    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/swap-requests/:id/manager-reject', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = SwapDecideInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const swap = await prisma.shiftSwapRequest.findFirst({
      where: { id: req.params.id, shift: { is: scopeShifts(req.user!) } },
    });
    if (!swap) throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    if (swap.status === 'MANAGER_APPROVED' || swap.status === 'MANAGER_REJECTED' || swap.status === 'CANCELLED') {
      throw new HttpError(409, 'invalid_state', `Swap is in ${swap.status}, cannot reject`);
    }
    // Guarded write — mirrors cancel: never overwrite a terminal state
    // that landed between our read and this update.
    const cas = await prisma.shiftSwapRequest.updateMany({
      where: {
        id: swap.id,
        status: { in: ['PENDING_PEER', 'PEER_ACCEPTED', 'PEER_DECLINED'] },
      },
      data: { status: 'MANAGER_REJECTED', decidedById: user.id, decidedAt: new Date() },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'invalid_state', 'This swap was already resolved.');
    }
    const updated = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: swap.id },
      include: SWAP_INCLUDE,
    });

    // Notify both parties so the requester knows to find another solution
    // and the counterparty isn't left wondering.
    const shiftLine = formatShiftLine({
      position: updated.shift.position,
      clientName: updated.shift.client?.name ?? null,
      startsAt: updated.shift.startsAt,
      endsAt: updated.shift.endsAt,
      timezone: updated.shift.locationRel?.timezone ?? null,
    });
    void notifyShift(prisma, {
      associateId: updated.requesterAssociateId,
      subject: 'Swap rejected by HR',
      body: `HR did not approve your swap for: ${shiftLine}`,
      category: 'swap_manager_rejected',
      senderUserId: req.user!.id,
    });
    void notifyShift(prisma, {
      associateId: updated.counterpartyAssociateId,
      subject: 'Swap rejected by HR',
      body: `HR did not approve the swap you accepted for: ${shiftLine}`,
      category: 'swap_manager_rejected',
      senderUserId: req.user!.id,
    });

    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/availability-overview?from=&to=
 * Fit data for the visible scheduling range: every ACTIVE associate's
 * weekly availability windows plus the calendar days blocked by approved
 * time off or one-off exceptions. The grid uses it to shade cells before
 * a shift is dropped on someone who can't work it.
 */
schedulingRouter.get('/availability-overview', MANAGE, async (req, res, next) => {
  try {
    const from = parseDateParam(req.query.from?.toString(), 'from');
    const to = parseDateParam(req.query.to?.toString(), 'to');
    if (!from || !to) {
      throw new HttpError(400, 'range_required', '`from` and `to` are required');
    }
    const spanDays = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
    if (spanDays <= 0 || spanDays > 62) {
      throw new HttpError(400, 'range_too_wide', 'Range must be 1–62 days');
    }

    // Bounded roles (SHIFT_SUPERVISOR) only see their own client's people
    // in the availability heatmap.
    const availBounded = effectiveClientIdFilter(req.user!, undefined);
    const [associates, ptoRows, exceptionRows] = await Promise.all([
      prisma.associate.findMany({
        where: {
          AND: [
            ACTIVE_ASSOCIATE_FILTER,
            ...(availBounded !== undefined
              ? [availBounded ? associatesOfClient(availBounded) : { id: NO_MATCH_ID }]
              : []),
          ],
        },
        select: {
          id: true,
          availability: {
            select: { dayOfWeek: true, startMinute: true, endMinute: true },
          },
        },
        take: 1000,
      }),
      prisma.timeOffRequest.findMany({
        take: 2000,
        where: { status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from } },
        select: { associateId: true, startDate: true, endDate: true },
      }),
      prisma.availabilityException.findMany({
        take: 2000,
        where: { date: { gte: from, lte: to } },
        select: { associateId: true, date: true },
      }),
    ]);

    const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
    const blocked = new Map<string, Set<string>>();
    const block = (associateId: string, key: string) => {
      const set = blocked.get(associateId) ?? new Set<string>();
      set.add(key);
      blocked.set(associateId, set);
    };
    for (const r of ptoRows) {
      // Expand the (date-only) PTO range into day keys, clamped to the
      // requested window so a 3-month leave doesn't explode the payload.
      const start = r.startDate < from ? from : r.startDate;
      const end = r.endDate > to ? to : r.endDate;
      for (
        let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
        t <= end.getTime();
        t += 86_400_000
      ) {
        block(r.associateId, dayKey(new Date(t)));
      }
    }
    for (const x of exceptionRows) block(x.associateId, dayKey(x.date));

    res.json(
      AvailabilityOverviewResponseSchema.parse({
        associates: associates.map((a) => ({
          associateId: a.id,
          windows: a.availability,
          blockedDays: [...(blocked.get(a.id) ?? [])],
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/* ===== Shift teams ======================================================= */

type RawTeam = Prisma.ShiftTeamGetPayload<{
  include: {
    location: { select: { name: true } };
    _count: { select: { members: true } };
  };
}>;

const TEAM_INCLUDE = {
  location: { select: { name: true } },
  _count: { select: { members: true } },
} as const;

function toShiftTeam(row: RawTeam): ShiftTeamDTO {
  return {
    id: row.id,
    clientId: row.clientId,
    locationId: row.locationId,
    locationName: row.location?.name ?? null,
    name: row.name,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    memberCount: row._count.members,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Load a team the caller may act on, or throw 404 (client-bounded). */
async function teamInScope(
  user: Parameters<typeof effectiveClientIdFilter>[0],
  id: string,
) {
  const bounded = effectiveClientIdFilter(user, undefined);
  // Client-bounded caller with no client → fail closed.
  if (bounded === null) {
    throw new HttpError(404, 'team_not_found', 'Shift team not found');
  }
  const team = await prisma.shiftTeam.findFirst({
    where: {
      id,
      deletedAt: null,
      ...(bounded ? { clientId: bounded } : {}),
    },
    include: TEAM_INCLUDE,
  });
  if (!team) throw new HttpError(404, 'team_not_found', 'Shift team not found');
  return team;
}

// GET /scheduling/teams?clientId=&locationId= — list standing crews.
schedulingRouter.get('/teams', MANAGE, async (req, res, next) => {
  try {
    let clientId = req.query.clientId?.toString();
    const locationId = req.query.locationId?.toString();
    const bounded = effectiveClientIdFilter(req.user!, undefined);
    if (bounded !== undefined) {
      if (!bounded) {
        res.json(ShiftTeamListResponseSchema.parse({ teams: [] }));
        return;
      }
      clientId = bounded;
    }
    const rows = await prisma.shiftTeam.findMany({
      where: {
        deletedAt: null,
        ...(clientId ? { clientId } : {}),
        ...(locationId ? { locationId } : {}),
      },
      orderBy: [{ name: 'asc' }],
      include: TEAM_INCLUDE,
      take: 500,
    });
    res.json(
      ShiftTeamListResponseSchema.parse({ teams: rows.map(toShiftTeam) }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/teams', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftTeamCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;
    const bounded = effectiveClientIdFilter(req.user!, undefined);
    if (bounded !== undefined && i.clientId !== bounded) {
      throw new HttpError(403, 'client_forbidden', 'Cannot create a team for another client');
    }
    const location = await prisma.location.findFirst({
      where: { id: i.locationId, clientId: i.clientId, deletedAt: null },
    });
    if (!location) {
      throw new HttpError(404, 'location_not_found', 'Location not found under this client');
    }
    const created = await prisma.shiftTeam.create({
      data: {
        clientId: i.clientId,
        locationId: i.locationId,
        name: i.name.trim(),
        startMinute: i.startMinute ?? null,
        endMinute: i.endMinute ?? null,
      },
      include: TEAM_INCLUDE,
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'scheduling.team_created',
        entityType: 'ShiftTeam',
        entityId: created.id,
        metadata: { name: created.name, clientId: created.clientId, locationId: created.locationId },
      },
      'scheduling.team_created',
    );
    res.status(201).json(toShiftTeam(created));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.patch('/teams/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftTeamUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const team = await teamInScope(req.user!, req.params.id);
    const updated = await prisma.shiftTeam.update({
      where: { id: team.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
        ...(parsed.data.startMinute !== undefined ? { startMinute: parsed.data.startMinute } : {}),
        ...(parsed.data.endMinute !== undefined ? { endMinute: parsed.data.endMinute } : {}),
      },
      include: TEAM_INCLUDE,
    });
    res.json(toShiftTeam(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.delete('/teams/:id', MANAGE, async (req, res, next) => {
  try {
    const team = await teamInScope(req.user!, req.params.id);
    await prisma.shiftTeam.update({
      where: { id: team.id },
      data: { deletedAt: new Date() },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'scheduling.team_deleted',
        entityType: 'ShiftTeam',
        entityId: team.id,
        metadata: { name: team.name },
      },
      'scheduling.team_deleted',
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /scheduling/teams/:id — team + members, flagging any member who no
// longer works at the team's location (stale membership).
schedulingRouter.get('/teams/:id', MANAGE, async (req, res, next) => {
  try {
    const team = await teamInScope(req.user!, req.params.id);
    const members = await prisma.shiftTeamMember.findMany({
      where: { teamId: team.id },
      include: {
        associate: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            user: { select: { status: true } },
            applications: {
              where: { status: 'APPROVED', locationId: team.locationId, deletedAt: null },
              take: 1,
              select: { id: true },
            },
            assignments: {
              where: { endedAt: null, locationId: team.locationId },
              take: 1,
              select: { id: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(
      ShiftTeamDetailResponseSchema.parse({
        team: toShiftTeam(team),
        members: members.map((m) => ({
          associateId: m.associate.id,
          firstName: m.associate.firstName,
          lastName: m.associate.lastName,
          email: m.associate.email,
          atLocation:
            m.associate.applications.length > 0 ||
            m.associate.assignments.length > 0,
          // Informational: login state never gates scheduling.
          portalActive: m.associate.user?.status === 'ACTIVE',
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/teams/:id/members/:associateId/assign-here
 *
 * The one-click cure for "not at this site". A whole class of legitimately
 * onboarded associates has locationId=NULL on their approved application
 * (the invite's location field is optional, and approval only opens an
 * AssociateAssignment when it's set) — nothing in the product recorded
 * their site, so the badge fired and location-filtered rosters dropped
 * them. This opens an assignment at the TEAM's location, the same
 * close-then-open pattern as onboarding approval and the org transfer.
 */
schedulingRouter.post(
  '/teams/:id/members/:associateId/assign-here',
  MANAGE,
  async (req, res, next) => {
    try {
      const team = await teamInScope(req.user!, req.params.id);
      const membership = await prisma.shiftTeamMember.findFirst({
        where: { teamId: team.id, associateId: req.params.associateId },
        select: {
          associate: { select: { id: true, deletedAt: true } },
        },
      });
      if (!membership || membership.associate.deletedAt) {
        throw new HttpError(404, 'member_not_found', 'Not a member of this team');
      }
      const associateId = membership.associate.id;

      // Same cross-client fence as the org transfer: if their employment
      // record points at a different client, this quick action must not
      // quietly move them — that's a real transfer with its own flow.
      const openAssignment = await prisma.associateAssignment.findFirst({
        where: { associateId, endedAt: null },
        select: { id: true, location: { select: { clientId: true } } },
      });
      let expectedClientId = openAssignment?.location.clientId ?? null;
      if (expectedClientId === null) {
        const latestApproved = await prisma.application.findFirst({
          where: { associateId, status: 'APPROVED', deletedAt: null },
          orderBy: { invitedAt: 'desc' },
          select: { clientId: true },
        });
        expectedClientId = latestApproved?.clientId ?? null;
      }
      if (expectedClientId !== null && expectedClientId !== team.clientId) {
        throw new HttpError(
          400,
          'cross_client_transfer',
          'They currently work for a different client — use the org transfer flow instead.',
        );
      }

      const startedAt = new Date();
      const created = await prisma.$transaction(async (tx) => {
        if (openAssignment) {
          await tx.associateAssignment.update({
            where: { id: openAssignment.id },
            data: { endedAt: startedAt },
          });
        }
        return tx.associateAssignment.create({
          data: {
            associateId,
            locationId: team.locationId,
            startedAt,
            reason: `Assigned from shift team "${team.name}"`,
            notedById: req.user!.id,
          },
          select: { id: true },
        });
      });

      enqueueAudit(
        {
          actorUserId: req.user!.id,
          action: 'scheduling.team_member_assigned',
          entityType: 'Associate',
          entityId: associateId,
          metadata: {
            teamId: team.id,
            locationId: team.locationId,
            closedAssignmentId: openAssignment?.id ?? null,
            assignmentId: created.id,
          },
        },
        'scheduling.team_member_assigned',
      );

      res.json(ShiftTeamAssignHereResponseSchema.parse({ assignmentId: created.id }));
    } catch (err) {
      next(err);
    }
  },
);

schedulingRouter.post('/teams/:id/members', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftTeamMemberInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const team = await teamInScope(req.user!, req.params.id);
    const associate = await prisma.associate.findFirst({
      where: { id: parsed.data.associateId, deletedAt: null },
      select: { id: true },
    });
    if (!associate) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found');
    }
    // Idempotent: re-adding an existing member is a no-op, not an error.
    await prisma.shiftTeamMember.upsert({
      where: {
        teamId_associateId: { teamId: team.id, associateId: associate.id },
      },
      create: { teamId: team.id, associateId: associate.id },
      update: {},
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

schedulingRouter.delete(
  '/teams/:id/members/:associateId',
  MANAGE,
  async (req, res, next) => {
    try {
      const team = await teamInScope(req.user!, req.params.id);
      await prisma.shiftTeamMember.deleteMany({
        where: { teamId: team.id, associateId: req.params.associateId },
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/* ===== Phase 51 — shift templates + copy-week ============================ */

type RawTemplate = Prisma.ShiftTemplateGetPayload<{
  include: { client: { select: { name: true } } };
}>;

function toTemplate(row: RawTemplate): ShiftTemplateDTO {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.client?.name ?? null,
    name: row.name,
    position: row.position,
    dayOfWeek: row.dayOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    location: row.location,
    hourlyRate: row.hourlyRate ? Number(row.hourlyRate) : null,
    payRate: row.payRate ? Number(row.payRate) : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

const TEMPLATE_INCLUDE = {
  client: { select: { name: true } },
} as const;

/**
 * GET /scheduling/templates?clientId=X
 * When clientId is supplied, returns templates for that client + every
 * global template. Without clientId, returns ALL non-deleted templates
 * (HR overview).
 */
schedulingRouter.get('/templates', MANAGE, async (req, res, next) => {
  try {
    // Bounded roles are clamped to their own client (+ globals) no matter
    // what they request; admins keep the org-wide overview when omitted.
    const tplBounded = effectiveClientIdFilter(
      req.user!,
      req.query.clientId?.toString(),
    );
    const clientId = tplBounded === null ? NO_MATCH_ID : tplBounded;
    const where: Prisma.ShiftTemplateWhereInput = {
      deletedAt: null,
      ...(clientId ? { OR: [{ clientId }, { clientId: null }] } : {}),
    };
    const rows = await prisma.shiftTemplate.findMany({
      take: 1000,
      where,
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
      include: TEMPLATE_INCLUDE,
    });
    res.json(
      ShiftTemplateListResponseSchema.parse({ templates: rows.map(toTemplate) })
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/templates', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftTemplateCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;
    // Bounded roles can only create templates pinned to their own client
    // (a global template would leak into every other client's schedule).
    const createBounded = effectiveClientIdFilter(req.user!, undefined);
    if (createBounded !== undefined && i.clientId !== createBounded) {
      throw new HttpError(403, 'forbidden', 'You can only manage templates for your assigned client.');
    }
    if (i.clientId) {
      const c = await prisma.client.findFirst({ where: { id: i.clientId, deletedAt: null } });
      if (!c) throw new HttpError(404, 'client_not_found', 'Client not found');
    }
    const created = await prisma.shiftTemplate.create({
      data: {
        clientId: i.clientId,
        name: i.name,
        position: i.position,
        dayOfWeek: i.dayOfWeek,
        startMinute: i.startMinute,
        endMinute: i.endMinute,
        location: i.location ?? null,
        hourlyRate: i.hourlyRate ?? null,
        payRate: i.payRate ?? null,
        notes: i.notes ?? null,
      },
      include: TEMPLATE_INCLUDE,
    });
    res.status(201).json(toTemplate(created));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.delete('/templates/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.shiftTemplate.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) throw new HttpError(404, 'template_not_found', 'Template not found');
    // Bounded roles can only delete their own client's templates (404, not
    // 403, so existence isn't leaked across tenants).
    const delBounded = effectiveClientIdFilter(req.user!, undefined);
    if (delBounded !== undefined && existing.clientId !== delBounded) {
      throw new HttpError(404, 'template_not_found', 'Template not found');
    }
    await prisma.shiftTemplate.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/templates/:id/apply
 * Body: { weekStart, clientId? }
 * Stamps a DRAFT shift on the template's dayOfWeek of the target week.
 * Returns the created shift.
 */
schedulingRouter.post('/templates/:id/apply', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftTemplateApplyInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const tpl = await prisma.shiftTemplate.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!tpl) throw new HttpError(404, 'template_not_found', 'Template not found');

    const clientId = tpl.clientId ?? parsed.data.clientId;
    if (!clientId) {
      throw new HttpError(
        400,
        'client_required',
        'Global templates require a clientId at apply time'
      );
    }
    // Same guard as POST /shifts — apply creates a Shift, so a bounded
    // role must not be able to smuggle one into another client via a
    // template. Without this, template-apply bypassed the create guard.
    const applyBounded = effectiveClientIdFilter(req.user!, undefined);
    if (applyBounded !== undefined && clientId !== applyBounded) {
      throw new HttpError(403, 'forbidden', 'You can only manage shifts for your assigned client.');
    }
    // Phase 131 — derive locationId from the resolved client.
    const location = await firstLocationForClient(prisma, clientId);

    // Template minutes are wall-clock AT THE WORK SITE (same rule as the
    // drag-drop apply path in the UI). The old server-local setHours() put
    // shifts at the wrong wall time whenever the server's zone differed
    // from the site's. Find the site-local Sunday of the week containing
    // weekStart, advance to the template's dayOfWeek, then build the UTC
    // instants from site-local wall time.
    const siteTz = location.timezone ?? DEFAULT_TIMEZONE;
    const anchorKey = localDateKey(new Date(parsed.data.weekStart), siteTz);
    const [ay, am, ad] = anchorKey.split('-').map(Number);
    const anchorUtcMidnight = Date.UTC(ay!, (am ?? 1) - 1, ad ?? 1);
    // Calendar weekday of a plain date is timezone-independent.
    const anchorDow = new Date(anchorUtcMidnight).getUTCDay();
    const targetMs =
      anchorUtcMidnight + (tpl.dayOfWeek - anchorDow) * 86_400_000;
    const t = new Date(targetMs);
    const ty = t.getUTCFullYear();
    const tm = t.getUTCMonth() + 1;
    const td = t.getUTCDate();
    const startsAt = zonedWallTimeToUtcInstant(ty, tm, td, tpl.startMinute, siteTz);
    let endsAt = zonedWallTimeToUtcInstant(ty, tm, td, tpl.endMinute, siteTz);
    // Overnight templates: endMinute <= startMinute means the shift ends
    // the next site-local day.
    if (endsAt <= startsAt) {
      const n = new Date(targetMs + 86_400_000);
      endsAt = zonedWallTimeToUtcInstant(
        n.getUTCFullYear(),
        n.getUTCMonth() + 1,
        n.getUTCDate(),
        tpl.endMinute,
        siteTz,
      );
    }

    // Accidental double-apply guard (same duplicate plague as copy-week):
    // an identical not-cancelled shift at this exact slot 409s unless the
    // caller explicitly says a second slot is intentional.
    if (!parsed.data.allowDuplicate) {
      const twin = await prisma.shift.findFirst({
        where: {
          clientId,
          position: tpl.position,
          startsAt,
          endsAt,
          status: { not: 'CANCELLED' },
        },
        select: { id: true },
      });
      if (twin) {
        throw new HttpError(
          409,
          'duplicate_shift',
          'An identical shift already exists at this time. Confirm again if you want a second slot on purpose.',
        );
      }
    }

    const created = await prisma.shift.create({
      data: {
        clientId,
        locationId: location.id,
        position: tpl.position,
        startsAt,
        endsAt,
        location: tpl.location,
        hourlyRate: tpl.hourlyRate,
        payRate: tpl.payRate,
        notes: tpl.notes,
        status: 'DRAFT',
        createdById: req.user!.id,
      },
      include: SHIFT_INCLUDE,
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.created_from_template',
      shiftId: created.id,
      clientId: created.clientId,
      metadata: { templateId: tpl.id, templateName: tpl.name },
      req,
    });

    res.status(201).json(await withEffectiveRate(created));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/copy-week
 * Body: { sourceWeekStart, targetWeekStart, clientId? }
 *
 * Duplicates every non-cancelled shift from the source week into the
 * target week, preserving day-of-week + time-of-day. By default each copy
 * also keeps its associate assignment, so the whole roster carries forward
 * (pass preserveAssignments:false for blank drafts). New shifts always land
 * in DRAFT — publish-week is still the gate that flips them live and screens
 * double-bookings. Idempotent by content: a copy whose exact twin already
 * exists in the target window is skipped (reported as alreadyThere), so
 * re-clicks, timeout retries, and concurrent copies can't duplicate a week.
 */
schedulingRouter.post('/copy-week', MANAGE, async (req, res, next) => {
  try {
    const parsed = CopyWeekInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    // Use the client's window VERBATIM. The UI sends local midnight of the
    // first day it is showing — its week can be anchored on any weekday
    // (the range picker allows it). The old server-side "snap to Sunday in
    // server-local time" re-alignment shifted the window by up to a day
    // against what the manager was looking at: their week's tail never
    // copied, and the previous week's tail copied INTO the visible week.
    const source = new Date(parsed.data.sourceWeekStart);
    const target = new Date(parsed.data.targetWeekStart);
    const dayOffset = Math.round(
      (target.getTime() - source.getTime()) / 86_400_000,
    );
    if (dayOffset === 0) {
      throw new HttpError(
        400,
        'same_week',
        'Target week must differ from the source week.',
      );
    }
    const sourceEnd = new Date(source.getTime() + 7 * 86_400_000);

    // Tenant clamp FIRST (same fix as /kpis): the raw body clientId used to
    // override scopeShifts' clamp, letting a bounded caller copy ANOTHER
    // client's week — a cross-tenant write, since copies inherit the source
    // rows' clientId.
    const copyClamped = effectiveClientIdFilter(req.user!, parsed.data.clientId);
    const copyClientId = copyClamped === null ? NO_MATCH_ID : copyClamped;
    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      startsAt: { gte: source, lt: sourceEnd },
      status: { not: 'CANCELLED' },
      ...(copyClientId ? { clientId: copyClientId } : {}),
    };
    // Cap the batch but SAY so — the old take:100 silently dropped the rest
    // of a big week while reporting skipped: 0.
    const COPY_CAP = 1000;
    const [sourceShifts, totalMatching] = await Promise.all([
      prisma.shift.findMany({
        take: COPY_CAP,
        where,
        orderBy: { startsAt: 'asc' },
        include: { locationRel: { select: { timezone: true } } },
      }),
      prisma.shift.count({ where }),
    ]);
    const skipped = Math.max(0, totalMatching - sourceShifts.length);
    if (sourceShifts.length === 0) {
      const empty: CopyWeekResponse = { created: 0, skipped: 0, assigned: 0 };
      res.json(empty);
      return;
    }

    // Default to carrying each shift's assignee into the target week so HR
    // copies the whole roster in one click instead of re-assigning every
    // shift by hand. Copies stay DRAFT (assigned-but-unpublished), so
    // associates don't see them until publish-week — which is where
    // double-bookings are screened.
    const preserveAssignments = parsed.data.preserveAssignments ?? true;
    const assignedAt = new Date();

    // Idempotency by content. This route used to say "idempotency is on
    // the user; calling twice produces duplicates" — and users obliged:
    // a re-click, a retry after a cold-start timeout (the server often
    // HAD committed), or two admins copying the same week doubled every
    // shift in the target as DRAFTs. Now each intended copy is checked
    // against what's already in the target window and skipped when its
    // exact twin exists. Multiset-matched (a counter per key, not a set)
    // so N deliberately-identical open slots still copy as N.
    const targetStart = new Date(source.getTime() + dayOffset * 86_400_000);
    const existingTarget = await prisma.shift.findMany({
      take: 2000,
      where: {
        ...scopeShifts(req.user!),
        ...(copyClientId ? { clientId: copyClientId } : {}),
        status: { not: 'CANCELLED' },
        // Padded ±1 day: wall-clock-preserving copies across a DST change
        // can land ±1h outside the plain-offset window. Keys are exact,
        // so the padding can't cause a false match.
        startsAt: {
          gte: new Date(targetStart.getTime() - 86_400_000),
          lt: new Date(targetStart.getTime() + 8 * 86_400_000),
        },
      },
      select: {
        clientId: true,
        locationId: true,
        position: true,
        startsAt: true,
        endsAt: true,
        assignedAssociateId: true,
      },
    });
    const twinKey = (s: {
      clientId: string;
      locationId: string | null;
      position: string;
      startsAt: Date;
      endsAt: Date;
      assignedAssociateId: string | null;
    }) =>
      [
        s.clientId,
        s.locationId ?? '',
        s.position,
        s.startsAt.toISOString(),
        s.endsAt.toISOString(),
        s.assignedAssociateId ?? 'open',
      ].join('|');
    const twinBudget = new Map<string, number>();
    for (const s of existingTarget) {
      const k = twinKey(s);
      twinBudget.set(k, (twinBudget.get(k) ?? 0) + 1);
    }

    let assigned = 0;
    let alreadyThere = 0;
    // Phase 131 — preserve the source shift's locationId so copy-week
    // doesn't drop the FK. Source rows always have one (set by the PR
    // 1 backfill and by every writer since).
    const data: Prisma.ShiftCreateManyInput[] = [];
    for (const s of sourceShifts) {
      const carry = preserveAssignments && s.assignedAssociateId != null;
      // Calendar-day shift in the WORK SITE's zone so a copy across a DST
      // boundary keeps its wall-clock time (9am stays 9am).
      const tz = s.locationRel?.timezone ?? DEFAULT_TIMEZONE;
      const startsAt = addDaysInZone(s.startsAt, dayOffset, tz);
      const endsAt = addDaysInZone(s.endsAt, dayOffset, tz);
      const k = twinKey({
        clientId: s.clientId,
        locationId: s.locationId,
        position: s.position,
        startsAt,
        endsAt,
        assignedAssociateId: carry ? s.assignedAssociateId : null,
      });
      const budget = twinBudget.get(k) ?? 0;
      if (budget > 0) {
        twinBudget.set(k, budget - 1);
        alreadyThere += 1;
        continue;
      }
      if (carry) assigned += 1;
      data.push({
        clientId: s.clientId,
        locationId: s.locationId,
        position: s.position,
        startsAt,
        endsAt,
        location: s.location,
        hourlyRate: s.hourlyRate,
        payRate: s.payRate,
        notes: s.notes,
        status: 'DRAFT' as const,
        createdById: req.user!.id,
        ...(carry
          ? { assignedAssociateId: s.assignedAssociateId, assignedAt }
          : {}),
      });
    }
    const result =
      data.length > 0 ? await prisma.shift.createMany({ data }) : { count: 0 };

    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'scheduling.copied_week',
        entityType: 'Shift',
        entityId: source.toISOString(),
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          source: source.toISOString(),
          target: target.toISOString(),
          createdCount: result.count,
          assignedCount: assigned,
          skippedCount: skipped,
          alreadyThereCount: alreadyThere,
          preserveAssignments,
        },
      },
      'scheduling.copied_week'
    );

    const body: CopyWeekResponse = {
      created: result.count,
      skipped,
      assigned,
      alreadyThere,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/drafts/dedupe
 * Body: { from, to (exclusive), clientId? }
 *
 * Cleanup for the duplicates the pre-idempotency copy-week left behind:
 * groups DRAFT shifts in the window by exact twin key (client, location,
 * position, start/end, assignee-or-open) and hard-deletes all but the
 * OLDEST of each group — mirroring the single-shift DELETE route, which
 * also hard-deletes. DRAFTs only, and only never-published rows: anything
 * an associate may have seen stays untouched.
 */
schedulingRouter.post('/drafts/dedupe', MANAGE, async (req, res, next) => {
  try {
    const parsed = DedupeDraftsInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (to <= from) {
      throw new HttpError(400, 'invalid_range', 'to must be after from');
    }
    // Tenant clamp first — same rule as every other clientId param here.
    const clamped = effectiveClientIdFilter(req.user!, parsed.data.clientId);
    const dedupeClientId = clamped === null ? NO_MATCH_ID : clamped;

    const drafts = await prisma.shift.findMany({
      take: 2000,
      where: {
        ...scopeShifts(req.user!),
        ...(dedupeClientId ? { clientId: dedupeClientId } : {}),
        status: 'DRAFT',
        publishedAt: null,
        startsAt: { gte: from, lt: to },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        clientId: true,
        locationId: true,
        position: true,
        startsAt: true,
        endsAt: true,
        assignedAssociateId: true,
      },
    });

    // Rows arrive oldest-first, so the first of each key is the keeper.
    const seen = new Set<string>();
    const dupGroups = new Set<string>();
    const extras: string[] = [];
    for (const s of drafts) {
      const k = [
        s.clientId,
        s.locationId ?? '',
        s.position,
        s.startsAt.toISOString(),
        s.endsAt.toISOString(),
        s.assignedAssociateId ?? 'open',
      ].join('|');
      if (seen.has(k)) {
        extras.push(s.id);
        dupGroups.add(k);
      } else {
        seen.add(k);
      }
    }

    if (extras.length > 0) {
      await prisma.shift.deleteMany({ where: { id: { in: extras } } });
      enqueueAudit(
        {
          actorUserId: req.user!.id,
          action: 'scheduling.drafts_deduped',
          entityType: 'Shift',
          entityId: from.toISOString(),
          metadata: {
            from: from.toISOString(),
            to: to.toISOString(),
            scanned: drafts.length,
            removed: extras.length,
            // First 100 ids so a forensic "what exactly did it delete"
            // stays answerable without a giant metadata blob.
            removedIds: extras.slice(0, 100),
          },
        },
        'scheduling.drafts_deduped',
      );
    }

    res.json(
      DedupeDraftsResponseSchema.parse({
        scanned: drafts.length,
        groups: dupGroups.size,
        removed: extras.length,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/publish-week
 * Body: { weekStart, clientId? }
 *
 * Phase 53 — flips every DRAFT shift in the week to OPEN (no assignee) or
 * ASSIGNED (assignee set). Stamps publishedAt = now and sends the same
 * "shift_published" notification the per-shift PATCH path sends.
 *
 * Predictive-scheduling guard: a shift in a covered state that's inside
 * the 14-day notice window without a documented `lateNoticeReason` is
 * SKIPPED rather than failing the whole batch — HR can still publish the
 * compliant ones in one click and resolve the noisy ones individually.
 */
schedulingRouter.post('/publish-week', MANAGE, async (req, res, next) => {
  try {
    const parsed = PublishWeekInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    // Trust the client's window verbatim. This used to re-snap to
    // SERVER-local Monday midnight — UTC in production — so an ET admin's
    // "publish this week" acted on the UTC week instead of the one on
    // screen: Sunday-evening drafts (Monday UTC) silently stayed DRAFT and
    // the previous week's tail snuck in. The UI computes the exact boundary
    // of the week it displays (zone-aware when the grid renders a store
    // zone); the server's job is just [weekStart, weekEnd).
    const start = new Date(parsed.data.weekStart);
    const end = parsed.data.weekEnd
      ? new Date(parsed.data.weekEnd)
      : new Date(start.getTime() + 7 * 86_400_000);
    if (end <= start) {
      throw new HttpError(400, 'invalid_window', 'weekEnd must be after weekStart.');
    }

    // Tenant clamp FIRST (same fix as /kpis): the raw body clientId used to
    // override scopeShifts' clamp — a bounded caller could publish ANOTHER
    // client's drafts, notifying that client's associates.
    const pubClamped = effectiveClientIdFilter(req.user!, parsed.data.clientId);
    const pubClientId = pubClamped === null ? NO_MATCH_ID : pubClamped;
    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      status: 'DRAFT',
      startsAt: { gte: start, lt: end },
      ...(pubClientId ? { clientId: pubClientId } : {}),
    };
    // Cap+1 so a giant week can be REPORTED as truncated instead of
    // silently publishing the first N and leaving the rest DRAFT with no
    // signal (the old take:100 did exactly that). Deterministic order so
    // "run again" continues where this run stopped.
    const PUBLISH_CAP = 500;
    const draftRows = await prisma.shift.findMany({
      take: PUBLISH_CAP + 1,
      where,
      orderBy: { startsAt: 'asc' },
      include: {
        client: { select: { state: true, name: true } },
        assignedAssociate: { select: { firstName: true, lastName: true } },
        locationRel: { select: { timezone: true } },
      },
    });
    const truncated = draftRows.length > PUBLISH_CAP;
    const drafts = truncated ? draftRows.slice(0, PUBLISH_CAP) : draftRows;

    const now = new Date();
    const skipped: PublishWeekSkip[] = [];
    const publishable: typeof drafts = [];

    // Tracks each associate's occupied windows as this batch is admitted,
    // so two overlapping DRAFTS for the same person can't both publish
    // (June audit P0 — publish-week had no double-booking guard).
    const admittedByAssociate = new Map<string, { startsAt: Date; endsAt: Date }[]>();

    // One batched fetch of every assigned draft's LIVE shifts (per-draft
    // findFirst here was an up-to-100-query loop — July review). Window is
    // overlap-based, not week-bounded, so an overnight shift from the
    // previous Sunday still counts.
    const assignedDraftIds = drafts
      .map((s) => s.assignedAssociateId)
      .filter((id): id is string => !!id);
    const liveByAssociate = new Map<string, { startsAt: Date; endsAt: Date }[]>();
    if (assignedDraftIds.length > 0) {
      const minStart = new Date(Math.min(...drafts.map((s) => s.startsAt.getTime())));
      const maxEnd = new Date(Math.max(...drafts.map((s) => s.endsAt.getTime())));
      const live = await prisma.shift.findMany({
        where: {
          assignedAssociateId: { in: [...new Set(assignedDraftIds)] },
          status: { notIn: ['CANCELLED', 'DRAFT'] },
          startsAt: { lt: maxEnd },
          endsAt: { gt: minStart },
        },
        select: { assignedAssociateId: true, startsAt: true, endsAt: true },
        take: 2000,
      });
      for (const r of live) {
        const list = liveByAssociate.get(r.assignedAssociateId!) ?? [];
        list.push({ startsAt: r.startsAt, endsAt: r.endsAt });
        liveByAssociate.set(r.assignedAssociateId!, list);
      }
    }

    for (const s of drafts) {
      const evaluation = evaluateShiftNotice({
        state: s.client.state,
        startsAt: s.startsAt,
        publishAt: now,
      });
      if (evaluation.requiresReason && !s.lateNoticeReason) {
        skipped.push({
          shiftId: s.id,
          reason: 'predictive_schedule_violation',
          detail: `Inside 14-day notice window in ${evaluation.state} — open the shift and add lateNoticeReason before publishing.`,
        });
        continue;
      }
      if (s.assignedAssociateId) {
        const inBatch = admittedByAssociate.get(s.assignedAssociateId) ?? [];
        const clashesInBatch = inBatch.some(
          (w) => w.startsAt < s.endsAt && w.endsAt > s.startsAt,
        );
        // LIVE-shift check from the batched prefetch — other drafts are
        // handled by the in-batch tracker above (they'd otherwise veto
        // each other and publish nothing).
        const liveClash = (liveByAssociate.get(s.assignedAssociateId) ?? []).some(
          (w) => w.startsAt < s.endsAt && w.endsAt > s.startsAt,
        );
        if (clashesInBatch || liveClash) {
          skipped.push({
            shiftId: s.id,
            reason: 'double_booking',
            detail:
              'Publishing would double-book the assigned associate — adjust the times or reassign first.',
          });
          continue;
        }
        inBatch.push({ startsAt: s.startsAt, endsAt: s.endsAt });
        admittedByAssociate.set(s.assignedAssociateId, inBatch);
      }
      publishable.push(s);
    }

    // Bucket publishable shifts by assignee so we can send ONE digest
    // notification per associate at the end. Without this, a person with
    // five shifts in the published week would get five push pings — fine
    // for a single change, spammy on a batch publish.
    // Bucket by assignee (for the per-associate digests below) and split by
    // target status — assigned shifts publish to ASSIGNED, unassigned to OPEN.
    const perAssociate = new Map<string, typeof publishable>();
    const assignedIds: string[] = [];
    const openIds: string[] = [];
    for (const s of publishable) {
      if (s.assignedAssociateId) {
        assignedIds.push(s.id);
        const bucket = perAssociate.get(s.assignedAssociateId) ?? [];
        bucket.push(s);
        perAssociate.set(s.assignedAssociateId, bucket);
      } else {
        openIds.push(s.id);
      }
    }
    const publishedCount = publishable.length;

    // Two bulk writes instead of one update per shift (a big week was 100+
    // serial round-trips that could brush the request timeout).
    await prisma.$transaction([
      ...(assignedIds.length > 0
        ? [
            prisma.shift.updateMany({
              where: { id: { in: assignedIds } },
              data: { status: 'ASSIGNED', publishedAt: now },
            }),
          ]
        : []),
      ...(openIds.length > 0
        ? [
            prisma.shift.updateMany({
              where: { id: { in: openIds } },
              data: { status: 'OPEN', publishedAt: now },
            }),
          ]
        : []),
    ]);

    // One audit event for the whole batch (per-shift events were the other
    // half of the N+1).
    if (publishedCount > 0) {
      await recordShiftEvent({
        actorUserId: req.user!.id,
        action: 'shift.updated',
        shiftId: publishable[0]!.id,
        clientId: publishable[0]!.clientId,
        metadata: {
          fields: ['status', 'publishedAt'],
          publish: 'week',
          count: publishedCount,
        },
        req,
      });
    }

    // One digest per associate, ordered chronologically. Subject scales
    // with the count so a single-shift batch reads naturally.
    for (const [associateId, shifts] of perAssociate) {
      shifts.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      const lines = shifts.map((s) =>
        formatShiftLine({
          position: s.position,
          clientName: s.client?.name ?? null,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          timezone: s.locationRel?.timezone ?? null,
        }),
      );
      const subject =
        shifts.length === 1
          ? 'Shift published'
          : `${shifts.length} shifts published`;
      const body =
        shifts.length === 1
          ? `Now on your schedule: ${lines[0]}`
          : `Now on your schedule:\n${lines.map((l) => `• ${l}`).join('\n')}`;
      void notifyShift(prisma, {
        associateId,
        subject,
        body,
        category: 'shift_published',
        senderUserId: req.user!.id,
      });
    }

    const body: PublishWeekResponse = {
      published: publishedCount,
      skipped,
      ...(truncated ? { truncated: true } : {}),
    };
    res.json(PublishWeekResponseSchema.parse(body));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/auto-schedule-week
 * Body: { weekStart, clientId? }
 *
 * One-click "fill the week" — for every OPEN shift in the snapped Mon–Sun
 * window, picks the best-scoring associate using the same heuristic as
 * /shifts/:id/auto-fill (availability match, no conflict, room before 40h
 * OT, PTO is a hard veto), and assigns them. Earlier shifts get first
 * claim on candidates so a popular associate isn't sniped from a Monday
 * morning by a Friday evening that scored them slightly higher.
 *
 * Stays in DRAFT-or-current status — does NOT touch publishedAt. Manager
 * still has to hit "Publish week" before associates see anything, which
 * means no notifications fire here either (the publish-week digest is
 * the single broadcast moment).
 *
 * Skipped shifts come back in the response with a reason so the manager
 * can see exactly which slots still need a human decision.
 */
schedulingRouter.post('/auto-schedule-week', MANAGE, async (req, res, next) => {
  try {
    const parsed = AutoScheduleWeekInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    // Same no-resnap contract as /publish-week: server-local Monday
    // snapping on a UTC box acted on the UTC week, not the one on screen.
    const start = new Date(parsed.data.weekStart);
    const end = parsed.data.weekEnd
      ? new Date(parsed.data.weekEnd)
      : new Date(start.getTime() + 7 * 86_400_000);
    if (end <= start) {
      throw new HttpError(400, 'invalid_window', 'weekEnd must be after weekStart.');
    }

    // Tenant clamp FIRST (same fix as /kpis): the raw body clientId used to
    // override scopeShifts' clamp — a bounded caller could auto-fill
    // ANOTHER client's open shifts.
    const autoClamped = effectiveClientIdFilter(req.user!, parsed.data.clientId);
    const autoClientId = autoClamped === null ? NO_MATCH_ID : autoClamped;
    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      // Unassigned DRAFTs are the normal state of a week being built (the
      // create dialog, copy-week, and template-apply all produce drafts) —
      // auto-schedule must see them or the build→auto-fill→publish flow
      // never has an auto-fill step. Assigned drafts stay private until
      // publish-week, which remains the double-booking gate.
      status: { in: ['OPEN', 'DRAFT'] },
      assignedAssociateId: null,
      startsAt: { gte: start, lt: end },
      ...(autoClientId ? { clientId: autoClientId } : {}),
    };

    // Earlier shifts go first so they get first pick of candidates.
    const openShifts = await prisma.shift.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: 2000,
      include: { locationRel: { select: { timezone: true } } },
    });

    if (openShifts.length === 0) {
      const empty: AutoScheduleWeekResponse = {
        assigned: 0,
        skipped: [],
        byAssociate: [],
      };
      res.json(AutoScheduleWeekResponseSchema.parse(empty));
      return;
    }

    // Pull the candidate pool ONCE for the whole week. We mutate the
    // in-memory state below as we assign so that consecutive iterations
    // don't double-book the same associate or push them over 40h.
    const weekStartUTC = startOfWeekUTC(openShifts[0].startsAt);
    const weekEndUTC = endOfWeekUTC(openShifts[0].startsAt);

    const [associates, ptoRows, exceptionRows] = await Promise.all([
      prisma.associate.findMany({
        where: ACTIVE_ASSOCIATE_FILTER,
        include: {
          assignedShifts: {
            where: {
              status: { notIn: ['CANCELLED', 'COMPLETED'] },
              startsAt: { gte: weekStartUTC, lt: weekEndUTC },
            },
            select: { startsAt: true, endsAt: true },
          },
          timeEntries: {
            where: { clockInAt: { gte: weekStartUTC, lt: weekEndUTC } },
            include: { breaks: true },
          },
          availability: true,
        },
        take: 1000,
      }),
      // SAFETY list, not a display list: any approved PTO past the cap was
      // silently ignored, and the scheduler could assign someone on leave.
      // These are 3-column selects over a one-week window — cap generously
      // at the same scale as the roster itself.
      prisma.timeOffRequest.findMany({
        take: 2000,
        where: {
          status: 'APPROVED',
          startDate: { lte: end },
          endDate: { gte: start },
        },
        select: { associateId: true, startDate: true, endDate: true },
      }),
      // One-off "can't work this day" exceptions — same veto as PTO, so
      // they merge into the pto ranges below as single-day blocks.
      prisma.availabilityException.findMany({
        take: 2000,
        where: { date: { gte: start, lte: end } },
        select: { associateId: true, date: true },
      }),
    ]);

    type AssocState = {
      id: string;
      name: string;
      availability: { dayOfWeek: number; startMinute: number; endMinute: number }[];
      // mutable: shifts already-assigned for THIS week (pre-existing + auto-added)
      busy: { startsAt: Date; endsAt: Date }[];
      // mutable: minutes already worked (actual + scheduled this week)
      weeklyMinutes: number;
      // PTO ranges that block specific shift days
      pto: { start: Date; end: Date }[];
    };

    const ptoByAssociate = new Map<string, { start: Date; end: Date }[]>();
    for (const r of ptoRows) {
      const list = ptoByAssociate.get(r.associateId) ?? [];
      list.push({ start: r.startDate, end: r.endDate });
      ptoByAssociate.set(r.associateId, list);
    }
    for (const x of exceptionRows) {
      const list = ptoByAssociate.get(x.associateId) ?? [];
      list.push({ start: x.date, end: x.date });
      ptoByAssociate.set(x.associateId, list);
    }

    const states: AssocState[] = associates.map((a) => {
      const scheduledMins = a.assignedShifts.reduce(
        (sum, s) => sum + Math.floor((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000),
        0,
      );
      const actualMins = a.timeEntries.reduce(
        (sum, e) => sum + netWorkedMinutes(e, e.breaks),
        0,
      );
      return {
        id: a.id,
        name: `${a.firstName} ${a.lastName}`,
        availability: a.availability.map((w) => ({
          dayOfWeek: w.dayOfWeek,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
        })),
        busy: a.assignedShifts.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
        // Use the larger of scheduled-or-actual as the "minutes consumed"
        // baseline — same idea as the per-shift /auto-fill route, which
        // checks against actuals to avoid pushing someone past 40h OT.
        weeklyMinutes: Math.max(scheduledMins, actualMins),
        pto: ptoByAssociate.get(a.id) ?? [],
      };
    });

    const skipped: AutoScheduleSkip[] = [];
    const assignedCounts = new Map<string, { name: string; count: number }>();
    let assignedTotal = 0;

    for (const shift of openShifts) {
      // Wall-clock at the store, matching how associates enter availability.
      const shiftTz = shift.locationRel?.timezone ?? DEFAULT_TIMEZONE;
      const dow = zonedDayOfWeek(shift.startsAt, shiftTz);
      const startMin = zonedMinutes(shift.startsAt, shiftTz);
      const endMin = zonedMinutes(shift.endsAt, shiftTz);
      const shiftMinutes = Math.floor(
        (shift.endsAt.getTime() - shift.startsAt.getTime()) / 60_000,
      );

      // Store-local day bounds — UTC flooring made the PTO/day-off veto
      // off by one for evening shifts west of UTC (July re-audit P2).
      const shiftDayStart = new Date(
        `${dayKeyInZone(shift.startsAt, shiftTz)}T00:00:00Z`,
      );
      const shiftDayEnd = new Date(
        `${dayKeyInZone(shift.endsAt, shiftTz)}T00:00:00Z`,
      );

      type Scored = { state: AssocState; score: number };
      const scored: Scored[] = [];
      let everyoneOverOT = true;
      let anyEligible = false;

      for (const s of states) {
        // PTO is a hard veto — don't even consider this candidate.
        const onPto = s.pto.some(
          (p) => p.start <= shiftDayEnd && p.end >= shiftDayStart,
        );
        if (onPto) continue;

        // Conflict against any prior or just-added shift this week.
        const hasConflict = s.busy.some(
          (b) => b.startsAt < shift.endsAt && b.endsAt > shift.startsAt,
        );
        if (hasConflict) continue;

        anyEligible = true;
        const wouldExceed40 = s.weeklyMinutes + shiftMinutes > 40 * 60;
        if (wouldExceed40) continue;
        everyoneOverOT = false;

        const matchesAvailability = s.availability.some(
          (w) =>
            w.dayOfWeek === dow &&
            w.startMinute <= startMin &&
            w.endMinute >= endMin,
        );

        // Mirror the per-shift scorer, then break ties with whoever has
        // FEWER weekly minutes — keeps load balanced across the team.
        let score = 0;
        if (matchesAvailability) score += 0.5;
        score += 0.3; // no conflict (already filtered)
        score += 0.2; // not over 40h (already filtered)
        // Tiebreak: prefer the lighter-loaded associate. Multiply by a
        // small factor so it never beats a real signal but always beats
        // alphabetical / insertion order.
        score += (1 - s.weeklyMinutes / (40 * 60)) * 0.05;

        scored.push({ state: s, score });
      }

      if (scored.length === 0) {
        if (anyEligible && everyoneOverOT) {
          skipped.push({
            shiftId: shift.id,
            reason: 'all_candidates_overtime',
            detail: 'Every available associate would cross 40h this week.',
          });
        } else {
          skipped.push({
            shiftId: shift.id,
            reason: 'no_eligible_candidate',
            detail: 'No associate is available without a conflict or approved time off.',
          });
        }
        continue;
      }

      scored.sort((a, b) => b.score - a.score);
      const winner = scored[0].state;

      // Guarded claim: only assign if the shift is STILL unassigned in its
      // original status. A concurrent manual assign/cancel between the
      // initial fetch and now would otherwise be silently overwritten
      // (TOCTOU). A DRAFT stays DRAFT (assigned-but-unpublished); an OPEN
      // shift flips to ASSIGNED as before.
      const claim = await prisma.shift.updateMany({
        where: { id: shift.id, status: shift.status, assignedAssociateId: null },
        data: {
          status: shift.status === 'DRAFT' ? 'DRAFT' : 'ASSIGNED',
          assignedAssociateId: winner.id,
          assignedAt: new Date(),
        },
      });
      if (claim.count === 0) {
        skipped.push({
          shiftId: shift.id,
          reason: 'no_eligible_candidate',
          detail: 'Shift was changed by someone else during auto-schedule; left as-is.',
        });
        continue;
      }
      await recordShiftEvent({
        actorUserId: req.user!.id,
        action: 'shift.updated',
        shiftId: shift.id,
        clientId: shift.clientId,
        metadata: {
          fields: ['status', 'assignedAssociateId'],
          autoFill: 'week',
          associateId: winner.id,
        },
        req,
      });

      // Mutate in-memory state so the next iteration sees this assignment.
      winner.busy.push({ startsAt: shift.startsAt, endsAt: shift.endsAt });
      winner.weeklyMinutes += shiftMinutes;
      assignedTotal += 1;
      const prev = assignedCounts.get(winner.id);
      if (prev) prev.count += 1;
      else assignedCounts.set(winner.id, { name: winner.name, count: 1 });
    }

    const byAssociate = Array.from(assignedCounts.entries())
      .map(([associateId, { name, count }]) => ({
        associateId,
        associateName: name,
        shiftsAssigned: count,
      }))
      .sort((a, b) => b.shiftsAssigned - a.shiftsAssigned);

    const body: AutoScheduleWeekResponse = {
      assigned: assignedTotal,
      skipped,
      byAssociate,
    };
    res.json(AutoScheduleWeekResponseSchema.parse(body));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/export.pdf
 * Body: { from: ISO, to: ISO (exclusive), clientId? }
 *
 * Phase 54.4 — chronological PDF of every shift in the range, scoped per
 * the caller's role (HR sees all, CLIENT_PORTAL sees its own client only).
 * Streams application/pdf so the browser triggers a download.
 */
schedulingRouter.post('/export.pdf', MANAGE, async (req, res, next) => {
  try {
    const parsed = ScheduleExportInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (to <= from) {
      throw new HttpError(400, 'invalid_range', 'to must be after from');
    }

    // Tenant clamp FIRST (same fix as /kpis): the raw body clientId used to
    // override scopeShifts' clamp — a bounded caller could export ANOTHER
    // client's schedule (names, positions, rates) as a PDF.
    const pdfClamped = effectiveClientIdFilter(req.user!, parsed.data.clientId);
    const pdfClientId = pdfClamped === null ? NO_MATCH_ID : pdfClamped;
    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      startsAt: { gte: from, lt: to },
      ...(pdfClientId ? { clientId: pdfClientId } : {}),
    };
    const rows = await prisma.shift.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      include: SHIFT_INCLUDE,
      take: SCHEDULE_PDF_MAX_ROWS,
    });
    if (rows.length === SCHEDULE_PDF_MAX_ROWS) {
      // Signal truncation so the UI can show "showing first 5000 of N+".
      // We deliberately ship the partial PDF rather than 413 — a partial
      // schedule export is more useful than an error, and the header
      // gives ops a way to spot when the cap is being hit at scale.
      res.setHeader('X-Truncated', 'true');
      res.setHeader('X-Truncated-Limit', String(SCHEDULE_PDF_MAX_ROWS));
    }

    let clientName: string | null = null;
    if (parsed.data.clientId) {
      const c = await prisma.client.findFirst({
        where: { id: parsed.data.clientId, deletedAt: null },
        select: { name: true },
      });
      clientName = c?.name ?? null;
    }

    const pdf = await renderSchedulePdf({
      rangeFrom: from,
      rangeTo: to,
      generatedAt: new Date(),
      // Header stamp timezone: the first shift's site, else the deployment
      // default. Per-row times each use their own site timezone.
      timezone: rows[0]?.locationRel?.timezone ?? DEFAULT_TIMEZONE,
      filters: { clientName },
      shifts: rows.map((r) => ({
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        position: r.position,
        clientName: r.client?.name ?? null,
        location: r.location,
        // Render each row's date/time in its own work-site timezone so the
        // printed schedule shows store-local times, not the server's UTC.
        timezone: r.locationRel?.timezone ?? DEFAULT_TIMEZONE,
        assignedAssociateName: r.assignedAssociate
          ? `${r.assignedAssociate.firstName} ${r.assignedAssociate.lastName}`
          : null,
        status: r.status,
        hourlyRate: r.hourlyRate ? Number(r.hourlyRate) : null,
        scheduledMinutes: scheduledMinutes(r),
      })),
    });

    const fname = `shifts-${from.toISOString().slice(0, 10)}-to-${new Date(
      to.getTime() - 1
    )
      .toISOString()
      .slice(0, 10)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});
