import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  DirectoryEntrySchema,
  DirectoryListResponseSchema,
  PersonOverviewSchema,
  WORK_STATUSES,
  WorkStatusCountsSchema,
  can,
  directoryStatusOf,
  type DirectoryEntry,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { peopleStandings, workStatusCounts } from '../lib/peopleStatus.js';
import { atClient, scopeAssociates, scopeDocuments, scopeShifts, scopeTimeEntries, scopeWhere } from '../lib/scope.js';
import { scheduleMembershipFor } from '../lib/payScheduleMembership.js';
import { ASSOCIATE_SEARCH, idsMatching } from '../lib/peopleSearch.js';
import { hireDatesFor } from '../lib/hireDate.js';
import { orgDateKey } from '../lib/timeAnomalies.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { computePercent } from '../lib/checklist.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { assertSameTenant } from '../lib/sameTenant.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { canUseMessenger } from '../lib/messaging.js';
import type { SessionUser } from '../types/express.js';

/**
 * People directory.
 *
 * One row per associate, with the joins HR actually wants up-front:
 * - employment status (derived from applications)
 * - current workplace (client of the most-recent ACTIVE application,
 *   falling back to the most-recent application overall)
 * - live pay rate (latest CompensationRecord with effectiveTo=null)
 * - employment type, start date, manager / dept / job profile
 * - onboarding % complete for PENDING entries
 *
 * Two reads share one row builder: the paged list, and one person by id
 * (the profile deep link — a name clicked on Compliance or a dashboard
 * must open whoever it names, whatever page or filter the directory is
 * sitting on).
 *
 * Scope: VIEW capability gate. CLIENT_PORTAL doesn't get a path here yet —
 * org views aren't surfaced to portal users today.
 */
export const directoryRouter = Router();

const VIEW = requireCapability('view:org');

// One page size, and the default may not exceed the maximum — it did
// (1000 vs 500), so the 'cap' applied only to callers who passed an
// explicit ?limit, and the default path quietly fetched double it. The
// endpoint returns nextCursor for callers that need more.
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = MAX_PAGE_SIZE;

const QuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'PENDING', 'INACTIVE']).optional(),
  /** The one status (lib/peopleStatus): the tiles' filters. */
  workStatus: z.enum(WORK_STATUSES).optional(),
  clientId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  employmentType: z
    .enum(['W2_EMPLOYEE', 'CONTRACTOR_1099_INDIVIDUAL', 'CONTRACTOR_1099_BUSINESS'])
    .optional(),
  // Pagination — optional. `cursor` is the id of the last associate
  // from the previous page; the API skips it and returns rows after.
  // `limit` is capped at MAX_PAGE_SIZE to bound query size.
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

// Everything a directory row is synthesized from. `applications` ordered
// desc so the first one in each array is the freshest.
const DIRECTORY_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  employmentType: true,
  j1Status: true,
  createdAt: true,
  photoS3Key: true,
  separatedAt: true,
  deactivatedAt: true,
  deactivationReason: true,
  photoUpdatedAt: true,
  managerId: true,
  manager: { select: { firstName: true, lastName: true } },
  departmentId: true,
  department: { select: { name: true } },
  jobProfileId: true,
  jobProfile: { select: { title: true } },
  // Their login, for the record's Message action (lib/messaging decides who may be messaged).
  user: { select: { id: true, role: true, status: true, deletedAt: true } },
  applications: {
    where: { deletedAt: null },
    select: {
      id: true,
      status: true,
      clientId: true,
      position: true,
      startDate: true,
      invitedAt: true,
      approvedAt: true,
      client: { select: { name: true } },
      checklist: {
        select: {
          tasks: { select: { status: true } },
        },
      },
    },
    orderBy: { invitedAt: 'desc' },
  },
  // Phase 131 — current open assignment, if any. There's at most
  // one per associate (partial unique index in the schema).
  // location.client is included so workplaceClient* can prefer
  // the live assignment over the Application's clientId.
  assignments: {
    where: { endedAt: null },
    select: {
      locationId: true,
      startedAt: true,
      location: {
        select: {
          name: true,
          clientId: true,
          client: { select: { name: true } },
        },
      },
    },
    take: 1,
  },
} satisfies Prisma.AssociateSelect;

