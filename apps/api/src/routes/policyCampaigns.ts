import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { dateColumnKey } from '../lib/timezone.js';
import { AudienceSchema, audienceSize, contentHash, launchCampaign } from '../lib/policyCampaigns.js';

/**
 * Policy campaigns (HR pack 2026-10) — see lib/policyCampaigns.
 *
 *   GET    /policy-campaigns                 the campaigns, with completion
 *   POST   /policy-campaigns                 draft one (template version + audience + due date)
 *   GET    /policy-campaigns/:id             one, with every recipient's status
 *   POST   /policy-campaigns/:id/launch      freeze the policy per person and notify them
 *   POST   /policy-campaigns/:id/close       stop reminders
 *   POST   /policy-campaigns/:id/recipients/:rid/waive
 *   POST   /policy-campaigns/audience-size   { audience } → how many people it names
 *   GET    /my/policies                      the signed-in person's policies to sign (and signed)
 *   POST   /my/policies/:rid/sign            { signature }
 */

export const policyCampaignsRouter = Router();

const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:documents');

const CreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  templateId: z.string().uuid(),
  /** Defaults to the template's current (published) version. */
  versionId: z.string().uuid().optional().nullable(),
  audience: AudienceSchema,
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reminderEveryDays: z.number().int().min(1).max(30).default(3),
});

function completion(rec: { status: string }[]) {
  const signed = rec.filter((r) => r.status === 'SIGNED').length;
  const waived = rec.filter((r) => r.status === 'WAIVED').length;
  const pending = rec.filter((r) => r.status === 'PENDING').length;
  const total = rec.length;
  return { total, signed, waived, pending, pct: total ? Math.round(((signed + waived) / total) * 100) : 0 };
}

policyCampaignsRouter.get('/policy-campaigns', VIEW, async (_req, res) => {
  const rows = await prisma.policyCampaign.findMany({
    take: 200,
    where: { tenantId: tenantIdForWrite() },
    include: { template: { select: { name: true } }, version: { select: { version: true } }, recipients: { select: { status: true } } },
    orderBy: [{ status: 'asc' }, { dueOn: 'asc' }],
  });
  res.json({
    campaigns: rows.map((c) => ({
      id: c.id,
      name: c.name,
      templateName: c.template.name,
      version: c.version.version,
      audience: c.audience,
      dueOn: dateColumnKey(c.dueOn),
      reminderEveryDays: c.reminderEveryDays,
      status: c.status,
      launchedAt: c.launchedAt?.toISOString() ?? null,
      lastReminderAt: c.lastReminderAt?.toISOString() ?? null,
      completion: completion(c.recipients),
    })),
  });
});

policyCampaignsRouter.post('/policy-campaigns/audience-size', VIEW, async (req, res) => {
  const audience = AudienceSchema.parse(req.body?.audience);
  res.json({ count: await audienceSize(audience, undefined, tenantIdForWrite()) });
});

policyCampaignsRouter.post('/policy-campaigns', MANAGE, async (req, res) => {
  const input = CreateSchema.parse(req.body);
  const template = await prisma.documentTemplate.findUnique({ where: { id: input.templateId } });
  if (!template || template.deletedAt) throw new HttpError(404, 'not_found', 'Template not found.');
  const versionId = input.versionId ?? template.currentVersionId;
  if (!versionId) throw new HttpError(400, 'no_version', 'Publish a version of the template first.');
  const version = await prisma.documentTemplateVersion.findUnique({ where: { id: versionId } });
  if (!version || version.templateId !== template.id) throw new HttpError(404, 'not_found', 'Version not found.');
  if (!version.publishedAt) throw new HttpError(400, 'unpublished', 'Only a published version can go out as a policy.');
  const created = await prisma.policyCampaign.create({
    data: {
      name: input.name,
      templateId: template.id,
      versionId,
      audience: input.audience,
      dueOn: new Date(input.dueOn),
      reminderEveryDays: input.reminderEveryDays,
      createdById: req.user!.id,
    },
  });
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'policy_campaign.created', entityType: 'PolicyCampaign', entityId: created.id, metadata: { name: input.name, audience: input.audience, dueOn: input.dueOn } },
    'policy_campaign.created',
  );
  res.status(201).json({ id: created.id });
});

policyCampaignsRouter.get('/policy-campaigns/:id', VIEW, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const c = await prisma.policyCampaign.findUnique({
    where: { id },
    include: {
      template: { select: { name: true } },
      version: { select: { version: true, body: true } },
      recipients: {
        include: { associate: { select: { id: true, firstName: true, lastName: true, email: true } } },
        orderBy: [{ status: 'asc' }, { associate: { lastName: 'asc' } }],
      },
    },
  });
  if (!c || c.tenantId !== tenantIdForWrite()) throw new HttpError(404, 'not_found', 'Campaign not found.');
  res.json({
    id: c.id,
    name: c.name,
    templateName: c.template.name,
    version: c.version.version,
    body: c.version.body,
    audience: c.audience,
    dueOn: dateColumnKey(c.dueOn),
    reminderEveryDays: c.reminderEveryDays,
    status: c.status,
    launchedAt: c.launchedAt?.toISOString() ?? null,
    lastReminderAt: c.lastReminderAt?.toISOString() ?? null,
    completion: completion(c.recipients),
    audienceSize: c.status === 'DRAFT' ? await audienceSize(AudienceSchema.parse(c.audience), undefined, tenantIdForWrite()) : c.recipients.length,
    recipients: c.recipients.map((r) => ({
      id: r.id,
      associateId: r.associateId,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
      associateEmail: r.associate.email,
      status: r.status,
      signedAt: r.signedAt?.toISOString() ?? null,
      remindedAt: r.remindedAt?.toISOString() ?? null,
      waiveReason: r.waiveReason,
    })),
  });
});

