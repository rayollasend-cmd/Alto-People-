import { Router } from 'express';
import { z } from 'zod';
import { ROLES, HUMAN_ROLES, type Role } from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache, requireCapability } from '../middleware/auth.js';
import { adminForcePasswordResetLimiter } from '../middleware/rateLimit.js';
import { recordCriticalAudit } from '../lib/audit.js';
import {
  generatePasswordResetToken,
  PASSWORD_RESET_TTL_SECONDS,
} from '../lib/passwordResetToken.js';
import { send } from '../lib/notifications.js';

/**
 * HR user-administration surface. Lets HR list every account, change a
 * user's role or status, and force a password reset (which bumps
 * tokenVersion to nuke every live session for that account).
 *
 * Gated on `view:hr-admin`. Every FULL_ADMIN role already has it via the
 * shared capability matrix — see packages/shared/src/roles.ts. We
 * deliberately don't introduce a separate `manage:users` cap: HR admin
 * is already an all-or-nothing surface (org-wide HR data, comp, audit),
 * so adding another tier here would be cosmetic.
 *
 * Self-edit guards: HR can't disable, demote, or password-bomb their own
 * account from this UI — that path is /settings. Removing it would let an
 * HR admin lock themselves out with one wrong click.
 */

export const usersRouter = Router();

const ROLE_VALUES = Object.keys(ROLES) as [Role, ...Role[]];

const ROLE_FILTER = z.enum(ROLE_VALUES);
const STATUS_FILTER = z.enum(['ACTIVE', 'DISABLED', 'INVITED']);

// ----- List ----------------------------------------------------------------

usersRouter.get('/admin/users', requireCapability('view:hr-admin'), async (req, res) => {
  const role = ROLE_FILTER.optional().parse(req.query.role);
  const status = STATUS_FILTER.optional().parse(req.query.status);
  const q = z.string().min(1).max(200).optional().parse(req.query.q);

  const rows = await prisma.user.findMany({
    where: {
      deletedAt: null,
      ...(role ? { role } : {}),
      ...(status ? { status } : {}),
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' as const } },
              {
                associate: {
                  OR: [
                    { firstName: { contains: q, mode: 'insensitive' as const } },
                    { lastName: { contains: q, mode: 'insensitive' as const } },
                  ],
                },
              },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      createdAt: true,
      clientId: true,
      associateId: true,
      associate: {
        select: { firstName: true, lastName: true },
      },
      client: {
        select: { id: true, name: true },
      },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 500,
  });

  res.json({
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt.toISOString(),
      associateId: u.associateId,
      associateName: u.associate
        ? `${u.associate.firstName} ${u.associate.lastName}`
        : null,
      clientId: u.clientId,
      clientName: u.client?.name ?? null,
    })),
  });
});

// ----- Patch role / status -------------------------------------------------

const PatchInputSchema = z
  .object({
    role: ROLE_FILTER.optional(),
    status: STATUS_FILTER.optional(),
    // Client scope for client-bounded roles (SHIFT_SUPERVISOR, CLIENT_PORTAL).
    // null clears it; omitted leaves it unchanged.
    clientId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (v) => v.role !== undefined || v.status !== undefined || v.clientId !== undefined,
    { message: 'At least one of role, status, or clientId is required' },
  );

// Roles that must be pinned to a single client to function.
const CLIENT_SCOPED_ROLES: Role[] = ['SHIFT_SUPERVISOR'];

usersRouter.patch(
  '/admin/users/:id',
  requireCapability('view:hr-admin'),
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = PatchInputSchema.parse(req.body);

    if (id === req.user!.id) {
      throw new HttpError(
        400,
        'self_edit_forbidden',
        'You cannot change your own role or status from here. Use /settings.',
      );
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, status: true, clientId: true, deletedAt: true },
    });
    if (!target || target.deletedAt) {
      throw new HttpError(404, 'not_found', 'User not found.');
    }

    if (input.role && !HUMAN_ROLES.includes(input.role)) {
      // LIVE_ASN is the system-integration role; humans can't be assigned to it.
      throw new HttpError(
        400,
        'non_human_role',
        'LIVE_ASN is reserved for system integrations and cannot be assigned to a person.',
      );
    }

    // Validate the client (if one was provided and not being cleared).
    if (input.clientId) {
      const client = await prisma.client.findFirst({
        where: { id: input.clientId, deletedAt: null },
        select: { id: true },
      });
      if (!client) {
        throw new HttpError(400, 'client_not_found', 'That client does not exist.');
      }
    }

    // A client-scoped role (e.g. SHIFT_SUPERVISOR) must end up with a client,
    // or its scope fails closed and the account can't see anything.
    const effectiveRole = input.role ?? target.role;
    const effectiveClientId =
      input.clientId !== undefined ? input.clientId : target.clientId;
    if (CLIENT_SCOPED_ROLES.includes(effectiveRole) && !effectiveClientId) {
      throw new HttpError(
        400,
        'client_required',
        `${effectiveRole} must be assigned to a client.`,
      );
    }

    const data: {
      role?: Role;
      status?: 'ACTIVE' | 'DISABLED' | 'INVITED';
      clientId?: string | null;
      tokenVersion?: { increment: number };
    } = {};
    if (input.role && input.role !== target.role) data.role = input.role;
    if (input.status && input.status !== target.status) data.status = input.status;
    if (input.clientId !== undefined && input.clientId !== target.clientId) {
      data.clientId = input.clientId;
    }
    // A role change, a client-scope change, or a flip into DISABLED kills
    // existing sessions so the new access takes effect immediately.
    if (data.role || data.clientId !== undefined || data.status === 'DISABLED') {
      data.tokenVersion = { increment: 1 };
    }

    if (Object.keys(data).length === 0) {
      res.status(204).end();
      return;
    }

    await prisma.user.update({ where: { id }, data });
    invalidateUserCache(id);

    // Critical: privilege escalation and account disablement MUST land in
    // AuditLog before the request returns. Without that, an admin who
    // grants themselves a higher role and immediately uses it could
    // theoretically leave no record if the audit insert blipped.
    await recordCriticalAudit(
      {
        actorUserId: req.user!.id,
        clientId: target.clientId ?? null,
        action: 'admin.user_updated',
        entityType: 'User',
        entityId: id,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          changes: {
            ...(data.role ? { role: { from: target.role, to: data.role } } : {}),
            ...(data.status ? { status: { from: target.status, to: data.status } } : {}),
            ...(data.clientId !== undefined
              ? { clientId: { from: target.clientId, to: data.clientId } }
              : {}),
          },
        },
      },
      'admin.user_updated',
    );

    res.status(204).end();
  },
);

