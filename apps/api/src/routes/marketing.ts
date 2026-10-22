import { Router } from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { can, rolesWithCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireAuth, requireCapability } from '../middleware/auth.js';
import { careersViewIpLimiter } from '../middleware/rateLimit.js';
import { enqueueAudit } from '../lib/audit.js';
import { getBlobStore, tenantBlobKey } from '../lib/blobStore.js';
import { computeMarketingOverview, proposeReferralBonus } from '../lib/marketing.js';
import { sourceKey } from '../lib/recruitingAnalytics.js';
import { scopePayrollRuns } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';
import { notifyUser } from '../lib/notify.js';
import { aggregateAndPersistRun } from './payroll.js';

/**
 * Marketing: the careers site's funnel, the employer brand page, referral
 * campaigns and the source-of-hire numbers — and the public half the
 * careers site reads (the brand, its photos, the view beacon).
 *
 * Reads self-gate on view:marketing, writes on manage:marketing. The one
 * write that moves money — approving a referral bonus onto a payroll run —
 * is Finance's (process:payroll).
 */

export const marketingRouter = Router();

const VIEW = requireCapability('view:marketing');
const MANAGE = requireCapability('manage:marketing');
const FINANCE = requireCapability('process:payroll');

const T = () => ({ tenantId: tenantIdForWrite() });
const BRAND_ID = 'singleton';

function audit(req: Parameters<typeof requireAuth>[0], action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
  enqueueAudit(
    { actorUserId: req.user?.id ?? null, action: `marketing.${action}`, entityType, entityId, metadata: metadata as Prisma.InputJsonValue, tenantId: tenantIdForWrite() },
    `marketing.${action}`,
  );
}

/* ===== Public: the careers site reads these ================================ */

const PHOTO_URL = (id: string) => `/api/careers/brand/photos/${id}`;

