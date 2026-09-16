import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { notifyUser } from './notify.js';
import { associatesOfClient } from './scope.js';
import { orgDateKey, utcInstantOfLocalMidnight } from './timeAnomalies.js';

/**
 * Portal readiness — the setup the store site depends on, with guardrails.
 *
 * The hero's "6 / 8" needs a contracted headcount per store, the Lead
 * tag needs a position flagged as lead, the Call button needs a phone
 * on the supervisor's associate record, and the faces need photos. None
 * of that is enforced at data entry, so this computes the checklist for
 * the Clients page and rings the Workforce desk the moment a portal
 * account is provisioned for a store that isn't ready.
 */

export interface PortalReadiness {
  accounts: number;
  stores: Array<{ id: string; name: string; hasTarget: boolean; portalAccounts: number }>;
  leadPositions: number;
  supervisors: Array<{ name: string; hasPhone: boolean }>;
  photos: { withPhoto: number; total: number; pct: number | null };
  supportEmail: string | null;
  mfa: { policy: string; coversPortal: boolean };
  /** Human sentences for anything not ready — empty means ready. */
  gaps: string[];
}

export async function computePortalReadiness(
  clientId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<PortalReadiness> {
  const [stores, accounts, leadPositions, supervisors, associates, org] = await Promise.all([
    prisma.location.findMany({
      where: { clientId, deletedAt: null, isActive: true },
      select: {
        id: true,
        name: true,
        staffingTargets: { select: { id: true }, take: 1 },
        portalUsers: { where: { role: 'CLIENT_PORTAL', deletedAt: null }, select: { id: true } },
      },
      orderBy: { name: 'asc' },
      take: 200,
    }),
    prisma.user.count({ where: { clientId, role: 'CLIENT_PORTAL', deletedAt: null } }),
    prisma.shiftPosition.count({ where: { clientId, isLead: true, deletedAt: null } }),
    prisma.user.findMany({
      where: {
        clientId,
        status: 'ACTIVE',
        deletedAt: null,
        role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] },
      },
      select: { email: true, associate: { select: { firstName: true, lastName: true, phone: true } } },
      take: 50,
    }),
    prisma.associate.findMany({
      where: { ...associatesOfClient(clientId), deletedAt: null },
      select: { photoS3Key: true },
      take: 5000,
    }),
    prisma.orgSetting.findUnique({
      where: { id: 'singleton' },
      select: { supportEmail: true, mfaRequirement: true },
    }),
  ]);

  const withPhoto = associates.filter((a) => a.photoS3Key).length;
  const gaps: string[] = [];
  const storeRows = stores.map((s) => ({
    id: s.id,
    name: s.name,
    hasTarget: s.staffingTargets.length > 0,
    portalAccounts: s.portalUsers.length,
  }));
  for (const s of storeRows) {
    if (!s.hasTarget) gaps.push(`${s.name} has no contracted headcount — the portal can't show "staffed vs contracted".`);
  }
  if (leadPositions === 0) gaps.push('No position is flagged as a lead — the portal can\'t mark who leads a wave.');
  if (supervisors.length === 0) {
    gaps.push('No supervisor account is bound to this client — the "Your Alto lead" card will be empty.');
  }
  for (const u of supervisors) {
    if (!u.associate?.phone) {
      const name = u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email;
      gaps.push(`${name} has no phone on file — the store can't call them from the portal.`);
    }
  }
  if (associates.length > 0 && withPhoto / associates.length < 0.8) {
    gaps.push(`${associates.length - withPhoto} of ${associates.length} associates have no profile photo.`);
  }
  if (!org?.supportEmail) gaps.push('No support email is set in Organization — the escalation line will be blank.');
  const policy = org?.mfaRequirement ?? 'OFF';
  return {
    accounts,
    stores: storeRows,
    leadPositions,
    supervisors: supervisors.map((u) => ({
      name: u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email,
      hasPhone: !!u.associate?.phone,
    })),
    photos: {
      withPhoto,
      total: associates.length,
      pct: associates.length > 0 ? Math.round((withPhoto / associates.length) * 100) : null,
    },
    supportEmail: org?.supportEmail ?? null,
    mfa: { policy, coversPortal: policy === 'ALL' },
    gaps,
  };
}

/**
 * Ring the Workforce desk once per client per org-day when a portal
 * account is provisioned for a store that isn't ready. Fire-and-forget;
 * callers don't await the bell.
 */
export async function nudgePortalReadiness(
  clientId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const readiness = await computePortalReadiness(clientId, prisma);
  if (readiness.gaps.length === 0) return false;
  const linkUrl = `/clients/${clientId}?section=portal`;
  const dayStart = utcInstantOfLocalMidnight(orgDateKey(new Date()), 'America/New_York');
  const already = await prisma.notification.findFirst({
    where: { category: 'portal.readiness', linkUrl, createdAt: { gte: dayStart } },
    select: { id: true },
  });
  if (already) return false;
  const [client, desk] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { name: true } }),
    prisma.user.findMany({
      where: { status: 'ACTIVE', deletedAt: null, role: { in: ['WORKFORCE_MANAGER', 'OPERATIONS_MANAGER'] } },
      select: { id: true },
      take: 50,
    }),
  ]);
  const lines = readiness.gaps.slice(0, 6).map((g) => `  • ${g}`);
  await Promise.all(
    desk.map((u) =>
      notifyUser(
        u.id,
        {
          subject: `${client?.name ?? 'A client'}'s portal isn't ready`,
          body: `A store manager account was just set up, and the portal will show dashes until this is fixed:\n\n${lines.join('\n')}\n\nThe checklist is on the client page.`,
          category: 'portal.readiness',
          linkUrl,
        },
        prisma,
      ),
    ),
  );
  return true;
}
