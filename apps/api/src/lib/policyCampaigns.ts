import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma as defaultPrisma } from '../db.js';
import { EMPLOYED_WHERE } from './activeDefinition.js';
import { ASSOCIATE_CTX_SELECT, renderTemplateTokens, toAssociateCtx } from './offerLetters.js';
import { tenantJob } from './tenantJobs.js';
import { env } from '../config/env.js';
import { fmtDay } from './humanDates.js';
import { dateColumnKey } from './timezone.js';

/**
 * Policy campaigns (HR pack 2026-10).
 *
 *   One policy — a published template version — goes to an audience at
 *   once: everyone, a department, a client's people, a site's people, or
 *   the holders of a role. Each person gets the policy rendered for them,
 *   frozen at launch, and signs it with a typed name; the signature line
 *   carries the IP, the user agent, the time and a SHA-256 of what they
 *   signed. Reminders go out on the campaign's cadence until the person
 *   signs or HR waives them. The agreement the person signs is this row:
 *   nothing is issued one by one.
 */

export const AudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ALL') }),
  z.object({ kind: z.literal('DEPARTMENT'), ids: z.array(z.string().uuid()).min(1).max(50) }),
  z.object({ kind: z.literal('CLIENT'), ids: z.array(z.string().uuid()).min(1).max(50) }),
  z.object({ kind: z.literal('SITE'), ids: z.array(z.string().uuid()).min(1).max(100) }),
  z.object({ kind: z.literal('ROLE'), roles: z.array(z.string().min(1)).min(1).max(20) }),
]);
export type Audience = z.infer<typeof AudienceSchema>;

/** The employed people an audience names, in one tenant — the recipients a launch creates. */
export function audienceWhere(audience: Audience, tenantId: string | null = null): Prisma.AssociateWhereInput {
  return { AND: [tenantId ? { tenantId } : {}, audienceOf(audience)] };
}

function audienceOf(audience: Audience): Prisma.AssociateWhereInput {
  switch (audience.kind) {
    case 'ALL':
      return { ...EMPLOYED_WHERE };
    case 'DEPARTMENT':
      return { ...EMPLOYED_WHERE, departmentId: { in: audience.ids } };
    case 'CLIENT':
      return { ...EMPLOYED_WHERE, applications: { some: { deletedAt: null, status: 'APPROVED', clientId: { in: audience.ids } } } };
    case 'SITE':
      return { ...EMPLOYED_WHERE, assignments: { some: { endedAt: null, locationId: { in: audience.ids } } } };
    case 'ROLE':
      return { ...EMPLOYED_WHERE, user: { is: { deletedAt: null, status: 'ACTIVE', role: { in: audience.roles as never[] } } } };
  }
}

export async function audienceSize(audience: Audience, db: PrismaClient = defaultPrisma, tenantId: string | null = null): Promise<number> {
  return db.associate.count({ where: audienceWhere(audience, tenantId) });
}

/** The signature line's hash: what was shown + who signed + when, so a changed body can be proven. */
export function contentHash(renderedBody: string, signature: string, signedAt: Date): string {
  return createHash('sha256').update(`${renderedBody}\n--\n${signature}\n${signedAt.toISOString()}`).digest('hex');
}

/** Launch: freeze the policy per person and tell each of them. Idempotent per (campaign, person). */
export async function launchCampaign(campaignId: string, db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<{ recipients: number }> {
  const campaign = await db.policyCampaign.findUnique({ where: { id: campaignId }, include: { version: true } });
  if (!campaign) throw new Error('campaign not found');
  const audience = AudienceSchema.parse(campaign.audience);
  // Everyone the audience names in the campaign's own tenant, in pages —
  // the launch used to stop at 5,000 while the audience count had no cap.
  const where = audienceWhere(audience, campaign.tenantId ?? null);
  const people: Array<Prisma.AssociateGetPayload<{ select: typeof ASSOCIATE_CTX_SELECT }>> = [];
  let created = 0;
  for (let cursor: string | undefined; ; ) {
    const page = await db.associate.findMany({
      where,
      select: ASSOCIATE_CTX_SELECT,
      orderBy: { id: 'asc' },
      take: 2000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const rows: Prisma.PolicyCampaignRecipientCreateManyInput[] = page.map((a) => ({
      campaignId,
      associateId: a.id,
      renderedBody: renderTemplateTokens(campaign.version.body, { associate: toAssociateCtx(a), campaign: { name: campaign.name, dueOn: dateColumnKey(campaign.dueOn) } }).text,
    }));
    if (rows.length) created += (await db.policyCampaignRecipient.createMany({ data: rows, skipDuplicates: true })).count;
    people.push(...page);
    if (page.length < 2000) break;
    cursor = page[page.length - 1]!.id;
  }
  await db.policyCampaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE', launchedAt: campaign.launchedAt ?? now } });
  const { notifyAssociate } = await import('./notify.js');
  for (const a of people) {
    void notifyAssociate(a.id, {
      subject: `Please read and sign: ${campaign.name}`,
      body: `${campaign.name} needs your signature by ${fmtDay(campaign.dueOn)}. Open Agreements to read and sign it.`,
      category: 'agreements',
      linkUrl: '/agreements?tab=policies',
      emailFallback: true,
    });
  }
  return { recipients: created };
}

/** Remind everyone still pending on an active campaign whose cadence has come round. */
export async function remindCampaigns(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<{ reminded: number }> {
  const campaigns = await db.policyCampaign.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true, dueOn: true, reminderEveryDays: true } });
  const { notifyAssociate } = await import('./notify.js');
  let reminded = 0;
  for (const c of campaigns) {
    const cutoff = new Date(now.getTime() - c.reminderEveryDays * 86_400_000);
    const pending = await db.policyCampaignRecipient.findMany({
      where: { campaignId: c.id, status: 'PENDING', OR: [{ remindedAt: null, createdAt: { lt: cutoff } }, { remindedAt: { lt: cutoff } }] },
      select: { id: true, associateId: true },
      take: 1000,
    });
    if (pending.length === 0) continue;
    await db.policyCampaignRecipient.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { remindedAt: now } });
    await db.policyCampaign.update({ where: { id: c.id }, data: { lastReminderAt: now } });
    const overdue = c.dueOn.getTime() < now.getTime();
    for (const p of pending) {
      void notifyAssociate(p.associateId, {
        subject: overdue ? `Overdue: sign ${c.name}` : `Reminder: sign ${c.name}`,
        body: `${c.name} is still waiting for your signature${overdue ? ` — it was due ${fmtDay(c.dueOn)}` : ` (due ${fmtDay(c.dueOn)})`}. Open Agreements to read and sign it.`,
        category: 'agreements',
        linkUrl: '/agreements?tab=policies',
        emailFallback: true,
      });
      reminded += 1;
    }
  }
  return { reminded };
}

let timer: NodeJS.Timeout | null = null;

export function startPolicyCampaignCron(): void {
  if (timer) return;
  const seconds = env.DOCUMENT_MAINTENANCE_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void tenantJob('policyCampaignReminders', () => remindCampaigns())().catch((err) => {
      console.error('[alto-people/api] policy campaign reminders failed:', err);
    });
  };
  tick();
  timer = setInterval(tick, Math.max(seconds, 3600) * 1000);
  timer.unref();
}

export function stopPolicyCampaignCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
