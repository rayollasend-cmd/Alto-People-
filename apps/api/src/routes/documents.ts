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
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeDocuments } from '../lib/scope.js';
import { recordDocumentEvent } from '../lib/audit.js';
import { resolveStoragePath, UPLOAD_ROOT } from '../lib/storage.js';

export const documentsRouter = Router();

const MANAGE = requireCapability('manage:documents');

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

    // Content-addressed path so the same upload twice stays the same blob.
    const sha = createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
    const id = randomUUID();
    const ext = extname(req.file.originalname || '').toLowerCase();
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
        filename: req.file.originalname || 'upload',
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
      metadata: { kind: created.kind, size: created.size, mime: created.mimeType },
      req,
    });

    res.status(201).json(toRecord(created));
  } catch (err) {
    next(err);
  }
});

/* ===== Download (associate of own + HR/Ops of any) ====================== */

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
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${doc.filename.replace(/"/g, '')}"`
    );
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
      metadata: { reason: parsed.data.reason },
      req,
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
