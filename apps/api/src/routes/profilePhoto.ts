import { Router } from 'express';
import { PROFILE_PHOTO_MAX_BYTES } from '@alto-people/shared';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import {
  invalidateUserCache,
  requireAuth,
  requireCapability,
} from '../middleware/auth.js';
import { PROFILE_PHOTO_DIR } from '../lib/storage.js';
import { getBlobStore } from '../lib/blobStore.js';
import { sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';
import { enqueueAudit } from '../lib/audit.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';

/**
 * Profile photos.
 *
 * The Avatar component renders an associate's uploaded headshot when one is
 * on file and falls back to initials otherwise. We keep the URL stable per
 * associate (`/associates/:id/photo`) and cache-bust via `?v=<updatedAt>`
 * on consumers — that lets us drop the URL into list responses without
 * exposing the storage key.
 */
export const profilePhotoRouter = Router();

const MAX_BYTES = PROFILE_PHOTO_MAX_BYTES;
const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      cb(
        new HttpError(
          400,
          'invalid_mime',
          `Profile photo must be PNG, JPEG, or WebP — got ${file.mimetype}.`,
        ),
      );
      return;
    }
    cb(null, true);
  },
});

/**
 * Store an uploaded photo blob and point the associate at it — shared by
 * the self-service route and the HR-side route so validation, key layout,
 * and prior-blob cleanup can never drift apart. Returns the fresh
 * cache-busted URL.
 */
async function savePhoto(
  associateId: string,
  file: Express.Multer.File,
): Promise<string> {
  const magicError = verifyFileMagic(file.buffer, file.mimetype);
  if (magicError) {
    throw new HttpError(400, 'invalid_file_contents', magicError);
  }
  const cleanName = sanitizeUploadFilename(file.originalname);
  const ext =
    EXT_BY_MIME[file.mimetype] ?? (extname(cleanName).toLowerCase() || '.bin');
  const relativeKey = `${PROFILE_PHOTO_DIR}/${associateId}-${randomUUID()}${ext}`;
  await getBlobStore().put(relativeKey, file.buffer, file.mimetype);

  const prior = await prisma.associate.findUnique({
    where: { id: associateId },
    select: { photoS3Key: true },
  });
  const updated = await prisma.associate.update({
    where: { id: associateId },
    data: { photoS3Key: relativeKey, photoUpdatedAt: new Date() },
    select: { id: true, photoS3Key: true, photoUpdatedAt: true },
  });
  if (prior?.photoS3Key && prior.photoS3Key !== relativeKey) {
    // Best-effort cleanup of the previous blob. Failure here is fine —
    // it's an orphan blob, not a correctness problem.
    try {
      await getBlobStore().delete(prior.photoS3Key);
    } catch {
      /* swallow */
    }
  }
  return profilePhotoUrlFor(updated)!;
}

/**
 * Keep the onboarding PROFILE_PHOTO task in lockstep with reality for any
 * in-flight application: a photo landing (self-service wizard OR the HR
 * escape hatch) completes it; a photo being removed pre-approval re-opens
 * it. Without this, HR uploading on the associate's behalf left the task
 * PENDING forever — and the 100%-checklist approval gate blocked on a step
 * that was actually done.
 */
async function syncPhotoTask(associateId: string, hasPhoto: boolean): Promise<void> {
  await prisma.onboardingTask.updateMany({
    where: {
      kind: 'PROFILE_PHOTO',
      status: hasPhoto ? 'PENDING' : 'DONE',
      checklist: {
        application: {
          associateId,
          status: { notIn: ['APPROVED', 'REJECTED'] },
          deletedAt: null,
        },
      },
    },
    data: hasPhoto
      ? { status: 'DONE', completedAt: new Date() }
      : { status: 'PENDING', completedAt: null },
  });
}

/** Flush the session cache of any login linked to this associate — their
 *  chrome (Topbar avatar) carries photoUrl in the cached SessionUser. */
async function invalidateAssociateUsers(associateId: string): Promise<void> {
  const users = await prisma.user.findMany({
    where: { associateId, deletedAt: null },
    select: { id: true },
  });
  for (const u of users) invalidateUserCache(u.id);
}

