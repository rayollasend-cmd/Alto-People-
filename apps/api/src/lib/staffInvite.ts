import { ROLE_CAPABILITIES, ROLE_LABELS, capabilitiesOf, type Role } from '@alto-people/shared';
import type { ApprovalRequest, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { generateInviteToken } from './inviteToken.js';
import { send } from './notifications.js';
import { enqueueAudit } from './audit.js';
import { genericNotificationTemplate } from './emailTemplates.js';
import { publicBaseUrl } from './emailLayout.js';
import { getBrandingSync } from './branding.js';
import { tenantIdForWrite } from './tenant.js';
import { assertRoleOffered, tenantOf, type Actor } from './tenantRoles.js';
import { loadApprovalPolicy, secondPersonExists } from './approvalPolicy.js';
import { createApprovalRequest } from './approvalRequests.js';
import { isElevation } from './accessChanges.js';

/**
 * Users & access → "Invite user": an account for someone on staff who is
 * not hired through Onboarding (an outside accountant, an IT admin, a
 * supervisor whose employment record lives elsewhere). Associates are
 * invited by Onboarding, with their paperwork; client logins by the
 * client's portal invite (lib/portalInvite). This is the third door.
 *
 * The link is the same single-use invite token every other invite uses
 * (/accept-invite/:token, where the person sets a password).
 *
 * A new account with a staff role is access granted from nothing, so it
 * answers to the same rule as a role elevation (Settings › Approval rules,
 * "Granting more access"): where a second administrator exists, the invite
 * is HELD — the account is created disabled and inert (role Associate, no
 * link) and a ROLE_CHANGE approval carries the role and `invite: true`.
 * Approving it gives the role and sends the link (lib/approvalApply);
 * rejecting it removes the held account.
 */

export const STAFF_INVITE_CATEGORY = 'staff.invite';

/** Roles invited elsewhere: associates by Onboarding, client logins by the client's page, LIVE_ASN never. */
export const NOT_INVITED_HERE: readonly Role[] = ['ASSOCIATE', 'CLIENT_PORTAL', 'LIVE_ASN'];

/** Roles that only work pinned to one client (mirrors routes/users CLIENT_SCOPED_ROLES). */
const CLIENT_SCOPED: readonly Role[] = ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'];

type Db = PrismaClient;

export interface StaffInviteInput {
  email: string;
  name?: string | null;
  role: Role;
  clientId?: string | null;
  actor: Actor & { id: string };
}

export interface StaffInviteResult {
  user: { id: string; email: string; status: string; role: Role };
  /** Set when the invite waits for a second administrator. */
  pending: ApprovalRequest | null;
  emailFailed: string | null;
  expiresAt: string | null;
}

/** Mint a fresh link for an invited staff account and email it. Old unused links stop working. */
export async function sendStaffInvite(
  db: Db,
  userId: string,
  actorUserId: string | null,
): Promise<{ emailFailed: string | null; expiresAt: Date }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, role: true, displayName: true } });
  const invite = generateInviteToken();
  const expiresAt = new Date(Date.now() + env.INVITE_TOKEN_TTL_SECONDS * 1000);
  await db.$transaction([
    db.inviteToken.updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: new Date() } }),
    db.inviteToken.create({ data: { tokenHash: invite.hash, userId, expiresAt } }),
  ]);
  const org = getBrandingSync().orgName;
  const name = user.displayName?.trim() || user.email.split('@')[0] || 'there';
  const template = genericNotificationTemplate({
    subject: `Your ${org} account is ready`,
    body: `${name}, ${org} has given you an account as ${ROLE_LABELS[user.role as Role]}.\n\nOpen the link to set your password. It works once and expires on ${expiresAt.toISOString().slice(0, 10)}; do not forward it.`,
    linkUrl: `${publicBaseUrl()}/accept-invite/${invite.raw}`,
    linkLabel: 'Set my password',
  });
  let emailFailed: string | null = null;
  let externalRef: string | null = null;
  try {
    const r = await send({
      channel: 'EMAIL',
      audit: false,
      recipient: { userId, phone: null, email: user.email },
      subject: template.subject,
      body: template.text,
      html: template.html,
    });
    externalRef = r.externalRef;
  } catch (err) {
    emailFailed = err instanceof Error ? err.message : String(err);
  }
  await db.notification.create({
    data: {
      channel: 'EMAIL',
      status: emailFailed ? 'FAILED' : 'SENT',
      recipientUserId: userId,
      recipientEmail: user.email,
      subject: template.subject,
      body: template.text,
      category: STAFF_INVITE_CATEGORY,
      externalRef,
      failureReason: emailFailed,
      sentAt: emailFailed ? null : new Date(),
      senderUserId: actorUserId,
    },
  });
  return { emailFailed, expiresAt };
}