async function loadBrand() {
  const row = await prisma.employerBrand.findFirst({
    where: T(),
    include: { photos: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
  });
  return {
    headline: row?.headline ?? null,
    intro: row?.intro ?? null,
    values: (row?.values as Array<{ title: string; body: string }> | undefined) ?? [],
    perks: (row?.perks as string[] | undefined) ?? [],
    ctaText: row?.ctaText ?? null,
    photos: (row?.photos ?? []).map((p) => ({ id: p.id, alt: p.alt, url: PHOTO_URL(p.id) })),
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

marketingRouter.get('/careers/brand', async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300').json(await loadBrand());
});

marketingRouter.get('/careers/brand/photos/:id', async (req, res) => {
  const p = await prisma.employerBrandPhoto.findFirst({ where: { id: req.params.id } });
  if (!p) throw new HttpError(404, 'not_found', 'Not found.');
  const stream = await getBlobStore().getStream(p.s3Key);
  if (!stream) throw new HttpError(404, 'not_found', 'Not found.');
  res.setHeader('Content-Type', p.contentType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  stream.pipe(res);
});

const ViewSchema = z.object({
  slug: z.string().max(200).optional().nullable(),
  source: z.string().max(120).optional().nullable(),
});

/** One more view of the list page or a posting, by the source the link carried. */
marketingRouter.post('/careers/view', careersViewIpLimiter, async (req, res) => {
  const input = ViewSchema.safeParse(req.body ?? {});
  if (!input.success) {
    res.status(204).end();
    return;
  }
  const slug = (input.data.slug ?? '').trim().slice(0, 200);
  const source = sourceKey(input.data.source ?? null) ?? '';
  const today = new Date();
  const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  await prisma.careersPageView.upsert({
    where: { slug_source_day: { slug, source, day } },
    create: { slug, source, day, count: 1 },
    update: { count: { increment: 1 } },
  });
  res.status(204).end();
});

/* ===== Overview + source of hire =========================================== */

function range(q: Record<string, unknown>): { from: Date; to: Date } {
  const parse = (v: unknown): Date | null => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const to = parse(q.to) ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const from = parse(q.from) ?? new Date(to.getTime() - 90 * 86_400_000);
  if (from > to) throw new HttpError(400, 'bad_range', 'from must not be after to.');
  // `to` is inclusive on the wire; exclusive here.
  return { from, to: new Date(to.getTime() + 86_400_000) };
}

marketingRouter.get('/marketing/overview', requireAuth, VIEW, async (req, res) => {
  res.json(await computeMarketingOverview(range(req.query as Record<string, unknown>)));
});

/* ===== Employer brand ====================================================== */

const BrandSchema = z.object({
  headline: z.string().trim().max(160).nullable().optional(),
  intro: z.string().trim().max(2000).nullable().optional(),
  values: z.array(z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().max(400) })).max(8).optional(),
  perks: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  ctaText: z.string().trim().max(80).nullable().optional(),
});

marketingRouter.get('/marketing/brand', requireAuth, VIEW, async (_req, res) => {
  res.json(await loadBrand());
});

marketingRouter.put('/marketing/brand', requireAuth, MANAGE, async (req, res) => {
  const input = BrandSchema.parse(req.body);
  const data = {
    ...(input.headline !== undefined ? { headline: input.headline || null } : {}),
    ...(input.intro !== undefined ? { intro: input.intro || null } : {}),
    ...(input.values !== undefined ? { values: input.values as Prisma.InputJsonValue } : {}),
    ...(input.perks !== undefined ? { perks: input.perks as Prisma.InputJsonValue } : {}),
    ...(input.ctaText !== undefined ? { ctaText: input.ctaText || null } : {}),
    updatedById: req.user!.id,
  };
  const existing = await prisma.employerBrand.findFirst({ where: T(), select: { id: true } });
  if (existing) await prisma.employerBrand.update({ where: { id: existing.id }, data });
  else await prisma.employerBrand.create({ data: { id: BRAND_ID, ...data } });
  audit(req, 'brand_updated', 'EmployerBrand', existing?.id ?? BRAND_ID, { fields: Object.keys(input) });
  res.json(await loadBrand());
});

const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!PHOTO_MIMES.has(file.mimetype)) {
      cb(new HttpError(400, 'invalid_mime', 'Upload a JPEG, PNG or WebP photo.'));
      return;
    }
    cb(null, true);
  },
});

marketingRouter.post('/marketing/brand/photos', requireAuth, MANAGE, photoUpload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'no_file', 'Attach a photo.');
  const magic = verifyFileMagic(file.buffer, file.mimetype);
  if (magic) throw new HttpError(400, 'invalid_file', magic);
  const alt = z.string().trim().min(1).max(200).parse(req.body?.alt ?? 'Working here');
  let brand = await prisma.employerBrand.findFirst({ where: T(), select: { id: true } });
  if (!brand) brand = await prisma.employerBrand.create({ data: { id: BRAND_ID }, select: { id: true } });
  const count = await prisma.employerBrandPhoto.count({ where: { brandId: brand.id } });
  if (count >= 8) throw new HttpError(409, 'too_many', 'Eight photos is the most the page shows. Remove one first.');
  const key = tenantBlobKey(`employer-brand/${Date.now()}-${sanitizeUploadFilename(file.originalname)}`);
  await getBlobStore().put(key, file.buffer, file.mimetype);
  const photo = await prisma.employerBrandPhoto.create({
    data: { brandId: brand.id, s3Key: key, contentType: file.mimetype, alt, sortOrder: count },
  });
  audit(req, 'brand_photo_added', 'EmployerBrandPhoto', photo.id, { alt });
  res.status(201).json({ id: photo.id, alt: photo.alt, url: PHOTO_URL(photo.id) });
});