policyCampaignsRouter.post('/policy-campaigns/:id/launch', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const c = await prisma.policyCampaign.findUnique({ where: { id } });
  if (!c || c.tenantId !== tenantIdForWrite()) throw new HttpError(404, 'not_found', 'Campaign not found.');
  if (c.status === 'CLOSED') throw new HttpError(409, 'closed', 'This campaign is closed.');
  const r = await launchCampaign(id);
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'policy_campaign.launched', entityType: 'PolicyCampaign', entityId: id, metadata: { recipients: r.recipients } },
    'policy_campaign.launched',
  );
  res.json({ ok: true, recipients: r.recipients });
});

policyCampaignsRouter.post('/policy-campaigns/:id/close', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const c = await prisma.policyCampaign.findUnique({ where: { id } });
  if (!c || c.tenantId !== tenantIdForWrite()) throw new HttpError(404, 'not_found', 'Campaign not found.');
  await prisma.policyCampaign.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'policy_campaign.closed', entityType: 'PolicyCampaign', entityId: id, metadata: {} }, 'policy_campaign.closed');
  res.json({ ok: true });
});

policyCampaignsRouter.post('/policy-campaigns/:id/recipients/:rid/waive', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const rid = z.string().uuid().parse(req.params.rid);
  const reason = z.string().trim().min(2).max(500).parse(req.body?.reason);
  const r = await prisma.policyCampaignRecipient.findUnique({ where: { id: rid } });
  if (!r || r.campaignId !== id) throw new HttpError(404, 'not_found', 'Recipient not found.');
  if (r.status !== 'PENDING') throw new HttpError(409, 'not_pending', `Already ${r.status.toLowerCase()}.`);
  await prisma.policyCampaignRecipient.update({ where: { id: rid }, data: { status: 'WAIVED', waivedById: req.user!.id, waiveReason: reason } });
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'policy_campaign.recipient_waived', entityType: 'PolicyCampaignRecipient', entityId: rid, metadata: { campaignId: id, associateId: r.associateId, reason } },
    'policy_campaign.recipient_waived',
  );
  res.json({ ok: true });
});

// ----- The person's side ------------------------------------------------------

policyCampaignsRouter.get('/my/policies', requireAuth, async (req, res) => {
  if (!req.user!.associateId) return res.json({ policies: [] });
  const rows = await prisma.policyCampaignRecipient.findMany({
    where: { associateId: req.user!.associateId, campaign: { status: { not: 'DRAFT' } } },
    include: { campaign: { select: { id: true, name: true, dueOn: true, status: true } } },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 200,
  });
  res.json({
    policies: rows.map((r) => ({
      id: r.id,
      campaignId: r.campaign.id,
      name: r.campaign.name,
      dueOn: dateColumnKey(r.campaign.dueOn),
      status: r.status,
      body: r.renderedBody,
      signedAt: r.signedAt?.toISOString() ?? null,
      signature: r.signature,
      contentSha256: r.contentSha256,
    })),
  });
});

policyCampaignsRouter.post('/my/policies/:rid/sign', requireAuth, async (req, res) => {
  const rid = z.string().uuid().parse(req.params.rid);
  const signature = z.string().trim().min(2).max(200).parse(req.body?.signature);
  const r = await prisma.policyCampaignRecipient.findUnique({ where: { id: rid }, include: { campaign: { select: { status: true, name: true } } } });
  if (!r || r.associateId !== req.user!.associateId) throw new HttpError(404, 'not_found', 'Policy not found.');
  if (r.status !== 'PENDING') throw new HttpError(409, 'not_pending', 'This policy is already signed.');
  if (r.campaign.status === 'DRAFT') throw new HttpError(409, 'not_launched', 'This policy has not been sent yet.');
  const signedAt = new Date();
  await prisma.policyCampaignRecipient.update({
    where: { id: rid },
    data: {
      status: 'SIGNED',
      signature,
      signedAt,
      signerIp: req.ip ?? null,
      signerUserAgent: (req.headers['user-agent'] ?? null) as string | null,
      contentSha256: contentHash(r.renderedBody, signature, signedAt),
    },
  });
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'policy_campaign.signed', entityType: 'PolicyCampaignRecipient', entityId: rid, metadata: { campaignId: r.campaignId, name: r.campaign.name } },
    'policy_campaign.signed',
  );
  res.json({ ok: true, signedAt: signedAt.toISOString() });
});
