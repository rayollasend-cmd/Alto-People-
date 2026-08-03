import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import {
  DocumentKindSchema,
  DocumentListResponseSchema,
  DocumentRejectInputSchema,
  DocumentVaultResponseSchema,
  type DocumentRecord,
} from '@alto-people/shared';
import type { DocumentKind, TaskKind } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeDocuments } from '../lib/scope.js';
import {
  recordCriticalAudit,
  recordDocumentEvent,
  recordOnboardingEvent,
} from '../lib/audit.js';
import { markTaskTodoByKind } from '../lib/checklist.js';
import { notifyAllAdmins, notifyAssociate, notifyManager } from '../lib/notify.js';
import {
  documentRejectedAssociateTemplate,
  documentRejectedManagerTemplate,
  documentUploadedTemplate,
} from '../lib/emailTemplates.js';
import { resolveStoragePath, UPLOAD_ROOT } from '../lib/storage.js';
import {
  isRejectedDocPastRetention,
  purgeOneRejectedDoc,
} from '../lib/documentMaintenance.js';
import {
  safeContentDisposition,
  sanitizeUploadFilename,
  verifyFileMagic,
} from '../lib/uploads.js';
import { env } from '../config/env.js';

export const documentsRouter = Router();

const MANAGE = requireCapability('manage:documents');

/**
 * Map associate-uploaded DocumentKind → the onboarding TaskKind whose
 * completion that document drives. When an admin rejects a doc, we use
 * this table to find the corresponding checklist task on the associate's
 * in-flight application and rewind it back to PENDING so they're
 * prompted to re-upload as part of their onboarding.
 *
 * Only includes kinds an associate can upload themselves. Admin-uploaded
 * result PDFs (BACKGROUND_CHECK_RESULT, DRUG_TEST_RESULT, etc.) and
 * server-generated docs (W4_PDF, SIGNED_AGREEMENT) intentionally have no
 * mapping — rejecting one of those doesn't rewind a self-serve task.
 */
const DOC_KIND_TO_TASK_KIND: Partial<Record<DocumentKind, TaskKind>> = {
  ID: 'DOCUMENT_UPLOAD',
  SSN_CARD: 'DOCUMENT_UPLOAD',
  I9_SUPPORTING: 'DOCUMENT_UPLOAD',
  J1_DS2019: 'J1_DOCS',
  J1_VISA: 'J1_DOCS',
};

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      cb(new HttpError(400, 'invalid_mime', `Unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

// HR-side uploads additionally accept a ZIP. E-Verify hands the employer a
// case-closure packet as a folder, which downloads as an archive — without
// this the only route was for HR to unzip and upload each PDF by hand.
//
// Kept OFF the associate-facing `/me/upload`: widening what an unauthenticated-
// adjacent role can push into storage is a different risk calculation, and
// associates have no reason to submit archives. Archives are stored and never
// extracted, and ZIP is absent from INLINEABLE_MIMES so it always downloads
// as an attachment.
const ADMIN_ALLOWED_MIMES = new Set([
  ...ALLOWED_MIMES,
  'application/zip',
  'application/x-zip-compressed',
]);

const adminUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ADMIN_ALLOWED_MIMES.has(file.mimetype)) {
      cb(new HttpError(400, 'invalid_mime', `Unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

type RawDoc = Prisma.DocumentRecordGetPayload<{
  include: {
    associate: { select: { firstName: true; lastName: true } };
    verifiedBy: { select: { email: true } };
  };
}>;

function toRecord(d: RawDoc): DocumentRecord {
  // True when the file blob still exists. We hit the filesystem here
  // because the underlying storage on Railway is ephemeral — a redeploy
  // can wipe `apps/api/uploads/` while the DocumentRecord row persists
  // in Neon, leaving zombie rows whose download endpoint returns 410.
  // The UI uses this flag to disable preview/download and prompt the
  // associate to re-upload before they hit the broken endpoint.
  //
  // Past-retention REJECTED rows also report unavailable even before the
  // cron or lazy-purge actually drops the blob: the file is conceptually
  // gone the moment retention lapses, so the listing UI shouldn't dangle
  // a clickable link that would 404 a moment later.
  const fileAvailable =
    d.s3Key !== null &&
    !isRejectedDocPastRetention(d) &&
    existsSync(resolveStoragePath(d.s3Key));
  return {
    id: d.id,
    associateId: d.associateId,
    associateName: d.associate ? `${d.associate.firstName} ${d.associate.lastName}` : null,
    clientId: d.clientId,
    kind: d.kind,
    filename: d.filename,
    mimeType: d.mimeType,
    size: d.size,
    status: d.status,
    expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
    rejectionReason: d.rejectionReason,
    verifiedById: d.verifiedById,
    verifierEmail: d.verifiedBy?.email ?? null,
    verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
    fileAvailable,
  };
}

const DOC_INCLUDE = {
  associate: { select: { firstName: true, lastName: true } },
  verifiedBy: { select: { email: true } },
} as const;

/* ===== ASSOCIATE-FACING (/me) =========================================== */

documentsRouter.get('/me', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json({ documents: [] });
      return;
    }
    const rows = await prisma.documentRecord.findMany({
      take: 500,
      where: { associateId: user.associateId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: DOC_INCLUDE,
    });
    res.json(DocumentListResponseSchema.parse({ documents: rows.map(toRecord) }));
  } catch (err) {
    next(err);
  }
});

