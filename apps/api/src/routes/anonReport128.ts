import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 128 — Anonymous reporting / whistleblower hotline.
 *
 * File / lookup / message: PUBLIC. The reporter never authenticates; the
 * 16-char tracking code is the only way back to a case. Don't leak the
 * authorUserId, internalOnly notes, or assignedTo to the public lookup.
 *
 * HR queue / triage / resolve: gated by manage:performance (the same audience
 * that runs HR cases — discipline, harassment, conduct).
 */

export const anonReport128Router = Router();

const MANAGE_PERF = requireCapability('manage:performance');

// ----- Helpers --------------------------------------------------------------

function generateTrackingCode(): string {
  // 16 uppercase alphanum chars; ambiguous chars (0, O, 1, I, L) excluded so
  // reporters don't fat-finger it when typing from a printout.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[buf[i] % alphabet.length];
  }
  return out;
}

// ----- File a report (public) ----------------------------------------------

const FileInputSchema = z.object({
  category: z.enum([
    'HARASSMENT',
    'DISCRIMINATION',
    'ETHICS_VIOLATION',
    'FRAUD',
    'SAFETY',
    'RETALIATION',
    'OTHER',
  ]),
  subject: z.string().min(3).max(200),
  description: z.string().min(20).max(20_000),
  contactEmail: z.string().email().max(200).optional().nullable(),
});

anonReport128Router.post('/anonymous-reports', async (req, res) => {
  const input = FileInputSchema.parse(req.body);
  // Try a few times in case of unique-collision (effectively never, but cheap).
  let trackingCode = generateTrackingCode();
  for (let i = 0; i < 3; i++) {
    const existing = await prisma.anonymousReport.findUnique({
      where: { trackingCode },
    });
    if (!existing) break;
    trackingCode = generateTrackingCode();
  }
  await prisma.anonymousReport.create({
    data: {
      trackingCode,
      category: input.category,
      subject: input.subject,
      description: input.description,
      contactEmail: input.contactEmail ?? null,
    },
  });
  res.status(201).json({ trackingCode });
});

// ----- Public lookup by tracking code --------------------------------------

