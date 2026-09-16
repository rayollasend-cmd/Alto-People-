import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { generateInviteToken } from './inviteToken.js';
import { send } from './notifications.js';
import { enqueueAudit } from './audit.js';
import { marketManagerInviteTemplate, storeManagerInviteTemplate, type EmailTemplate } from './emailTemplates.js';

/**
 * Onboarding a portal account — a store manager or a market manager.
 *
 * Both are CLIENT_PORTAL logins, but they are onboarded differently: the
 * store manager gets their store site, the market manager gets the
 * command center for every store in their market. Neither is an
 * associate, so there is no paperwork, no start date, no position —
 * the invite is addressed by name only and opens the right site.
 *
 *   store  → clientId (+ locationId)          storeManagerInviteTemplate
 *   market → regionId, or a client-wide login  marketManagerInviteTemplate
 */

export type PortalInviteScope =
  | {
      kind: 'store';
      clientId: string;
      clientName: string;
      /** null = the whole client — a market manager over one client. */
      location: { id: string; name: string } | null;
      storeCount: number;
    }
  | { kind: 'region'; regionId: string; regionName: string; storeCount: number };

export const PORTAL_INVITE_CATEGORY = 'portal.invite';

/** What we call the person: the name given, else the front of the email. */
export function portalDisplayName(name: string | null | undefined, email: string): string {
  const n = name?.trim();
  return n && n.length > 0 ? n : (email.split('@')[0] ?? 'there');
}

export function portalInviteTemplate(opts: {
  name: string;
  scope: PortalInviteScope;
  magicLink: string;
  linkExpiresAt: string;
}): { kind: 'store' | 'market'; template: EmailTemplate } {
  const { scope } = opts;
  if (scope.kind === 'store' && scope.location) {
    return {
      kind: 'store',
      template: storeManagerInviteTemplate({
        name: opts.name,
        storeName: scope.location.name,
        clientName: scope.clientName,
        magicLink: opts.magicLink,
        linkExpiresAt: opts.linkExpiresAt,
      }),
    };
  }
  return {
    kind: 'market',
    template: marketManagerInviteTemplate({
      name: opts.name,
      regionName: scope.kind === 'region' ? scope.regionName : scope.clientName,
      storeCount: scope.storeCount,
      magicLink: opts.magicLink,
      linkExpiresAt: opts.linkExpiresAt,
    }),
  };
}

/** The scope a portal account was invited into, read back off the user
 *  row — for the reminder sweep, which re-sends the same kind of note. */
export async function portalScopeForUser(user: {
  clientId: string | null;
  locationId: string | null;
  regionId: string | null;
}): Promise<PortalInviteScope | null> {
  if (user.regionId) {
    const region = await prisma.region.findFirst({ where: { id: user.regionId, deletedAt: null }, select: { id: true, name: true } });
    if (!region) return null;
    const storeCount = await prisma.location.count({ where: { regionId: region.id, deletedAt: null, isActive: true } });
    return { kind: 'region', regionId: region.id, regionName: region.name, storeCount };
  }
  if (user.clientId) {
    const client = await prisma.client.findFirst({ where: { id: user.clientId, deletedAt: null }, select: { id: true, name: true } });
    if (!client) return null;
    const location = user.locationId
      ? await prisma.location.findFirst({ where: { id: user.locationId, deletedAt: null }, select: { id: true, name: true } })
      : null;
    const storeCount = await prisma.location.count({ where: { clientId: client.id, deletedAt: null, isActive: true } });
    return { kind: 'store', clientId: client.id, clientName: client.name, location, storeCount };
  }
  return null;
}

export interface PortalInviteResult {
  user: { id: string; email: string; status: string };
  expiresAt: Date;
  emailFailed: string | null;
  template: 'store' | 'market';
}

/**
 * Create (or re-invite) the account, mint a single-use magic link, and
 * mail the right note. Throws HttpError on the conflicts the caller
 * should surface (409 email in use / already active).
 */
