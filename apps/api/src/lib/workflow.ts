import { Prisma, type PrismaClient, type WorkflowTrigger } from '@prisma/client';
import { prisma } from '../db.js';

/**
 * Phase 80 — Workflow engine.
 *
 * Public API:
 *   - emit(trigger, entity, context): synchronously fires every active
 *     definition that matches the trigger + conditions. Each match
 *     spawns a WorkflowRun whose steps execute in declared order. v1
 *     runs steps inline (no queue); failures are captured per-step and
 *     don't cascade — a SEND_NOTIFICATION error doesn't block the next
 *     SET_FIELD action.
 *
 * Action handlers are pluggable via the ACTION_HANDLERS map below.
 * Future phases swap in a worker queue without changing the call sites.
 *
 * Conditions JSON shape (v1):
 *   {} → always run
 *   { "and": [{ "field": "associate.state", "op": "eq", "value": "CA" }] }
 *   { "or": [...] }
 *   ops: eq, neq, in, nin, exists
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

function evalCondition(cond: ConditionGroup | ConditionLeaf | undefined | null, ctx: unknown): boolean {
  if (!cond || (typeof cond === 'object' && Object.keys(cond).length === 0)) return true;
  if ('field' in cond && 'op' in cond) return evalLeaf(cond, ctx);
  if ('and' in cond && cond.and) {
    return cond.and.every((c) => evalCondition(c, ctx));
  }
  if ('or' in cond && cond.or) {
    return cond.or.some((c) => evalCondition(c, ctx));
  }
  return true;
}

interface ActionDef {
  kind:
    | 'SEND_NOTIFICATION'
    | 'SET_FIELD'
    | 'ASSIGN_TASK'
    | 'CREATE_AUDIT_LOG'
    | 'WEBHOOK';
  params: Record<string, unknown>;
}

type ActionHandler = (
  tx: PrismaClient | Prisma.TransactionClient,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<{ result?: unknown }>;

const ACTION_HANDLERS: Record<ActionDef['kind'], ActionHandler> = {
  SEND_NOTIFICATION: async (tx, params, ctx) => {
    const channel = (params.channel as string | undefined) ?? 'IN_APP';
    const recipientUserId = resolveTemplate(params.recipientUserId, ctx);
    const recipientPhone = resolveTemplate(params.recipientPhone, ctx);
    const recipientEmail = resolveTemplate(params.recipientEmail, ctx);
    const subject = resolveTemplate(params.subject, ctx) ?? null;
    const body = resolveTemplate(params.body, ctx) ?? '';
    const category = (params.category as string | undefined) ?? 'workflow';
    const created = await tx.notification.create({
      data: {
        channel: channel as 'SMS' | 'PUSH' | 'EMAIL' | 'IN_APP',
        recipientUserId: recipientUserId || null,
        recipientPhone: recipientPhone || null,
        recipientEmail: recipientEmail || null,
        subject,
        body,
        category,
      },
    });
    return { result: { notificationId: created.id } };
  },

  SET_FIELD: async (_tx, params, _ctx) => {
    // v1 stub — explicit allow-list rather than risking arbitrary writes.
    // A real impl wires per-entity setters; for now we no-op and record
    // the intended mutation so HR can audit what would have happened.
    return {
      result: {
        intended: { entity: params.entity, field: params.field, value: params.value },
        note: 'SET_FIELD is recorded but not applied in v1',
      },
    };
  },

  ASSIGN_TASK: async (_tx, params, _ctx) => {
    return { result: { intended: params, note: 'ASSIGN_TASK queued for v2 task fulfillment' } };
  },

  CREATE_AUDIT_LOG: async (tx, params, ctx) => {
    const action = (params.action as string | undefined) ?? 'workflow.action';
    const entityType = (params.entityType as string | undefined) ?? 'WorkflowRun';
    const entityId =
      typeof params.entityId === 'string'
        ? params.entityId
        : (ctx.entityId as string | undefined) ?? '';
    const created = await tx.auditLog.create({
      data: {
        action,
        entityType,
        entityId,
        metadata: params.metadata ?? null,
      } as Prisma.AuditLogUncheckedCreateInput,
    });
    return { result: { auditLogId: created.id } };
  },

  WEBHOOK: async (_tx, params, _ctx) => {
    // v1 stub — Phase 93 wires the actual outbound HMAC-signed POST.
    return { result: { intended: params, note: 'WEBHOOK queued for Phase 93' } };
  },
};

function resolveTemplate(value: unknown, ctx: Record<string, unknown>): string | undefined {
  if (typeof value !== 'string') return value as string | undefined;
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = getByPath(ctx, path);
    return v == null ? '' : String(v);
  });
}

export interface EmitArgs {
  trigger: WorkflowTrigger;
  entityType: string;
  entityId: string;
  context: Record<string, unknown>;
  // Optional clientId to scope which definitions match. NULL = both
  // client-specific and global definitions.
  clientId?: string | null;
}

export async function emit(args: EmitArgs): Promise<{ runs: string[] }> {
  const candidates = await prisma.workflowDefinition.findMany({
    where: {
      trigger: args.trigger,
      isActive: true,
      deletedAt: null,
      OR: [
        { clientId: null },
        ...(args.clientId ? [{ clientId: args.clientId }] : []),
      ],
    },
  });

  const matched = candidates.filter((d) =>
    evalCondition(d.conditions as ConditionGroup, args.context),
  );

  const createdRuns: string[] = [];

  for (const def of matched) {
    const actions = (def.actions as unknown as ActionDef[]) ?? [];
    const run = await prisma.workflowRun.create({
      data: {
        definitionId: def.id,
        trigger: args.trigger,
        entityType: args.entityType,
        entityId: args.entityId,
        context: args.context as Prisma.InputJsonValue,
        status: 'RUNNING',
        startedAt: new Date(),
        steps: {
          create: actions.map((a, i) => ({
            ordinal: i,
            kind: a.kind,
            params: (a.params ?? {}) as Prisma.InputJsonValue,
          })),
        },
      },
      include: { steps: { orderBy: { ordinal: 'asc' } } },
    });
    createdRuns.push(run.id);

    let runFailed = false;
    for (const step of run.steps) {
      try {
        await prisma.workflowStep.update({
          where: { id: step.id },
          data: { status: 'RUNNING', startedAt: new Date() },
        });
        const handler = ACTION_HANDLERS[step.kind];
        if (!handler) throw new Error(`Unknown action kind ${step.kind}`);
        const out = await handler(prisma, step.params as Record<string, unknown>, args.context);
        await prisma.workflowStep.update({
          where: { id: step.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            result: (out.result ?? null) as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        runFailed = true;
        await prisma.workflowStep.update({
          where: { id: step.id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            failureReason: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        status: runFailed ? 'FAILED' : 'COMPLETED',
        completedAt: new Date(),
        failureReason: runFailed ? 'One or more steps failed' : null,
      },
    });
  }

  return { runs: createdRuns };
}
