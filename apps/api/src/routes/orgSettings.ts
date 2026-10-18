import { Router } from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import {
  ASSISTANT_PLATFORM_NAME,
  ORG_LOGO_ALLOWED_TYPES,
  ORG_LOGO_MAX_BYTES,
  UpdateOrgBrandingInputSchema,
  type OrgBranding,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit, recordCriticalAudit } from '../lib/audit.js';
import {
  ensureBrandingLoaded,
  orgSettingIdFor,
  refreshBranding,
} from '../lib/branding.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Org branding (Phase: settings audit row #8), one row per tenant. The
 * row is read and written by the tenant in context (the session's);
 * Alto HR's row keeps the historical id 'singleton', another tenant's
 * takes an id derived from its tenant id. The PATCH path bumps that
 * tenant's cached snapshot so subsequent emails and replies render with
 * the new branding immediately rather than waiting for the 5-minute
 * refresh tick. The logo lives in the DB as a BYTEA so it survives without
 * a Volume mount and is served by the same API host that the SPA hits —
 * no CDN needed.
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

/** The row's identity for a create: the tenant in context and its OrgSetting id. */
function rowFor(tenantId: string): { id: string; tenantId: string } {
  return { id: orgSettingIdFor(tenantId), tenantId };
}

async function loadResponse(tenantId: string): Promise<OrgBranding> {
  // Always read from DB so the response reflects committed state, not the
  // cache (the cache is for the email-render path).
  const row = await prisma.orgSetting.findUnique({ where: { tenantId } });
  if (!row) {
    // No row yet: the defaults, under the tenant's own name (the cache resolves it).
    const defaults = await ensureBrandingLoaded(prisma, tenantId);
    return {
      orgName: defaults.orgName,
      assistantName: ASSISTANT_PLATFORM_NAME,
      activeWindowDays: 14,
      weekStartsOn: 6,
      timezone: 'America/New_York',
      senderName: null,
      supportEmail: null,
      primaryColor: null,
      logoUrl: null,
      logoUpdatedAt: null,
      mfaRequirement: 'OFF',
      financeMailbox: null,
      unverifiedPayoutPolicy: 'PREVIOUS_VERIFIED',
      payChangeApprovalPct: 10,
      payChangeAlwaysApprove: false,
      billRateApproval: true,
      separationSecondPerson: true,
      selfServiceApproval: false,
      roleChangeApproval: true,
      requisitionApproval: true,
      payrollReviewRequired: true,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    orgName: row.orgName,
    assistantName: row.assistantName,
    activeWindowDays: row.activeWindowDays,
    weekStartsOn: row.weekStartsOn,
    timezone: row.timezone,
    senderName: row.senderName,
    supportEmail: row.supportEmail,
    primaryColor: row.primaryColor,
    logoUrl: row.logoBytes
      ? `/admin/org/settings/logo?v=${row.logoUpdatedAt?.getTime() ?? row.updatedAt.getTime()}`
      : null,
    logoUpdatedAt: row.logoUpdatedAt?.toISOString() ?? null,
    mfaRequirement: row.mfaRequirement,
    financeMailbox: row.financeMailbox,
    unverifiedPayoutPolicy: row.unverifiedPayoutPolicy,
    payChangeApprovalPct: row.payChangeApprovalPct,
    payChangeAlwaysApprove: row.payChangeAlwaysApprove,
    billRateApproval: row.billRateApproval,
    separationSecondPerson: row.separationSecondPerson,
    selfServiceApproval: row.selfServiceApproval,
    roleChangeApproval: row.roleChangeApproval,
    requisitionApproval: row.requisitionApproval,
    payrollReviewRequired: row.payrollReviewRequired,
    updatedAt: row.updatedAt.toISOString(),
  };
}

orgSettingsRouter.get(
  '/admin/org/settings',
  requireCapability('view:hr-admin'),
  async (_req, res) => {
    res.json(await loadResponse(tenantIdForWrite()));
  },
);

orgSettingsRouter.patch(
  '/admin/org/settings',
  // manage:org, NOT view:hr-admin — the read-only EXECUTIVE_CHAIRMAN
  // holds view:hr-admin; branding writes must stay admin-only.
  requireCapability('manage:org'),
  async (req, res) => {
    const body = UpdateOrgBrandingInputSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      throw new HttpError(400, 'no_changes', 'Request body has no fields to update.');
    }
    const tenantId = tenantIdForWrite();
    const row = rowFor(tenantId);
    await prisma.orgSetting.upsert({
      where: { tenantId },
      create: {
        ...row,
        // A first write under the tenant's own name (the cache resolves it from the Tenant row).
        orgName: body.orgName ?? (await ensureBrandingLoaded(prisma, tenantId)).orgName,
        assistantName: body.assistantName ?? ASSISTANT_PLATFORM_NAME,
        activeWindowDays: body.activeWindowDays ?? 14,
        weekStartsOn: body.weekStartsOn ?? 6,
        timezone: body.timezone ?? 'America/New_York',
        senderName: body.senderName ?? null,
        supportEmail: body.supportEmail ?? null,
        primaryColor: body.primaryColor ?? null,
        // Org-enforced MFA policy — defaults OFF when not supplied.
        mfaRequirement: body.mfaRequirement ?? 'OFF',
        financeMailbox: body.financeMailbox ?? null,
        unverifiedPayoutPolicy: body.unverifiedPayoutPolicy ?? 'PREVIOUS_VERIFIED',
      },
      update: body,
    });
    await refreshBranding(prisma, tenantId);
    // Flipping the org MFA requirement is a security-posture change that
    // affects who can sign in — record it synchronously (critical) and
    // under its own action so the audit feed distinguishes it from
    // cosmetic branding edits.
    if (body.mfaRequirement !== undefined) {
      await recordCriticalAudit(
        {
          actorUserId: req.user!.id,
          action: 'org.mfa_requirement_updated',
          entityType: 'OrgSetting',
          entityId: row.id,
          metadata: {
            ip: req.ip ?? null,
            userAgent: req.headers['user-agent'] ?? null,
            mfaRequirement: body.mfaRequirement,
          },
        },
        'orgSettings.patch.mfaRequirement',
      );
    }
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'org.branding_updated',
        entityType: 'OrgSetting',
        entityId: row.id,
        metadata: body as Prisma.InputJsonValue,
      },
      'orgSettings.patch',
    );
    res.json(await loadResponse(tenantId));
  },
);