marketingRouter.patch('/marketing/brand/photos/:id', requireAuth, MANAGE, async (req, res) => {
  const input = z.object({ alt: z.string().trim().min(1).max(200).optional(), sortOrder: z.number().int().min(0).max(100).optional() }).parse(req.body);
  const p = await prisma.employerBrandPhoto.findFirst({ where: { id: req.params.id, ...T() } });
  if (!p) throw new HttpError(404, 'not_found', 'Photo not found.');
  const u = await prisma.employerBrandPhoto.update({ where: { id: p.id }, data: input });
  res.json({ id: u.id, alt: u.alt, url: PHOTO_URL(u.id) });
});

marketingRouter.delete('/marketing/brand/photos/:id', requireAuth, MANAGE, async (req, res) => {
  const p = await prisma.employerBrandPhoto.findFirst({ where: { id: req.params.id, ...T() } });
  if (!p) throw new HttpError(404, 'not_found', 'Photo not found.');
  await prisma.employerBrandPhoto.delete({ where: { id: p.id } });
  await getBlobStore().delete(p.s3Key).catch(() => undefined);
  audit(req, 'brand_photo_removed', 'EmployerBrandPhoto', p.id);
  res.status(204).end();
});

/* ===== Referral campaigns ================================================== */

const CampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  bonusAmount: z.number().positive().max(100_000),
  currency: z.string().length(3).optional(),
  payAfterDays: z.number().int().min(0).max(365).optional(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  positions: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
});

function campaignOut(c: {
  id: string;
  name: string;
  description: string | null;
  bonusAmount: Prisma.Decimal;
  currency: string;
  payAfterDays: number;
  startsOn: Date;
  endsOn: Date | null;
  positions: string[];
  status: string;
  createdAt: Date;
  _count?: { referrals: number; payouts: number };
}) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    bonusAmount: Number(c.bonusAmount),
    currency: c.currency,
    payAfterDays: c.payAfterDays,
    startsOn: c.startsOn.toISOString().slice(0, 10),
    endsOn: c.endsOn ? c.endsOn.toISOString().slice(0, 10) : null,
    positions: c.positions,
    status: c.status as 'DRAFT' | 'ACTIVE' | 'CLOSED',
    referrals: c._count?.referrals ?? 0,
    payouts: c._count?.payouts ?? 0,
    createdAt: c.createdAt.toISOString(),
  };
}

const CAMPAIGN_INCLUDE = { _count: { select: { referrals: true, payouts: true } } } as const;

/** Anyone signed in may read the campaigns that are on — the referral form offers them. */
marketingRouter.get('/marketing/campaigns', requireAuth, async (req, res) => {
  const all = can(req.user!, 'view:marketing');
  const rows = await prisma.referralCampaign.findMany({
    where: { ...T(), ...(all ? {} : { status: 'ACTIVE' }) },
    orderBy: [{ status: 'asc' }, { startsOn: 'desc' }],
    include: CAMPAIGN_INCLUDE,
    take: 100,
  });
  res.json({ campaigns: rows.map(campaignOut) });
});

marketingRouter.post('/marketing/campaigns', requireAuth, MANAGE, async (req, res) => {
  const input = CampaignSchema.parse(req.body);
  const row = await prisma.referralCampaign.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      bonusAmount: input.bonusAmount,
      currency: input.currency ?? 'USD',
      payAfterDays: input.payAfterDays ?? 30,
      startsOn: new Date(`${input.startsOn}T00:00:00Z`),
      endsOn: input.endsOn ? new Date(`${input.endsOn}T00:00:00Z`) : null,
      positions: input.positions ?? [],
      createdById: req.user!.id,
    },
    include: CAMPAIGN_INCLUDE,
  });
  audit(req, 'campaign_created', 'ReferralCampaign', row.id, { name: row.name, bonusAmount: input.bonusAmount });
  res.status(201).json(campaignOut(row));
});

