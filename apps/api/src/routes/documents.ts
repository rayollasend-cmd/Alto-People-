import { Router } from 'express';
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
  type DocumentRecord,
} from '@alto-people/shared';
import type { DocumentKind, TaskKind } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeDocuments } from '../lib/scope.js';
import { recordDocumentEvent, recordOnboardingEvent } from '../lib/audit.js';
import { markTaskTodoByKind } from '../lib/checklist.js';
import { notifyAllAdmins, notifyAssociate, notifyManager } from '../lib/notify.js';
import {
  documentRejectedAssociateTemplate,
  documentRejectedManagerTemplate,
  documentUploadedTemplate,
} from '../lib/emailTemplates.js';
import { resolveStoragePath, UPLOAD_ROOT } from '../lib/storage.js';
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
  const fileAvailable =
    d.s3Key !== null && existsSync(resolveStoragePath(d.s3Key));
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
      documentsUrl: `${env.APP_BASE_URL}/admin/associates/${created.associateId}/documents`,
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
  upload.single('file'),
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
    const rows = await prisma.documentRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: DOC_INCLUDE,
    });
    res.json(DocumentListResponseSchema.parse({ documents: rows.map(toRecord) }));
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
    const updated = await prisma.documentRecord.update({
      where: { id: doc.id },
      data: {
        status: 'VERIFIED',
        verifiedById: user.id,
        verifiedAt: new Date(),
        rejectionReason: null,
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

    // Drop the blob — the row stays for audit, but a rejected file shouldn't
    // linger on disk where it can still be downloaded. Clearing s3Key makes
    // the download endpoint 404 cleanly.
    if (doc.s3Key) {
      try {
        await unlink(resolveStoragePath(doc.s3Key));
      } catch {
        // Best-effort: if the blob is already missing we proceed.
      }
    }

    const updated = await prisma.documentRecord.update({
      where: { id: doc.id },
      data: {
        status: 'REJECTED',
        rejectionReason: parsed.data.reason,
        verifiedById: user.id,
        verifiedAt: new Date(),
        s3Key: null,
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
