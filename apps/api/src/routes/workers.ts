import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { WorkerAssignmentInputSchema, WorkerInputSchema, WorkerStatusSchema, WorkerTypeSchema, WorkerUpdateSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { enqueueAudit } from '../lib/audit.js';
import { isInternallyScoped, scopeAssociates } from '../lib/scope.js';
import { assignWorkerToSite, createWorker, ensurePersonWorkers, getWorker, listWorkers, scheduleWorkerOnShift, updateWorker } from '../lib/workers.js';

/**
 * Workers (Brief 1D-1).
 *
 *   GET   /workers                      every worker, counts by type and status, any without an owner (view:org)
 *   POST  /workers                      an AGENT or ROBOT worker — owner required                  (manage:org)
 *   GET   /workers/:id · PATCH /workers/:id
 *   POST  /workers/:id/assignments      put it at a site
 *   POST  /workers/:id/shifts/:shiftId  put it on a shift (a person goes on as their associate)
 *   POST  /workers/ensure-people        the sweep: a PERSON worker for every associate
 */
export const workersRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');
const Id = z.string().uuid();

/**
 * Brief 2-6 step 1: the registry is the customer's. A worker (a person, an
 * agent, a robot) and a shift named in the path must be the caller's
 * tenant's; another tenant's id answers 404, as if it did not exist.
 */
async function ownWorker(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = tenantIdForWrite();
    const w = await prisma.worker.findFirst({ where: { id: Id.parse(req.params.id), tenantId }, select: { id: true } });
    if (!w) throw new HttpError(404, 'worker_not_found', 'Worker not found.');
    if (req.params.shiftId) {
      const s = await prisma.shift.findFirst({ where: { id: Id.parse(req.params.shiftId), tenantId }, select: { id: true } });
      if (!s) throw new HttpError(404, 'shift_not_found', 'Shift not found.');
    }
    next();
  } catch (err) {
    next(err);
  }
}

workersRouter.get('/', VIEW, async (req, res, next) => {
  try {
    const q = z.object({ type: WorkerTypeSchema.optional(), status: WorkerStatusSchema.optional() }).parse(req.query);
    // A site/region-bound office account sees the people at its own sites —
    // in the list, the counts and the people's standing alike. Each person
    // carries where they stand at work (the People directory's status).
    res.json(
      await listWorkers(prisma, {
        ...q,
        tenantId: tenantIdForWrite(),
        peopleStatus: true,
        ...(isInternallyScoped(req.user!) ? { people: scopeAssociates(req.user!) } : {}),
      }),
    );
  } catch (err) {
    next(err);
  }
});

workersRouter.post('/ensure-people', MANAGE, async (req, res, next) => {
  try {
    const made = await ensurePersonWorkers(prisma);
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'worker.people_ensured', entityType: 'Worker', entityId: 'sweep', metadata: { made } }, 'workers');
    res.json({ made });
  } catch (err) {
    next(err);
  }
});

workersRouter.get('/:id', VIEW, ownWorker, async (req, res, next) => {
  try {
    res.json(await getWorker(prisma, Id.parse(req.params.id)));
  } catch (err) {
    next(err);
  }
});

workersRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const input = WorkerInputSchema.parse(req.body);
    const worker = await createWorker(prisma, input, req.user!.id);
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: null, action: 'worker.created', entityType: 'Worker', entityId: worker.id, workerId: worker.id, metadata: { type: worker.type, name: worker.name, ownerUserId: input.ownerUserId, capabilities: worker.capabilities } },
      'workers',
    );
    res.status(201).json(worker);
  } catch (err) {
    next(err);
  }
});

workersRouter.patch('/:id', MANAGE, ownWorker, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const input = WorkerUpdateSchema.parse(req.body);
    if (input.status === 'ACTIVE') {
      // Brief 1D-3: an agent leaves onboarding only through certification on /agents.
      const row = await prisma.worker.findUnique({ where: { id }, select: { type: true, status: true } });
      if (row?.type === 'AGENT' && row.status !== 'ACTIVE') {
        res.status(409).json({ error: { code: 'use_agent_registry', message: 'An agent becomes active through certification in the AI agents registry.' } });
        return;
      }
    }
    const worker = await updateWorker(prisma, id, input);
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'worker.updated', entityType: 'Worker', entityId: id, workerId: id, metadata: { fields: Object.keys(input), status: worker.status, ownerUserId: worker.owner?.id ?? null } }, 'workers');
    res.json(worker);
  } catch (err) {
    next(err);
  }
});

workersRouter.post('/:id/assignments', MANAGE, ownWorker, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const input = WorkerAssignmentInputSchema.parse(req.body);
    const worker = await assignWorkerToSite(prisma, id, input);
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'worker.assigned_site', entityType: 'Worker', entityId: id, workerId: id, metadata: { locationId: input.locationId, startedAt: input.startedAt ?? null } }, 'workers');
    res.json(worker);
  } catch (err) {
    next(err);
  }
});

workersRouter.post('/:id/shifts/:shiftId', requireCapability('manage:scheduling'), ownWorker, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const shiftId = Id.parse(req.params.shiftId);
    const result = await scheduleWorkerOnShift(prisma, shiftId, id);
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'shift.assigned_worker', entityType: 'Shift', entityId: shiftId, workerId: id, metadata: { workerId: id, associateId: result.associateId } }, 'workers');
    res.json(result);
  } catch (err) {
    next(err);
  }
});