marketingRouter.patch('/marketing/campaigns/:id', requireAuth, MANAGE, async (req, res) => {
  const input = CampaignSchema.partial().parse(req.body);
  const existing = await prisma.referralCampaign.findFirst({ where: { id: req.params.id, ...T() } });
  if (!existing) throw new HttpError(404, 'not_found', 'Campaign not found.');
  if (existing.status === 'CLOSED') throw new HttpError(409, 'closed', 'A closed campaign cannot be edited.');
  const row = await prisma.referralCampaign.update({
    where: { id: existing.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.bonusAmount !== undefined ? { bonusAmount: input.bonusAmount } : {}),
      ...(input.payAfterDays !== undefined ? { payAfterDays: input.payAfterDays } : {}),
      ...(input.startsOn !== undefined ? { startsOn: new Date(`${input.startsOn}T00:00:00Z`) } : {}),
      ...(input.endsOn !== undefined ? { endsOn: input.endsOn ? new Date(`${input.endsOn}T00:00:00Z`) : null } : {}),
      ...(input.positions !== undefined ? { positions: input.positions } : {}),
    },
    include: CAMPAIGN_INCLUDE,
  });
  audit(req, 'campaign_updated', 'ReferralCampaign', row.id, { fields: Object.keys(input) });
  res.json(campaignOut(row));
});

marketingRouter.post('/marketing/campaigns/:id/status', requireAuth, MANAGE, async (req, res) => {
  const status = z.enum(['ACTIVE', 'CLOSED']).parse(req.body?.status);
  const existing = await prisma.referralCampaign.findFirst({ where: { id: req.params.id, ...T() } });
  if (!existing) throw new HttpError(404, 'not_found', 'Campaign not found.');
  const row = await prisma.referralCampaign.update({ where: { id: existing.id }, data: { status }, include: CAMPAIGN_INCLUDE });
  audit(req, status === 'ACTIVE' ? 'campaign_activated' : 'campaign_closed', 'ReferralCampaign', row.id);
  res.json(campaignOut(row));
});

/**
 * "Announce it": write the campaign up as a broadcast DRAFT for HR to send.
 * Marketing holds no send permission and gains none here — the draft lands
 * in HR's Broadcasts list, and everyone who can send broadcasts is told one
 * is waiting. HR edits, targets and sends it (or doesn't).
 */
marketingRouter.post('/marketing/campaigns/:id/announce', requireAuth, MANAGE, async (req, res) => {
  const input = z
    .object({ title: z.string().trim().min(1).max(250).optional(), body: z.string().trim().min(1).max(4000).optional() })
    .parse(req.body ?? {});
  const c = await prisma.referralCampaign.findFirst({ where: { id: req.params.id, ...T() } });
  if (!c) throw new HttpError(404, 'not_found', 'Campaign not found.');
  if (c.status === 'CLOSED') throw new HttpError(409, 'closed', 'A closed campaign can’t be announced.');
  const out = campaignOut(c);
  const money = `$${out.bonusAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const until = out.endsOn ? new Date(`${out.endsOn}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : null;
  const roles = out.positions.length ? out.positions.join(', ') : 'any open role';
  const title = input.title ?? `Refer a friend — ${money} bonus`;
  const body =
    input.body ??
    [
      `Know someone who'd be great for ${roles}? Refer them${until ? ` by ${until}` : ''} and earn ${money} once they've worked ${out.payAfterDays} days.`,
      c.description ?? '',
      'Send their name and phone number to HR or your supervisor and say who referred them.',
    ]
      .filter(Boolean)
      .join('\n\n');
  const draft = await prisma.broadcast.create({
    data: { title, body, channels: ['IN_APP'], status: 'DRAFT', createdById: req.user!.id },
  });
  audit(req, 'campaign_announce_drafted', 'ReferralCampaign', c.id, { broadcastId: draft.id });

  // Tell the people who can send it. Fire-and-forget: the draft exists either way.
  const senders = await prisma.user.findMany({
    where: { ...T(), deletedAt: null, status: 'ACTIVE', role: { in: rolesWithCapability('manage:communications') }, id: { not: req.user!.id } },
    select: { id: true },
    take: 50,
  });
  for (const u of senders) {
    void notifyUser(u.id, {
      subject: `Announcement to review: ${c.name}`,
      body: `Marketing drafted an announcement for the ${c.name} referral campaign. Review the wording and the audience, then send it.`,
      category: 'broadcast.review',
      linkUrl: `/directory?tab=broadcasts&broadcast=${draft.id}`,
    }).catch(() => undefined);
  }
  res.status(201).json({ broadcastId: draft.id, notified: senders.length });
});

