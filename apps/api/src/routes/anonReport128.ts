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

// ----- SLA constants -------------------------------------------------------
//
// Two-tier service-level commitments shown on the HR dashboard:
//
//   - ACK SLA  (3 business days, simplified to 3 calendar days): once a
//     report is RECEIVED, HR must post the first reply.
//   - RESPONSE SLA (5 days): once the reporter posts a follow-up, HR
//     must respond within 5 days OR the case is breach-flagged.
//
// Reports past either window with no fresh HR reply are flagged stale.
// The thresholds are deliberately conservative; whistleblower regulations
// (Sarbanes-Oxley §806, EU Whistleblower Directive) require demonstrable
// follow-up, and "case dropped into a void" is the most common complaint.

const ACK_SLA_DAYS = 3;
const RESPONSE_SLA_DAYS = 5;
const dayMs = 24 * 60 * 60 * 1000;

type ReportUpdateForSla = {
  isFromReporter: boolean;
  internalOnly: boolean;
  createdAt: Date;
};

interface SlaInfo {
  ackedAt: string | null;
  ackHoursLeft: number | null;
  lastReporterAt: string | null;
  lastHrReplyAt: string | null;
  responseHoursLeft: number | null;
  isOverdue: boolean;
  reason: 'unacked' | 'unanswered' | null;
}

function computeSla(
  status: string,
  createdAt: Date,
  updates: ReportUpdateForSla[],
): SlaInfo {
  // Resolved/closed cases don't accrue SLA pressure.
  if (status === 'RESOLVED' || status === 'CLOSED') {
    return {
      ackedAt: null,
      ackHoursLeft: null,
      lastReporterAt: null,
      lastHrReplyAt: null,
      responseHoursLeft: null,
      isOverdue: false,
      reason: null,
    };
  }
  const visible = updates.filter((u) => !u.internalOnly);
  const firstHrReply = visible.find((u) => !u.isFromReporter);
  const lastHrReply = [...visible].reverse().find((u) => !u.isFromReporter);
  const lastReporter = [...visible].reverse().find((u) => u.isFromReporter);
  const now = Date.now();

  let ackHoursLeft: number | null = null;
  if (!firstHrReply) {
    const deadline = createdAt.getTime() + ACK_SLA_DAYS * dayMs;
    ackHoursLeft = Math.round((deadline - now) / (60 * 60 * 1000));
  }

  let responseHoursLeft: number | null = null;
  if (
    lastReporter &&
    (!lastHrReply || lastHrReply.createdAt < lastReporter.createdAt)
  ) {
    const deadline = lastReporter.createdAt.getTime() + RESPONSE_SLA_DAYS * dayMs;
    responseHoursLeft = Math.round((deadline - now) / (60 * 60 * 1000));
  }

  let reason: SlaInfo['reason'] = null;
  let isOverdue = false;
  if (ackHoursLeft !== null && ackHoursLeft <= 0) {
    isOverdue = true;
    reason = 'unacked';
  } else if (responseHoursLeft !== null && responseHoursLeft <= 0) {
    isOverdue = true;
    reason = 'unanswered';
  }

  return {
    ackedAt: firstHrReply?.createdAt.toISOString() ?? null,
    ackHoursLeft,
    lastReporterAt: lastReporter?.createdAt.toISOString() ?? null,
    lastHrReplyAt: lastHrReply?.createdAt.toISOString() ?? null,
    responseHoursLeft,
    isOverdue,
    reason,
  };
}

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
      updates: {
        select: { isFromReporter: true, internalOnly: true, createdAt: true },
      },
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
      updateCount: r.updates.length,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      sla: computeSla(r.status, r.createdAt, r.updates),
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
        sla: computeSla(report.status, report.createdAt, report.updates),
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
    const [received, triaging, investigating, resolved, openReports] =
      await Promise.all([
        prisma.anonymousReport.count({ where: { status: 'RECEIVED' } }),
        prisma.anonymousReport.count({ where: { status: 'TRIAGING' } }),
        prisma.anonymousReport.count({ where: { status: 'INVESTIGATING' } }),
        prisma.anonymousReport.count({ where: { status: 'RESOLVED' } }),
        prisma.anonymousReport.findMany({
          where: { status: { in: ['RECEIVED', 'TRIAGING', 'INVESTIGATING'] } },
          select: {
            status: true,
            createdAt: true,
            updates: {
              select: {
                isFromReporter: true,
                internalOnly: true,
                createdAt: true,
              },
            },
          },
        }),
      ]);
    let overdueCount = 0;
    for (const r of openReports) {
      const sla = computeSla(r.status, r.createdAt, r.updates);
      if (sla.isOverdue) overdueCount++;
    }
    res.json({
      newCount: received,
      triagingCount: triaging,
      investigatingCount: investigating,
      resolvedCount: resolved,
      overdueCount,
    });
  },
);

