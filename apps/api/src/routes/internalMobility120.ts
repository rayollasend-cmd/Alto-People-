import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';

/**
 * Phase 120 — Internal mobility.
 *
 * Browse and apply: open to any authenticated associate.
 * Review and decide: gated by manage:recruiting (the same role that
 * runs external recruiting also runs internal mobility).
 */

export const internalMobility120Router = Router();

const MANAGE = requireCapability('manage:recruiting');

const STATUS = z.enum([
  'SUBMITTED',
  'UNDER_REVIEW',
  'INTERVIEWING',
  'OFFERED',
  'HIRED',
  'REJECTED',
  'WITHDRAWN',
]);

// ----- Browse open postings (associate-facing) -----------------------------

internalMobility120Router.get(
  '/internal-jobs',
  requireAuth,
  async (req, res) => {
    const associateId = req.user!.associateId;
    const postings = await prisma.jobPosting.findMany({
      where: { status: 'OPEN' },
      include: {
        client: { select: { name: true } },
        _count: { select: { internalApplications: true } },
        internalApplications: associateId
          ? {
              where: { associateId },
              select: { id: true, status: true },
            }
          : false,
      },
      orderBy: { openedAt: 'desc' },
    });
    res.json({
      jobs: postings.map((p) => {
        const mine =
          'internalApplications' in p && Array.isArray(p.internalApplications)
            ? p.internalApplications[0] ?? null
            : null;
        return {
          id: p.id,
          title: p.title,
          description: p.description,
          location: p.location,
          minSalary: p.minSalary?.toString() ?? null,
          maxSalary: p.maxSalary?.toString() ?? null,
          currency: p.currency,
          clientName: p.client?.name ?? null,
          openedAt: p.openedAt?.toISOString() ?? null,
          applicantCount: p._count.internalApplications,
          myApplication: mine,
        };
      }),
    });
  },
);

// ----- Single posting (read) -----------------------------------------------

internalMobility120Router.get(
  '/internal-jobs/:id',
  requireAuth,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const posting = await prisma.jobPosting.findUnique({
      where: { id },
      include: { client: { select: { name: true } } },
    });
    if (!posting || posting.status !== 'OPEN') {
      throw new HttpError(404, 'not_found', 'Job not found.');
    }
    let myApplication: { id: string; status: string } | null = null;
    if (req.user!.associateId) {
      const app = await prisma.internalJobApplication.findUnique({
        where: {
          postingId_associateId: {
            postingId: id,
            associateId: req.user!.associateId,
          },
        },
      });
      if (app) {
        myApplication = { id: app.id, status: app.status };
      }
    }
    res.json({
      id: posting.id,
      title: posting.title,
      description: posting.description,
      location: posting.location,
      minSalary: posting.minSalary?.toString() ?? null,
      maxSalary: posting.maxSalary?.toString() ?? null,
      currency: posting.currency,
      clientName: posting.client?.name ?? null,
      openedAt: posting.openedAt?.toISOString() ?? null,
      myApplication,
    });
  },
);

// ----- Apply ---------------------------------------------------------------

const ApplyInputSchema = z.object({
  coverLetter: z.string().max(8000).optional().nullable(),
  resumeUrl: z.string().url().max(500).optional().nullable(),
});

internalMobility120Router.post(
  '/internal-jobs/:id/apply',
  requireAuth,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (!req.user!.associateId) {
      throw new HttpError(
        403,
        'no_associate_record',
        'Only associates can apply to internal jobs.',
      );
    }
    const input = ApplyInputSchema.parse(req.body);
    const posting = await prisma.jobPosting.findUnique({ where: { id } });
    if (!posting || posting.status !== 'OPEN') {
      throw new HttpError(404, 'not_found', 'Job not found.');
    }
    try {
      const created = await prisma.internalJobApplication.create({
        data: {
          postingId: id,
          associateId: req.user!.associateId,
          coverLetter: input.coverLetter ?? null,
          resumeUrl: input.resumeUrl ?? null,
        },
      });
      res.status(201).json({ id: created.id });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new HttpError(
          409,
          'already_applied',
          'You have already applied. Withdraw first if you want to re-apply.',
        );
      }
      throw err;
    }
  },
);

// ----- My applications -----------------------------------------------------

internalMobility120Router.get(
  '/my/internal-applications',
  requireAuth,
  async (req, res) => {
    if (!req.user!.associateId) {
      return res.json({ applications: [] });
    }
    const apps = await prisma.internalJobApplication.findMany({
      where: { associateId: req.user!.associateId },
      include: {
        posting: {
          select: { id: true, title: true, location: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      applications: apps.map((a) => ({
        id: a.id,
        status: a.status,
        coverLetter: a.coverLetter,
        createdAt: a.createdAt.toISOString(),
        posting: a.posting,
      })),
    });
  },
);

// ----- Withdraw ------------------------------------------------------------

internalMobility120Router.post(
  '/internal-applications/:id/withdraw',
  requireAuth,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const app = await prisma.internalJobApplication.findUnique({ where: { id } });
    if (!app) {
      throw new HttpError(404, 'not_found', 'Application not found.');
    }
    if (req.user!.associateId !== app.associateId) {
      throw new HttpError(403, 'not_owner', 'Only the applicant can withdraw.');
    }
    if (app.status === 'WITHDRAWN' || app.status === 'HIRED' || app.status === 'REJECTED') {
      throw new HttpError(
        409,
        'terminal',
        `Application is ${app.status}, cannot withdraw.`,
      );
    }
    await prisma.internalJobApplication.update({
      where: { id },
      data: { status: 'WITHDRAWN' },
    });
    res.json({ ok: true });
  },
);

// ----- Review queue (manager) ----------------------------------------------

internalMobility120Router.get(
  '/internal-jobs/:id/applications',
  MANAGE,
  async (req, res) => {
    const postingId = z.string().uuid().parse(req.params.id);
    const status = STATUS.optional().parse(req.query.status);
    const apps = await prisma.internalJobApplication.findMany({
      where: { postingId, ...(status ? { status } : {}) },
      include: {
        associate: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            jobProfile: { select: { title: true } },
            department: { select: { name: true } },
          },
        },
        reviewedBy: { select: { email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      applications: apps.map((a) => ({
        id: a.id,
        associateId: a.associateId,
        associateName: `${a.associate.firstName} ${a.associate.lastName}`,
        associateEmail: a.associate.email,
        currentTitle: a.associate.jobProfile?.title ?? null,
        currentDepartment: a.associate.department?.name ?? null,
        status: a.status,
        coverLetter: a.coverLetter,
        resumeUrl: a.resumeUrl,
        reviewerNotes: a.reviewerNotes,
        reviewedByEmail: a.reviewedBy?.email ?? null,
        reviewedAt: a.reviewedAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  },
);

// ----- Update application status (manager) ---------------------------------

const DecisionInputSchema = z.object({
  status: STATUS,
  reviewerNotes: z.string().max(4000).optional().nullable(),
});

internalMobility120Router.patch(
  '/internal-applications/:id/decision',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = DecisionInputSchema.parse(req.body);
    const app = await prisma.internalJobApplication.findUnique({ where: { id } });
    if (!app) {
      throw new HttpError(404, 'not_found', 'Application not found.');
    }
    await prisma.internalJobApplication.update({
      where: { id },
      data: {
        status: input.status,
        reviewerNotes: input.reviewerNotes ?? null,
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
      },
    });
    res.json({ ok: true });
  },
);
