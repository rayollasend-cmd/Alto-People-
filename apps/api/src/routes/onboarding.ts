import { Router } from 'express';
import type {
  ApplicationDetail,
  ApplicationListResponse,
  ApplicationSummary,
  ChecklistTask,
  OnboardingTemplate,
  TemplateListResponse,
  TemplateTask,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';

export const onboardingRouter = Router();

/* GET /onboarding/applications ------------------------------------------- */
onboardingRouter.get('/applications', async (_req, res, next) => {
  try {
    const rows = await prisma.application.findMany({
      where: { deletedAt: null },
      orderBy: { invitedAt: 'desc' },
      include: {
        associate: { select: { firstName: true, lastName: true } },
        client: { select: { name: true } },
        checklist: {
          include: {
            tasks: { select: { status: true } },
          },
        },
      },
    });

    const applications: ApplicationSummary[] = rows.map((row) => ({
      id: row.id,
      associateName: `${row.associate.firstName} ${row.associate.lastName}`,
      clientName: row.client.name,
      onboardingTrack: row.onboardingTrack,
      status: row.status,
      position: row.position,
      startDate: row.startDate ? row.startDate.toISOString() : null,
      invitedAt: row.invitedAt.toISOString(),
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      percentComplete: computePercent(row.checklist?.tasks ?? []),
    }));

    const payload: ApplicationListResponse = { applications };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/* GET /onboarding/applications/:id --------------------------------------- */
onboardingRouter.get('/applications/:id', async (req, res, next) => {
  try {
    const row = await prisma.application.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        associate: { select: { firstName: true, lastName: true } },
        client: { select: { name: true } },
        checklist: {
          include: {
            tasks: { orderBy: { order: 'asc' } },
          },
        },
      },
    });
    if (!row) {
      throw new HttpError(
        404,
        'application_not_found',
        'Application not found'
      );
    }

    const tasks: ChecklistTask[] = (row.checklist?.tasks ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      title: t.title,
      description: t.description,
      order: t.order,
      documentId: t.documentId,
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    }));

    const detail: ApplicationDetail = {
      id: row.id,
      associateId: row.associateId,
      clientId: row.clientId,
      associateName: `${row.associate.firstName} ${row.associate.lastName}`,
      clientName: row.client.name,
      onboardingTrack: row.onboardingTrack,
      status: row.status,
      position: row.position,
      startDate: row.startDate ? row.startDate.toISOString() : null,
      invitedAt: row.invitedAt.toISOString(),
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      percentComplete: computePercent(row.checklist?.tasks ?? []),
      tasks,
    };
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

/* GET /onboarding/templates ---------------------------------------------- */
onboardingRouter.get('/templates', async (_req, res, next) => {
  try {
    const rows = await prisma.onboardingTemplate.findMany({
      include: { tasks: { orderBy: { order: 'asc' } } },
      orderBy: [{ track: 'asc' }, { name: 'asc' }],
    });

    const templates: OnboardingTemplate[] = rows.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      track: row.track,
      name: row.name,
      tasks: row.tasks.map(
        (t): TemplateTask => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          description: t.description,
          order: t.order,
        })
      ),
    }));

    const payload: TemplateListResponse = { templates };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------------ */

function computePercent(tasks: Array<{ status: string }>): number {
  if (tasks.length === 0) return 0;
  const done = tasks.filter((t) => t.status === 'DONE').length;
  return Math.round((done / tasks.length) * 100);
}