type DirectoryRow = Prisma.AssociateGetPayload<{ select: typeof DIRECTORY_SELECT }>;

const DAY_MS = 86_400_000;

/** Net minutes of one clock-in, breaks taken out; an open one counts to `now`. */
function netMinutesOf(e: { clockInAt: Date; clockOutAt: Date | null; breaks: Array<{ startedAt: Date; endedAt: Date | null }> }, now: Date): number {
  const end = Math.min((e.clockOutAt ?? now).getTime(), now.getTime());
  let ms = Math.max(0, end - e.clockInAt.getTime());
  for (const b of e.breaks) {
    const bEnd = Math.min((b.endedAt ?? new Date(end)).getTime(), end);
    ms -= Math.max(0, bEnd - b.startedAt.getTime());
  }
  return Math.max(0, Math.floor(ms / 60_000));
}

/**
 * The time behind "Last shift" and "Hours (14 days)": per person, their
 * latest clock-in and the net minutes of the clock-ins that started in the
 * active window. Rejected punches don't count (the active definition reads
 * the same), and only time the caller may see counts — a store-bound
 * account reads the hours worked at its stores, not someone's shifts at a
 * store outside its reach (lib/scope.scopeTimeEntries).
 */
async function recentWork(
  user: SessionUser,
  ids: string[],
  windowDays: number,
  now: Date,
): Promise<Map<string, { lastWorkedAt: Date | null; minutes: number; entries: number }>> {
  const out = new Map<string, { lastWorkedAt: Date | null; minutes: number; entries: number }>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, { lastWorkedAt: null, minutes: 0, entries: 0 });
  const since = new Date(now.getTime() - windowDays * DAY_MS);
  const base = { associateId: { in: ids }, tenantId: tenantIdForWrite(), status: { not: 'REJECTED' as const }, clockInAt: { lte: now } };
  const [latest, recent] = await Promise.all([
    prisma.timeEntry.groupBy({
      by: ['associateId'],
      where: scopeWhere<Prisma.TimeEntryWhereInput>(base, scopeTimeEntries(user)),
      _max: { clockInAt: true },
    }),
    prisma.timeEntry.findMany({
      where: scopeWhere<Prisma.TimeEntryWhereInput>({ ...base, clockInAt: { gte: since, lte: now } }, scopeTimeEntries(user)),
      select: { associateId: true, clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true } } },
    }),
  ]);
  for (const l of latest) {
    const cur = out.get(l.associateId);
    if (cur) cur.lastWorkedAt = l._max.clockInAt ?? null;
  }
  for (const e of recent) {
    const cur = out.get(e.associateId);
    if (!cur) continue;
    cur.minutes += netMinutesOf(e, now);
    cur.entries += 1;
  }
  return out;
}

