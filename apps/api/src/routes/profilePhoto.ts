import { Router, type Request, type Response } from 'express';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../types/express.js';
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
import { profilePhotoUrlFor, userPhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { assertSameTenant } from '../lib/sameTenant.js';
import { scopeAssociates, scopeShifts, scopeTimeEntries } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { env } from '../config/env.js';

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

type PhotoOwner = { kind: 'associate' | 'user'; id: string };

async function readPhotoKey(owner: PhotoOwner): Promise<string | null> {
  const row =
    owner.kind === 'associate'
      ? await prisma.associate.findUnique({ where: { id: owner.id }, select: { photoS3Key: true } })
      : await prisma.user.findUnique({ where: { id: owner.id }, select: { photoS3Key: true } });
  return row?.photoS3Key ?? null;
}

async function writePhotoKey(owner: PhotoOwner, key: string | null) {
  const data = { photoS3Key: key, photoUpdatedAt: new Date() };
  const select = { id: true, photoS3Key: true, photoUpdatedAt: true } as const;
  return owner.kind === 'associate'
    ? prisma.associate.update({ where: { id: owner.id }, data, select })
    : prisma.user.update({ where: { id: owner.id }, data, select });
}

/**
 * Store an uploaded photo blob and point its owner at it — shared by the
 * self-service route (an associate's headshot, or a staff account's own
 * photo) and the HR-side route so validation, key layout, and prior-blob
 * cleanup can never drift apart. Returns the fresh cache-busted URL.
 */
async function savePhoto(
  owner: PhotoOwner,
  file: Express.Multer.File,
): Promise<string> {
  const magicError = verifyFileMagic(file.buffer, file.mimetype);
  if (magicError) {
    throw new HttpError(400, 'invalid_file_contents', magicError);
  }
  const cleanName = sanitizeUploadFilename(file.originalname);
  const ext =
    EXT_BY_MIME[file.mimetype] ?? (extname(cleanName).toLowerCase() || '.bin');
  const prefix = owner.kind === 'user' ? 'user-' : '';
  const relativeKey = `${PROFILE_PHOTO_DIR}/${prefix}${owner.id}-${randomUUID()}${ext}`;
  await getBlobStore().put(relativeKey, file.buffer, file.mimetype);

  const prior = await readPhotoKey(owner);
  const updated = await writePhotoKey(owner, relativeKey);
  if (prior && prior !== relativeKey) {
    // Best-effort cleanup of the previous blob. Failure here is fine —
    // it's an orphan blob, not a correctness problem.
    try {
      await getBlobStore().delete(prior);
    } catch {
      /* swallow */
    }
  }
  return (owner.kind === 'associate' ? profilePhotoUrlFor(updated) : userPhotoUrlFor(updated))!;
}

/** Clear an owner's photo and drop the blob (best effort). */
async function removePhoto(owner: PhotoOwner): Promise<void> {
  const prior = await readPhotoKey(owner);
  await writePhotoKey(owner, null);
  if (prior) {
    try {
      await getBlobStore().delete(prior);
    } catch {
      /* swallow */
    }
  }
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
          status: { notIn: ['APPROVED', 'REJECTED', 'CANCELLED'] },
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
    if (!req.file) {
      throw new HttpError(400, 'no_file', 'A "file" multipart field is required.');
    }
    // An associate-linked login sets their headshot (the one HR, the
    // schedule and the kiosk see); a staff account with no associate sets
    // the photo on the account.
    const associateId = req.user!.associateId;
    const photoUrl = await savePhoto(
      associateId ? { kind: 'associate', id: associateId } : { kind: 'user', id: req.user!.id },
      req.file,
    );
    if (associateId) await syncPhotoTask(associateId, true);

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
    await assertSameTenant('associate', String(req.params.id));
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
    const photoUrl = await savePhoto({ kind: 'associate', id: associate.id }, req.file);
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
    await assertSameTenant('associate', String(req.params.id));
    const associate = await prisma.associate.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, photoS3Key: true },
    });
    if (!associate) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    await removePhoto({ kind: 'associate', id: associate.id });
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
    await removePhoto(
      associateId ? { kind: 'associate', id: associateId } : { kind: 'user', id: req.user!.id },
    );
    if (associateId) await syncPhotoTask(associateId, false);
    invalidateUserCache(req.user!.id);
    res.status(204).end();
  },
);

/** Stream a stored photo, or 404 when none is on file (or the blob is gone). */
async function sendPhoto(req: Request, res: Response, key: string | null | undefined): Promise<void> {
  if (!key) {
    // Most screens build the photo URL from an id and let the avatar fall
    // back to initials: let the browser remember "no photo" for a couple of
    // minutes, or a roster page re-asks for every face on every visit.
    res.setHeader('Cache-Control', 'private, max-age=120');
    throw new HttpError(404, 'no_photo', 'No profile photo on file.');
  }
  // Driver-based read; null (blob gone) keeps the existing 404.
  const blob = await getBlobStore().get(key);
  if (!blob) {
    throw new HttpError(404, 'no_photo', 'No profile photo on file.');
  }
  const ext = extname(key).toLowerCase();
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
  // A ?v=<updatedAt> URL names one version of the photo, so it can be kept
  // for an hour. A bare URL (the many places that build it from an id)
  // must revalidate every time — Express answers with an ETag and a 304
  // when nothing changed — or a new photo hid behind the old one for an hour.
  res.setHeader(
    'Cache-Control',
    req.query.v ? 'private, max-age=3600' : 'private, no-cache',
  );
  res.send(blob);
}

