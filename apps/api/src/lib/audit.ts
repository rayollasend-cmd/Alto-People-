import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

// ---------------------------------------------------------------------------
// Fire-and-forget audit writes
//
// Every onboarding mutation, time-clock event, shift update, etc. previously
// `await`-ed `prisma.auditLog.create(...)` before responding. At hundreds of
// associates each making dozens of audited actions per day, the cumulative
// 5-15ms per audit insert sat right on the request critical path. Audit rows
// are not user-visible and not strict-consistency-critical: a 50-100ms lag
// between the action returning and the row landing is fine for forensics.
//
// This helper kicks off the create synchronously, swallows the promise,
// logs failures so they aren't silent. Each public `recordXxx` helper builds
// its data row and calls `enqueueAudit`, so the call site signature stays
// `async`/`Promise<void>` (existing `await recordXxx(...)` keeps working —
// it now just resolves immediately).
//
// Caveat: if the Node process crashes between response and audit insert,
// the row is lost. Acceptable for this app; if it ever isn't, swap this
// for a durable queue (Bull, RabbitMQ) without touching call sites.
// ---------------------------------------------------------------------------

// In-flight audit writes — tests can `await flushPendingAudits()` to wait
// for fire-and-forget inserts to land before asserting on AuditLog rows.
// Negligible overhead in production (one push + one splice per audit).
const inFlight: Set<Promise<unknown>> = new Set();

export function enqueueAudit(
  data: Prisma.AuditLogUncheckedCreateInput,
  where: string
): void {
  const p = prisma.auditLog
    .create({ data })
    .catch((err) => {
      console.error(`[audit] ${where} failed:`, err);
    })
    .finally(() => {
      inFlight.delete(p);
    });
  inFlight.add(p);
}

/** Test-only: resolves once every queued audit insert has settled. */
export async function flushPendingAudits(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

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
  enqueueAudit(
    {
      actorUserId: ctx.userId,
      clientId: ctx.clientId ?? null,
      action: 'auth.login',
      entityType: 'User',
      entityId: ctx.userId,
      metadata: meta(ctx.req, { email: ctx.email }),
    },
    'recordLoginSuccess'
  );
}

export async function recordLoginFailure(ctx: LoginFailureContext) {
  // We don't have a user ID by definition — entityId records the attempted email.
  enqueueAudit(
    {
      actorUserId: null,
      action: 'auth.login_failed',
      entityType: 'User',
      entityId: ctx.email,
      metadata: meta(ctx.req, { email: ctx.email, reason: ctx.reason }),
    },
    'recordLoginFailure'
  );
}

export async function recordLogout(ctx: LogoutContext) {
  enqueueAudit(
    {
      actorUserId: ctx.userId,
      clientId: ctx.clientId ?? null,
      action: 'auth.logout',
      entityType: 'User',
      entityId: ctx.userId,
      metadata: meta(ctx.req),
    },
    'recordLogout'
  );
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

interface ComplianceEventContext {
  actorUserId: string | null;
  action: string;
  entityType: 'I9Verification' | 'BackgroundCheck' | 'J1Profile';
  entityId: string;
  associateId: string;
  clientId?: string | null;
  metadata?: Record<string, unknown>;
  req?: Request;
}

export async function recordComplianceEvent(ctx: ComplianceEventContext) {
  const reqMeta = ctx.req
    ? { ip: ctx.req.ip ?? null, userAgent: ctx.req.headers['user-agent'] ?? null }
    : {};
  enqueueAudit(
    {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId ?? null,
      action: ctx.action,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      metadata: { associateId: ctx.associateId, ...reqMeta, ...(ctx.metadata ?? {}) },
    },
    'recordComplianceEvent'
  );
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
  enqueueAudit(
    {
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
    'recordDocumentEvent'
  );
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
  enqueueAudit(
    {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId ?? null,
      action: ctx.action,
      entityType: 'PayrollRun',
      entityId: ctx.payrollRunId,
      metadata: { ...reqMeta, ...(ctx.metadata ?? {}) },
    },
    'recordPayrollEvent'
  );
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
  enqueueAudit(
    {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId,
      action: ctx.action,
      entityType: 'Shift',
      entityId: ctx.shiftId,
      metadata: { ...reqMeta, ...(ctx.metadata ?? {}) },
    },
    'recordShiftEvent'
  );
}

export async function recordTimeEvent(ctx: TimeEventContext) {
  const reqMeta = ctx.req
    ? { ip: ctx.req.ip ?? null, userAgent: ctx.req.headers['user-agent'] ?? null }
    : {};
  enqueueAudit(
    {
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
    'recordTimeEvent'
  );
}

export async function recordOnboardingEvent(ctx: OnboardingEventContext) {
  const reqMeta = ctx.req
    ? { ip: ctx.req.ip ?? null, userAgent: ctx.req.headers['user-agent'] ?? null }
    : {};
  enqueueAudit(
    {
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
    'recordOnboardingEvent'
  );
}
