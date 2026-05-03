import { Router } from 'express';
import { z } from 'zod';
import { ROLES, HUMAN_ROLES, type Role } from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
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
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: 'At least one of role or status is required',
  });

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

    const data: { role?: Role; status?: 'ACTIVE' | 'DISABLED' | 'INVITED'; tokenVersion?: { increment: number } } = {};
    if (input.role && input.role !== target.role) data.role = input.role;
    if (input.status && input.status !== target.status) data.status = input.status;
    // Any role change OR a flip into DISABLED kills existing sessions.
    if (data.role || data.status === 'DISABLED') {
      data.tokenVersion = { increment: 1 };
    }

    if (Object.keys(data).length === 0) {
      res.status(204).end();
      return;
    }

    await prisma.user.update({ where: { id }, data });
    invalidateUserCache(id);

    enqueueAudit(
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

    enqueueAudit(
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
