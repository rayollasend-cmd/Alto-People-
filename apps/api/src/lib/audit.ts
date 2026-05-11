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

/**
 * Synchronous variant for security-critical events: login success/failure,
 * payout-method reveal, payroll disbursement, admin user mutations. These
 * MUST land in AuditLog before we return success to the caller — a
 * Postgres blip that silently swallows the row is exactly the gap a
 * forensic investigation would need to close.
 *
 * Failure mode: this throws. Wire the call so a failed audit fails the
 * request rather than letting the action complete unrecorded. The caller
 * decides whether to surface the original action's success first (e.g.
 * payroll disbursement is irreversible — better to record-then-fail than
 * fail-without-record).
 *
 * Still tracked in `inFlight` so tests' `flushPendingAudits()` stays
 * accurate when both flavours are mixed in a single request.
 */
export async function recordCriticalAudit(
  data: Prisma.AuditLogUncheckedCreateInput,
  where: string,
): Promise<void> {
  const p = prisma.auditLog.create({ data }).finally(() => {
    inFlight.delete(p);
  });
  inFlight.add(p);
  try {
    await p;
  } catch (err) {
    console.error(`[audit:critical] ${where} failed:`, err);
    throw err;
  }
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
    | 'non_human_role'
    // mfa-challenge: a code was submitted but neither matched a TOTP
    // window nor an unused recovery code. Distinct so the audit feed can
    // tell "they didn't know the password" from "they had the password
    // but couldn't pass MFA" — different incident response.
    | 'mfa_invalid_code';
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
    // Per-request trace ID set by middleware/requestId.ts. Lets audit
    // forensics tie an AuditLog row back to the exact request that wrote
    // it, even across replicas.
    requestId: req.id ?? null,
    ...extra,
  };
}

// Same shape as meta() but tolerates a missing req — used by helpers that
// can be called from background jobs / crons where there's no HTTP
// request to derive ip/userAgent/requestId from. Return is shaped as
// Prisma.InputJsonObject so it composes cleanly into the metadata field
// without widening to `unknown`.
function reqMetaOptional(req: Request | undefined): Prisma.InputJsonObject {
  if (!req) return {};
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: req.id ?? null,
  };
}

export async function recordLoginSuccess(ctx: LoginSuccessContext) {
  // Critical: a missing login row would let an attacker quietly establish
  // a session that doesn't show up in the audit feed.
  await recordCriticalAudit(
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
  // Critical: brute-force forensics depend on having every failed attempt
  // in AuditLog. We don't have a user ID by definition — entityId records
  // the attempted email instead.
  await recordCriticalAudit(
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
  // Critical: pairs with login_success for session-lifetime forensics.
  await recordCriticalAudit(
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
  const reqMeta = reqMetaOptional(ctx.req);
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
  const reqMeta = reqMetaOptional(ctx.req);
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
  // Set true for disbursement / void / amend — irreversible money events
  // that MUST land in AuditLog before we tell the caller "done". A failed
  // critical audit aborts the request handler so the disbursement state
  // never goes "happened in the bank, missing from the audit feed".
  critical?: boolean;
}

export async function recordPayrollEvent(ctx: PayrollEventContext) {
  const reqMeta = reqMetaOptional(ctx.req);
  const metadata = { ...reqMeta, ...(ctx.metadata ?? {}) } as Prisma.InputJsonObject;
  if (ctx.critical) {
    await recordCriticalAudit(
      {
        actorUserId: ctx.actorUserId,
        clientId: ctx.clientId ?? null,
        action: ctx.action,
        entityType: 'PayrollRun',
        entityId: ctx.payrollRunId,
        metadata,
      },
      `recordPayrollEvent:${ctx.action}`,
    );
  } else {
    enqueueAudit(
      {
        actorUserId: ctx.actorUserId,
        clientId: ctx.clientId ?? null,
        action: ctx.action,
        entityType: 'PayrollRun',
        entityId: ctx.payrollRunId,
        metadata,
      },
      'recordPayrollEvent',
    );
  }
}

interface ReimbursementEventContext {
  actorUserId: string | null;
  action: string; // e.g. 'reimbursement.submitted'
  reimbursementId: string;
  associateId: string;
  clientId?: string | null;
  metadata?: Record<string, unknown>;
  req?: Request;
}

export async function recordReimbursementEvent(ctx: ReimbursementEventContext) {
  const reqMeta = reqMetaOptional(ctx.req);
  enqueueAudit(
    {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId ?? null,
      action: ctx.action,
      entityType: 'Reimbursement',
      entityId: ctx.reimbursementId,
      metadata: {
        associateId: ctx.associateId,
        ...reqMeta,
        ...(ctx.metadata ?? {}),
      },
    },
    'recordReimbursementEvent'
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
  const reqMeta = reqMetaOptional(ctx.req);
  enqueueAudit(
    {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId,
      action: ctx.action,
      entityType: 'Shift',
      entityId: ctx.shiftId,
      metadata: { ...reqMeta, ...(ctx.metadata ?? {}) } as Prisma.InputJsonObject,
    },
    'recordShiftEvent'
  );
}

export async function recordTimeEvent(ctx: TimeEventContext) {
  const reqMeta = reqMetaOptional(ctx.req);
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
  const reqMeta = reqMetaOptional(ctx.req);
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
