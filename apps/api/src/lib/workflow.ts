import { Prisma, type WorkflowRun, type WorkflowStep, type WorkflowTrigger, type Role } from '@prisma/client';
import type { Capability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { signatureV2 } from './webhookSecrets.js';
import { assertSafeOutboundUrl } from './safeOutboundUrl.js';
import { recordChange } from './associateHistory.js';
import { notifyUser } from './notify.js';
import { currentTenantId, runWithTenant, tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { createApprovalRequest, registerApplyHandler } from './approvalRequests.js';
import { rolesHolding } from './approvalPolicy.js';

/**
 * Workflow engine.
 *
 * emit(trigger, entity, context) matches every active definition for the
 * trigger whose conditions hold and QUEUES one run per match: the run and
 * its steps are rows, status PENDING, and the worker (runWorkflowQueue —
 * on a timer per tenant, and right after an emit outside tests) executes
 * the steps in order. A business event therefore never waits on a webhook
 * or a notification, and a crash between the two loses nothing.
 *
 * Actions: SEND_NOTIFICATION, SET_FIELD (an allow-list of fields per
 * entity, with history), ASSIGN_TASK (a WorkflowTask for a person or a
 * role), CREATE_AUDIT_LOG, WEBHOOK (signed POST, retried on a backoff),
 * and REQUIRE_APPROVAL — the run pauses (WAITING) until the named person,
 * capability holder or role decides the ApprovalRequest it opens; approval
 * resumes the run, rejection cancels the steps after the gate.
 *
 * Conditions JSON: {} always; { and: [...] } / { or: [...] } of leaves
 * { field, op: eq|neq|in|nin|exists, value }, fields read from the context
 * by dotted path. Templates in params: "{{ associate.firstName }}".
 */

interface ConditionLeaf {
  field: string;
  op: 'eq' | 'neq' | 'in' | 'nin' | 'exists';
  value?: unknown;
}
interface ConditionGroup {
  and?: Array<ConditionLeaf | ConditionGroup>;
  or?: Array<ConditionLeaf | ConditionGroup>;
}

function getByPath(ctx: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), ctx);
}

function evalLeaf(leaf: ConditionLeaf, ctx: unknown): boolean {
  const actual = getByPath(ctx, leaf.field);
  switch (leaf.op) {
    case 'eq':
      return actual === leaf.value;
    case 'neq':
      return actual !== leaf.value;
    case 'in':
      return Array.isArray(leaf.value) && leaf.value.includes(actual);
    case 'nin':
      return Array.isArray(leaf.value) && !leaf.value.includes(actual);
    case 'exists':
      return actual !== undefined && actual !== null;
    default:
      return false;
  }
}

export function evalCondition(cond: ConditionGroup | ConditionLeaf | undefined | null, ctx: unknown): boolean {
  if (!cond || (typeof cond === 'object' && Object.keys(cond).length === 0)) return true;
  if ('field' in cond && 'op' in cond) return evalLeaf(cond, ctx);
  if ('and' in cond && cond.and) return cond.and.every((c) => evalCondition(c, ctx));
  if ('or' in cond && cond.or) return cond.or.some((c) => evalCondition(c, ctx));
  return true;
}

export type WorkflowActionKind = WorkflowStep['kind'];

interface ActionDef {
  kind: WorkflowActionKind;
  params: Record<string, unknown>;
}

export function resolveTemplate(value: unknown, ctx: Record<string, unknown>): string | undefined {
  if (typeof value !== 'string') return value == null ? undefined : String(value);
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = getByPath(ctx, path);
    return v == null ? '' : String(v);
  });
}

/* ----- Actions ------------------------------------------------------------ */

type StepOutcome =
  | { kind: 'done'; result?: unknown }
  | { kind: 'wait'; result?: unknown }
  | { kind: 'retry'; error: string }
  | { kind: 'fail'; error: string };