// ----- Force password reset -------------------------------------------------

/**
 * Issues a fresh single-use reset link to the target's email — same
 * machinery as /auth/forgot-password but without the "is this user
 * eligible" gating (HR can reset anyone, including INVITED accounts that
 * haven't set a password yet — useful when the original invite was lost).
 *
 * Always bumps tokenVersion so any active sessions die immediately, even
 * if the user never opens the email.
 */
usersRouter.post(
  '/admin/users/:id/force-password-reset',
  requireCapability('view:hr-admin'),
  // Capability + rate limit. The cap controls *who* can call this; the
  // limiter controls *how often* — without it a compromised admin
  // session can fan out resets to every user in seconds.
  adminForcePasswordResetLimiter,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);

    if (id === req.user!.id) {
      throw new HttpError(
        400,
        'self_edit_forbidden',
        'Use /settings to change your own password.',
      );
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, role: true, clientId: true, deletedAt: true },
    });
    if (!target || target.deletedAt) {
      throw new HttpError(404, 'not_found', 'User not found.');
    }

    const { raw, hash } = generatePasswordResetToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000);

    await prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({
        where: { userId: target.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.passwordResetToken.create({
        data: {
          tokenHash: hash,
          userId: target.id,
          expiresAt,
          requestedIp: req.ip ?? null,
        },
      });
      await tx.user.update({
        where: { id: target.id },
        data: { tokenVersion: { increment: 1 } },
      });
    });
    invalidateUserCache(target.id);

    const resetUrl = `${env.APP_BASE_URL}/reset-password/${raw}`;
    const subject = 'Set a new Alto People password';
    const body = [
      `Hi,`,
      ``,
      `Your Alto People administrator has issued a password reset for ${target.email}.`,
      ``,
      `Open this link to set a new password — it works once and expires in 1 hour:`,
      ``,
      resetUrl,
      ``,
      `If you didn't expect this, contact your HR team — your old password and any active sessions have already been revoked.`,
      ``,
      `— Alto People`,
    ].join('\n');

    try {
      await send({
        channel: 'EMAIL',
        recipient: { userId: target.id, phone: null, email: target.email },
        subject,
        body,
      });
    } catch (err) {
      // The session-kill + token-mint already happened. Don't fail the
      // request if the email send blips — HR can re-fire the reset.
      console.error('[admin.force_password_reset] email send failed:', err);
    }

    // Critical: a forced password reset kills every active session for
    // the target. The audit row is the only durable record of who pushed
    // the button and against whom.
    await recordCriticalAudit(
      {
        actorUserId: req.user!.id,
        clientId: target.clientId ?? null,
        action: 'admin.password_reset_forced',
        entityType: 'User',
        entityId: target.id,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          targetEmail: target.email,
        },
      },
      'admin.password_reset_forced',
    );

    res.status(204).end();
  },
);
