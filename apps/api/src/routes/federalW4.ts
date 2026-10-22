import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { UPLOAD_MAX_BYTES } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { assertAssociateInScope } from '../lib/scope.js';
import { enqueueAudit } from '../lib/audit.js';
import { federalW4Fields } from '../lib/payrollTax.js';
import { getBlobStore, tenantBlobKey } from '../lib/blobStore.js';
import { safeContentDisposition, sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';

/**
 * The federal W-4 facts payroll records that the worker's own W-4 form
 * doesn't carry: an "Exempt" claim and its year, nonresident-alien status,
 * a 2019-or-earlier W-4 never replaced, and an IRS lock-in letter. Payroll
 * (process:payroll) only; every change is audited.
 *
 *   GET /payroll/federal-w4/:associateId   what withholding reads today
 *   PUT /payroll/federal-w4/:associateId   set any of the facts
 *   POST /payroll/federal-w4/:associateId/lock-in-letter   file the letter itself (PDF or photo)
 *   GET  /payroll/federal-w4/:associateId/lock-in-letter   read it back
 *
 * The letter is filed as a document in the person's vault (DocumentRecord,
 * the blob store), so it sits with their other records and their retention.
 */
export const federalW4Router = Router();

const PROCESS = requireCapability('process:payroll');

const Body = z
  .object({
    exempt: z.boolean().optional(),
    exemptTaxYear: z.number().int().min(2020).max(2100).nullable().optional(),
    nonresidentAlien: z.boolean().optional(),
    pre2020Allowances: z.number().int().min(0).max(99).nullable().optional(),
    lockIn: z
      .object({
        filingStatus: z.enum(['SINGLE', 'MARRIED_FILING_JOINTLY', 'HEAD_OF_HOUSEHOLD']),
        multipleJobs: z.boolean().default(false),
        effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .nullable()
      .optional(),
  })
  .strict();

async function load(associateId: string) {
  const w4 = await prisma.w4Submission.findUnique({ where: { associateId } });
  if (!w4) throw new HttpError(404, 'no_w4', 'This person has no W-4 on file yet.');
  return w4;
}

/** The letter on file, when one was uploaded and is still in the vault. */
async function letterOf(w4: { lockInLetterDocumentId: string | null }) {
  if (!w4.lockInLetterDocumentId) return null;
  const doc = await prisma.documentRecord.findFirst({
    where: { id: w4.lockInLetterDocumentId, deletedAt: null },
    select: { id: true, filename: true, mimeType: true, createdAt: true, s3Key: true, purgedAt: true },
  });
  if (!doc) return null;
  return { documentId: doc.id, filename: doc.filename, mimeType: doc.mimeType, uploadedAt: doc.createdAt.toISOString(), available: !!doc.s3Key && !doc.purgedAt };
}

async function view(w4: Awaited<ReturnType<typeof load>>) {
  const reads = federalW4Fields(w4, new Date());
  return {
    exempt: w4.exempt,
    exemptTaxYear: w4.exemptTaxYear,
    nonresidentAlien: w4.nonresidentAlien,
    pre2020Allowances: w4.pre2020Allowances,
    lockIn: w4.lockInFilingStatus
      ? { filingStatus: w4.lockInFilingStatus, multipleJobs: !!w4.lockInMultipleJobs, effectiveDate: w4.lockInEffectiveDate?.toISOString().slice(0, 10) ?? null }
      : null,
    /** The IRS letter itself (Letter 2800C), when filed. */
    lockInLetter: await letterOf(w4),
    /** How withholding reads the W-4 today (exempt expiry and lock-in applied). */
    effective: reads,
  };
}

federalW4Router.get('/:associateId', PROCESS, async (req, res, next) => {
  try {
    const associateId = z.string().uuid().parse(req.params.associateId);
    await assertAssociateInScope(prisma, req.user!, associateId);
    res.json(await view(await load(associateId)));
  } catch (err) {
    next(err);
  }
});

federalW4Router.put('/:associateId', PROCESS, async (req, res, next) => {
  try {
    const associateId = z.string().uuid().parse(req.params.associateId);
    await assertAssociateInScope(prisma, req.user!, associateId);
    const body = Body.parse(req.body ?? {});
    const before = await load(associateId);
    const updated = await prisma.w4Submission.update({
      where: { associateId },
      data: {
        ...(body.exempt !== undefined ? { exempt: body.exempt, exemptTaxYear: body.exempt ? (body.exemptTaxYear ?? new Date().getUTCFullYear()) : null } : {}),
        ...(body.exemptTaxYear !== undefined && body.exempt === undefined ? { exemptTaxYear: body.exemptTaxYear } : {}),
        ...(body.nonresidentAlien !== undefined ? { nonresidentAlien: body.nonresidentAlien } : {}),
        ...(body.pre2020Allowances !== undefined ? { pre2020Allowances: body.pre2020Allowances } : {}),
        ...(body.lockIn !== undefined
          ? body.lockIn
            ? { lockInFilingStatus: body.lockIn.filingStatus, lockInMultipleJobs: body.lockIn.multipleJobs, lockInEffectiveDate: new Date(`${body.lockIn.effectiveDate}T00:00:00Z`), lockInReceivedAt: new Date() }
            : { lockInFilingStatus: null, lockInMultipleJobs: null, lockInEffectiveDate: null, lockInReceivedAt: null, lockInLetterDocumentId: null }
          : {}),
      },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId: null,
        action: 'payroll.federal_w4_updated',
        entityType: 'W4Submission',
        entityId: updated.id,
        metadata: JSON.parse(JSON.stringify({ associateId, before: await view(before), after: { exempt: updated.exempt, nonresidentAlien: updated.nonresidentAlien, pre2020Allowances: updated.pre2020Allowances, lockIn: updated.lockInFilingStatus } })),
      },
      'federalW4.update',
    );
    res.json(await view(updated));
  } catch (err) {
    next(err);
  }
});

/* ----- The lock-in letter itself ------------------------------------------ */

const LETTER_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const letterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!LETTER_MIMES.has(file.mimetype)) {
      cb(new HttpError(400, 'invalid_mime', 'Upload the letter as a PDF or a photo (PNG or JPEG).'));
      return;
    }
    cb(null, true);
  },
});