interface ActionArgs {
  run: WorkflowRun;
  step: WorkflowStep;
  params: Record<string, unknown>;
  ctx: Record<string, unknown>;
  now: Date;
}

type ActionHandler = (args: ActionArgs) => Promise<StepOutcome>;

/** The fields a SET_FIELD may write, per entity. Anything else is refused and recorded. */
const SET_FIELD_ALLOW: Record<string, readonly string[]> = {
  Associate: ['managerId', 'departmentId', 'costCenterId', 'jobProfileId'],
  Position: ['status', 'notes'],
  HrCase: ['priority', 'assignedToId'],
};

/** The entity a step acts on: an explicit id, else the trigger's own entity, else the context's associate. */
function entityIdFor(params: Record<string, unknown>, run: WorkflowRun, ctx: Record<string, unknown>, entity: string): string | null {
  const explicit = resolveTemplate(params.entityId, ctx);
  if (explicit) return explicit;
  if (run.entityType === entity) return run.entityId;
  if (entity === 'Associate' && typeof ctx.associateId === 'string') return ctx.associateId;
  return null;
}

/** Outbound sender, swappable in tests. */
type Sender = (url: string, init: RequestInit) => Promise<Response>;
let sender: Sender = (url, init) => fetch(url, init);
export function setWorkflowWebhookSenderForTests(fn: Sender | null): void {
  sender = fn ?? ((url, init) => fetch(url, init));
}

export const WEBHOOK_MAX_ATTEMPTS = 4;
export const WEBHOOK_BACKOFF_MINUTES = [1, 5, 30] as const;
const WEBHOOK_TIMEOUT_MS = 10_000;

