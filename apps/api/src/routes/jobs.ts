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

export const jobsRouter = Router();

const MANAGE = requireCapability('manage:scheduling');

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
    const clientId = req.query.clientId?.toString();
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
    const client = await prisma.client.findFirst({
      where: { id: i.clientId, deletedAt: null },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');

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
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) throw new HttpError(404, 'job_not_found', 'Job not found');

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
      where: { id: req.params.id, deletedAt: null },
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