orgSettingsRouter.post(
  '/admin/org/settings/logo',
  // manage:org — write; see PATCH above.
  requireCapability('manage:org'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      throw new HttpError(400, 'no_file', 'A "file" multipart field is required.');
    }
    const now = new Date();
    const tenantId = tenantIdForWrite();
    const row = rowFor(tenantId);
    await prisma.orgSetting.upsert({
      where: { tenantId },
      create: {
        ...row,
        logoBytes: Buffer.from(req.file.buffer),
        logoContentType: req.file.mimetype,
        logoUpdatedAt: now,
      },
      update: {
        logoBytes: Buffer.from(req.file.buffer),
        logoContentType: req.file.mimetype,
        logoUpdatedAt: now,
      },
    });
    await refreshBranding(prisma, tenantId);
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'org.logo_updated',
        entityType: 'OrgSetting',
        entityId: row.id,
        metadata: { contentType: req.file.mimetype, bytes: req.file.size },
      },
      'orgSettings.logo.post',
    );
    res.status(201).json(await loadResponse(tenantId));
  },
);

orgSettingsRouter.delete(
  '/admin/org/settings/logo',
  // manage:org — write; see PATCH above.
  requireCapability('manage:org'),
  async (req, res) => {
    const tenantId = tenantIdForWrite();
    const row = rowFor(tenantId);
    await prisma.orgSetting.upsert({
      where: { tenantId },
      create: { ...row },
      update: {
        logoBytes: null,
        logoContentType: null,
        logoUpdatedAt: null,
      },
    });
    await refreshBranding(prisma, tenantId);
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'org.logo_removed',
        entityType: 'OrgSetting',
        entityId: row.id,
      },
      'orgSettings.logo.delete',
    );
    res.status(204).end();
  },
);

// Intentionally public — no auth middleware. The logo URL is embedded
// in outbound transactional emails (invite, welcome, password reset)
// where the recipient may not have a session yet, so requiring auth
// would break email rendering. A logo is by nature a public brand
// asset; if you ever need to keep it private, surface it via a signed
// short-lived URL instead of gating this endpoint. With no session the
// tenant in context is Alto HR (tenantMiddleware's default).
orgSettingsRouter.get(
  '/admin/org/settings/logo',
  async (_req, res) => {
    const tenantId = tenantIdForWrite();
    await ensureBrandingLoaded(prisma, tenantId);
    const row = await prisma.orgSetting.findUnique({
      where: { tenantId },
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