export async function inviteStaffAccount(input: StaffInviteInput, db: Db = defaultPrisma): Promise<StaffInviteResult> {
  const email = input.email.trim().toLowerCase();
  const { role, actor } = input;
  if (NOT_INVITED_HERE.includes(role)) {
    throw new HttpError(
      400,
      'role_invited_elsewhere',
      role === 'ASSOCIATE'
        ? 'Associates are invited from Onboarding, which sends their paperwork with the invite.'
        : role === 'CLIENT_PORTAL'
          ? 'Client logins are invited for a client and store.'
          : `${role} is reserved for system integrations.`,
    );
  }
  // The same no-escalation rule as a role change: never grant more than you hold.
  const callerCaps = capabilitiesOf(actor);
  const escalating = [...ROLE_CAPABILITIES[role]].filter((c) => !callerCaps.has(c));
  if (escalating.length > 0) {
    throw new HttpError(403, 'role_escalation_forbidden', `You cannot grant ${ROLE_LABELS[role]}: it holds capabilities you don't have (${escalating.join(', ')}).`);
  }
  await assertRoleOffered(role, tenantOf(actor));

  const tenantId = tenantIdForWrite();
  const clientId = input.clientId ?? null;
  if (CLIENT_SCOPED.includes(role) && !clientId) {
    throw new HttpError(400, 'client_required', `${ROLE_LABELS[role]} works at one client: pick it.`);
  }
  if (clientId) {
    const client = await db.client.findFirst({ where: { id: clientId, tenantId, deletedAt: null }, select: { id: true } });
    if (!client) throw new HttpError(400, 'client_not_found', 'That client does not exist.');
  }

  const existing = await db.user.findUnique({ where: { email }, select: { id: true, deletedAt: true } });
  if (existing?.deletedAt) {
    throw new HttpError(409, 'email_belongs_to_removed_user', 'This email belongs to a removed account. Use a different email, or ask Alto support to restore it.');
  }
  if (existing) {
    throw new HttpError(409, 'email_in_use', 'That email already has an account. Find it in the list to change its role.');
  }

  const displayName = input.name?.trim() || null;
  const policy = await loadApprovalPolicy(db);
  const needsSecond =
    isElevation({ role: 'ASSOCIATE', additionalRoles: [] }, { role }) &&
    policy.roleChangeApproval &&
    (await secondPersonExists(db, 'manage:org', actor.id));

  if (needsSecond) {
    const held = await db.user.create({
      data: { tenantId, email, role: 'ASSOCIATE', status: 'DISABLED', displayName, clientId },
      select: { id: true, email: true, status: true },
    });
    const pending = await createApprovalRequest(db, {
      kind: 'ROLE_CHANGE',
      subjectType: 'User',
      subjectId: held.id,
      title: `Invite ${displayName ?? email} as ${ROLE_LABELS[role]}`,
      summary: 'A new account with this role. The invite email goes out when it is approved; rejecting it removes the account.',
      proposed: { userId: held.id, role, invite: true },
      before: null,
      requesterUserId: actor.id,
      approver: { capability: 'manage:org' },
      clientId,
    });
    enqueueAudit(
      { actorUserId: actor.id, clientId, action: 'user.invite_held', entityType: 'User', entityId: held.id, metadata: { email, role, approvalRequestId: pending.id } },
      'staffInvite.inviteStaffAccount',
    );
    return { user: { ...held, role: 'ASSOCIATE' }, pending, emailFailed: null, expiresAt: null };
  }

  const user = await db.user.create({
    data: { tenantId, email, role, status: 'INVITED', displayName, clientId },
    select: { id: true, email: true, status: true, role: true },
  });
  invalidateUserCache(user.id);
  const { emailFailed, expiresAt } = await sendStaffInvite(db, user.id, actor.id);
  enqueueAudit(
    { actorUserId: actor.id, clientId, action: 'user.invited', entityType: 'User', entityId: user.id, metadata: { email, role, emailFailed } },
    'staffInvite.inviteStaffAccount',
  );
  return { user: { ...user, role: user.role as Role }, pending: null, emailFailed, expiresAt: expiresAt.toISOString() };
}

/** The held invite was approved: the role landed (applyRoleChange); open the account and send the link. */
export async function releaseHeldInvite(db: Db, userId: string, deciderId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { status: 'INVITED' } });
  invalidateUserCache(userId);
  await sendStaffInvite(db, userId, deciderId);
}

/** The held invite was rejected: the account never existed for anyone, so it goes. */
export async function dropHeldInvite(db: Db, userId: string): Promise<void> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { status: true, passwordHash: true } });
  if (!u || u.status !== 'DISABLED' || u.passwordHash) return;
  try {
    await db.user.delete({ where: { id: userId } });
  } catch {
    // Something already points at it: leave it disabled (it can never sign in).
  }
  invalidateUserCache(userId);
}