/** Rows → directory entries, with the live pay rate batch-fetched once. */
async function buildEntries(user: SessionUser, associates: DirectoryRow[], now: Date = new Date()): Promise<DirectoryEntry[]> {
  // The one status per person (lib/peopleStatus), asked about this page's rows only.
  const standings = await peopleStandings({ tenantId: tenantIdForWrite(), associateIds: associates.map((a) => a.id) }, now);
  const ids = associates.map((a) => a.id);
  // Pay is read by those who may read pay (view:comp — the Pay tab's own
  // gate); everyone else gets the fields left out, not a fake "no rate".
  const seesPay = can(user, 'view:comp');
  const work = await recentWork(user, ids, standings.windowDays, now);
  // One open compensation row per associate ⇒ batch-fetch and index.
  const liveComp =
    ids.length === 0 || !seesPay
      ? []
      : await prisma.compensationRecord.findMany({
          take: 500,
          where: { associateId: { in: ids }, effectiveTo: null },
          select: {
            associateId: true,
            amount: true,
            payType: true,
            currency: true,
            effectiveFrom: true,
          },
        });
  // Many associates may have no comp record. If multiple match (data
  // glitch), keep the most recent effectiveFrom.
  const compByAssoc = new Map<string, (typeof liveComp)[number]>();
  for (const c of liveComp) {
    const cur = compByAssoc.get(c.associateId);
    if (!cur || c.effectiveFrom > cur.effectiveFrom) {
      compByAssoc.set(c.associateId, c);
    }
  }

  const hires = await hireDatesFor(
    prisma,
    associates.map((a) => a.id),
    new Map(
      associates.map((a) => {
        // The workplace application, as below: approved, else in flight, else the newest.
        const app =
          a.applications.find((x) => x.status === 'APPROVED') ??
          a.applications.find((x) => x.status === 'DRAFT' || x.status === 'SUBMITTED' || x.status === 'IN_REVIEW') ??
          a.applications[0] ??
          null;
        return [a.id, app?.startDate ?? null];
      }),
    ),
  );
  return associates.map((a) => {
    const apps = a.applications;
    const approved = apps.find((x) => x.status === 'APPROVED');
    const inFlight = apps.find(
      (x) =>
        x.status === 'DRAFT' ||
        x.status === 'SUBMITTED' ||
        x.status === 'IN_REVIEW',
    );
    // Where they stand, by the one rule (lib/peopleStatus): Working, No
    // recent shifts, Not placed, Onboarding, Paused or Separated. The older
    // ACTIVE / PENDING / INACTIVE is derived from it, never computed apart.
    const workStatus = standings.people.get(a.id)?.status ?? 'NOT_PLACED';
    const status = directoryStatusOf(workStatus);
    const separated = workStatus === 'SEPARATED';

    // Workplace = approved client first, then most-recent application.
    const workplaceApp = approved ?? inFlight ?? apps[0] ?? null;

    // Phase 131 — when an open AssociateAssignment exists, its Location's
    // client is the live workplace. Falls back to the application chain
    // for associates that haven't been placed at a Location yet.
    const openAssignment = a.assignments[0] ?? null;
    const workplaceClientId =
      openAssignment?.location.clientId ?? workplaceApp?.clientId ?? null;
    const workplaceClientName =
      openAssignment?.location.client?.name ??
      workplaceApp?.client?.name ??
      null;

    const comp = compByAssoc.get(a.id) ?? null;

    // Onboarding % only meaningful for PENDING (or freshly approved)
    // — pulls from the most-recent application's checklist.
    let onboardingPercent: number | null = null;
    if (status === 'PENDING' && inFlight?.checklist) {
      onboardingPercent = computePercent(
        inFlight.checklist.tasks.map((t) => ({ status: t.status })),
      );
    }

    return {
      id: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      email: a.email,
      phone: a.phone,
      employmentType: a.employmentType,
      j1Status: a.j1Status,
      status,
      workStatus,
      workplaceClientId,
      workplaceClientName,
      position: workplaceApp?.position ?? null,
      // One hire date (lib/hireDate): the employment record, else the hire
      // at approval, else the application's planned start (PEOPLE-10).
      startDate: hires.get(a.id)?.date ?? null,
      startDateSource: hires.get(a.id)?.source ?? null,
      ...(seesPay
        ? {
            payAmount: comp ? comp.amount.toString() : null,
            payType: comp?.payType ?? null,
            payCurrency: comp?.currency ?? null,
          }
        : {}),
      lastWorkedAt: work.get(a.id)?.lastWorkedAt?.toISOString() ?? null,
      recentMinutes: work.get(a.id)?.minutes ?? 0,
      managerId: a.managerId,
      managerName: a.manager
        ? `${a.manager.firstName} ${a.manager.lastName}`.trim()
        : null,
      departmentId: a.departmentId,
      departmentName: a.department?.name ?? null,
      jobProfileId: a.jobProfileId,
      jobProfileTitle: a.jobProfile?.title ?? null,
      onboardingPercent,
      applicationId: workplaceApp?.id ?? null,
      separatedAt: separated && a.separatedAt ? a.separatedAt.toISOString() : null,
      deactivatedAt: a.deactivatedAt ? a.deactivatedAt.toISOString() : null,
      deactivationReason: a.deactivatedAt ? a.deactivationReason : null,
      createdAt: a.createdAt.toISOString(),
      photoUrl: profilePhotoUrlFor({
        id: a.id,
        photoS3Key: a.photoS3Key,
        photoUpdatedAt: a.photoUpdatedAt,
      }),
      // The user id to open a thread with, when they hold a login the
      // messenger serves (staff; never a plain associate's login).
      messageUserId:
        a.user && !a.user.deletedAt && a.user.status === 'ACTIVE' && canUseMessenger(a.user.role)
          ? a.user.id
          : null,
      currentLocationId: a.assignments[0]?.locationId ?? null,
      currentLocationName: a.assignments[0]?.location?.name ?? null,
      currentAssignmentStartedAt: a.assignments[0]?.startedAt
        ? // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: AssociateAssignment.startedAt is a @db.Date column
          a.assignments[0].startedAt.toISOString().slice(0, 10)
        : null,
    };
  });
}

