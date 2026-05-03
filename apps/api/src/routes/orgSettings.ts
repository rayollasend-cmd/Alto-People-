import { Router } from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import {
  ORG_LOGO_ALLOWED_TYPES,
  ORG_LOGO_MAX_BYTES,
  UpdateOrgBrandingInputSchema,
  type OrgBranding,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import {
  ensureBrandingLoaded,
  refreshBranding,
} from '../lib/branding.js';

/**
 * Org-wide branding (Phase: settings audit row #8). Singleton row keyed
 * by id='singleton'. The PATCH path bumps the cached snapshot so
 * subsequent emails render with the new branding immediately rather than
 * waiting for the 5-minute refresh tick. The logo lives in the DB as a
 * BYTEA so it survives without a Volume mount and is served by the same
 * API host that the SPA hits — no CDN needed.
 */
export const orgSettingsRouter = Router();

const ALLOWED_TYPES = new Set<string>(ORG_LOGO_ALLOWED_TYPES);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ORG_LOGO_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      cb(
        new HttpError(
          400,
          'invalid_mime',
          `Logo must be one of ${ORG_LOGO_ALLOWED_TYPES.join(', ')} — got ${file.mimetype}.`,
        ),
      );
      return;
    }
    cb(null, true);
  },
});

async function loadResponse(): Promise<OrgBranding> {
  // Always read from DB so the response reflects committed state, not the
  // cache (the cache is for the email-render path).
  const row = await prisma.orgSetting.findUnique({ where: { id: 'singleton' } });
  if (!row) {
    return {
      orgName: 'Alto HR',
      senderName: null,
      supportEmail: null,
      primaryColor: null,
      logoUrl: null,
      logoUpdatedAt: null,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    orgName: row.orgName,
    senderName: row.senderName,
    supportEmail: row.supportEmail,
    primaryColor: row.primaryColor,
    logoUrl: row.logoBytes
      ? `/admin/org/settings/logo?v=${row.logoUpdatedAt?.getTime() ?? row.updatedAt.getTime()}`
      : null,
    logoUpdatedAt: row.logoUpdatedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

orgSettingsRouter.get(
  '/admin/org/settings',
  requireCapability('view:hr-admin'),
  async (_req, res) => {
    res.json(await loadResponse());
  },
);

orgSettingsRouter.patch(
  '/admin/org/settings',
  requireCapability('view:hr-admin'),
  async (req, res) => {
    const body = UpdateOrgBrandingInputSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      throw new HttpError(400, 'no_changes', 'Request body has no fields to update.');
    }
    await prisma.orgSetting.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        orgName: body.orgName ?? 'Alto HR',
        senderName: body.senderName ?? null,
        supportEmail: body.supportEmail ?? null,
        primaryColor: body.primaryColor ?? null,
      },
      update: body,
    });
    await refreshBranding(prisma);
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'org.branding_updated',
        entityType: 'OrgSetting',
        entityId: 'singleton',
        metadata: body as Prisma.InputJsonValue,
      },
      'orgSettings.patch',
    );
    res.json(await loadResponse());
  },
);

orgSettingsRouter.post(
  '/admin/org/settings/logo',
  requireCapability('view:hr-admin'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      throw new HttpError(400, 'no_file', 'A "file" multipart field is required.');
    }
    const now = new Date();
    await prisma.orgSetting.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        logoBytes: req.file.buffer,
        logoContentType: req.file.mimetype,
        logoUpdatedAt: now,
      },
      update: {
        logoBytes: req.file.buffer,
        logoContentType: req.file.mimetype,
        logoUpdatedAt: now,
      },
    });
    await refreshBranding(prisma);
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'org.logo_updated',
        entityType: 'OrgSetting',
        entityId: 'singleton',
        metadata: { contentType: req.file.mimetype, bytes: req.file.size },
      },
      'orgSettings.logo.post',
    );
    res.status(201).json(await loadResponse());
  },
);

orgSettingsRouter.delete(
  '/admin/org/settings/logo',
  requireCapability('view:hr-admin'),
  async (req, res) => {
    await prisma.orgSetting.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {
        logoBytes: null,
        logoContentType: null,
        logoUpdatedAt: null,
      },
    });
    await refreshBranding(prisma);
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'org.logo_removed',
        entityType: 'OrgSetting',
        entityId: 'singleton',
      },
      'orgSettings.logo.delete',
    );
    res.status(204).end();
  },
);

// Public-ish: any authenticated user can read the logo so it can render in
// emails-being-previewed UIs and in the in-app chrome later. We don't
// gate on view:hr-admin here because every signed-in chrome surface needs
// to render the logo.
orgSettingsRouter.get(
  '/admin/org/settings/logo',
  async (_req, res) => {
    await ensureBrandingLoaded(prisma);
    const row = await prisma.orgSetting.findUnique({
      where: { id: 'singleton' },
      select: { logoBytes: true, logoContentType: true, logoUpdatedAt: true },
    });
    if (!row?.logoBytes || !row.logoContentType) {
      throw new HttpError(404, 'no_logo', 'No org logo on file.');
    }
    res.setHeader('Content-Type', row.logoContentType);
    res.setHeader('Content-Length', String(row.logoBytes.byteLength));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(Buffer.from(row.logoBytes));
  },
);