documentsRouter.post('/me/upload', upload.single('file'), async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can upload to /me');
    }
    if (!req.file) {
      throw new HttpError(400, 'no_file', 'A "file" multipart field is required');
    }
    const kindParse = DocumentKindSchema.safeParse(req.body.kind);
    if (!kindParse.success) {
      throw new HttpError(400, 'invalid_kind', 'Invalid or missing "kind" field');
    }
    const magicError = verifyFileMagic(req.file.buffer, req.file.mimetype);
    if (magicError) {
      throw new HttpError(400, 'invalid_file_contents', magicError);
    }
    const cleanName = sanitizeUploadFilename(req.file.originalname);

    // Content-addressed path so the same upload twice stays the same blob.
    const sha = createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
    const id = randomUUID();
    const ext = extname(cleanName).toLowerCase();
    const relativeKey = `${id}-${sha}${ext}`;
    const fullPath = resolveStoragePath(relativeKey);
    await writeFile(fullPath, req.file.buffer);

    const created = await prisma.documentRecord.create({
      data: {
        id,
        associateId: user.associateId,
        clientId: user.clientId,
        kind: kindParse.data,
        s3Key: relativeKey,
        filename: cleanName,
        mimeType: req.file.mimetype,
        size: req.file.size,
        status: 'UPLOADED',
      },
      include: DOC_INCLUDE,
    });

    await recordDocumentEvent({
      actorUserId: user.id,
      action: 'document.uploaded',
      documentId: created.id,
      associateId: created.associateId,
      clientId: created.clientId,
      metadata: {
        kind: created.kind,
        size: created.size,
        mime: created.mimeType,
        filename: created.filename,
      },
      req,
    });

    const assoc = await prisma.associate.findUnique({
      where: { id: created.associateId },
      select: { firstName: true, lastName: true },
    });
    const associateName = assoc ? `${assoc.firstName} ${assoc.lastName}` : 'An associate';
    const tpl = documentUploadedTemplate({
      associateName,
      documentKind: created.kind.replace(/_/g, ' ').toLowerCase(),
      filename: created.filename,
      uploadedAt: new Date(created.createdAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      documentsUrl: `${env.APP_BASE_URL}/documents`,
    });
    void notifyAllAdmins({ subject: tpl.subject, body: tpl.text, html: tpl.html, category: 'documents' });

    res.status(201).json(toRecord(created));
  } catch (err) {
    next(err);
  }
});

/* ===== HR-side upload =================================================== */