const ACTIONS: Record<WorkflowActionKind, ActionHandler> = {
  SEND_NOTIFICATION: async ({ params, ctx }) => {
    const channel = ((params.channel as string | undefined) ?? 'IN_APP') as 'SMS' | 'PUSH' | 'EMAIL' | 'IN_APP';
    const recipientUserId = resolveTemplate(params.recipientUserId, ctx) || null;
    const recipientPhone = resolveTemplate(params.recipientPhone, ctx) || null;
    const recipientEmail = resolveTemplate(params.recipientEmail, ctx) || null;
    const subject = resolveTemplate(params.subject, ctx) ?? null;
    const body = resolveTemplate(params.body, ctx) ?? '';
    const category = (params.category as string | undefined) ?? 'workflow';
    const created = await prisma.notification.create({
      data: { channel, recipientUserId, recipientPhone, recipientEmail, subject, body, category },
    });
    return { kind: 'done', result: { notificationId: created.id } };
  },

  SET_FIELD: async ({ run, params, ctx }) => {
    const entity = String(params.entity ?? '');
    const field = String(params.field ?? '');
    const allowed = SET_FIELD_ALLOW[entity];
    if (!allowed) return { kind: 'fail', error: `SET_FIELD: "${entity}" is not an entity a workflow may write.` };
    if (!allowed.includes(field)) return { kind: 'fail', error: `SET_FIELD: "${entity}.${field}" is not a field a workflow may write (allowed: ${allowed.join(', ')}).` };
    const id = entityIdFor(params, run, ctx, entity);
    if (!id) return { kind: 'fail', error: `SET_FIELD: no ${entity} to write — set params.entityId.` };
    const raw = params.value;
    const value = typeof raw === 'string' ? resolveTemplate(raw, ctx) || null : raw == null ? null : raw;
    if (entity === 'Associate') {
      const updated = await prisma.associate.update({ where: { id }, data: { [field]: value } as Prisma.AssociateUncheckedUpdateInput });
      await recordChange(prisma, {
        associateId: id,
        managerId: updated.managerId,
        departmentId: updated.departmentId,
        costCenterId: updated.costCenterId,
        jobProfileId: updated.jobProfileId,
        state: updated.state,
        hourlyRate: null,
        reason: 'workflow',
        actorUserId: null,
      });
    } else if (entity === 'Position') {
      await prisma.position.update({ where: { id }, data: { [field]: value } as Prisma.PositionUncheckedUpdateInput });
    } else if (entity === 'HrCase') {
      await prisma.hrCase.update({ where: { id }, data: { [field]: value } as Prisma.HrCaseUncheckedUpdateInput });
    }
    return { kind: 'done', result: { entity, id, field, value } };
  },

  ASSIGN_TASK: async ({ run, params, ctx, now }) => {
    const title = resolveTemplate(params.title, ctx)?.trim();
    if (!title) return { kind: 'fail', error: 'ASSIGN_TASK: params.title is required.' };
    const assigneeUserId = resolveTemplate(params.assigneeUserId, ctx) || null;
    const assigneeRole = (params.assigneeRole as Role | undefined) ?? null;
    if (!assigneeUserId && !assigneeRole) return { kind: 'fail', error: 'ASSIGN_TASK: name a person (assigneeUserId) or a role (assigneeRole).' };
    const dueInDays = typeof params.dueInDays === 'number' ? params.dueInDays : null;
    const task = await prisma.workflowTask.create({
      data: {
        tenantId: tenantIdForWrite(),
        runId: run.id,
        title: title.slice(0, 200),
        details: resolveTemplate(params.details, ctx)?.slice(0, 2000) ?? null,
        assigneeUserId,
        assigneeRole,
        entityType: run.entityType.slice(0, 60),
        entityId: /^[0-9a-f-]{36}$/i.test(run.entityId) ? run.entityId : null,
        linkUrl: resolveTemplate(params.linkUrl, ctx)?.slice(0, 300) ?? null,
        dueAt: dueInDays != null ? new Date(now.getTime() + dueInDays * 86_400_000) : null,
      },
    });
    const ring = assigneeUserId
      ? [assigneeUserId]
      : (await prisma.user.findMany({ where: { tenantId: tenantIdForWrite(), role: assigneeRole!, status: 'ACTIVE', deletedAt: null }, select: { id: true }, take: 25 })).map((u) => u.id);
    for (const uid of ring) {
      void notifyUser(uid, { subject: `Task: ${task.title}`, body: task.details ?? 'A workflow handed you this.', category: 'workflow', linkUrl: '/workflows?tab=tasks' });
    }
    return { kind: 'done', result: { taskId: task.id } };
  },

  CREATE_AUDIT_LOG: async ({ run, params, ctx }) => {
    const action = (params.action as string | undefined) ?? 'workflow.action';
    const entityType = (params.entityType as string | undefined) ?? 'WorkflowRun';
    const entityId = typeof params.entityId === 'string' ? params.entityId : (ctx.entityId as string | undefined) ?? run.entityId;
    const created = await prisma.auditLog.create({
      data: { action, entityType, entityId, metadata: (params.metadata ?? null) as Prisma.InputJsonValue } as Prisma.AuditLogUncheckedCreateInput,
    });
    return { kind: 'done', result: { auditLogId: created.id } };
  },

  WEBHOOK: async ({ run, step, params, ctx, now }) => {
    const url = resolveTemplate(params.url, ctx);
    if (!url) return { kind: 'fail', error: 'WEBHOOK: params.url is required.' };
    const secret = typeof params.secret === 'string' && params.secret ? params.secret : env.WEBHOOK_SIGNING_SECRET ?? 'alto-workflow';
    try {
      await assertSafeOutboundUrl(url);
    } catch (err) {
      return { kind: 'fail', error: `WEBHOOK: unsafe destination refused: ${err instanceof Error ? err.message : 'invalid URL'}` };
    }
    const body = JSON.stringify({
      event: (params.event as string | undefined) ?? `workflow.${run.trigger.toLowerCase()}`,
      timestamp: now.toISOString(),
      run: { id: run.id, trigger: run.trigger, entityType: run.entityType, entityId: run.entityId },
      data: ctx,
    });
    try {
      const r = await sender(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Alto-Signature': signatureV2(secret, body, now), 'X-Alto-Event': 'workflow', 'X-Alto-Delivery': step.id },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (r.status >= 200 && r.status < 300) return { kind: 'done', result: { status: r.status } };
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return { kind: 'fail', error: `WEBHOOK: endpoint answered ${r.status}` };
      return { kind: 'retry', error: `WEBHOOK: endpoint answered ${r.status}` };
    } catch (err) {
      return { kind: 'retry', error: `WEBHOOK: ${err instanceof Error ? err.message : 'request failed'}` };
    }
  },

  REQUIRE_APPROVAL: async ({ run, step, params, ctx }) => {
    const existing = (step.result ?? null) as { approvalRequestId?: string } | null;
    if (existing?.approvalRequestId) return { kind: 'wait', result: existing };
    const capability = (params.capability as Capability | undefined) ?? undefined;
    const userId = resolveTemplate(params.userId, ctx) || undefined;
    const role = (params.role as Role | undefined) ?? undefined;
    if (!capability && !userId && !role) return { kind: 'fail', error: 'REQUIRE_APPROVAL: name who decides — capability, userId or role.' };
    if (capability && rolesHolding(capability).length === 0) return { kind: 'fail', error: `REQUIRE_APPROVAL: no role holds "${capability}".` };
    const def = await prisma.workflowDefinition.findUnique({ where: { id: run.definitionId }, select: { name: true, clientId: true } });
    const title = resolveTemplate(params.title, ctx)?.trim() || `${def?.name ?? 'Workflow'}: approval needed`;
    const request = await createApprovalRequest(prisma, {
      kind: 'WORKFLOW_GATE',
      subjectType: 'WorkflowRun',
      subjectId: run.id,
      title: title.slice(0, 200),
      summary: resolveTemplate(params.summary, ctx)?.slice(0, 2000) ?? `${run.trigger} on ${run.entityType}. The steps after this gate run only if you approve.`,
      proposed: { trigger: run.trigger, entityType: run.entityType, entityId: run.entityId, stepOrdinal: step.ordinal },
      requesterUserId: null,
      approver: { capability, userId, role },
      clientId: def?.clientId ?? null,
      associateId: typeof ctx.associateId === 'string' ? ctx.associateId : null,
      workflowRunId: run.id,
      workflowStepId: step.id,
    });
    return { kind: 'wait', result: { approvalRequestId: request.id } };
  },
};

/* ----- Queue -------------------------------------------------------------- */

export interface EmitArgs {
  trigger: WorkflowTrigger;
  entityType: string;
  entityId: string;
  context: Record<string, unknown>;
  /** Scope which definitions match. NULL = both client-specific and global definitions. */
  clientId?: string | null;
  /** Skip when a run for the same (trigger, entity) was queued within this many days — for sweeps that see the same item daily. */
  dedupeDays?: number;
}

/** Queue a run per matching definition. Returns their ids; the worker executes them. */
export async function emit(args: EmitArgs): Promise<{ runs: string[] }> {
  const candidates = await prisma.workflowDefinition.findMany({
    where: {
      trigger: args.trigger,
      isActive: true,
      deletedAt: null,
      OR: [{ clientId: null }, ...(args.clientId ? [{ clientId: args.clientId }] : [])],
    },
  });
  const matched = candidates.filter((d) => evalCondition(d.conditions as ConditionGroup, args.context));
  if (matched.length === 0) return { runs: [] };

  if (args.dedupeDays) {
    const since = new Date(Date.now() - args.dedupeDays * 86_400_000);
    const recent = await prisma.workflowRun.findFirst({ where: { trigger: args.trigger, entityType: args.entityType, entityId: args.entityId, createdAt: { gte: since } }, select: { id: true } });
    if (recent) return { runs: [] };
  }

  const createdRuns: string[] = [];
  for (const def of matched) {
    const actions = (def.actions as unknown as ActionDef[]) ?? [];
    const run = await prisma.workflowRun.create({
      data: {
        definitionId: def.id,
        trigger: args.trigger,
        entityType: args.entityType,
        entityId: args.entityId,
        context: { ...args.context, entityId: args.entityId, entityType: args.entityType } as Prisma.InputJsonValue,
        status: 'PENDING',
        steps: { create: actions.map((a, i) => ({ ordinal: i, kind: a.kind, params: (a.params ?? {}) as Prisma.InputJsonValue })) },
      },
    });
    createdRuns.push(run.id);
  }
  scheduleDrain();
  return { runs: createdRuns };
}

let drainScheduled = false;
/** Run the queue soon, in the emitting tenant's context. Tests drive the worker themselves. */
function scheduleDrain(): void {
  if (process.env.NODE_ENV === 'test' || drainScheduled) return;
  const tenantId = currentTenantId();
  if (!tenantId) return;
  drainScheduled = true;
  setTimeout(() => {
    drainScheduled = false;
    void runWithTenant(tenantId, 'job', () => runWorkflowQueue()).catch((err) => console.error('[alto-people/api] workflow drain failed:', err));
  }, 50).unref();
}

const terminal = (s: WorkflowStep['status']) => s === 'COMPLETED' || s === 'FAILED' || s === 'SKIPPED';

/** Execute one claimed run's steps in order until it finishes, pauses or waits for a retry. */
async function processRun(runId: string, now: Date): Promise<void> {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId }, include: { steps: { orderBy: { ordinal: 'asc' } } } });
  if (!run) return;
  const ctx = (run.context ?? {}) as Record<string, unknown>;
  let anyFailed = run.steps.some((s) => s.status === 'FAILED');
  for (const step of run.steps) {
    if (terminal(step.status)) continue;
    if (step.status === 'WAITING') {
      await prisma.workflowRun.update({ where: { id: run.id }, data: { status: 'WAITING' } });
      return;
    }
    if (step.nextAttemptAt && step.nextAttemptAt > now) {
      // Not yet: leave the run RUNNING; the next tick picks it up.
      return;
    }
    await prisma.workflowStep.update({ where: { id: step.id }, data: { status: 'RUNNING', startedAt: step.startedAt ?? now, attempts: { increment: 1 } } });
    const handler = ACTIONS[step.kind];
    let outcome: StepOutcome;
    try {
      outcome = handler ? await handler({ run, step, params: (step.params ?? {}) as Record<string, unknown>, ctx, now }) : { kind: 'fail', error: `Unknown action kind ${step.kind}` };
    } catch (err) {
      outcome = { kind: 'fail', error: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.kind === 'done') {
      await prisma.workflowStep.update({ where: { id: step.id }, data: { status: 'COMPLETED', completedAt: new Date(), result: (outcome.result ?? null) as Prisma.InputJsonValue, nextAttemptAt: null } });
      continue;
    }
    if (outcome.kind === 'wait') {
      await prisma.workflowStep.update({ where: { id: step.id }, data: { status: 'WAITING', result: (outcome.result ?? null) as Prisma.InputJsonValue } });
      await prisma.workflowRun.update({ where: { id: run.id }, data: { status: 'WAITING' } });
      return;
    }
    const attempts = step.attempts + 1;
    if (outcome.kind === 'retry' && attempts < WEBHOOK_MAX_ATTEMPTS) {
      const minutes = WEBHOOK_BACKOFF_MINUTES[Math.min(attempts - 1, WEBHOOK_BACKOFF_MINUTES.length - 1)];
      await prisma.workflowStep.update({ where: { id: step.id }, data: { status: 'PENDING', failureReason: outcome.error, nextAttemptAt: new Date(now.getTime() + minutes * 60_000) } });
      await prisma.workflowRun.update({ where: { id: run.id }, data: { status: 'RUNNING' } });
      return;
    }
    anyFailed = true;
    await prisma.workflowStep.update({ where: { id: step.id }, data: { status: 'FAILED', completedAt: new Date(), failureReason: outcome.error, nextAttemptAt: null } });
    // A failed step does not stop the next one — a broken webhook must not block a notification.
  }
  await prisma.workflowRun.update({
    where: { id: run.id },
    data: { status: anyFailed ? 'FAILED' : 'COMPLETED', completedAt: new Date(), failureReason: anyFailed ? 'One or more steps failed' : null },
  });
}