federalW4Router.post('/:associateId/lock-in-letter', PROCESS, letterUpload.single('file'), async (req, res, next) => {
  try {
    const associateId = z.string().uuid().parse(req.params.associateId);
    await assertAssociateInScope(prisma, req.user!, associateId);
    const w4 = await load(associateId);
    if (!req.file) throw new HttpError(400, 'file_required', 'Choose the letter to upload.');
    const magic = verifyFileMagic(req.file.buffer, req.file.mimetype);
    if (magic) throw new HttpError(400, 'file_mismatch', magic);
    const filename = sanitizeUploadFilename(req.file.originalname);
    const key = tenantBlobKey(`w4-lock-in/${associateId}/${Date.now()}-${filename}`);
    await getBlobStore().put(key, req.file.buffer, req.file.mimetype);
    const doc = await prisma.documentRecord.create({
      data: {
        associateId,
        kind: 'OTHER',
        s3Key: key,
        filename,
        mimeType: req.file.mimetype,
        size: req.file.size,
        // Payroll filed it from the IRS's own letter: nothing for HR to check.
        status: 'VERIFIED',
        verifiedById: req.user!.id,
        verifiedAt: new Date(),
      },
    });
    const updated = await prisma.w4Submission.update({ where: { associateId }, data: { lockInLetterDocumentId: doc.id } });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId: null,
        action: 'payroll.lock_in_letter_uploaded',
        entityType: 'W4Submission',
        entityId: w4.id,
        metadata: { associateId, documentId: doc.id, replaced: w4.lockInLetterDocumentId, filename },
      },
      'federalW4.letter',
    );
    res.status(201).json(await view(updated));
  } catch (err) {
    next(err);
  }
});

federalW4Router.get('/:associateId/lock-in-letter', PROCESS, async (req, res, next) => {
  try {
    const associateId = z.string().uuid().parse(req.params.associateId);
    await assertAssociateInScope(prisma, req.user!, associateId);
    const w4 = await load(associateId);
    const doc = w4.lockInLetterDocumentId
      ? await prisma.documentRecord.findFirst({ where: { id: w4.lockInLetterDocumentId, associateId, deletedAt: null } })
      : null;
    if (!doc?.s3Key) throw new HttpError(404, 'no_letter', 'No lock-in letter is on file for this person.');
    const stream = await getBlobStore().getStream(doc.s3Key);
    if (!stream) throw new HttpError(410, 'file_missing', 'The letter file is no longer available. Upload it again.');
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', safeContentDisposition(doc.filename, doc.mimeType === 'application/pdf'));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});
