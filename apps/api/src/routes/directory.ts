import { Router } from 'express';
import { z } from 'zod';
import {
  DirectoryListResponseSchema,
  type DirectoryEntry,
  type DirectoryStatus,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { computePercent } from '../lib/checklist.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';

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
 * Scope: VIEW capability gate. CLIENT_PORTAL doesn't get a path here yet —
 * org views aren't surfaced to portal users today.
 */
export const directoryRouter = Router();

const VIEW = requireCapability('view:org');

const QuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'PENDING', 'INACTIVE']).optional(),
  clientId: z.string().uuid().optional(),
  employmentType: z
    .enum(['W2_EMPLOYEE', 'CONTRACTOR_1099_INDIVIDUAL', 'CONTRACTOR_1099_BUSINESS'])
    .optional(),
});

directoryRouter.get('/directory', VIEW, async (req, res, next) => {
  try {
    const filters = QuerySchema.parse(req.query);

    // Pull every non-deleted associate plus the relations we need to
    // synthesize the row. `applications` ordered desc so the first one in
    // each array is the freshest.
    const associates = await prisma.associate.findMany({
      take: 1000,
      where: {
        deletedAt: null,
        ...(filters.employmentType ? { employmentType: filters.employmentType } : {}),
        ...(filters.clientId
          ? {
              applications: {
                some: { clientId: filters.clientId, deletedAt: null },
              },
            }
          : {}),
        ...(filters.q
          ? {
              OR: [
                { firstName: { contains: filters.q, mode: 'insensitive' } },
                { lastName: { contains: filters.q, mode: 'insensitive' } },
                { email: { contains: filters.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        employmentType: true,
        j1Status: true,
        createdAt: true,
        photoS3Key: true,
        photoUpdatedAt: true,
        managerId: true,
        manager: { select: { firstName: true, lastName: true } },
        departmentId: true,
        department: { select: { name: true } },
        jobProfileId: true,
        jobProfile: { select: { title: true } },
        applications: {
          where: { deletedAt: null },
          select: {
            id: true,
            status: true,
            clientId: true,
            position: true,
            startDate: true,
            invitedAt: true,
            client: { select: { name: true } },
            checklist: {
              select: {
                tasks: { select: { status: true } },
              },
            },
          },
          orderBy: { invitedAt: 'desc' },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });

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

    const entries: DirectoryEntry[] = associates.map((a) => {
      // Status derivation: APPROVED ⇒ ACTIVE; any in-flight (DRAFT,
      // SUBMITTED, IN_REVIEW) ⇒ PENDING; otherwise INACTIVE.
      const apps = a.applications;
      const approved = apps.find((x) => x.status === 'APPROVED');
      const inFlight = apps.find(
        (x) =>
          x.status === 'DRAFT' ||
          x.status === 'SUBMITTED' ||
          x.status === 'IN_REVIEW',
      );
      const status: DirectoryStatus = approved
        ? 'ACTIVE'
        : inFlight
          ? 'PENDING'
          : 'INACTIVE';

      // Workplace = approved client first, then most-recent application.
      const workplaceApp = approved ?? inFlight ?? apps[0] ?? null;

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
        workplaceClientId: workplaceApp?.clientId ?? null,
        workplaceClientName: workplaceApp?.client?.name ?? null,
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
        createdAt: a.createdAt.toISOString(),
        photoUrl: profilePhotoUrlFor({
          id: a.id,
          photoS3Key: a.photoS3Key,
          photoUpdatedAt: a.photoUpdatedAt,
        }),
      };
    });

    // Apply status filter after derivation since status is computed.
    const filtered = filters.status
      ? entries.filter((e) => e.status === filters.status)
      : entries;

    const body = DirectoryListResponseSchema.parse({ associates: filtered });
    res.json(body);
  } catch (err) {
    next(err);
  }
});
