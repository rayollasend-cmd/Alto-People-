import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { randomUUID, createHash } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import {
  ExternalPaymentInputSchema,
  ExternalPaymentListResponseSchema,
  ExternalPaymentMethodSchema,
  UPLOAD_MAX_BYTES,
  toDateOnly,
} from '@alto-people/shared';
import { buildExternalPayrollSheet } from '../lib/externalPayrollSheet.js';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit, recordDocumentEvent } from '../lib/audit.js';
import { blobExistsForListing, getBlobStore } from '../lib/blobStore.js';
import { sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';

/**
 * External payments — audit documentation for externally-run payroll.
 *
 * Payroll is currently processed outside Alto, so HR records each pay
 * period per associate here and attaches evidence (paystub PDF, cleared
 * check image, processor report) as PAYSTUB DocumentRecords. The files ride
 * the regular document vault — same storage, same download route, same
 * retention semantics — so an auditor pulling the associate's file gets the
 * payment evidence without knowing this feature exists.
 *
 * Deliberately NOT derived from PayrollRun: these rows document payments
 * Alto never computed. Same capability gate as the rest of the pay-facing
 * drawer sections (Pay setup, Tax identity, W-4).
 */

export const externalPaymentsRouter = Router();

const PAYROLL_OR_HR = requireCapability('process:payroll');
externalPaymentsRouter.use(PAYROLL_OR_HR);

// Evidence files: same allowlist as associate document uploads — the vault
// never stores anything it can't safely serve back.
const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      cb(new HttpError(400, 'invalid_mime', `Unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

type PaymentWithRelations = Prisma.ExternalPaymentGetPayload<{
  include: {
    createdBy: { select: { email: true } };
    evidence: true;
  };
}>;

function toPayment(p: PaymentWithRelations) {
  return {
    id: p.id,
    associateId: p.associateId,
    periodStart: toDateOnly(p.periodStart)!,
    periodEnd: toDateOnly(p.periodEnd)!,
    payDate: toDateOnly(p.payDate),
    grossAmount: p.grossAmount === null ? null : Number(p.grossAmount),
    netAmount: p.netAmount === null ? null : Number(p.netAmount),
    method: p.method,
    reference: p.reference,
    note: p.note,
    createdByEmail: p.createdBy?.email ?? null,
    createdAt: p.createdAt.toISOString(),
    evidence: p.evidence
      .filter((d) => d.deletedAt === null)
      .map((d) => ({
        id: d.id,
        filename: d.filename,
        mimeType: d.mimeType,
        size: d.size,
        createdAt: d.createdAt.toISOString(),
        fileAvailable: blobExistsForListing(d.s3Key),
      })),
  };
}

const PAYMENT_INCLUDE = {
  createdBy: { select: { email: true } },
  evidence: true,
} as const;

async function assertAssociate(associateId: string) {
  const associate = await prisma.associate.findFirst({
    where: { id: associateId, deletedAt: null },
    select: { id: true },
  });
  if (!associate) {
    throw new HttpError(404, 'associate_not_found', 'Associate not found');
  }
  return associate;
}

/** Denormalized tenant pointer for audit rows and evidence DocumentRecords —
 *  same "most recent application" convention as the admin document upload. */
async function recentClientId(associateId: string): Promise<string | null> {
  const app = await prisma.application.findFirst({
    where: { associateId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { clientId: true },
  });
  return app?.clientId ?? null;
}

async function loadPayment(paymentId: string) {
  const payment = await prisma.externalPayment.findFirst({
    where: { id: paymentId, deletedAt: null },
    include: PAYMENT_INCLUDE,
  });
  if (!payment) {
    throw new HttpError(404, 'payment_not_found', 'Payment record not found');
  }
  return payment;
}

/* ----- List ------------------------------------------------------------- */

externalPaymentsRouter.get(
  '/associates/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await assertAssociate(req.params.id);
      const where = { associateId: req.params.id, deletedAt: null };
      const [total, rows] = await Promise.all([
        prisma.externalPayment.count({ where }),
        prisma.externalPayment.findMany({
          where,
          orderBy: { periodEnd: 'desc' },
          take: 200,
          include: PAYMENT_INCLUDE,
        }),
      ]);
      res.json(
        ExternalPaymentListResponseSchema.parse({
          payments: rows.map(toPayment),
          total,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

/* ----- Batch: record a whole pay period ---------------------------------- */

/**
 * GET /external-payments/period-prefill?from=YYYY-MM-DD&to=YYYY-MM-DD
 * One row per associate with APPROVED time in the period, hours split
 * reg/OT by the SAME math as the bureau handoff sheet, plus a suggested
 * gross (hourly rate × hours, 1.5× OT) and whether a payment row already
 * exists for this exact period. NO PII — this powers the on-screen batch
 * recorder, not the bureau file.
 */
externalPaymentsRouter.get(
  '/period-prefill',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const from = req.query.from?.toString();
      const to = req.query.to?.toString();
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
        throw new HttpError(400, 'invalid_period', 'from/to must be YYYY-MM-DD, to on or after from.');
      }
      const sheet = await buildExternalPayrollSheet(prisma, {}, {
        from: `${from}T00:00:00.000Z`,
        to: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 3_600_000).toISOString(),
      });
      const existing = await prisma.externalPayment.findMany({
        where: {
          deletedAt: null,
          periodStart: new Date(from),
          periodEnd: new Date(to),
          associateId: { in: sheet.rows.map((r) => r.associateId) },
        },
        select: { associateId: true, grossAmount: true },
      });
      const recorded = new Map(existing.map((p) => [p.associateId, p]));
      res.json({
        rows: sheet.rows.map((r) => {
          const hourly = r.payType === 'HOURLY' && r.payRate != null;
          const gross = hourly
            ? Math.round((r.regularHours * r.payRate! + r.overtimeHours * r.payRate! * 1.5) * 100) / 100
            : null;
          const prior = recorded.get(r.associateId);
          return {
            associateId: r.associateId,
            fullName: r.fullName,
            clientName: r.clientName,
            regularHours: r.regularHours,
            overtimeHours: r.overtimeHours,
            suggestedGross: gross,
            alreadyRecorded: !!prior,
            recordedGross: prior?.grossAmount != null ? Number(prior.grossAmount) : null,
          };
        }),
        truncated: sheet.truncated,
      });
    } catch (err) {
      next(err);
    }
  },
);

const RecordPeriodSchema = z.object({
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  payDate: z.string().date().nullable().optional(),
  method: ExternalPaymentMethodSchema.default('OTHER'),
  reference: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  rows: z
    .array(
      z.object({
        associateId: z.string().uuid(),
        grossAmount: z.number().nonnegative().max(1_000_000).nullable().optional(),
        netAmount: z.number().nonnegative().max(1_000_000).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
}).refine((v) => v.periodEnd >= v.periodStart, {
  message: 'periodEnd must be on or after periodStart',
  path: ['periodEnd'],
});

/**
 * POST /external-payments/record-period — the whole pay run in one call.
 * Idempotent per (associate, period): an existing row for the exact
 * period is UPDATED, so re-running after corrections never duplicates.
 * One audit row carries the batch; the per-payment evidence flow is
 * unchanged.
 */
externalPaymentsRouter.post(
  '/record-period',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RecordPeriodSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const input = parsed.data;
      const periodStart = new Date(input.periodStart);
      const periodEnd = new Date(input.periodEnd);
      const ids = [...new Set(input.rows.map((r) => r.associateId))];
      const valid = new Set(
        (
          await prisma.associate.findMany({
            where: { id: { in: ids }, deletedAt: null },
            select: { id: true },
          })
        ).map((a) => a.id),
      );

      let created = 0;
      let updated = 0;
      let skipped = 0;
      for (const row of input.rows) {
        if (!valid.has(row.associateId)) {
          skipped += 1;
          continue;
        }
        const shared = {
          payDate: input.payDate ? new Date(input.payDate) : null,
          grossAmount: row.grossAmount ?? null,
          netAmount: row.netAmount ?? null,
          method: input.method,
          reference: input.reference || null,
          note: input.note || null,
        };
        const existing = await prisma.externalPayment.findFirst({
          where: {
            associateId: row.associateId,
            periodStart,
            periodEnd,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (existing) {
          await prisma.externalPayment.update({
            where: { id: existing.id },
            data: shared,
          });
          updated += 1;
        } else {
          await prisma.externalPayment.create({
            data: {
              associateId: row.associateId,
              periodStart,
              periodEnd,
              createdById: req.user!.id,
              ...shared,
            },
          });
          created += 1;
        }
      }

      enqueueAudit(
        {
          actorUserId: req.user!.id,
          action: 'external_payment.batch_recorded',
          entityType: 'ExternalPayment',
          entityId: `${input.periodStart}..${input.periodEnd}`,
          metadata: {
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            method: input.method,
            created,
            updated,
            skipped,
          },
        },
        'externalPayments.batch',
      );
      res.json({ created, updated, skipped });
    } catch (err) {
      next(err);
    }
  },
);

/* ----- Create / update / delete ----------------------------------------- */

externalPaymentsRouter.post(
  '/associates/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const associate = await assertAssociate(req.params.id);
      const parsed = ExternalPaymentInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const input = parsed.data;
      const created = await prisma.externalPayment.create({
        data: {
          associateId: associate.id,
          periodStart: new Date(input.periodStart),
          periodEnd: new Date(input.periodEnd),
          payDate: input.payDate ? new Date(input.payDate) : null,
          grossAmount: input.grossAmount ?? null,
          netAmount: input.netAmount ?? null,
          method: input.method,
          reference: input.reference || null,
          note: input.note || null,
          createdById: req.user!.id,
        },
        include: PAYMENT_INCLUDE,
      });
      enqueueAudit(
        {
          actorUserId: req.user!.id,
          clientId: await recentClientId(associate.id),
          action: 'external_payment.created',
          entityType: 'ExternalPayment',
          entityId: created.id,
          metadata: {
            associateId: associate.id,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            method: input.method,
          },
        },
        'externalPayments',
      );
      res.status(201).json(toPayment(created));
    } catch (err) {
      next(err);
    }
  },
);

externalPaymentsRouter.patch(
  '/:paymentId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await loadPayment(req.params.paymentId);
      const parsed = ExternalPaymentInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const input = parsed.data;
      const updated = await prisma.externalPayment.update({
        where: { id: existing.id },
        data: {
          periodStart: new Date(input.periodStart),
          periodEnd: new Date(input.periodEnd),
          payDate: input.payDate ? new Date(input.payDate) : null,
          grossAmount: input.grossAmount ?? null,
          netAmount: input.netAmount ?? null,
          method: input.method,
          reference: input.reference || null,
          note: input.note || null,
        },
        include: PAYMENT_INCLUDE,
      });
      enqueueAudit(
        {
          actorUserId: req.user!.id,
          clientId: await recentClientId(existing.associateId),
          action: 'external_payment.updated',
          entityType: 'ExternalPayment',
          entityId: existing.id,
          metadata: {
            associateId: existing.associateId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
          },
        },
        'externalPayments',
      );
      res.json(toPayment(updated));
    } catch (err) {
      next(err);
    }
  },
);

externalPaymentsRouter.delete(
  '/:paymentId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await loadPayment(req.params.paymentId);
      // Soft delete. Evidence DocumentRecords are deliberately left alone —
      // deleting the period row must never destroy the audit artifacts; the
      // files stay in the associate's vault under Tax & payroll.
      await prisma.externalPayment.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
      enqueueAudit(
        {
          actorUserId: req.user!.id,
          clientId: await recentClientId(existing.associateId),
          action: 'external_payment.deleted',
          entityType: 'ExternalPayment',
          entityId: existing.id,
          metadata: {
            associateId: existing.associateId,
            periodStart: toDateOnly(existing.periodStart),
            periodEnd: toDateOnly(existing.periodEnd),
            evidenceCount: existing.evidence.filter((d) => d.deletedAt === null).length,
          },
        },
        'externalPayments',
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/* ----- Evidence upload --------------------------------------------------- */

externalPaymentsRouter.post(
  '/:paymentId/evidence',
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payment = await loadPayment(req.params.paymentId);
      if (!req.file) {
        throw new HttpError(400, 'no_file', 'A "file" multipart field is required');
      }
      const magicError = verifyFileMagic(req.file.buffer, req.file.mimetype);
      if (magicError) {
        throw new HttpError(400, 'invalid_file_contents', magicError);
      }
      const cleanName = sanitizeUploadFilename(req.file.originalname);

      const sha = createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const id = randomUUID();
      const ext = extname(cleanName).toLowerCase();
      const relativeKey = `${id}-${sha}${ext}`;
      await getBlobStore().put(relativeKey, req.file.buffer, req.file.mimetype);

      const clientId = await recentClientId(payment.associateId);
      const created = await prisma.documentRecord.create({
        data: {
          id,
          associateId: payment.associateId,
          clientId,
          kind: 'PAYSTUB',
          externalPaymentId: payment.id,
          s3Key: relativeKey,
          filename: cleanName,
          mimeType: req.file.mimetype,
          size: req.file.size,
          // HR uploads land verified — the uploader is the verifier, same
          // as provider result PDFs on /documents/admin/upload.
          status: 'VERIFIED',
          verifiedById: req.user!.id,
          verifiedAt: new Date(),
        },
      });

      await recordDocumentEvent({
        actorUserId: req.user!.id,
        action: 'document.payment_evidence_uploaded',
        documentId: created.id,
        associateId: payment.associateId,
        clientId,
        metadata: {
          externalPaymentId: payment.id,
          periodStart: toDateOnly(payment.periodStart),
          periodEnd: toDateOnly(payment.periodEnd),
          size: created.size,
        },
        req,
      });

      res.status(201).json({
        id: created.id,
        filename: created.filename,
        mimeType: created.mimeType,
        size: created.size,
        createdAt: created.createdAt.toISOString(),
        fileAvailable: true,
      });
    } catch (err) {
      next(err);
    }
  },
);
