import type { Prisma, PrismaClient, Role } from '@prisma/client';
import { ROLE_CAPABILITIES, ROLE_LABELS, type Role as SharedRole } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { enqueueAudit, recordCriticalAudit } from './audit.js';
import { notifyUser } from './notify.js';
import { tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { fmtMomentInZone } from './humanDates.js';

/**
 * Access changes the approval engine applies, and temporary elevation.
 *
 * applyRoleChange is the one write for "this account's role is now X": it
 * sets the role (and the extra hats), kills live sessions and lands a
 * critical audit row — used by the admin route when no second person is
 * needed and by the engine when one approved it.
 *
 * An AccessGrant is a role given UNTIL a date: it rides as an additional
 * role (the person switches into it), and the sweep takes it back when it
 * expires, killing sessions, so elevated access never outlives its reason.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface RoleChange {
  role?: Role;
  additionalRoles?: Role[];
}

/**
 * Does granting `next` give the account capabilities it does not hold today?
 * What every associate holds (their own pay, time, documents) never counts:
 * moving someone to ASSOCIATE is a demotion, not an elevation.
 */
export function isElevation(current: { role: Role; additionalRoles: Role[] }, next: RoleChange): boolean {
  const held = new Set<string>(ROLE_CAPABILITIES.ASSOCIATE);
  for (const r of [current.role, ...current.additionalRoles]) for (const c of ROLE_CAPABILITIES[r as SharedRole]) held.add(c);
  const wanted = [next.role, ...(next.additionalRoles ?? [])].filter((r): r is Role => !!r);
  for (const r of wanted) for (const c of ROLE_CAPABILITIES[r as SharedRole]) if (!held.has(c)) return true;
  return false;
}

export async function applyRoleChange(db: Db, userId: string, change: RoleChange, actorUserId: string | null, meta: Record<string, unknown> = {}): Promise<void> {
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, additionalRoles: true, activeRole: true, clientId: true, deletedAt: true } });
  if (!target || target.deletedAt) throw new HttpError(404, 'not_found', 'User not found.');
  const nextPrimary = change.role ?? target.role;
  const nextAdditional = [...new Set(change.additionalRoles ?? target.additionalRoles)].filter((r) => r !== nextPrimary);
  const activeStillGranted = !target.activeRole || target.activeRole === nextPrimary || nextAdditional.includes(target.activeRole);
  await db.user.update({
    where: { id: userId },
    data: {
      role: nextPrimary,
      ...(change.role && change.role !== target.role ? { tenantRoleId: null } : {}),
      additionalRoles: nextAdditional,
      ...(activeStillGranted ? {} : { activeRole: null }),
      tokenVersion: { increment: 1 },
    },
  });
  if (nextPrimary !== 'SHIFT_SUPERVISOR' && nextPrimary !== 'FLOOR_SUPERVISOR' && change.role && change.role !== target.role) {
    await db.supervisorShiftWindow.deleteMany({ where: { userId } });
    await db.user.update({ where: { id: userId }, data: { leadUserId: null } });
    await db.user.updateMany({ where: { leadUserId: userId }, data: { leadUserId: null } });
  }
  invalidateUserCache(userId);
  await recordCriticalAudit(
    {
      actorUserId,
      clientId: target.clientId ?? null,
      action: 'admin.user_updated',
      entityType: 'User',
      entityId: userId,
      metadata: {
        ...meta,
        changes: {
          ...(change.role && change.role !== target.role ? { role: { from: target.role, to: change.role } } : {}),
          ...(change.additionalRoles ? { additionalRoles: { from: target.additionalRoles, to: nextAdditional } } : {}),
          ...(!activeStillGranted && target.activeRole ? { activeRole: { from: target.activeRole, to: null } } : {}),
        },
      },
    },
    'accessChanges.applyRoleChange',
  );
}

export const MAX_GRANT_DAYS = 30;

export interface GrantInput {
  userId: string;
  role: Role;
  until: Date;
  reason: string;
}