/** The referrals made, with where each referred person got to and the bonus's state. */
marketingRouter.get('/marketing/referrals', requireAuth, VIEW, async (req, res) => {
  const campaignId = z.string().uuid().optional().parse(req.query.campaignId);
  const rows = await prisma.referral.findMany({
    where: { ...T(), ...(campaignId ? { campaignId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 300,
    include: {
      referrer: { select: { id: true, email: true, associateId: true, associate: { select: { firstName: true, lastName: true } } } },
      candidate: { select: { id: true, stage: true, hiredAt: true } },
      campaign: { select: { id: true, name: true, bonusAmount: true, payAfterDays: true } },
      bonusPayout: { select: { id: true, status: true, amount: true, decidedAt: true, payrollRunId: true } },
    },
  });
  const now = Date.now();
  res.json({
    referrals: rows.map((r) => {
      const hiredAt = r.candidate?.hiredAt ?? null;
      const waitDays = r.campaign?.payAfterDays ?? 0;
      const hired = r.status === 'HIRED' || r.candidate?.stage === 'HIRED';
      const eligibleOn = hired && hiredAt ? new Date(hiredAt.getTime() + waitDays * 86_400_000) : null;
      return {
        id: r.id,
        referrerName: r.referrer.associate ? `${r.referrer.associate.firstName} ${r.referrer.associate.lastName}` : r.referrer.email,
        referrerHasPayroll: !!r.referrer.associateId,
        candidateId: r.candidateId,
        candidateName: r.candidateName,
        position: r.position,
        status: r.status,
        candidateStage: r.candidate?.stage ?? null,
        hiredAt: hiredAt?.toISOString() ?? null,
        campaign: r.campaign ? { id: r.campaign.id, name: r.campaign.name, bonusAmount: Number(r.campaign.bonusAmount) } : null,
        bonusAmount: r.campaign ? Number(r.campaign.bonusAmount) : r.bonusAmount ? Number(r.bonusAmount) : null,
        eligibleOn: eligibleOn?.toISOString() ?? null,
        eligible: !!eligibleOn && eligibleOn.getTime() <= now,
        payout: r.bonusPayout
          ? { id: r.bonusPayout.id, status: r.bonusPayout.status, amount: Number(r.bonusPayout.amount), decidedAt: r.bonusPayout.decidedAt?.toISOString() ?? null, attached: !!r.bonusPayout.payrollRunId }
          : null,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  });
});

marketingRouter.post('/marketing/referrals/:id/propose-bonus', requireAuth, MANAGE, async (req, res) => {
  const r = await prisma.referral.findFirst({ where: { id: req.params.id, ...T() }, select: { id: true } });
  if (!r) throw new HttpError(404, 'not_found', 'Referral not found.');
  const force = z.boolean().optional().parse(req.body?.force) ?? false;
  const out = await proposeReferralBonus(r.id, req.user!.id, { force });
  if (!out.ok) {
    const why: Record<typeof out.reason, string> = {
      not_hired: 'The referred person has not been hired.',
      no_associate: 'The referrer has no payroll record to pay the bonus to.',
      no_bonus: 'No bonus amount is set on the referral or its campaign.',
      too_soon: 'The campaign’s waiting period has not passed yet.',
    };
    throw new HttpError(409, out.reason, why[out.reason]);
  }
  audit(req, 'bonus_proposed', 'ReferralBonusPayout', out.payoutId, { referralId: r.id, created: out.created });
  res.status(out.created ? 201 : 200).json({ payoutId: out.payoutId, created: out.created });
});

/* ===== Bonus payouts (Finance decides) ===================================== */

const payoutInclude = {
  referral: { select: { candidateName: true, referrer: { select: { email: true } } } },
  associate: { select: { firstName: true, lastName: true } },
  campaign: { select: { name: true } },
  decidedBy: { select: { email: true } },
} as const;

function payoutOut(p: Prisma.ReferralBonusPayoutGetPayload<{ include: typeof payoutInclude }>) {
  return {
    id: p.id,
    status: p.status as 'PROPOSED' | 'APPROVED' | 'DECLINED',
    amount: Number(p.amount),
    currency: p.currency,
    referrerName: `${p.associate.firstName} ${p.associate.lastName}`,
    referrerEmail: p.referral.referrer.email,
    candidateName: p.referral.candidateName,
    campaignName: p.campaign?.name ?? null,
    note: p.note,
    decisionNote: p.decisionNote,
    decidedBy: p.decidedBy?.email ?? null,
    decidedAt: p.decidedAt?.toISOString() ?? null,
    payrollRunId: p.payrollRunId,
    createdAt: p.createdAt.toISOString(),
  };
}

marketingRouter.get('/marketing/bonus-payouts', requireAuth, requireAnyCapability('view:marketing', 'process:payroll'), async (req, res) => {
  const status = z.enum(['PROPOSED', 'APPROVED', 'DECLINED']).optional().parse(req.query.status);
  const rows = await prisma.referralBonusPayout.findMany({
    where: { ...T(), ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    include: payoutInclude,
    take: 300,
  });
  // The DRAFT runs a Finance approver can put the line on.
  const runs = can(req.user!, 'process:payroll')
    ? await prisma.payrollRun.findMany({
        where: { ...scopePayrollRuns(req.user!), status: 'DRAFT' },
        orderBy: { periodEnd: 'desc' },
        select: { id: true, periodStart: true, periodEnd: true, kind: true, clientId: true },
        take: 10,
      })
    : [];
  res.json({
    payouts: rows.map(payoutOut),
    draftRuns: runs.map((r) => ({ id: r.id, periodStart: r.periodStart.toISOString().slice(0, 10), periodEnd: r.periodEnd.toISOString().slice(0, 10), kind: r.kind })),
  });
});

const DecideSchema = z.object({
  decision: z.enum(['APPROVE', 'DECLINE']),
  note: z.string().trim().max(500).nullable().optional(),
  /** Approve AND attach: the DRAFT run the bonus line goes on. */
  payrollRunId: z.string().uuid().nullable().optional(),
});

marketingRouter.post('/marketing/bonus-payouts/:id/decide', requireAuth, FINANCE, async (req, res) => {
  const input = DecideSchema.parse(req.body);
  const p = await prisma.referralBonusPayout.findFirst({ where: { id: req.params.id, ...T() }, include: payoutInclude });
  if (!p) throw new HttpError(404, 'not_found', 'Payout not found.');
  if (p.status === 'DECLINED' || p.payrollRunId) {
    throw new HttpError(409, 'decided', 'This bonus has already been decided.');
  }
  if (input.decision === 'DECLINE') {
    const u = await prisma.referralBonusPayout.update({
      where: { id: p.id },
      data: { status: 'DECLINED', decidedById: req.user!.id, decidedAt: new Date(), decisionNote: input.note ?? null },
      include: payoutInclude,
    });
    audit(req, 'bonus_declined', 'ReferralBonusPayout', p.id, { note: input.note ?? null });
    if (p.proposedById) {
      void notifyUser(p.proposedById, {
        subject: `Referral bonus declined: ${p.referral.candidateName}`,
        body: input.note ?? 'Finance declined the bonus.',
        category: 'payroll',
        linkUrl: '/marketing?tab=referrals',
      });
    }
    res.json(payoutOut(u));
    return;
  }
  let runId: string | null = null;
  let addOnId: string | null = null;
  if (input.payrollRunId) {
    const run = await prisma.payrollRun.findFirst({ where: { id: input.payrollRunId, ...scopePayrollRuns(req.user!) } });
    if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found.');
    if (run.status !== 'DRAFT') throw new HttpError(409, 'run_not_draft', 'Only a draft run can take a new line.');
    const addOn = await prisma.payrollRunAddOn.create({
      data: {
        payrollRunId: run.id,
        associateId: p.associateId,
        kind: 'BONUS',
        amount: p.amount,
        note: `Referral bonus — ${p.referral.candidateName}${p.campaign ? ` (${p.campaign.name})` : ''}`,
        createdById: req.user!.id,
      },
    });
    await prisma.$transaction((tx) => aggregateAndPersistRun(tx, run, 15), { timeout: 60_000, maxWait: 10_000 });
    runId = run.id;
    addOnId = addOn.id;
  }
  const u = await prisma.referralBonusPayout.update({
    where: { id: p.id },
    data: {
      status: 'APPROVED',
      decidedById: req.user!.id,
      decidedAt: new Date(),
      decisionNote: input.note ?? null,
      payrollRunId: runId,
      payrollRunAddOnId: addOnId,
    },
    include: payoutInclude,
  });
  if (runId) await prisma.referral.update({ where: { id: p.referralId }, data: { bonusPaidAt: new Date() } });
  audit(req, 'bonus_approved', 'ReferralBonusPayout', p.id, { payrollRunId: runId, addOnId, amount: Number(p.amount) });
  res.json(payoutOut(u));
});

/** Attach an approved-but-unattached bonus to a draft run that exists now. */
marketingRouter.post('/marketing/bonus-payouts/:id/attach', requireAuth, FINANCE, async (req, res) => {
  const payrollRunId = z.string().uuid().parse(req.body?.payrollRunId);
  const p = await prisma.referralBonusPayout.findFirst({ where: { id: req.params.id, ...T() }, include: payoutInclude });
  if (!p) throw new HttpError(404, 'not_found', 'Payout not found.');
  if (p.status !== 'APPROVED' || p.payrollRunId) throw new HttpError(409, 'not_attachable', 'Only an approved, unattached bonus can be attached.');
  const run = await prisma.payrollRun.findFirst({ where: { id: payrollRunId, ...scopePayrollRuns(req.user!) } });
  if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found.');
  if (run.status !== 'DRAFT') throw new HttpError(409, 'run_not_draft', 'Only a draft run can take a new line.');
  const addOn = await prisma.payrollRunAddOn.create({
    data: {
      payrollRunId: run.id,
      associateId: p.associateId,
      kind: 'BONUS',
      amount: p.amount,
      note: `Referral bonus — ${p.referral.candidateName}${p.campaign ? ` (${p.campaign.name})` : ''}`,
      createdById: req.user!.id,
    },
  });
  await prisma.$transaction((tx) => aggregateAndPersistRun(tx, run, 15), { timeout: 60_000, maxWait: 10_000 });
  const u = await prisma.referralBonusPayout.update({
    where: { id: p.id },
    data: { payrollRunId: run.id, payrollRunAddOnId: addOn.id },
    include: payoutInclude,
  });
  await prisma.referral.update({ where: { id: p.referralId }, data: { bonusPaidAt: new Date() } });
  audit(req, 'bonus_attached', 'ReferralBonusPayout', p.id, { payrollRunId: run.id, addOnId: addOn.id });
  res.json(payoutOut(u));
});