anonReport128Router.get(
  '/anonymous-reports/code/:code',
  async (req, res) => {
    const code = z.string().min(8).max(64).parse(req.params.code);
    const report = await prisma.anonymousReport.findUnique({
      where: { trackingCode: code },
      include: {
        updates: {
          where: { internalOnly: false },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!report) {
      throw new HttpError(404, 'not_found', 'No report with that code.');
    }
    res.json({
      report: {
        trackingCode: report.trackingCode,
        category: report.category,
        subject: report.subject,
        description: report.description,
        status: report.status,
        contactEmail: report.contactEmail,
        resolution: report.resolution,
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        createdAt: report.createdAt.toISOString(),
        updates: report.updates.map((u) => ({
          id: u.id,
          body: u.body,
          isFromReporter: u.isFromReporter,
          createdAt: u.createdAt.toISOString(),
        })),
      },
    });
  },
);

// ----- Public reply from reporter ------------------------------------------

const ReporterReplySchema = z.object({
  body: z.string().min(1).max(20_000),
});

anonReport128Router.post(
  '/anonymous-reports/code/:code/messages',
  async (req, res) => {
    const code = z.string().min(8).max(64).parse(req.params.code);
    const input = ReporterReplySchema.parse(req.body);
    const report = await prisma.anonymousReport.findUnique({
      where: { trackingCode: code },
      select: { id: true, status: true },
    });
    if (!report) {
      throw new HttpError(404, 'not_found', 'No report with that code.');
    }
    if (report.status === 'CLOSED') {
      throw new HttpError(
        409,
        'closed',
        'This report is closed. Open a new report.',
      );
    }
    await prisma.anonymousReportUpdate.create({
      data: {
        reportId: report.id,
        body: input.body,
        isFromReporter: true,
        internalOnly: false,
      },
    });
    res.status(201).json({ ok: true });
  },
);

// ----- HR queue -------------------------------------------------------------

anonReport128Router.get('/anonymous-reports', MANAGE_PERF, async (req, res) => {
  const status = z
    .enum(['RECEIVED', 'TRIAGING', 'INVESTIGATING', 'RESOLVED', 'CLOSED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.anonymousReport.findMany({
    take: 100,
    where: status ? { status } : {},
    include: {
      assignedTo: { select: { email: true } },
      _count: { select: { updates: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    reports: rows.map((r) => ({
      id: r.id,
      trackingCode: r.trackingCode,
      category: r.category,
      subject: r.subject,
      status: r.status,
      contactEmail: r.contactEmail,
      assignedToEmail: r.assignedTo?.email ?? null,
      updateCount: r._count.updates,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    })),
  });
});

// ----- HR detail (full timeline incl. internal notes) ----------------------

anonReport128Router.get(
  '/anonymous-reports/:id',
  MANAGE_PERF,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const report = await prisma.anonymousReport.findUnique({
      where: { id },
      include: {
        assignedTo: { select: { id: true, email: true } },
        updates: {
          orderBy: { createdAt: 'asc' },
          include: {
            authorUser: { select: { email: true } },
          },
        },
      },
    });
    if (!report) {
      throw new HttpError(404, 'not_found', 'Report not found.');
    }
    res.json({
      report: {
        id: report.id,
        trackingCode: report.trackingCode,
        category: report.category,
        subject: report.subject,
        description: report.description,
        status: report.status,
        contactEmail: report.contactEmail,
        assignedTo: report.assignedTo
          ? { id: report.assignedTo.id, email: report.assignedTo.email }
          : null,
        resolution: report.resolution,
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        createdAt: report.createdAt.toISOString(),
        updatedAt: report.updatedAt.toISOString(),
        updates: report.updates.map((u) => ({
          id: u.id,
          body: u.body,
          isFromReporter: u.isFromReporter,
          internalOnly: u.internalOnly,
          authorEmail: u.authorUser?.email ?? null,
          createdAt: u.createdAt.toISOString(),
        })),
      },
    });
  },
);

// ----- HR: assign / set status ---------------------------------------------

const TriageInputSchema = z.object({
  status: z
    .enum(['RECEIVED', 'TRIAGING', 'INVESTIGATING', 'RESOLVED', 'CLOSED'])
    .optional(),
  assignedToId: z.string().uuid().nullable().optional(),
  resolution: z.string().max(20_000).nullable().optional(),
});

anonReport128Router.patch(
  '/anonymous-reports/:id',
  MANAGE_PERF,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = TriageInputSchema.parse(req.body);
    const existing = await prisma.anonymousReport.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Report not found.');
    }
    const data: Record<string, unknown> = {};
    if (input.status !== undefined) {
      data.status = input.status;
      if (input.status === 'RESOLVED' && !existing.resolvedAt) {
        data.resolvedAt = new Date();
      }
    }
    if (input.assignedToId !== undefined) {
      data.assignedToId = input.assignedToId;
    }
    if (input.resolution !== undefined) {
      data.resolution = input.resolution;
    }
    await prisma.anonymousReport.update({ where: { id }, data });
    res.json({ ok: true });
  },
);

// ----- HR: post message (visible or internal-only) -------------------------

const HrMessageSchema = z.object({
  body: z.string().min(1).max(20_000),
  internalOnly: z.boolean().optional().default(false),
});

anonReport128Router.post(
  '/anonymous-reports/:id/messages',
  MANAGE_PERF,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = HrMessageSchema.parse(req.body);
    const existing = await prisma.anonymousReport.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Report not found.');
    }
    await prisma.anonymousReportUpdate.create({
      data: {
        reportId: existing.id,
        body: input.body,
        authorUserId: req.user!.id,
        isFromReporter: false,
        internalOnly: input.internalOnly,
      },
    });
    res.status(201).json({ ok: true });
  },
);

// ----- Summary --------------------------------------------------------------

anonReport128Router.get(
  '/anonymous-reports-summary',
  MANAGE_PERF,
  async (_req, res) => {
    const [received, triaging, investigating, resolved] = await Promise.all([
      prisma.anonymousReport.count({ where: { status: 'RECEIVED' } }),
      prisma.anonymousReport.count({ where: { status: 'TRIAGING' } }),
      prisma.anonymousReport.count({ where: { status: 'INVESTIGATING' } }),
      prisma.anonymousReport.count({ where: { status: 'RESOLVED' } }),
    ]);
    res.json({
      newCount: received,
      triagingCount: triaging,
      investigatingCount: investigating,
      resolvedCount: resolved,
    });
  },
);