/**
 * Who the directory lists for this caller and these filters. AND, never
 * spread: the store filter and the caller's scope both constrain
 * `assignments`, and a search and the client filter both use `OR` —
 * spread, the later one silently replaced the earlier (a site-bound lead
 * could list any store; a search dropped the client). The list and its
 * status counts read the same where, so a tile is the list it filters.
 */
async function directoryWhere(user: SessionUser, filters: z.infer<typeof QuerySchema>): Promise<Prisma.AssociateWhereInput> {
  // Search (PEOPLE-6): every word must match some field — "Maria Lopez",
  // "lopez maria", accents ignored, phone by digits (lib/peopleSearch).
  const matched = filters.q ? await idsMatching(prisma, ASSOCIATE_SEARCH, tenantIdForWrite(), filters.q) : null;
  return scopeWhere<Prisma.AssociateWhereInput>(
    { deletedAt: null, tenantId: tenantIdForWrite() },
    // Access pack: an internal role narrowed to sites/regions lists its people only.
    scopeAssociates(user),
    !!filters.employmentType && { employmentType: filters.employmentType },
    !!filters.departmentId && { departmentId: filters.departmentId },
    !!filters.locationId && { assignments: { some: { endedAt: null, locationId: filters.locationId } } },
    // Where they work now (a transfer moves them), else — nobody
    // placed yet — the client they applied to (lib/scope.atClient).
    !!filters.clientId && atClient(filters.clientId),
    matched !== null && { id: { in: matched } },
  );
}

/** True when no filter narrows the list (the counts are then the tenant's, in the caller's reach). */
const unfiltered = (f: z.infer<typeof QuerySchema>) => !f.q && !f.clientId && !f.departmentId && !f.locationId && !f.employmentType;

/**
 * GET /directory/summary — how many people stand where, for the same
 * filters as the list: the People page's tiles. The same counts the
 * Headcount screen shows (lib/peopleStatus), so "No recent shifts 10"
 * there is the 10 the tile here filters to.
 */
directoryRouter.get('/directory/summary', VIEW, async (req, res, next) => {
  try {
    const filters = QuerySchema.parse(req.query);
    const tenantId = tenantIdForWrite();
    const where = await directoryWhere(req.user!, filters);
    // Unfiltered and unbounded: the whole tenant (no id list to ship).
    const bounded = !unfiltered(filters) || Object.keys(scopeAssociates(req.user!)).length > 0;
    const ids = bounded ? (await prisma.associate.findMany({ where, select: { id: true } })).map((r) => r.id) : undefined;
    res.json(WorkStatusCountsSchema.parse(await workStatusCounts({ tenantId, ...(ids ? { associateIds: ids } : {}) })));
  } catch (err) {
    next(err);
  }
});

