import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  JobCreateInputSchema,
  JobListResponseSchema,
  JobUpdateInputSchema,
  type Job,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import type { SessionUser } from '../types/express.js';
import { assertClientInScope, effectiveClientIdFilter, scopeClients } from '../lib/scope.js';

export const jobsRouter = Router();

const MANAGE = requireCapability('manage:scheduling');

/**
 * A Job is a client's: its name, its bill rate and its pay rate. The GET
 * below was already clamped to the caller's client; the three writes were
 * not, and manage:scheduling is held by SHIFT_SUPERVISOR, which is bounded
 * to one client everywhere else in the product.
 *
 * So a supervisor at one store could retitle, re-rate or delete another
 * store's job profiles. Pay is computed from the compensation record rather
 * than from here (see time.ts, which stamps job.payRate onto the entry for
 * reporting), so this is not a way to move money — it is a way to corrupt
 * another client's rate card and their clock-in options.
 *
 * `is` + the client's own scope, so the ownership test is one query with
 * the load rather than a second round trip.
 */
const jobInScope = (user: SessionUser, id: string): Prisma.JobWhereInput => ({
  AND: [{ id, deletedAt: null }, { client: { is: scopeClients(user) } }],
});

type RawJob = Prisma.JobGetPayload<{ include: { client: { select: { name: true } } } }>;

function toJob(row: RawJob): Job {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.client?.name ?? null,
    name: row.name,
    billRate: row.billRate ? Number(row.billRate) : null,
    payRate: row.payRate ? Number(row.payRate) : null,
    isActive: row.isActive,
  };
}

const JOB_INCLUDE = { client: { select: { name: true } } } as const;

jobsRouter.get('/', async (req, res, next) => {
  try {
    // Client-bounded roles only see their own client's job profiles.
    const boundedJobs = effectiveClientIdFilter(
      req.user!,
      req.query.clientId?.toString(),
    );
    const clientId =
      boundedJobs === null ? '00000000-0000-0000-0000-000000000000' : boundedJobs;
    const includeInactive = req.query.includeInactive === 'true';
    const where: Prisma.JobWhereInput = {
      deletedAt: null,
      ...(clientId ? { clientId } : {}),
      ...(includeInactive ? {} : { isActive: true }),
    };
    const rows = await prisma.job.findMany({
      where,
      orderBy: [{ clientId: 'asc' }, { name: 'asc' }],
      take: 200,
      include: JOB_INCLUDE,
    });
    res.json(JobListResponseSchema.parse({ jobs: rows.map(toJob) }));
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const parsed = JobCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;
    await assertClientInScope(prisma, req.user!, i.clientId);

    try {
      const created = await prisma.job.create({
        data: {
          clientId: i.clientId,
          name: i.name,
          billRate: i.billRate ?? null,
          payRate: i.payRate ?? null,
        },
        include: JOB_INCLUDE,
      });
      res.status(201).json(toJob(created));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(409, 'job_name_taken', 'A job with this name already exists for this client');
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

jobsRouter.patch('/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = JobUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await prisma.job.findFirst({
      where: jobInScope(req.user!, req.params.id),
    });
    if (!existing) throw new HttpError(404, 'job_not_found', 'Job not found');

    // clientId is deliberately not updatable: moving a job between clients
    // would carry every time entry already pinned to it across with it.
    const i = parsed.data;
    const data: Prisma.JobUpdateInput = {};
    if (i.name !== undefined) data.name = i.name;
    if (i.billRate !== undefined) data.billRate = i.billRate;
    if (i.payRate !== undefined) data.payRate = i.payRate;
    if (i.isActive !== undefined) data.isActive = i.isActive;

    const updated = await prisma.job.update({
      where: { id: existing.id },
      data,
      include: JOB_INCLUDE,
    });
    res.json(toJob(updated));
  } catch (err) {
    next(err);
  }
});

jobsRouter.delete('/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.job.findFirst({
      where: jobInScope(req.user!, req.params.id),
    });
    if (!existing) throw new HttpError(404, 'job_not_found', 'Job not found');
    await prisma.job.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
