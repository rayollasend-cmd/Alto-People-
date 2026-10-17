import type { AccessCertificationScope, PrismaClient, Role } from '@prisma/client';
import { hasCapability, rolesWithCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { recordCriticalAudit } from './audit.js';
import { notifyUser } from './notify.js';
import { tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';

/**
 * Access pack — access certification campaigns for every tenant.
 *
 *   The quarterly access review (lib/accessReview) is the operator's own
 *   SOC 2 evidence. A customer tenant needs the same discipline over ITS
 *   accounts: a named campaign, every account in scope reviewed by the
 *   person accountable for it — the manager of the associate behind the
 *   account, else the campaign's owner — with a decision (keep, revoke,
 *   change) and a note, reminders while it is overdue, and a close that
 *   records what was decided as a critical audit row the trust center
 *   can show. The campaign never changes access by itself: a REVOKE is a
 *   finding the owner acts on in Users & access, so the certification
 *   and the change stay two separate, attributable steps.
 */

type Db = PrismaClient;

const INTERNAL_EXCLUDED: Role[] = ['ASSOCIATE', 'CLIENT_PORTAL', 'LIVE_ASN'];

function roleInScope(role: Role, scope: AccessCertificationScope): boolean {
  if (role === 'LIVE_ASN') return false;
  switch (scope) {
    case 'ALL':
      return true;
    case 'INTERNAL':
      return !INTERNAL_EXCLUDED.includes(role);
    case 'CLIENT':
      return role === 'CLIENT_PORTAL';
    case 'ASSOCIATE':
      return role === 'ASSOCIATE';
  }
}

/** The reviewer of an account: the user account of the manager of its associate, else the owner. */
async function reviewerFor(db: Db, subject: { id: string; associateId: string | null }, ownerId: string): Promise<string> {
  if (!subject.associateId) return ownerId;
  const a = await db.associate.findUnique({ where: { id: subject.associateId }, select: { manager: { select: { user: { select: { id: true, status: true, deletedAt: true } } } } } });
  const u = a?.manager?.user;
  if (u && u.status === 'ACTIVE' && !u.deletedAt && u.id !== subject.id) return u.id;
  return ownerId;
}

export async function openCertification(
  db: Db,
  input: { name: string; scope: AccessCertificationScope; dueAt: Date; createdById: string },
): Promise<{ id: string; items: number }> {
  const tenantId = tenantIdForWrite();
  const accounts = await db.user.findMany({
    where: { tenantId, deletedAt: null, status: 'ACTIVE' },
    select: { id: true, email: true, role: true, additionalRoles: true, associateId: true, clientId: true, locationId: true, regionId: true, scopeSiteIds: true, scopeRegionIds: true, breakGlass: true, lastSeenAt: true },
  });
  const inScope = accounts.filter((u) => roleInScope(u.role, input.scope));
  const cert = await db.accessCertification.create({
    data: { tenantId, name: input.name, scope: input.scope, dueAt: input.dueAt, createdById: input.createdById },
    select: { id: true },
  });
  const items = [] as Array<{ reviewerUserId: string }>;
  for (const u of inScope) {
    const reviewerUserId = await reviewerFor(db, u, input.createdById);
    items.push({ reviewerUserId });
    await db.accessCertificationItem.create({
      data: {
        tenantId,
        certificationId: cert.id,
        subjectUserId: u.id,
        reviewerUserId,
        snapshot: {
          email: u.email,
          role: u.role,
          additionalRoles: u.additionalRoles,
          clientId: u.clientId,
          locationId: u.locationId,
          regionId: u.regionId,
          scopeSiteIds: u.scopeSiteIds,
          scopeRegionIds: u.scopeRegionIds,
          breakGlass: u.breakGlass,
          lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
        },
      },
    });
  }
  await recordCriticalAudit(
    { actorUserId: input.createdById, clientId: null, tenantId, action: 'access.certification_opened', entityType: 'AccessCertification', entityId: cert.id, metadata: { name: input.name, scope: input.scope, dueAt: input.dueAt.toISOString(), items: items.length } },
    'accessCertification',
  );
  for (const reviewerId of new Set(items.map((i) => i.reviewerUserId))) {
    const n = items.filter((i) => i.reviewerUserId === reviewerId).length;
    void notifyUser(reviewerId, {
      subject: 'Access to certify',
      body: `${input.name}: ${n} account${n === 1 ? '' : 's'} to review by ${input.dueAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`,
      linkUrl: `/admin/access-certifications/${cert.id}`,
      category: 'security',
    });
  }
  return { id: cert.id, items: items.length };
}

/** Everything undecided for this person, across open campaigns. */
export function countToCertify(db: Db, reviewerUserId: string): Promise<number> {
  return db.accessCertificationItem.count({ where: { reviewerUserId, decision: null, certification: { is: { status: 'OPEN' } } } });
}

/** May this person decide items on the campaign at all? The reviewer, or anyone who runs access. */
export function canRunCertifications(role: Role): boolean {
  return hasCapability(role, 'manage:org');
}

/** Close: refuses while an item is undecided; records the tally as a critical audit row. */
export async function closeCertification(db: Db, id: string, actorUserId: string): Promise<{ keep: number; revoke: number; change: number }> {
  const cert = await db.accessCertification.findFirst({ where: { id, tenantId: tenantIdForWrite() }, include: { items: { select: { decision: true } } } });
  if (!cert) throw new Error('not_found');
  if (cert.status === 'CLOSED') throw new Error('already_closed');
  const undecided = cert.items.filter((i) => !i.decision).length;
  if (undecided > 0) throw new Error(`undecided:${undecided}`);
  const tally = {
    keep: cert.items.filter((i) => i.decision === 'KEEP').length,
    revoke: cert.items.filter((i) => i.decision === 'REVOKE').length,
    change: cert.items.filter((i) => i.decision === 'CHANGE').length,
  };
  await db.accessCertification.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: actorUserId } });
  await recordCriticalAudit(
    { actorUserId, clientId: null, tenantId: cert.tenantId, action: 'access.certification_closed', entityType: 'AccessCertification', entityId: id, metadata: { name: cert.name, ...tally, items: cert.items.length } },
    'accessCertification',
  );
  if (tally.revoke + tally.change > 0) {
    const admins = await db.user.findMany({ where: { tenantId: cert.tenantId, status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:org') } }, select: { id: true }, take: 20 });
    for (const a of admins) {
      void notifyUser(a.id, {
        subject: 'Certification closed with findings',
        body: `${cert.name}: ${tally.revoke} to revoke, ${tally.change} to change. Act on them in Users & access.`,
        linkUrl: `/admin/access-certifications/${id}`,
        category: 'security',
      });
    }
  }
  return tally;
}

/** Overdue campaigns nudge their reviewers once a day. */
export async function runCertificationReminders(db: Db = prisma, now: Date = new Date()): Promise<number> {
  const tenantId = tenantIdForWrite();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const overdue = await db.accessCertification.findMany({
    where: { tenantId, status: 'OPEN', dueAt: { lte: now }, OR: [{ lastReminderAt: null }, { lastReminderAt: { lte: dayAgo } }] },
    select: { id: true, name: true, items: { where: { decision: null }, select: { reviewerUserId: true } } },
  });
  let sent = 0;
  for (const c of overdue) {
    const by = new Map<string, number>();
    for (const i of c.items) by.set(i.reviewerUserId, (by.get(i.reviewerUserId) ?? 0) + 1);
    for (const [reviewerId, n] of by) {
      void notifyUser(reviewerId, {
        subject: 'Access certification overdue',
        body: `${c.name} is past due: ${n} account${n === 1 ? '' : 's'} still waiting on your decision.`,
        linkUrl: `/admin/access-certifications/${c.id}`,
        category: 'security',
      });
      sent += 1;
    }
    await db.accessCertification.update({ where: { id: c.id }, data: { lastReminderAt: now } });
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

/** Hourly: overdue campaigns remind their reviewers (once a day each). */
export function startCertificationReminderCron(): void {
  if (timer) return;
  const tick = () => {
    void tenantJob('accessCertificationReminders', () => runCertificationReminders())().catch((err) => {
      console.error('[alto-people/api] access certification reminders failed:', err);
    });
  };
  timer = setInterval(tick, 60 * 60_000);
  timer.unref();
}