/**
 * The worker: claim every PENDING run (and every RUNNING run whose retry
 * is due) in the tenant in context and execute it. Idempotent under
 * concurrent ticks — a run is claimed by a guarded status flip.
 */
export async function runWorkflowQueue(opts: { now?: Date; limit?: number } = {}): Promise<{ processed: number }> {
  const now = opts.now ?? new Date();
  const tenantId = tenantIdForWrite();
  const due = await prisma.workflowRun.findMany({
    where: {
      tenantId,
      OR: [
        { status: 'PENDING' },
        { status: 'RUNNING', steps: { some: { status: 'PENDING', nextAttemptAt: { lte: now } } } },
      ],
    },
    select: { id: true, status: true },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 100,
  });
  let processed = 0;
  for (const r of due) {
    const claimed = await prisma.workflowRun.updateMany({ where: { id: r.id, status: r.status }, data: { status: 'RUNNING', startedAt: now } });
    if (claimed.count === 0) continue;
    processed += 1;
    try {
      await processRun(r.id, now);
    } catch (err) {
      await prisma.workflowRun.update({ where: { id: r.id }, data: { status: 'FAILED', completedAt: new Date(), failureReason: err instanceof Error ? err.message : String(err) } }).catch(() => undefined);
    }
  }
  return { processed };
}

