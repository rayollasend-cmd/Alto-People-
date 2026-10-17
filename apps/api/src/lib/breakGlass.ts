import type { Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { rolesWithCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { recordCriticalAudit } from './audit.js';
import { getBrandingSync } from './branding.js';
import { send } from './notifications.js';
import { notifyUser, trackNotificationWork } from './notify.js';
import { loadSecurityPolicy } from './securityPolicy.js';
import { ALTO_TENANT_ID } from './tenant.js';

/**
 * Access pack — break-glass.
 *
 *   "SSO required" used to exempt only associates, so an identity-provider
 *   outage locked out every administrator and every client account. A
 *   tenant now names a few break-glass owners (Users & access, with an
 *   approver). While SSO is required they may still sign in with their
 *   password AND a two-step code — never a password alone — and every such
 *   sign-in is a critical audit row, an email to the security contact and
 *   a bell for the tenant's org admins. The policy can close the path.
 */

export type BreakGlassVerdict = 'not_needed' | 'allowed' | 'needs_mfa' | 'closed';

/** May this account take the break-glass path right now? `ssoRequired` is the tenant's rule for the role. */
export async function breakGlassVerdict(
  user: { breakGlass: boolean; mfaEnabledAt: Date | null; tenantId: string | null },
  ssoRequired: boolean,
  db: PrismaClient = prisma,
): Promise<BreakGlassVerdict> {
  if (!ssoRequired) return 'not_needed';
  if (!user.breakGlass) return 'closed';
  const policy = await loadSecurityPolicy(user.tenantId, db);
  if (!policy.breakGlassEnabled) return 'closed';
  return user.mfaEnabledAt ? 'allowed' : 'needs_mfa';
}

/** The break-glass sign-in completed: record it where it cannot be missed. */
export async function recordBreakGlassUse(
  req: Request,
  user: { id: string; email: string; tenantId: string | null; clientId: string | null },
  db: PrismaClient = prisma,
): Promise<void> {
  const tenantId = user.tenantId ?? ALTO_TENANT_ID;
  await recordCriticalAudit(
    {
      actorUserId: user.id,
      clientId: user.clientId,
      tenantId,
      action: 'auth.break_glass_used',
      entityType: 'User',
      entityId: user.id,
      metadata: { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null },
    },
    'breakGlass',
  );
  const brand = getBrandingSync(tenantId);
  const when = new Date().toISOString();
  const summary = `${user.email} signed in through the break-glass path (password + two-step while company sign-in is required) at ${when} from ${req.ip ?? 'an unknown address'}.`;
  const setting = await db.orgSetting.findFirst({ where: { tenantId }, select: { securityContactEmail: true } });
  if (setting?.securityContactEmail) {
    void trackNotificationWork(
      send({
        channel: 'EMAIL',
        recipient: { userId: null, phone: null, email: setting.securityContactEmail },
        subject: `${brand.orgName}: break-glass sign-in`,
        body: `${summary}\n\nIf this was not expected, disable the account in Users & access and review the audit log.`,
        category: 'security_alert',
      }).then(() => true, () => false),
    );
  }
  const admins = await db.user.findMany({
    where: { tenantId, status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:org') }, id: { not: user.id } },
    select: { id: true },
    take: 20,
  });
  for (const a of admins) {
    void notifyUser(a.id, { subject: 'Break-glass sign-in', body: summary, linkUrl: '/audit', category: 'security_alert' });
  }
}