// HR uploads result PDFs (background-check, drug-test, E-Verify) into the
// associate's profile. Different from /me/upload in that:
//   1. The actor isn't the associate — `associateId` comes from a form field.
//   2. Status is auto-VERIFIED with `verifiedById = HR user`. These are
//      HR-curated source-of-truth artifacts, not associate submissions
//      that need a review pass.
documentsRouter.post(
  '/admin/upload',
  MANAGE,
  adminUpload.single('file'),
  async (req, res, next) => {
    try {
      const user = req.user!;
      if (!req.file) {
        throw new HttpError(400, 'no_file', 'A "file" multipart field is required');
      }
      const associateId =
        typeof req.body.associateId === 'string' ? req.body.associateId : null;
      if (!associateId) {
        throw new HttpError(400, 'invalid_body', '"associateId" form field is required');
      }
      const kindParse = DocumentKindSchema.safeParse(req.body.kind);
      if (!kindParse.success) {
        throw new HttpError(400, 'invalid_kind', 'Invalid or missing "kind" field');
      }
      const associate = await prisma.associate.findFirst({
        where: { id: associateId, deletedAt: null },
        select: { id: true },
      });
      if (!associate) {
        throw new HttpError(404, 'associate_not_found', 'Associate not found');
      }
      // Denormalized clientId on DocumentRecord powers tenant scoping for
      // CLIENT_PORTAL viewers. Associate <-> Client lives on Application,
      // so pull the most recent application's clientId; falls back to null
      // for associates without one (still HR-visible via scopeDocuments).
      const recentApp = await prisma.application.findFirst({
        where: { associateId: associate.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { clientId: true },
      });

      const magicError = verifyFileMagic(req.file.buffer, req.file.mimetype);
      if (magicError) {
        throw new HttpError(400, 'invalid_file_contents', magicError);
      }
      const cleanName = sanitizeUploadFilename(req.file.originalname);

      const sha = createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const id = randomUUID();
      const ext = extname(cleanName).toLowerCase();
      const relativeKey = `${id}-${sha}${ext}`;
      await writeFile(resolveStoragePath(relativeKey), req.file.buffer);

      const created = await prisma.documentRecord.create({
        data: {
          id,
          associateId: associate.id,
          clientId: recentApp?.clientId ?? null,
          kind: kindParse.data,
          s3Key: relativeKey,
          filename: cleanName,
          mimeType: req.file.mimetype,
          size: req.file.size,
          status: 'VERIFIED',
          verifiedById: user.id,
          verifiedAt: new Date(),
        },
        include: DOC_INCLUDE,
      });

      await recordDocumentEvent({
        actorUserId: user.id,
        action: 'document.hr_uploaded',
        documentId: created.id,
        associateId: created.associateId,
        clientId: created.clientId,
        metadata: {
          kind: created.kind,
          size: created.size,
          mime: created.mimeType,
          filename: created.filename,
        },
        req,
      });

      res.status(201).json(toRecord(created));
    } catch (err) {
      next(err);
    }
  }
);

/* ===== Download (associate of own + HR/Ops of any) ====================== */

// Pass `?inline=1` to render the document in-browser (PDFs / images) for the
// in-platform viewer. Default is `attachment` so a bare URL still downloads.
// Only the MIME types we already accept on upload are eligible for inline —
// anything else falls back to attachment so a stray text/html upload couldn't
// be rendered as a same-origin page.
const INLINEABLE_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

documentsRouter.get('/:id/download', async (req, res, next) => {
  try {
    const doc = await prisma.documentRecord.findFirst({
      where: { id: req.params.id, ...scopeDocuments(req.user!) },
    });
    if (!doc || !doc.s3Key) {
      throw new HttpError(404, 'document_not_found', 'Document not found');
    }
    // REJECTED docs stay on disk during the retention window so HR can
    // review them — but the associate shouldn't be able to re-download
    // what they were told is no good. 404 (not 403) matches the existing
    // "doesn't exist for you" pattern and avoids confirming the row.
    const requester = req.user!;
    if (
      doc.status === 'REJECTED' &&
      requester.role === 'ASSOCIATE' &&
      requester.associateId === doc.associateId
    ) {
      throw new HttpError(404, 'document_not_found', 'Document not found');
    }
    // Lazy purge on first read past retention. The daily maintenance
    // cron is the primary path, but between ticks a stale-but-still-
    // downloadable file would technically be served to HR. Catching it
    // on the way to disk here closes that window: drop the blob, null
    // s3Key, and 404 as if the cron had already run.
    if (doc.s3Key && isRejectedDocPastRetention(doc)) {
      await purgeOneRejectedDoc(prisma, doc.id, doc.s3Key);
      throw new HttpError(404, 'document_not_found', 'Document not found');
    }
    const path = resolveStoragePath(doc.s3Key);
    if (!existsSync(path)) {
      throw new HttpError(410, 'document_missing', 'Underlying file is no longer available');
    }
    const wantInline =
      req.query.inline === '1' && INLINEABLE_MIMES.has(doc.mimeType);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader(
      'Content-Disposition',
      safeContentDisposition(doc.filename, wantInline),
    );
    // Belt-and-braces against framing/sniffing on the inline path.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Identity docs / I-9 papers: keep them out of shared & disk caches.
    res.setHeader('Cache-Control', 'private, no-store');
    if (wantInline) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; object-src 'self'; frame-ancestors 'self'");
    }
    res.sendFile(path);
  } catch (err) {
    next(err);
  }
});