/** Give a role until a date. It rides as an additional hat; the sweep reverts it. */
export async function grantTemporaryRole(db: PrismaClient, input: GrantInput, grantedById: string, now = new Date()) {
  if (input.until <= now) throw new HttpError(400, 'until_past', 'The end of the grant has to be in the future.');
  if (input.until.getTime() - now.getTime() > MAX_GRANT_DAYS * 86_400_000) throw new HttpError(400, 'until_too_far', `A temporary grant lasts at most ${MAX_GRANT_DAYS} days.`);
  const target = await db.user.findUnique({ where: { id: input.userId }, select: { id: true, role: true, additionalRoles: true, deletedAt: true, email: true } });
  if (!target || target.deletedAt) throw new HttpError(404, 'not_found', 'User not found.');
  if (target.role === input.role || target.additionalRoles.includes(input.role)) throw new HttpError(409, 'already_holds', 'This account already holds that role.');
  const open = await db.accessGrant.findFirst({ where: { userId: input.userId, role: input.role, revertedAt: null } });
  if (open) throw new HttpError(409, 'grant_open', 'An open grant for that role already exists.');
  const grant = await db.accessGrant.create({
    data: { tenantId: tenantIdForWrite(), userId: input.userId, role: input.role, grantedById, reason: input.reason, expiresAt: input.until },
  });
  await applyRoleChange(db, input.userId, { additionalRoles: [...target.additionalRoles, input.role] }, grantedById, { accessGrantId: grant.id, until: input.until.toISOString(), reason: input.reason });
  void notifyUser(input.userId, {
    subject: `Temporary access: ${ROLE_LABELS[input.role as SharedRole] ?? input.role}`,
    body: `You can work as ${(ROLE_LABELS[input.role as SharedRole] ?? input.role).replace(/^(?!HR|ASN)\w/, (c) => c.toLowerCase())} until ${fmtMomentInZone(input.until)}. Switch roles from your account menu. Reason: ${input.reason}`,
    category: 'access',
    linkUrl: '/settings',
  });
  return grant;
}

/** Take the role back (expiry, or a person's decision). */
export async function revertGrant(db: PrismaClient, grantId: string, by: { userId: string | null; why: string }): Promise<void> {
  const grant = await db.accessGrant.findUnique({ where: { id: grantId } });
  if (!grant || grant.revertedAt) return;
  const target = await db.user.findUnique({ where: { id: grant.userId }, select: { id: true, role: true, additionalRoles: true, deletedAt: true } });
  await db.accessGrant.update({ where: { id: grantId }, data: { revertedAt: new Date(), revertedById: by.userId, revertedWhy: by.why.slice(0, 120) } });
  if (target && !target.deletedAt && target.additionalRoles.includes(grant.role)) {
    await applyRoleChange(db, grant.userId, { additionalRoles: target.additionalRoles.filter((r) => r !== grant.role) }, by.userId, { accessGrantId: grantId, reverted: by.why });
  }
  enqueueAudit({ actorUserId: by.userId, action: 'access.grant_reverted', entityType: 'AccessGrant', entityId: grantId, metadata: { userId: grant.userId, role: grant.role, why: by.why } }, 'accessChanges.revert');
}

/** Every expired, open grant in the tenant in context is taken back. */
export async function revertExpiredGrants(db: PrismaClient = defaultPrisma, now = new Date()): Promise<number> {
  const due = await db.accessGrant.findMany({ where: { tenantId: tenantIdForWrite(), revertedAt: null, expiresAt: { lte: now } }, select: { id: true } });
  for (const g of due) await revertGrant(db, g.id, { userId: null, why: 'expired' });
  return due.length;
}

let timer: NodeJS.Timeout | null = null;

export function startAccessGrantSweepCron(): void {
  if (timer) return;
  const seconds = env.ACCESS_GRANT_SWEEP_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void tenantJob('accessGrants', () => revertExpiredGrants())().catch((err) => {
      console.error('[alto-people/api] access grant sweep failed:', err);
    });
  };
  tick();
  timer = setInterval(tick, seconds * 1000);
  timer.unref();
}

export function stopAccessGrantSweepCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