/**
 * Any signed-in user in the tenant can see an associate's headshot — they
 * appear next to names everywhere in the app — except a client's own
 * account: a store manager sees the people who work, or worked, for them
 * (their roster, or a shift or punch at their client or store), not every
 * associate on Alto's books. A region-wide portal account (no client, store
 * or org unit) keeps the tenant-wide view its command center draws from.
 */
function portalAssociateScope(u: SessionUser): Prisma.AssociateWhereInput {
  const bounded = u.role === 'CLIENT_PORTAL' && Boolean(u.clientId || u.locationId || u.orgUnitPath);
  if (!bounded) return {};
  return {
    OR: [
      scopeAssociates(u),
      { assignedShifts: { some: scopeShifts(u) } },
      { timeEntries: { some: scopeTimeEntries(u) } },
    ],
  };
}

profilePhotoRouter.get(
  '/associates/:id/photo',
  requireAuth,
  async (req, res) => {
    await assertSameTenant('associate', String(req.params.id));
    const associate = await prisma.associate.findFirst({
      where: { id: req.params.id, deletedAt: null, ...portalAssociateScope(req.user!) },
      select: { photoS3Key: true },
    });
    await sendPhoto(req, res, associate?.photoS3Key);
  },
);

// A login's face, by user id — the same pick as accountPhotoUrlFor: the
// linked associate's headshot, else the account's own photo (staff with no
// associate) — so a screen that only
// knows who someone is as a user (an audit actor, a note author, a
// recipient) gets the right face for everyone. Visible to any signed-in
// user in the tenant, like an associate's headshot.
profilePhotoRouter.get(
  '/users/:id/photo',
  requireAuth,
  async (req, res) => {
    await assertSameTenant('user', String(req.params.id));
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { photoS3Key: true, associateId: true },
    });
    // The associate fallback under the same rule as /associates/:id/photo.
    const linked = user?.associateId
      ? await prisma.associate.findFirst({
          where: { id: user.associateId, deletedAt: null, ...portalAssociateScope(req.user!) },
          select: { photoS3Key: true },
        })
      : null;
    const associateKey = linked?.photoS3Key ?? null;
    await sendPhoto(req, res, associateKey ?? user?.photoS3Key);
  },
);

// ----- Storage health ----------------------------------------------------
// A photo whose blob is gone renders exactly like no photo — initials, no
// error anywhere — so a storage that loses files (Railway's container disk
// with no Volume, wiped on every redeploy) looked like "nobody has a
// photo". These two routes make it visible from inside the app and let HR
// clear the dangling keys, so the people affected are asked again (Settings
// says Upload, an open onboarding re-opens its photo step) instead of
// silently showing initials.

const HEALTH_CHECK_CAP = 5_000;

async function photoRowsWithMissingBlobs() {
  const tenantId = tenantIdForWrite();
  const [associates, users] = await Promise.all([
    prisma.associate.findMany({
      take: HEALTH_CHECK_CAP,
      where: { tenantId, deletedAt: null, photoS3Key: { not: null } },
      select: { id: true, photoS3Key: true },
    }),
    prisma.user.findMany({
      take: HEALTH_CHECK_CAP,
      where: { tenantId, deletedAt: null, photoS3Key: { not: null } },
      select: { id: true, photoS3Key: true },
    }),
  ]);
  const rows = [
    ...associates.map((a) => ({ kind: 'associate' as const, id: a.id, key: a.photoS3Key! })),
    ...users.map((u) => ({ kind: 'user' as const, id: u.id, key: u.photoS3Key! })),
  ];
  const missing: typeof rows = [];
  const store = getBlobStore();
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25);
    const found = await Promise.all(batch.map((r) => store.exists(r.key).catch(() => true)));
    batch.forEach((r, j) => {
      if (!found[j]) missing.push(r);
    });
  }
  return {
    onFile: rows.length,
    missing,
    truncated: associates.length === HEALTH_CHECK_CAP || users.length === HEALTH_CHECK_CAP,
  };
}

/** Does this deployment keep uploads across a redeploy? */
function storageDurability() {
  const driver = env.STORAGE_DRIVER;
  const durable = driver === 's3' || Boolean(env.UPLOAD_DIR) || env.NODE_ENV !== 'production';
  return { driver, durable };
}

profilePhotoRouter.get(
  '/profile-photos/health',
  requireCapability('manage:org'),
  async (_req, res) => {
    const { onFile, missing, truncated } = await photoRowsWithMissingBlobs();
    res.json({ ...storageDurability(), onFile, missing: missing.length, truncated });
  },
);

profilePhotoRouter.post(
  '/profile-photos/clear-missing',
  requireCapability('manage:org'),
  async (req, res) => {
    const { missing } = await photoRowsWithMissingBlobs();
    for (const row of missing) {
      // Only clear while the key is still the one we found missing — a
      // fresh upload in the meantime must survive.
      const data = { photoS3Key: null, photoUpdatedAt: new Date() };
      if (row.kind === 'associate') {
        const r = await prisma.associate.updateMany({ where: { id: row.id, photoS3Key: row.key }, data });
        if (r.count > 0) {
          await syncPhotoTask(row.id, false);
          await invalidateAssociateUsers(row.id);
        }
      } else {
        const r = await prisma.user.updateMany({ where: { id: row.id, photoS3Key: row.key }, data });
        if (r.count > 0) invalidateUserCache(row.id);
      }
    }
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'profile_photos.missing_cleared',
        entityType: 'Tenant',
        entityId: tenantIdForWrite(),
        metadata: { cleared: missing.length },
      },
      'profile_photos.missing_cleared',
    );
    res.json({ cleared: missing.length });
  },
);