export async function invitePortalAccount(input: {
  email: string;
  name?: string | null;
  scope: PortalInviteScope;
  actorUserId: string;
}): Promise<PortalInviteResult> {
  const email = input.email.trim().toLowerCase();
  const { scope } = input;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && existing.deletedAt === null && existing.role !== 'CLIENT_PORTAL') {
    throw new HttpError(409, 'email_in_use', 'That email already belongs to an Alto account.');
  }
  if (existing && existing.deletedAt === null && scope.kind === 'store' && existing.clientId && existing.clientId !== scope.clientId) {
    throw new HttpError(409, 'email_in_use', 'That email already has a portal login for another client.');
  }
  if (existing && existing.deletedAt === null && scope.kind === 'region' && existing.regionId && existing.regionId !== scope.regionId) {
    throw new HttpError(409, 'email_in_use', 'That email already has a command center for another region.');
  }
  if (existing && existing.status === 'ACTIVE' && existing.passwordHash) {
    throw new HttpError(
      409,
      'already_active',
      scope.kind === 'region' ? 'That market manager already has an active login.' : 'That store manager already has an active login.',
    );
  }

  const invite = generateInviteToken();
  const expiresAt = new Date(Date.now() + env.INVITE_TOKEN_TTL_SECONDS * 1000);
  const bind =
    scope.kind === 'store'
      ? { clientId: scope.clientId, locationId: scope.location?.id ?? null, regionId: null }
      : { clientId: null, locationId: null, regionId: scope.regionId };
  const user = await prisma.$transaction(async (tx) => {
    const u = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: { role: 'CLIENT_PORTAL', status: 'INVITED', ...bind, deletedAt: null, tokenVersion: { increment: 1 } },
        })
      : await tx.user.create({ data: { email, role: 'CLIENT_PORTAL', status: 'INVITED', ...bind } });
    await tx.inviteToken.updateMany({ where: { userId: u.id, consumedAt: null }, data: { consumedAt: new Date() } });
    await tx.inviteToken.create({ data: { tokenHash: invite.hash, userId: u.id, expiresAt } });
    return u;
  });
  invalidateUserCache(user.id);

  const magicLink = `${env.APP_BASE_URL}/accept-invite/${invite.raw}`;
  const { kind, template } = portalInviteTemplate({
    name: portalDisplayName(input.name, email),
    scope,
    magicLink,
    linkExpiresAt: expiresAt.toISOString().slice(0, 10),
  });
  let emailFailed: string | null = null;
  let externalRef: string | null = null;
  try {
    const r = await send({
      channel: 'EMAIL',
      recipient: { userId: user.id, phone: null, email },
      subject: template.subject,
      body: template.text,
      html: template.html,
    });
    externalRef = r.externalRef;
  } catch (err) {
    emailFailed = err instanceof Error ? err.message : String(err);
  }
  // The note is on the record — HR can see what was sent and resend it.
  await prisma.notification.create({
    data: {
      channel: 'EMAIL',
      status: emailFailed ? 'FAILED' : 'SENT',
      recipientUserId: user.id,
      recipientEmail: email,
      subject: template.subject,
      body: template.text,
      category: PORTAL_INVITE_CATEGORY,
      externalRef,
      failureReason: emailFailed,
      sentAt: emailFailed ? null : new Date(),
      senderUserId: input.actorUserId,
    },
  });

  enqueueAudit(
    {
      actorUserId: input.actorUserId,
      clientId: scope.kind === 'store' ? scope.clientId : null,
      action: scope.kind === 'store' ? 'client.portal_user_invited' : 'region.portal_user_invited',
      entityType: 'User',
      entityId: user.id,
      metadata: {
        email,
        template: kind,
        locationId: scope.kind === 'store' ? (scope.location?.id ?? null) : null,
        regionId: scope.kind === 'region' ? scope.regionId : null,
        emailFailed,
      },
    },
    'portalInvite.invitePortalAccount',
  );

  return { user: { id: user.id, email: user.email, status: user.status }, expiresAt, emailFailed, template: kind };
}