/* ----- The approval gate's two outcomes ------------------------------------ */

registerApplyHandler(
  'WORKFLOW_GATE',
  async (db, row, decider) => {
    if (!row.workflowStepId || !row.workflowRunId) return;
    await db.workflowStep.update({ where: { id: row.workflowStepId }, data: { status: 'COMPLETED', completedAt: new Date(), result: { approvalRequestId: row.id, decision: 'APPROVE', decidedById: decider.id } } });
    await db.workflowRun.updateMany({ where: { id: row.workflowRunId, status: 'WAITING' }, data: { status: 'PENDING' } });
    scheduleDrain();
  },
  async (db, row, decider) => {
    if (!row.workflowStepId || !row.workflowRunId) return;
    await db.workflowStep.update({ where: { id: row.workflowStepId }, data: { status: 'FAILED', completedAt: new Date(), failureReason: `Rejected by the approver${row.reason ? `: ${row.reason}` : ''}`, result: { approvalRequestId: row.id, decision: 'REJECT', decidedById: decider.id } } });
    await db.workflowStep.updateMany({ where: { runId: row.workflowRunId, status: 'PENDING' }, data: { status: 'SKIPPED' } });
    await db.workflowRun.updateMany({ where: { id: row.workflowRunId, status: 'WAITING' }, data: { status: 'CANCELLED', completedAt: new Date(), failureReason: 'The approval gate was rejected.' } });
  },
);

/* ----- Timer -------------------------------------------------------------- */

let timer: NodeJS.Timeout | null = null;

export function startWorkflowWorkerCron(): void {
  if (timer) return;
  const seconds = env.WORKFLOW_WORKER_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void tenantJob('workflowQueue', () => runWorkflowQueue())().catch((err) => {
      console.error('[alto-people/api] workflow worker failed:', err);
    });
  };
  tick();
  timer = setInterval(tick, seconds * 1000);
  timer.unref();
  console.log(`[alto-people/api] workflow worker armed (every ${seconds}s)`);
}

export function stopWorkflowWorkerCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

