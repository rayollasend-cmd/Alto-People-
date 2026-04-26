import type { Request } from 'express';
import { prisma } from '../db.js';

interface LoginContext {
  email: string;
  req: Request;
}

interface LoginSuccessContext extends LoginContext {
  userId: string;
  clientId?: string | null;
}

interface LoginFailureContext extends LoginContext {
  reason:
    | 'unknown_email'
    | 'no_password'
    | 'wrong_password'
    | 'disabled'
    | 'soft_deleted'
    | 'non_human_role';
}

interface LogoutContext {
  userId: string;
  clientId?: string | null;
  req: Request;
}

function meta(req: Request, extra: Record<string, unknown> = {}) {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    ...extra,
  };
}

export async function recordLoginSuccess(ctx: LoginSuccessContext) {
  await prisma.auditLog.create({
    data: {
      actorUserId: ctx.userId,
      clientId: ctx.clientId ?? null,
      action: 'auth.login',
      entityType: 'User',
      entityId: ctx.userId,
      metadata: meta(ctx.req, { email: ctx.email }),
    },
  });
}

export async function recordLoginFailure(ctx: LoginFailureContext) {
  // We don't have a user ID by definition — entityId records the attempted email.
  await prisma.auditLog.create({
    data: {
      actorUserId: null,
      action: 'auth.login_failed',
      entityType: 'User',
      entityId: ctx.email,
      metadata: meta(ctx.req, { email: ctx.email, reason: ctx.reason }),
    },
  });
}

export async function recordLogout(ctx: LogoutContext) {
  await prisma.auditLog.create({
    data: {
      actorUserId: ctx.userId,
      clientId: ctx.clientId ?? null,
      action: 'auth.logout',
      entityType: 'User',
      entityId: ctx.userId,
      metadata: meta(ctx.req),
    },
  });
}