/* ===== HR/Ops queue ===================================================== */

documentsRouter.get('/admin', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const kind = req.query.kind?.toString();
    const associateId = req.query.associateId?.toString();
    const where: Prisma.DocumentRecordWhereInput = {
      ...scopeDocuments(req.user!),
      ...(status ? { status: status as Prisma.DocumentRecordWhereInput['status'] } : {}),
      ...(kind ? { kind: kind as Prisma.DocumentRecordWhereInput['kind'] } : {}),
      ...(associateId ? { associateId } : {}),
    };
    // Total alongside the capped page — past 200 docs the vault used to
    // present a silently-partial list as authoritative audit truth.
    const [rows, total] = await Promise.all([
      prisma.documentRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: DOC_INCLUDE,
      }),
      prisma.documentRecord.count({ where }),
    ]);
    res.json(
      DocumentListResponseSchema.parse({
        documents: rows.map(toRecord),
        total,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /documents/admin/vault/:associateId — the associate document vault.
 *
 * Every DocumentRecord on file plus a compliance summary from each domain's
 * ledger (I-9, E-Verify, background, drug test, J-1), so the profile's
 * Documents tab can pair evidence with the decision it supports instead of
 * rendering a flat pile. Read-only aggregation — all writes stay with the
 * owning directorates.
 */
documentsRouter.get('/admin/vault/:associateId', MANAGE, async (req, res, next) => {
  try {
    const associateId = req.params.associateId;
    const associate = await prisma.associate.findFirst({
      where: { id: associateId, deletedAt: null },
      select: { id: true },
    });
    if (!associate) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found');
    }

    const docWhere: Prisma.DocumentRecordWhereInput = {
      ...scopeDocuments(req.user!),
      associateId,
    };
    const [rows, total, i9, latestBg, latestDrug, lastDrugResult, j1] = await Promise.all([
      prisma.documentRecord.findMany({
        where: docWhere,
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: DOC_INCLUDE,
      }),
      prisma.documentRecord.count({ where: docWhere }),
      prisma.i9Verification.findUnique({
        where: { associateId },
        select: {
          section1CompletedAt: true,
          section2CompletedAt: true,
          eVerifyStatus: true,
          eVerifyCaseNumber: true,
          eVerifyClosedAt: true,
        },
      }),
      prisma.backgroundCheck.findFirst({
        where: { associateId },
        orderBy: { initiatedAt: 'desc' },
        select: { status: true, completedAt: true },
      }),
      prisma.drugTest.findFirst({
        where: { associateId },
        orderBy: { initiatedAt: 'desc' },
        select: { status: true, completedAt: true },
      }),
      prisma.documentRecord.findFirst({
        where: { associateId, kind: 'DRUG_TEST_RESULT', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.j1Profile.findUnique({
        where: { associateId },
        select: { programStartDate: true, programEndDate: true, sponsorAgency: true },
      }),
    ]);

    // Same 60-day recency rule as the drug-test directorate's pending roster.
    const DRUG_WINDOW_MS = 60 * 86_400_000;
    const lastResultAt = lastDrugResult?.createdAt ?? null;

    res.json(
      DocumentVaultResponseSchema.parse({
        documents: rows.map(toRecord),
        total,
        summary: {
          i9: i9
            ? {
                section1CompletedAt: i9.section1CompletedAt?.toISOString() ?? null,
                section2CompletedAt: i9.section2CompletedAt?.toISOString() ?? null,
              }
            : null,
          everify:
            i9 && (i9.eVerifyStatus || i9.eVerifyCaseNumber)
              ? {
                  status: i9.eVerifyStatus ?? null,
                  caseNumber: i9.eVerifyCaseNumber ?? null,
                  closedAt: i9.eVerifyClosedAt?.toISOString() ?? null,
                }
              : null,
          background: latestBg
            ? {
                status: latestBg.status,
                completedAt: latestBg.completedAt?.toISOString() ?? null,
              }
            : null,
          drugTest:
            latestDrug || lastResultAt
              ? {
                  status: latestDrug?.status ?? null,
                  completedAt: latestDrug?.completedAt?.toISOString() ?? null,
                  lastResultAt: lastResultAt?.toISOString() ?? null,
                  fresh:
                    lastResultAt !== null &&
                    Date.now() - lastResultAt.getTime() < DRUG_WINDOW_MS,
                }
              : null,
          j1: j1
            ? {
                programStartDate: j1.programStartDate.toISOString().slice(0, 10),
                programEndDate: j1.programEndDate.toISOString().slice(0, 10),
                sponsorAgency: j1.sponsorAgency,
              }
            : null,
        },
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /documents/admin/all.zip?associateId=UUID — one archive of every
 * available document for an associate. An auditor asking for someone's
 * file used to mean opening and downloading each row individually.
 */
documentsRouter.get('/admin/all.zip', MANAGE, async (req, res, next) => {
  try {
    const associateId = req.query.associateId?.toString();
    if (!associateId) {
      throw new HttpError(400, 'associate_required', 'associateId is required');
    }
    // Optional `kinds=ID,SSN_CARD,...` filter. Without it a reviewer working
    // an I-9 or E-Verify case gets the associate's ENTIRE file — offer
    // letters, signed policies, tax forms — when they wanted the four
    // identity documents. Exporting more PII than the task needs is a habit
    // worth designing out.
    const kindsRaw = req.query.kinds?.toString().trim();
    const kinds = kindsRaw
      ? (kindsRaw.split(',').map((k) => k.trim()).filter(Boolean) as DocumentKind[])
      : null;

    const [associate, docs] = await Promise.all([
      prisma.associate.findFirst({
        where: { id: associateId, deletedAt: null },
        select: { firstName: true, lastName: true },
      }),
      prisma.documentRecord.findMany({
        where: {
          ...scopeDocuments(req.user!),
          associateId,
          deletedAt: null,
          s3Key: { not: null },
          ...(kinds && kinds.length > 0 ? { kind: { in: kinds } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }),
    ]);
    if (!associate) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found');
    }

    const { default: archiver } = await import('archiver');
    const { createReadStream, existsSync } = await import('node:fs');

    // Decide what's actually going in BEFORE streaming: the audit row and the
    // manifest both need the real list, and once the archive starts piping
    // the response headers are gone.
    const included: Array<{ id: string; kind: string; entry: string }> = [];
    const skipped: Array<{ id: string; kind: string; filename: string }> = [];
    const seen = new Set<string>();
    for (const d of docs) {
      if (!existsSync(resolveStoragePath(d.s3Key!))) {
        // Purged or lost blob. This used to be a silent `continue`, so an
        // auditor received an archive quietly missing documents with no way
        // to tell — it looked like the associate never uploaded them.
        skipped.push({ id: d.id, kind: d.kind, filename: d.filename });
        continue;
      }
      let entry = `${d.kind.toLowerCase()}-${d.filename}`;
      if (seen.has(entry)) entry = `${d.id.slice(0, 8)}-${entry}`;
      seen.add(entry);
      included.push({ id: d.id, kind: d.kind, entry });
    }

    // A bulk archive of one person's identity documents is the same class of
    // disclosure as the SSN reveal and the external payroll sheet, and both
    // of those record before the bytes leave. This endpoint recorded nothing
    // at all — the highest-volume PII export in the module was invisible.
    // Critical, so a failed insert aborts the download rather than handing
    // over an untraceable copy of someone's passport.
    await recordCriticalAudit(
      {
        actorUserId: req.user!.id,
        action: 'document.bulk_exported',
        entityType: 'Associate',
        entityId: associateId,
        metadata: {
          documentCount: included.length,
          kinds: included.map((i) => i.kind),
          skippedCount: skipped.length,
          filtered: kinds !== null,
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        },
      },
      'documents.bulk_export',
    );

    const zipName = `documents-${associate.lastName}-${associate.firstName}`
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);

    for (const d of docs) {
      const inc = included.find((i) => i.id === d.id);
      if (!inc) continue;
      archive.append(createReadStream(resolveStoragePath(d.s3Key!)), {
        name: inc.entry,
      });
    }

    // Manifest so the recipient can tell a complete archive from a partial
    // one without cross-checking against the product.
    const manifest = [
      `Documents for ${associate.firstName} ${associate.lastName}`,
      `Exported ${new Date().toISOString()}`,
      kinds ? `Filtered to: ${kinds.join(', ')}` : 'All document types',
      '',
      `Included (${included.length}):`,
      ...included.map((i) => `  ${i.entry}`),
    ];
    if (skipped.length > 0) {
      manifest.push(
        '',
        `MISSING — file no longer on the server (${skipped.length}):`,
        ...skipped.map((s) => `  ${s.kind.toLowerCase()}-${s.filename}`),
        '',
        'These need to be re-uploaded by the associate.',
      );
    }
    archive.append(manifest.join('\n'), { name: 'MANIFEST.txt' });

    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

documentsRouter.post('/admin/:id/verify', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const doc = await prisma.documentRecord.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!doc) throw new HttpError(404, 'document_not_found', 'Document not found');
    if (doc.status === 'VERIFIED') {
      // Idempotent — return as-is.
      const r = await prisma.documentRecord.findUniqueOrThrow({
        where: { id: doc.id },
        include: DOC_INCLUDE,
      });
      res.json(toRecord(r));
      return;
    }
    // Optional document expiry captured AT VERIFICATION — the reviewer is
    // looking at the ID/visa's printed expiry right now. Feeds the daily
    // expiry sweep + the (previously always-zero) Expired chips and the
    // associate's Renew flow.
    const expiresAtRaw = req.body?.expiresAt;
    let expiresAt: Date | undefined;
    if (typeof expiresAtRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expiresAtRaw)) {
      expiresAt = new Date(`${expiresAtRaw}T00:00:00.000Z`);
    }
    const updated = await prisma.documentRecord.update({
      where: { id: doc.id },
      data: {
        status: 'VERIFIED',
        verifiedById: user.id,
        verifiedAt: new Date(),
        rejectionReason: null,
        ...(expiresAt ? { expiresAt } : {}),
      },
      include: DOC_INCLUDE,
    });
    await recordDocumentEvent({
      actorUserId: user.id,
      action: 'document.verified',
      documentId: updated.id,
      associateId: updated.associateId,
      clientId: updated.clientId,
      req,
    });
    res.json(toRecord(updated));
  } catch (err) {
    next(err);
  }
});

// Bulk-verify the good docs in one pass. Mirrors the single-verify path
// (status → VERIFIED, stamp verifier, clear any prior rejection reason, audit
// each). Processes per-id so one bad id never sinks the batch; rows that are
// missing or already verified come back in `skipped` with a reason. Reject
// stays per-row — it carries a per-doc reason plus onboarding/email side
// effects we don't want to fan out blindly.
const BulkVerifySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

documentsRouter.post('/admin/bulk-verify', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = BulkVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'ids is required', parsed.error.flatten());
    }
    // One fetch + one identical-payload updateMany instead of a
    // findFirst/update pair per id. Per-id result reporting is preserved by
    // classifying against the fetched set; audits stay per-row but are
    // enqueue-only, so they run in a plain JS loop after the write.
    const docs = await prisma.documentRecord.findMany({
      where: { id: { in: parsed.data.ids }, deletedAt: null },
      select: { id: true, status: true, associateId: true, clientId: true },
    });
    const docById = new Map(docs.map((d) => [d.id, d]));
    const toVerify: typeof docs = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of parsed.data.ids) {
      const doc = docById.get(id);
      if (!doc) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (doc.status === 'VERIFIED') {
        skipped.push({ id, reason: 'already_verified' });
        continue;
      }
      toVerify.push(doc);
    }
    let verified = 0;
    if (toVerify.length > 0) {
      try {
        await prisma.documentRecord.updateMany({
          where: { id: { in: toVerify.map((d) => d.id) }, deletedAt: null },
          data: {
            status: 'VERIFIED',
            verifiedById: user.id,
            verifiedAt: new Date(),
            rejectionReason: null,
          },
        });
        verified = toVerify.length;
      } catch {
        for (const doc of toVerify) {
          skipped.push({ id: doc.id, reason: 'error' });
        }
      }
    }
    if (verified > 0) {
      // Per-row audits preserved; recordDocumentEvent enqueues (fire-and-
      // forget) so this loop costs no extra DB round trips.
      for (const doc of toVerify) {
        await recordDocumentEvent({
          actorUserId: user.id,
          action: 'document.verified',
          documentId: doc.id,
          associateId: doc.associateId,
          clientId: doc.clientId,
          metadata: { bulk: true },
          req,
        });
      }
    }
    res.json({ verified, skipped });
  } catch (err) {
    next(err);
  }
});

documentsRouter.post('/admin/:id/reject', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = DocumentRejectInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'reason is required', parsed.error.flatten());
    }
    const doc = await prisma.documentRecord.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!doc) throw new HttpError(404, 'document_not_found', 'Document not found');

    // Don't unlink the blob here — we keep it on disk for the retention
    // window (REJECTED_DOC_RETENTION_DAYS) so HR can re-open / dispute the
    // rejection while the file is still there. The download endpoint
    // blocks the associate from re-fetching it; HR still has access. The
    // daily maintenance sweep (purgeRejectedDocs) clears the blob and
    // nulls s3Key once `verifiedAt + retention` is in the past.
    const updated = await prisma.documentRecord.update({
      where: { id: doc.id },
      data: {
        status: 'REJECTED',
        rejectionReason: parsed.data.reason,
        verifiedById: user.id,
        verifiedAt: new Date(),
      },
      include: DOC_INCLUDE,
    });
    await recordDocumentEvent({
      actorUserId: user.id,
      action: 'document.rejected',
      documentId: updated.id,
      associateId: updated.associateId,
      clientId: updated.clientId,
      metadata: { reason: parsed.data.reason, filename: updated.filename },
      req,
    });

    // Onboarding rewind — if the rejected doc was tied to a self-serve
    // task on the associate's in-flight application, flip that task back
    // to PENDING so the checklist re-opens. Looks at the most recent
    // non-terminal application (DRAFT / SUBMITTED / IN_REVIEW) for this
    // associate; if they have no live application (e.g. doc uploaded
    // post-hire via /me/documents) this is a no-op. Best-effort —
    // failures don't block the rejection itself.
    //
    // Also drives the deep link in the rejection email: if there's an
    // active application, point the associate at its checklist rather
    // than the generic /me/documents page, so they land where the
    // (now-reopened) task is waiting for them.
    const taskKind = DOC_KIND_TO_TASK_KIND[updated.kind];
    let liveApplicationId: string | null = null;
    if (taskKind) {
      try {
        const liveApp = await prisma.application.findFirst({
          where: {
            associateId: updated.associateId,
            status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] },
          },
          orderBy: { invitedAt: 'desc' },
          include: { checklist: { select: { id: true } } },
        });
        if (liveApp) {
          liveApplicationId = liveApp.id;
          // The application is no longer "ready for review": clear the
          // submitted stamp (and roll SUBMITTED back to DRAFT) so the
          // ready-for-review notification RE-FIRES when the associate
          // fixes the document — without this, the app sat at 100% again
          // with nobody told.
          if (liveApp.submittedAt || liveApp.status === 'SUBMITTED') {
            await prisma.application.update({
              where: { id: liveApp.id },
              data: {
                submittedAt: null,
                ...(liveApp.status === 'SUBMITTED' ? { status: 'DRAFT' } : {}),
              },
            });
          }
          // An I-9-class rejection also reopens the associate's I-9 upload
          // step — documentsSubmittedAt was set-once, which left them
          // staring at "awaiting HR" with no way to act.
          if (
            updated.kind === 'ID' ||
            updated.kind === 'SSN_CARD' ||
            updated.kind === 'I9_SUPPORTING' ||
            updated.kind === 'J1_VISA' ||
            updated.kind === 'J1_DS2019'
          ) {
            await prisma.i9Verification.updateMany({
              where: {
                associateId: updated.associateId,
                section2CompletedAt: null,
              },
              data: { documentsSubmittedAt: null },
            });
          }
          if (liveApp.checklist) {
            const reopened = await markTaskTodoByKind(
              prisma,
              liveApp.checklist.id,
              taskKind
            );
            if (reopened > 0) {
              await recordOnboardingEvent({
                actorUserId: user.id,
                action: 'onboarding.task_reopened',
                applicationId: liveApp.id,
                clientId: liveApp.clientId,
                metadata: {
                  taskKind,
                  reason: 'document_rejected',
                  documentId: updated.id,
                  documentKind: updated.kind,
                },
                req,
              });
            }
          }
        }
      } catch {
        // Best-effort — the rejection itself has already succeeded and
        // been audited; a rewind failure is recoverable by admin re-saving.
      }
    }

    const rejAssoc = await prisma.associate.findUnique({
      where: { id: updated.associateId },
      select: { firstName: true, lastName: true },
    });
    const reviewerName = user.email; // Reviewer's display name (User has no name fields today; surface email).
    const docKindLabel = updated.kind.replace(/_/g, ' ').toLowerCase();
    // Two parallel link forms: a relative path the bell hands to
    // react-router's navigate(), and an absolute URL the email template
    // renders for out-of-app clicks. Both point to the same destination —
    // onboarding checklist when there's a live application, generic
    // documents view otherwise.
    const associateLinkPath = liveApplicationId
      ? `/onboarding/me/${liveApplicationId}`
      : `/me/documents`;
    const documentsUrl = `${env.APP_BASE_URL}${associateLinkPath}`;
    const assocTpl = documentRejectedAssociateTemplate({
      firstName: rejAssoc?.firstName ?? 'there',
      documentKind: docKindLabel,
      filename: updated.filename,
      rejectionReason: parsed.data.reason,
      reviewerName,
      documentsUrl,
    });
    void notifyAssociate(updated.associateId, {
      subject: assocTpl.subject,
      body: assocTpl.text,
      html: assocTpl.html,
      category: 'documents',
      linkUrl: associateLinkPath,
    });
    // Manager copy so the associate's direct manager knows their report is
    // blocked on a re-upload — no-op if the associate has no manager assigned.
    const mgrTpl = documentRejectedManagerTemplate({
      associateName: rejAssoc ? `${rejAssoc.firstName} ${rejAssoc.lastName}` : 'an associate',
      documentKind: docKindLabel,
      rejectionReason: parsed.data.reason,
      reviewerName,
    });
    void notifyManager(updated.associateId, {
      subject: mgrTpl.subject,
      body: mgrTpl.text,
      html: mgrTpl.html,
      category: 'documents',
      // Land the manager on the admin documents page so they can spot
      // the rejected row in context. The admin view groups by associate;
      // there's no per-associate sub-route to deep-link to today.
      linkUrl: `/documents`,
    });

    res.json(toRecord(updated));
  } catch (err) {
    next(err);
  }
});

documentsRouter.delete('/me/:id', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) throw new HttpError(403, 'not_an_associate', 'Forbidden');
    const doc = await prisma.documentRecord.findFirst({
      where: { id: req.params.id, associateId: user.associateId, deletedAt: null },
    });
    if (!doc) throw new HttpError(404, 'document_not_found', 'Document not found');
    if (doc.status === 'VERIFIED') {
      throw new HttpError(409, 'document_verified', 'Cannot delete a verified document');
    }
    await prisma.documentRecord.update({
      where: { id: doc.id },
      data: { deletedAt: new Date() },
    });
    if (doc.s3Key) {
      const path = resolveStoragePath(doc.s3Key);
      try {
        await unlink(path);
      } catch {
        // Best-effort; the soft-delete is what matters for compliance.
      }
    }
    await recordDocumentEvent({
      actorUserId: user.id,
      action: 'document.deleted',
      documentId: doc.id,
      associateId: doc.associateId,
      clientId: doc.clientId,
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Reference UPLOAD_ROOT so the storage-init side effect can't be tree-shaken.
void UPLOAD_ROOT;
