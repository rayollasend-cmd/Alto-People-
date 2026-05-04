import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache, requireAuth } from '../middleware/auth.js';
import { resolveStoragePath, PROFILE_PHOTO_DIR } from '../lib/storage.js';
import { sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';

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

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
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
    const magicError = verifyFileMagic(req.file.buffer, req.file.mimetype);
    if (magicError) {
      throw new HttpError(400, 'invalid_file_contents', magicError);
    }

    const cleanName = sanitizeUploadFilename(req.file.originalname);
    const ext =
      EXT_BY_MIME[req.file.mimetype] ??
      (extname(cleanName).toLowerCase() || '.bin');
    const relativeKey = `${PROFILE_PHOTO_DIR}/${associateId}-${randomUUID()}${ext}`;
    const fullPath = resolveStoragePath(relativeKey);
    await writeFile(fullPath, req.file.buffer);

    const prior = await prisma.associate.findUnique({
      where: { id: associateId },
      select: { photoS3Key: true },
    });
    await prisma.associate.update({
      where: { id: associateId },
      data: { photoS3Key: relativeKey, photoUpdatedAt: new Date() },
    });
    if (prior?.photoS3Key && prior.photoS3Key !== relativeKey) {
      // Best-effort cleanup of the previous file. Failure here is fine —
      // it's an orphan blob, not a correctness problem.
      try {
        await unlink(resolveStoragePath(prior.photoS3Key));
      } catch {
        /* swallow */
      }
    }

    // photoUrl is part of the cached SessionUser; bumping photoUpdatedAt
    // changes the cache-bust query, so flush the cache so chrome reflects
    // the new photo on the next request.
    invalidateUserCache(req.user!.id);

    res.status(201).json({ ok: true });
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
        await unlink(resolveStoragePath(prior.photoS3Key));
      } catch {
        /* swallow */
      }
    }
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
    const fullPath = resolveStoragePath(associate.photoS3Key);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
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
    res.setHeader('Content-Length', String(stat.size));
    // Cache-bustable via the ?v=<updatedAt> param consumers attach.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    createReadStream(fullPath).pipe(res);
  },
);