profilePhotoRouter.post(
  '/me/profile-photo',
  requireAuth,
  upload.single('file'),
  async (req, res) => {
    const associateId = req.user!.associateId;
    if (!associateId) {
      throw new HttpError(
        403,
        'not_an_associate',
        'Only associate-linked accounts can upload a profile photo.',
      );
    }
    if (!req.file) {
      throw new HttpError(400, 'no_file', 'A "file" multipart field is required.');
    }
    const photoUrl = await savePhoto(associateId, req.file);
    await syncPhotoTask(associateId, true);

    // photoUrl is part of the cached SessionUser; bumping photoUpdatedAt
    // changes the cache-bust query, so flush the cache so chrome reflects
    // the new photo on the next request.
    invalidateUserCache(req.user!.id);

    res.status(201).json({ ok: true, photoUrl });
  },
);

// ----- HR-side photo management ------------------------------------------
// A bad or missing photo shouldn't have to wait for the associate to log
// in: HR can set or remove one straight from the People profile. Same
// validation and storage as self-service; audited, since it's someone
// changing another person's likeness.
profilePhotoRouter.post(
  '/associates/:id/photo',
  requireCapability('manage:org'),
  upload.single('file'),
  async (req, res) => {
    const associate = await prisma.associate.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true },
    });
    if (!associate) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    if (!req.file) {
      throw new HttpError(400, 'no_file', 'A "file" multipart field is required.');
    }
    const photoUrl = await savePhoto(associate.id, req.file);
    await syncPhotoTask(associate.id, true);
    await invalidateAssociateUsers(associate.id);
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'associate.photo_set_by_admin',
        entityType: 'Associate',
        entityId: associate.id,
        metadata: { bytes: req.file.size, mime: req.file.mimetype },
      },
      'associate.photo_set_by_admin',
    );
    res.status(201).json({ ok: true, photoUrl });
  },
);

profilePhotoRouter.delete(
  '/associates/:id/photo',
  requireCapability('manage:org'),
  async (req, res) => {
    const associate = await prisma.associate.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, photoS3Key: true },
    });
    if (!associate) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    await prisma.associate.update({
      where: { id: associate.id },
      data: { photoS3Key: null, photoUpdatedAt: new Date() },
    });
    if (associate.photoS3Key) {
      try {
        await getBlobStore().delete(associate.photoS3Key);
      } catch {
        /* swallow */
      }
    }
    await syncPhotoTask(associate.id, false);
    await invalidateAssociateUsers(associate.id);
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'associate.photo_removed_by_admin',
        entityType: 'Associate',
        entityId: associate.id,
        metadata: {},
      },
      'associate.photo_removed_by_admin',
    );
    res.status(204).end();
  },
);

profilePhotoRouter.delete(
  '/me/profile-photo',
  requireAuth,
  async (req, res) => {
    const associateId = req.user!.associateId;
    if (!associateId) {
      throw new HttpError(
        403,
        'not_an_associate',
        'Only associate-linked accounts can remove a profile photo.',
      );
    }
    const prior = await prisma.associate.findUnique({
      where: { id: associateId },
      select: { photoS3Key: true },
    });
    await prisma.associate.update({
      where: { id: associateId },
      data: { photoS3Key: null, photoUpdatedAt: new Date() },
    });
    if (prior?.photoS3Key) {
      try {
        await getBlobStore().delete(prior.photoS3Key);
      } catch {
        /* swallow */
      }
    }
    await syncPhotoTask(associateId, false);
    invalidateUserCache(req.user!.id);
    res.status(204).end();
  },
);

profilePhotoRouter.get(
  '/associates/:id/photo',
  requireAuth,
  async (req, res) => {
    // Any authenticated user can see another user's profile photo — these
    // appear next to names everywhere in the app. We don't tenant-scope:
    // CLIENT_PORTAL still sees their associates' headshots, HR sees all.
    const associate = await prisma.associate.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { photoS3Key: true },
    });
    if (!associate?.photoS3Key) {
      throw new HttpError(404, 'no_photo', 'No profile photo on file.');
    }
    // Driver-based read; null (blob gone) keeps the existing 404.
    const blob = await getBlobStore().get(associate.photoS3Key);
    if (!blob) {
      throw new HttpError(404, 'no_photo', 'No profile photo on file.');
    }
    const ext = extname(associate.photoS3Key).toLowerCase();
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : 'image/jpeg';
    res.setHeader('Content-Type', mime);
    // Same treatment as the document stream: never let a browser sniff a
    // user-supplied image into something scriptable.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Length', String(blob.length));
    // Cache-bustable via the ?v=<updatedAt> param consumers attach.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(blob);
  },
);
