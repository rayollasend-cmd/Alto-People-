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

/* -------------------------------------------------------------------------- *
 *  Onboarding events
 *
 *  Single helper for every onboarding-related AuditLog entry. `applicationId`
 *  is always carried in metadata so the timeline query in
 *  `GET /onboarding/applications/:id/audit` is cheap.
 * -------------------------------------------------------------------------- */

interface OnboardingEventContext {
  actorUserId: string | null;
  action: string; // e.g. 'onboarding.profile_updated'
  applicationId: string;
  taskId?: string | null;
  clientId?: string | null;
  metadata?: Record<string, unknown>;
  req?: Request;
}

interface TimeEventContext {
  actorUserId: string | null;
  action: string; // e.g. 'time.clock_in'
  timeEntryId: string;
  associateId: string;
  clientId?: string | null;
  metadata?: Record<string, unknown>;
  req?: Request;
}

interface DocumentEventContext {
  actorUserId: string | null;
  action: string; // e.g. 'document.uploaded'
  documentId: string;
  associateId: string;
  clientId?: string | null;
  metadata?: Record<string, unknown>;
  req?: Request;
}

export async function recordDocumentEvent(ctx: DocumentEventContext) {
  const reqMeta = ctx.req
    ? { ip: ctx.req.ip ?? null, userAgent: ctx.req.headers['user-agent'] ?? null }
    : {};
  await prisma.auditLog.create({
    data: {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId ?? null,
      action: ctx.action,
      entityType: 'DocumentRecord',
      entityId: ctx.documentId,
      metadata: {
        associateId: ctx.associateId,
        ...reqMeta,
        ...(ctx.metadata ?? {}),
      },
    },
  });
}

interface PayrollEventContext {
  actorUserId: string | null;
  action: string; // e.g. 'payroll.run_created'
  payrollRunId: string;
  clientId?: string | null;
  metadata?: Record<string, unknown>;
  req?: Request;
}

export async function recordPayrollEvent(ctx: PayrollEventContext) {
  const reqMeta = ctx.req
    ? { ip: ctx.req.ip ?? null, userAgent: ctx.req.headers['user-agent'] ?? null }
    : {};
  await prisma.auditLog.create({
    data: {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId ?? null,
      action: ctx.action,
      entityType: 'PayrollRun',
      entityId: ctx.payrollRunId,
      metadata: { ...reqMeta, ...(ctx.metadata ?? {}) },
    },
  });
}

interface ShiftEventContext {
  actorUserId: string | null;
  action: string; // e.g. 'shift.created'
  shiftId: string;
  clientId: string;
  metadata?: Record<string, unknown>;
  req?: Request;
}

export async function recordShiftEvent(ctx: ShiftEventContext) {
  const reqMeta = ctx.req
    ? { ip: ctx.req.ip ?? null, userAgent: ctx.req.headers['user-agent'] ?? null }
    : {};
  await prisma.auditLog.create({
    data: {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId,
      action: ctx.action,
      entityType: 'Shift',
      entityId: ctx.shiftId,
      metadata: { ...reqMeta, ...(ctx.metadata ?? {}) },
    },
  });
}

export async function recordTimeEvent(ctx: TimeEventContext) {
  const reqMeta = ctx.req
    ? { ip: ctx.req.ip ?? null, userAgent: ctx.req.headers['user-agent'] ?? null }
    : {};
  await prisma.auditLog.create({
    data: {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId ?? null,
      action: ctx.action,
      entityType: 'TimeEntry',
      entityId: ctx.timeEntryId,
      metadata: {
        associateId: ctx.associateId,
        ...reqMeta,
        ...(ctx.metadata ?? {}),
      },
    },
  });
}

export async function recordOnboardingEvent(ctx: OnboardingEventContext) {
  const reqMeta = ctx.req
    ? { ip: ctx.req.ip ?? null, userAgent: ctx.req.headers['user-agent'] ?? null }
    : {};
  await prisma.auditLog.create({
    data: {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId ?? null,
      action: ctx.action,
      entityType: 'Application',
      entityId: ctx.applicationId,
      metadata: {
        applicationId: ctx.applicationId,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        ...reqMeta,
        ...(ctx.metadata ?? {}),
      },
    },
  });
}
