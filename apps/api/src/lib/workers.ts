import type { Prisma, PrismaClient } from '@prisma/client';
import {
  rolesWithCapability,
  WORKER_STATUS_LABELS,
  WORKER_TYPE_LABELS,
  type WorkerAssignmentInput,
  type WorkerInput,
  type WorkerSiteRef,
  type WorkerStatus,
  type WorkerSummary,
  type WorkerType,
  type WorkerUpdate,
  type WorkersResponse,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { emitWorkerStatusChanged } from './webhookEvents.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * WORKERS — the data model stops assuming a person.
 *
 * A Worker is a person, an AI agent, or a robot. Every one has an
 * accountable owner (a user — required by the schema and by the input),
 * certified capabilities, and a lifecycle: onboarding → active →
 * suspended / offboarded. PERSON workers are made from associates — by
 * the migration for everyone who exists, by the onboarding paths for
 * everyone who arrives, and by ensurePersonWorkers for anyone the first
 * two missed — and they keep their associate record untouched.
 *
 * Scheduling writes workerId next to assignedAssociateId (a client
 * extension in db.ts keeps the two in step), so a shift can carry an
 * agent or a robot with no associate at all.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const atUtc = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Who owns an associate's PERSON worker: their manager's account, else the first org-wide admin. */
export async function defaultOwnerFor(db: Db, associateId: string): Promise<string | null> {
  const a = await db.associate.findUnique({ where: { id: associateId }, select: { managerId: true } });
  if (a?.managerId) {
    const mgr = await db.user.findFirst({ where: { associateId: a.managerId, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
    if (mgr) return mgr.id;
  }
  const roles = rolesWithCapability('manage:org');
  const admin = await db.user.findFirst({
    where: { status: 'ACTIVE', deletedAt: null, role: { in: roles } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return admin?.id ?? null;
}

/** Make (or find) the PERSON worker for an associate. Null when no owner can be found yet. */
export async function ensureWorkerForAssociate(db: Db, associateId: string, ownerUserId?: string | null): Promise<string | null> {
  const existing = await db.worker.findUnique({ where: { associateId }, select: { id: true } });
  if (existing) return existing.id;
  const a = await db.associate.findUnique({ where: { id: associateId }, select: { firstName: true, lastName: true, separatedAt: true, deactivatedAt: true, deletedAt: true } });
  if (!a || a.deletedAt) return null;
  const owner = ownerUserId ?? (await defaultOwnerFor(db, associateId));
  if (!owner) return null;
  const w = await db.worker.create({
    data: {
      type: 'PERSON',
      associateId,
      name: `${a.firstName} ${a.lastName}`.trim().slice(0, 160),
      ownerUserId: owner,
      status: a.separatedAt ? 'OFFBOARDED' : a.deactivatedAt ? 'SUSPENDED' : 'ACTIVE',
    },
    select: { id: true },
  });
  return w.id;
}

/** The sweep: every associate without a worker gets one, when an owner exists. Returns how many were made. */
export async function ensurePersonWorkers(db: PrismaClient = defaultPrisma): Promise<number> {
  const missing = await db.associate.findMany({ where: { deletedAt: null, worker: null }, select: { id: true }, take: 2000 });
  let made = 0;
  for (const a of missing) {
    if (await ensureWorkerForAssociate(db, a.id)) made += 1;
  }
  if (missing.length > 0) {
    // Shifts assigned to people who only just became workers.
    await db.$executeRaw`UPDATE "Shift" s SET "workerId" = w."id" FROM "Worker" w WHERE w."associateId" = s."assignedAssociateId" AND s."workerId" IS NULL`;
  }
  // A person's status follows their associate record: a separation or a
  // deactivation anywhere in the app shows on the worker within the sweep.
  await db.$executeRaw`
    UPDATE "Worker" w
    SET "status" = CASE WHEN a."separatedAt" IS NOT NULL THEN 'OFFBOARDED'::"WorkerStatus"
                        WHEN a."deactivatedAt" IS NOT NULL THEN 'SUSPENDED'::"WorkerStatus"
                        ELSE 'ACTIVE'::"WorkerStatus" END,
        "offboardedAt" = a."separatedAt",
        "updatedAt" = now()
    FROM "Associate" a
    WHERE a."id" = w."associateId" AND w."type" = 'PERSON'::"WorkerType"
      AND w."status" <> CASE WHEN a."separatedAt" IS NOT NULL THEN 'OFFBOARDED'::"WorkerStatus"
                             WHEN a."deactivatedAt" IS NOT NULL THEN 'SUSPENDED'::"WorkerStatus"
                             ELSE 'ACTIVE'::"WorkerStatus" END`;
  return made;
}

/** Keep the PERSON worker's status with the associate record. */
export async function syncPersonWorkerStatus(db: Db, associateId: string): Promise<void> {
  const a = await db.associate.findUnique({ where: { id: associateId }, select: { separatedAt: true, deactivatedAt: true, firstName: true, lastName: true } });
  if (!a) return;
  await db.worker.updateMany({
    where: { associateId },
    data: {
      status: a.separatedAt ? 'OFFBOARDED' : a.deactivatedAt ? 'SUSPENDED' : 'ACTIVE',
      offboardedAt: a.separatedAt ?? null,
      name: `${a.firstName} ${a.lastName}`.trim().slice(0, 160),
    },
  });
}

/* ---------------------------------------------------------------- shapes */

const WORKER_INCLUDE = {
  owner: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
  assignments: { include: { location: { select: { id: true, name: true, clientId: true, client: { select: { name: true } } } } }, orderBy: { startedAt: 'desc' } },
} satisfies Prisma.WorkerInclude;
type WorkerRow = Prisma.WorkerGetPayload<{ include: typeof WORKER_INCLUDE }>;

async function personSites(db: Db, associateIds: string[]): Promise<Map<string, WorkerSiteRef[]>> {
  const out = new Map<string, WorkerSiteRef[]>();
  if (associateIds.length === 0) return out;
  const rows = await db.associateAssignment.findMany({
    where: { associateId: { in: associateIds } },
    select: { associateId: true, startedAt: true, endedAt: true, location: { select: { id: true, name: true, clientId: true, client: { select: { name: true } } } } },
    orderBy: { startedAt: 'desc' },
  });
  for (const r of rows) {
    // The site reference names a client (shared contract); a client-less site (a direct employer) is listed once the contract allows it.
    if (!r.location.clientId || !r.location.client) continue;
    const list = out.get(r.associateId) ?? [];
    list.push({
      locationId: r.location.id,
      siteName: r.location.name,
      clientId: r.location.clientId,
      clientName: r.location.client.name,
      startedAt: ymd(r.startedAt),
      endedAt: r.endedAt ? ymd(r.endedAt) : null,
      source: 'associate',
    });
    out.set(r.associateId, list);
  }
  return out;
}

async function summarize(db: Db, rows: WorkerRow[], now: Date): Promise<WorkerSummary[]> {
  const personIds = rows.map((r) => r.associateId).filter((x): x is string => !!x);
  const sitesByAssociate = await personSites(db, personIds);
  const upcoming = rows.length
    ? await db.shift.groupBy({ by: ['workerId'], where: { workerId: { in: rows.map((r) => r.id) }, startsAt: { gte: now }, status: { notIn: ['CANCELLED'] } }, _count: { _all: true } })
    : [];
  const upcomingBy = new Map(upcoming.map((u) => [u.workerId, u._count._all]));
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    associateId: r.associateId,
    owner: r.owner
      ? { id: r.owner.id, name: r.owner.associate ? `${r.owner.associate.firstName} ${r.owner.associate.lastName}`.trim() : r.owner.email, email: r.owner.email }
      : null,
    status: r.status,
    capabilities: r.capabilities,
    notes: r.notes,
    sites: [
      ...(r.associateId ? (sitesByAssociate.get(r.associateId) ?? []) : []),
      ...r.assignments.flatMap((a) =>
        a.location.clientId && a.location.client
          ? [{
              locationId: a.location.id,
              siteName: a.location.name,
              clientId: a.location.clientId,
              clientName: a.location.client.name,
              startedAt: ymd(a.startedAt),
              endedAt: a.endedAt ? ymd(a.endedAt) : null,
              source: 'worker' as const,
            }]
          : [],
      ),
    ],
    upcomingShifts: upcomingBy.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
    offboardedAt: r.offboardedAt?.toISOString() ?? null,
  }));
}

export async function listWorkers(db: PrismaClient = defaultPrisma, f: { type?: WorkerType; status?: WorkerStatus; tenantId?: string } = {}, now: Date = new Date()): Promise<WorkersResponse> {
  // Agent families step 0: an optional tenant (the agent registry passes the caller's); without one, as before.
  const tenantWhere = f.tenantId ? { tenantId: f.tenantId } : {};
  const rows = await db.worker.findMany({
    where: { ...(f.type ? { type: f.type } : {}), ...(f.status ? { status: f.status } : {}), ...tenantWhere },
    include: WORKER_INCLUDE,
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    take: 5000,
  });
  const all = await summarize(db, rows, now);
  const grouped = await db.worker.groupBy({ by: ['type', 'status'], where: tenantWhere, _count: { _all: true } });
  const counts = {} as WorkersResponse['counts'];
  for (const t of Object.keys(WORKER_TYPE_LABELS) as WorkerType[]) {
    counts[t] = {} as Record<WorkerStatus, number>;
    for (const s of Object.keys(WORKER_STATUS_LABELS) as WorkerStatus[]) counts[t][s] = 0;
  }
  for (const g of grouped) counts[g.type][g.status] = g._count._all;
  // The schema forbids a null owner; a deleted owner account would be the
  // only way to lose one, and Restrict forbids that too. Still asked.
  const withoutOwner = all.filter((w) => !w.owner);
  const associatesWithoutWorker = await db.associate.count({ where: { deletedAt: null, worker: null, ...tenantWhere } });
  return { workers: all, counts, withoutOwner, associatesWithoutWorker };
}

export async function getWorker(db: Db, id: string, now: Date = new Date()): Promise<WorkerSummary> {
  const row = await db.worker.findUnique({ where: { id }, include: WORKER_INCLUDE });
  if (!row) throw new HttpError(404, 'worker_not_found', 'No such worker.');
  return (await summarize(db, [row], now))[0]!;
}

async function assertOwner(db: Db, ownerUserId: string): Promise<void> {
  // Brief 2-6 step 1: the owner is an active account of the same tenant.
  const owner = await db.user.findFirst({ where: { id: ownerUserId, status: 'ACTIVE', deletedAt: null, tenantId: tenantIdForWrite() }, select: { id: true, role: true } });
  if (!owner) throw new HttpError(400, 'owner_not_found', 'The accountable owner must be an active account.');
  if (owner.role === 'CLIENT_PORTAL' || owner.role === 'LIVE_ASN') {
    throw new HttpError(400, 'owner_not_eligible', 'A client portal account cannot own a worker.');
  }
}

export async function createWorker(db: Db, input: WorkerInput, actorUserId: string, now: Date = new Date()): Promise<WorkerSummary> {
  await assertOwner(db, input.ownerUserId);
  if (input.locationId && !(await db.site.findFirst({ where: { id: input.locationId, deletedAt: null, tenantId: tenantIdForWrite() }, select: { id: true } }))) {
    throw new HttpError(400, 'site_not_found', 'No such site.');
  }
  const row = await db.worker.create({
    data: {
      tenantId: tenantIdForWrite(),
      type: input.type,
      name: input.name,
      ownerUserId: input.ownerUserId,
      status: input.status,
      capabilities: input.capabilities,
      notes: input.notes ?? null,
      createdById: actorUserId,
      ...(input.locationId ? { assignments: { create: { locationId: input.locationId, startedAt: atUtc(ymd(now)) } } } : {}),
    },
    include: WORKER_INCLUDE,
  });
  return (await summarize(db, [row], now))[0]!;
}

export async function updateWorker(db: Db, id: string, input: WorkerUpdate, now: Date = new Date()): Promise<WorkerSummary> {
  const existing = await db.worker.findUnique({ where: { id }, select: { type: true, status: true } });
  if (!existing) throw new HttpError(404, 'worker_not_found', 'No such worker.');
  if (input.ownerUserId) await assertOwner(db, input.ownerUserId);
  if (existing.type === 'PERSON' && (input.status || input.name)) {
    throw new HttpError(400, 'person_follows_associate', "A person's name and status come from their associate record; change them there.");
  }
  const row = await db.worker.update({
    where: { id },
    data: {
      name: input.name,
      ownerUserId: input.ownerUserId,
      status: input.status,
      capabilities: input.capabilities,
      notes: input.notes,
      ...(input.status === 'OFFBOARDED' ? { offboardedAt: now } : input.status ? { offboardedAt: null } : {}),
    },
    include: WORKER_INCLUDE,
  });
  // Brief 2-4: an agent's or robot's status change is an event.
  if (input.status && input.status !== existing.status) emitWorkerStatusChanged({ workerId: id }, 'status_change');
  return (await summarize(db, [row], now))[0]!;
}

/** Put a worker at a site. PERSON workers are placed through their associate's assignment, as before. */
export async function assignWorkerToSite(db: Db, id: string, input: WorkerAssignmentInput, now: Date = new Date()): Promise<WorkerSummary> {
  const w = await db.worker.findUnique({ where: { id }, select: { type: true, associateId: true } });
  if (!w) throw new HttpError(404, 'worker_not_found', 'No such worker.');
  const loc = await db.site.findFirst({ where: { id: input.locationId, deletedAt: null, tenantId: tenantIdForWrite() }, select: { id: true } });
  if (!loc) throw new HttpError(400, 'site_not_found', 'No such site.');
  const startedAt = atUtc(input.startedAt ?? ymd(now));
  if (w.type === 'PERSON' && w.associateId) {
    await db.associateAssignment.updateMany({ where: { associateId: w.associateId, endedAt: null }, data: { endedAt: startedAt } });
    await db.associateAssignment.create({ data: { associateId: w.associateId, locationId: loc.id, startedAt, notes: input.notes ?? null } });
  } else {
    await db.workerAssignment.updateMany({ where: { workerId: id, endedAt: null }, data: { endedAt: startedAt } });
    await db.workerAssignment.create({ data: { workerId: id, locationId: loc.id, startedAt, notes: input.notes ?? null } });
  }
  return getWorker(db, id, now);
}

/**
 * Put a worker on a shift. A person goes on as their associate (every
 * existing screen keeps working); an agent or a robot goes on as itself.
 * Suspended and offboarded workers do not work.
 */
export async function scheduleWorkerOnShift(db: Db, shiftId: string, workerId: string, now: Date = new Date()): Promise<{ shiftId: string; workerId: string; associateId: string | null }> {
  const w = await db.worker.findUnique({ where: { id: workerId }, select: { type: true, associateId: true, status: true, name: true } });
  if (!w) throw new HttpError(404, 'worker_not_found', 'No such worker.');
  if (w.status === 'SUSPENDED' || w.status === 'OFFBOARDED') {
    throw new HttpError(409, 'worker_not_available', `${w.name} is ${w.status.toLowerCase()} and cannot be scheduled.`);
  }
  const shift = await db.shift.findUnique({ where: { id: shiftId }, select: { id: true, status: true } });
  if (!shift) throw new HttpError(404, 'shift_not_found', 'No such shift.');
  if (shift.status === 'CANCELLED' || shift.status === 'COMPLETED') {
    throw new HttpError(409, 'shift_closed', 'That shift is over.');
  }
  await db.shift.update({
    where: { id: shiftId },
    data: { workerId, assignedAssociateId: w.type === 'PERSON' ? w.associateId : null, assignedAt: now, status: 'ASSIGNED' },
  });
  return { shiftId, workerId, associateId: w.type === 'PERSON' ? w.associateId : null };
}

/** Everywhere a worker works today — both tables as one. */
export async function workerSites(db: Db, workerId: string): Promise<WorkerSiteRef[]> {
  return (await getWorker(db, workerId)).sites.filter((s) => s.endedAt === null);
}
