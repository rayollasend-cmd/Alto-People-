import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  DirectoryEntrySchema,
  DirectoryListResponseSchema,
  WORK_STATUSES,
  WorkStatusCountsSchema,
  directoryStatusOf,
  type DirectoryEntry,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { peopleStandings, workStatusCounts } from '../lib/peopleStatus.js';
import { atClient, scopeAssociates, scopeWhere } from '../lib/scope.js';
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

/** Rows → directory entries, with the live pay rate batch-fetched once. */
async function buildEntries(associates: DirectoryRow[]): Promise<DirectoryEntry[]> {
  // The one status per person (lib/peopleStatus), asked about this page's rows only.
  const standings = await peopleStandings({ tenantId: tenantIdForWrite(), associateIds: associates.map((a) => a.id) });
  // One open compensation row per associate ⇒ batch-fetch and index.
  const ids = associates.map((a) => a.id);
  const liveComp =
    ids.length === 0
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
      startDate: workplaceApp?.startDate
        ? workplaceApp.startDate.toISOString().slice(0, 10)
        : null,
      payAmount: comp ? comp.amount.toString() : null,
      payType: comp?.payType ?? null,
      payCurrency: comp?.currency ?? null,
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
        ? a.assignments[0].startedAt.toISOString().slice(0, 10)
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
function directoryWhere(user: SessionUser, filters: z.infer<typeof QuerySchema>): Prisma.AssociateWhereInput {
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
    !!filters.q && {
      OR: [
        { firstName: { contains: filters.q, mode: 'insensitive' } },
        { lastName: { contains: filters.q, mode: 'insensitive' } },
        { email: { contains: filters.q, mode: 'insensitive' } },
      ],
    },
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
    const where = directoryWhere(req.user!, filters);
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
      where: directoryWhere(req.user!, filters),
      select: DIRECTORY_SELECT,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    });

    const entries = await buildEntries(associates);

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
    const [entry] = await buildEntries([row]);
    res.json(DirectoryEntrySchema.parse(entry));
  } catch (err) {
    next(err);
  }
});