directoryRouter.get('/directory', VIEW, async (req, res, next) => {
  try {
    const filters = QuerySchema.parse(req.query);
    const take = filters.limit ?? DEFAULT_PAGE_SIZE;

    // Pull every non-deleted associate plus the relations we need to
    // synthesize the row. Ordering ends with id as the tiebreaker so the
    // cursor (id) is stable when lastName/firstName collide — without
    // that, cursor pagination can skip or duplicate rows across
    // boundaries.
    const associates = await prisma.associate.findMany({
      take,
      ...(filters.cursor
        ? { cursor: { id: filters.cursor }, skip: 1 }
        : {}),
      where: await directoryWhere(req.user!, filters),
      select: DIRECTORY_SELECT,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    });

    const entries = await buildEntries(req.user!, associates);

    // Apply status filters after derivation since status is computed.
    const filtered = entries.filter(
      (e) => (!filters.status || e.status === filters.status) && (!filters.workStatus || e.workStatus === filters.workStatus),
    );

    // nextCursor is the id of the last associate FETCHED (not the last
    // filtered). The cursor walks the underlying rows, not the post-
    // filter view — if every row in this page is filtered out by
    // status, the caller still needs to advance past them to find the
    // next batch. Returning the last fetched id keeps the walk moving.
    // Null when we received fewer rows than requested → end of stream.
    const nextCursor =
      associates.length === take ? associates[associates.length - 1]!.id : null;

    const body = DirectoryListResponseSchema.parse({
      associates: filtered,
      nextCursor,
    });
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * One person, as the directory would list them.
 *
 * The People page used to resolve a profile deep link by scanning the
 * page of rows it had loaded — 500 people sorted by last name, under
 * whatever filters the viewer had saved. Anyone on page two, or hidden by
 * an Active filter while they were still onboarding, came back as
 * "Couldn't find that person". This is the lookup that scan never had.
 */
directoryRouter.get('/directory/:id', VIEW, async (req, res, next) => {
  try {
    await assertSameTenant('associate', String(req.params.id));
    const id = z.string().uuid().safeParse(req.params.id);
    const row = id.success
      ? await prisma.associate.findFirst({
          // Within the caller's tenant and reach: a site-bound lead can't open
          // someone at another site by pasting their id.
          where: scopeWhere<Prisma.AssociateWhereInput>({ id: id.data, deletedAt: null, tenantId: tenantIdForWrite() }, scopeAssociates(req.user!)),
          select: DIRECTORY_SELECT,
        })
      : null;
    if (!row) throw new HttpError(404, 'not_found', 'No one in the directory has that id.');
    const [entry] = await buildEntries(req.user!, [row]);
    res.json(DirectoryEntrySchema.parse(entry));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /directory/:id/overview — what a person's record opens on (F500
 * fix-up): their hours in the active window, last and next shift, time
 * waiting for approval, no-shows in 30 days, documents running out and
 * their pay schedule.
 *
 * The person is looked up in the caller's tenant and reach (as the by-id
 * read); each number reads only what the caller may see (their time,
 * shifts and documents through the same scope helpers the lists use). A
 * section the caller may not read is left out, never zeroed.
 */
directoryRouter.get('/directory/:id/overview', VIEW, async (req, res, next) => {
  try {
    const user = req.user!;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, 'not_found', 'No one in the directory has that id.');
    await assertSameTenant('associate', id.data);
    const tenantId = tenantIdForWrite();
    const person = await prisma.associate.findFirst({
      where: scopeWhere<Prisma.AssociateWhereInput>({ id: id.data, deletedAt: null, tenantId }, scopeAssociates(user)),
      select: { id: true },
    });
    if (!person) throw new HttpError(404, 'not_found', 'No one in the directory has that id.');

    const now = new Date();
    const windowDays = (await peopleStandings({ tenantId, associateIds: [person.id] }, now)).windowDays;
    const in30 = new Date(now.getTime() + 30 * DAY_MS);
    const ago30 = new Date(now.getTime() - 30 * DAY_MS);
    const seesDocuments = can(user, 'view:documents');
    const seesSchedule = can(user, 'view:comp') || can(user, 'process:payroll');

    const [work, awaitingReview, nextShift, noShows, dated, membership] = await Promise.all([
      recentWork(user, [person.id], windowDays, now),
      prisma.timeEntry.count({
        where: scopeWhere<Prisma.TimeEntryWhereInput>({ associateId: person.id, tenantId, status: 'COMPLETED' }, scopeTimeEntries(user)),
      }),
      prisma.shift.findFirst({
        where: scopeWhere<Prisma.ShiftWhereInput>(
          { assignedAssociateId: person.id, tenantId, status: 'ASSIGNED', startsAt: { gte: now } },
          scopeShifts(user),
        ),
        orderBy: { startsAt: 'asc' },
        select: { id: true, startsAt: true, endsAt: true, position: true, locationRel: { select: { name: true, timezone: true } } },
      }),
      prisma.attendanceEvent.count({
        where: { associateId: person.id, tenantId, kind: 'NO_CALL_NO_SHOW', excusedAt: null, occurredOn: { gte: new Date(`${orgDateKey(ago30)}T00:00:00.000Z`) } },
      }),
      // Their documents that carry an expiry date, newest first: per kind,
      // the newest one is the one that counts (a renewed ID replaces the
      // expired one; the old file isn't "expired" any more).
      seesDocuments
        ? prisma.documentRecord.findMany({
            where: scopeWhere<Prisma.DocumentRecordWhereInput>(
              { associateId: person.id, tenantId, deletedAt: null, status: { not: 'REJECTED' }, expiresAt: { not: null } },
              scopeDocuments(user),
            ),
            orderBy: { createdAt: 'desc' },
            select: { kind: true, expiresAt: true },
            take: 200,
          })
        : Promise.resolve([]),
      seesSchedule ? scheduleMembershipFor(prisma, [person.id]) : Promise.resolve(null),
    ]);

    let expiringSoon = 0;
    let expired = 0;
    const seenKinds = new Set<string>();
    for (const d of dated) {
      if (seenKinds.has(d.kind)) continue;
      seenKinds.add(d.kind);
      if (!d.expiresAt) continue;
      if (d.expiresAt < now) expired += 1;
      else if (d.expiresAt < in30) expiringSoon += 1;
    }

    let pay: { scheduleId: string | null; scheduleName: string | null } | undefined;
    if (seesSchedule) {
      const scheduleId = membership?.get(person.id)?.scheduleId ?? null;
      const schedule = scheduleId ? await prisma.payrollSchedule.findFirst({ where: { id: scheduleId, tenantId }, select: { name: true } }) : null;
      pay = { scheduleId: schedule ? scheduleId : null, scheduleName: schedule?.name ?? null };
    }

    const w = work.get(person.id)!;
    res.json(
      PersonOverviewSchema.parse({
        windowDays,
        work: {
          minutes: w.minutes,
          entries: w.entries,
          awaitingReview,
          lastWorkedAt: w.lastWorkedAt?.toISOString() ?? null,
          nextShift: nextShift
            ? {
                id: nextShift.id,
                startsAt: nextShift.startsAt.toISOString(),
                endsAt: nextShift.endsAt.toISOString(),
                position: nextShift.position,
                locationName: nextShift.locationRel?.name ?? null,
                timezone: nextShift.locationRel?.timezone ?? null,
              }
            : null,
          noShows30d: noShows,
        },
        ...(seesDocuments ? { documents: { expiringSoon, expired } } : {}),
        ...(pay ? { pay } : {}),
      }),
    );
  } catch (err) {
    next(err);
  }
});
