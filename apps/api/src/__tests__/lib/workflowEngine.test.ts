import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { runWithTenant } from '../../lib/tenant.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

// The SSRF guard resolves DNS; the engine's tests never leave the process.
vi.mock('../../lib/safeOutboundUrl.js', () => ({ assertSafeOutboundUrl: async (raw: string) => new URL(raw) }));

import { emit, runWorkflowQueue, setWorkflowWebhookSenderForTests, WEBHOOK_MAX_ATTEMPTS } from '../../lib/workflow.js';
import { decideApprovalRequest } from '../../lib/approvalRequests.js';
import { flushPendingAudits } from '../../lib/audit.js';

/**
 * The workflow engine: a business event queues a run; the worker executes
 * its steps in order; SET_FIELD writes only allow-listed fields with
 * history; ASSIGN_TASK lands a task a person can finish; WEBHOOK signs,
 * retries and gives up; REQUIRE_APPROVAL pauses the run until a person
 * decides — approval resumes it, rejection cancels what was left.
 */

const inTenant = <T>(fn: () => Promise<T>) => runWithTenant(ALTO_TENANT_ID, 'job', fn);

beforeEach(async () => {
  await truncateAll();
  setWorkflowWebhookSenderForTests(null);
});

afterAll(async () => {
  setWorkflowWebhookSenderForTests(null);
  await prisma.$disconnect();
});

async function definition(trigger: 'ASSOCIATE_HIRED' | 'TIME_OFF_REQUESTED', actions: Array<{ kind: string; params: Record<string, unknown> }>, conditions: Record<string, unknown> = {}) {
  return prisma.workflowDefinition.create({ data: { name: `${trigger} test`, trigger, conditions: conditions as Prisma.InputJsonValue, actions: actions as unknown as Prisma.InputJsonValue } });
}

describe('the workflow engine', () => {
  it('queues a run per matching definition and the worker executes SET_FIELD (with history), ASSIGN_TASK and a notification', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const client = await createClient('Store 1');
    const dept = await prisma.department.create({ data: { clientId: client.id, name: 'Nights' } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await definition('ASSOCIATE_HIRED', [
      { kind: 'SET_FIELD', params: { entity: 'Associate', field: 'departmentId', value: dept.id } },
      { kind: 'SET_FIELD', params: { entity: 'Associate', field: 'firstName', value: 'Mallory' } },
      { kind: 'ASSIGN_TASK', params: { title: 'Welcome {{ associate.firstName }} on day one', assigneeRole: 'HR_ADMINISTRATOR', dueInDays: 3 } },
      { kind: 'SEND_NOTIFICATION', params: { recipientUserId: hr.id, subject: 'Hired: {{ associate.firstName }}', body: 'x' } },
    ]);
    // A definition whose condition does not hold never runs.
    await definition('ASSOCIATE_HIRED', [{ kind: 'CREATE_AUDIT_LOG', params: { action: 'never' } }], { and: [{ field: 'associate.state', op: 'eq', value: 'CA' }] });

    const { runs } = await inTenant(() => emit({ trigger: 'ASSOCIATE_HIRED', entityType: 'Associate', entityId: ana.id, context: { associateId: ana.id, associate: { firstName: 'Ana', state: 'FL' } } }));
    expect(runs).toHaveLength(1);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runs[0] } })).status).toBe('PENDING');

    await inTenant(() => runWorkflowQueue());
    const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runs[0] }, include: { steps: { orderBy: { ordinal: 'asc' } } } });
    // One step refused (firstName is not on the allow-list); the rest still ran.
    expect(run.status).toBe('FAILED');
    expect(run.steps.map((s) => s.status)).toEqual(['COMPLETED', 'FAILED', 'COMPLETED', 'COMPLETED']);
    expect(run.steps[1].failureReason).toContain('not a field a workflow may write');
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: ana.id } })).departmentId).toBe(dept.id);
    expect(await prisma.associateHistory.count({ where: { associateId: ana.id, reason: 'workflow' } })).toBe(1);
    const task = await prisma.workflowTask.findFirstOrThrow({ where: { runId: run.id } });
    expect(task.title).toBe('Welcome Ana on day one');
    expect(task.assigneeRole).toBe('HR_ADMINISTRATOR');
    expect(task.dueAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { recipientUserId: hr.id, subject: 'Hired: Ana' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'never' } })).toBe(0);
  });

  it('WEBHOOK signs the body, retries on a 5xx with backoff, and gives up after the last attempt', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    let status = 503;
    setWorkflowWebhookSenderForTests(async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('', { status });
    });
    await definition('ASSOCIATE_HIRED', [{ kind: 'WEBHOOK', params: { url: 'https://hooks.example.com/alto', secret: 's3cret', event: 'associate.hired' } }]);
    const ana = await createAssociate();
    const now = new Date('2026-10-20T10:00:00Z');
    const { runs } = await inTenant(() => emit({ trigger: 'ASSOCIATE_HIRED', entityType: 'Associate', entityId: ana.id, context: { associateId: ana.id } }));

    await inTenant(() => runWorkflowQueue({ now }));
    let step = await prisma.workflowStep.findFirstOrThrow({ where: { runId: runs[0] } });
    expect(step.status).toBe('PENDING');
    expect(step.attempts).toBe(1);
    expect(step.nextAttemptAt?.toISOString()).toBe('2026-10-20T10:01:00.000Z');
    expect(calls[0].headers['Alto-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(calls[0].body).event).toBe('associate.hired');
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runs[0] } })).status).toBe('RUNNING');

    // Not due yet: nothing happens.
    await inTenant(() => runWorkflowQueue({ now: new Date('2026-10-20T10:00:30Z') }));
    expect(calls).toHaveLength(1);

    // Due, and the endpoint recovered.
    status = 200;
    await inTenant(() => runWorkflowQueue({ now: new Date('2026-10-20T10:02:00Z') }));
    step = await prisma.workflowStep.findFirstOrThrow({ where: { runId: runs[0] } });
    expect(step.status).toBe('COMPLETED');
    expect(calls).toHaveLength(2);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runs[0] } })).status).toBe('COMPLETED');

    // A dead endpoint: the step fails for good after the last attempt.
    status = 503;
    const { runs: dead } = await inTenant(() => emit({ trigger: 'ASSOCIATE_HIRED', entityType: 'Associate', entityId: ana.id, context: {} }));
    let at = new Date('2026-10-21T00:00:00Z');
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i += 1) {
      await inTenant(() => runWorkflowQueue({ now: at }));
      at = new Date(at.getTime() + 3_600_000);
    }
    const deadStep = await prisma.workflowStep.findFirstOrThrow({ where: { runId: dead[0] } });
    expect(deadStep.status).toBe('FAILED');
    expect(deadStep.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: dead[0] } })).status).toBe('FAILED');
  });

  it('REQUIRE_APPROVAL pauses the run; approval resumes it, rejection cancels the steps after the gate', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await definition('ASSOCIATE_HIRED', [
      { kind: 'REQUIRE_APPROVAL', params: { capability: 'manage:org', title: 'Confirm the hire of {{ associate.firstName }}' } },
      { kind: 'CREATE_AUDIT_LOG', params: { action: 'hire.confirmed' } },
    ]);
    const ana = await createAssociate({ firstName: 'Ana' });
    const bob = await createAssociate({ firstName: 'Bob' });
    const ctx = (a: { id: string; firstName: string }) => ({ associateId: a.id, associate: { firstName: a.firstName } });

    const { runs: first } = await inTenant(() => emit({ trigger: 'ASSOCIATE_HIRED', entityType: 'Associate', entityId: ana.id, context: ctx(ana) }));
    await inTenant(() => runWorkflowQueue());
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: first[0] } })).status).toBe('WAITING');
    const gate = await prisma.approvalRequest.findFirstOrThrow({ where: { workflowRunId: first[0] } });
    expect(gate.kind).toBe('WORKFLOW_GATE');
    expect(gate.title).toBe('Confirm the hire of Ana');
    expect(gate.approverCapability).toBe('manage:org');
    // Idle ticks neither re-open the gate nor advance the run.
    await inTenant(() => runWorkflowQueue());
    expect(await prisma.approvalRequest.count({ where: { workflowRunId: first[0] } })).toBe(1);

    await inTenant(() => decideApprovalRequest(prisma, gate.id, { id: hr.id, role: 'HR_ADMINISTRATOR' }, { decision: 'APPROVE' }));
    await inTenant(() => runWorkflowQueue());
    const done = await prisma.workflowRun.findUniqueOrThrow({ where: { id: first[0] }, include: { steps: { orderBy: { ordinal: 'asc' } } } });
    expect(done.status).toBe('COMPLETED');
    expect(done.steps.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED']);
    expect(await prisma.auditLog.count({ where: { action: 'hire.confirmed' } })).toBe(1);

    const { runs: second } = await inTenant(() => emit({ trigger: 'ASSOCIATE_HIRED', entityType: 'Associate', entityId: bob.id, context: ctx(bob) }));
    await inTenant(() => runWorkflowQueue());
    const gate2 = await prisma.approvalRequest.findFirstOrThrow({ where: { workflowRunId: second[0] } });
    await inTenant(() => decideApprovalRequest(prisma, gate2.id, { id: hr.id, role: 'HR_ADMINISTRATOR' }, { decision: 'REJECT', reason: 'Not this week.' }));
    const cancelled = await prisma.workflowRun.findUniqueOrThrow({ where: { id: second[0] }, include: { steps: { orderBy: { ordinal: 'asc' } } } });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.steps.map((s) => s.status)).toEqual(['FAILED', 'SKIPPED']);
    expect(await prisma.auditLog.count({ where: { action: 'hire.confirmed' } })).toBe(1);
    await flushPendingAudits();
  });

  it('dedupes a sweep trigger for the same item within the window', async () => {
    await definition('ASSOCIATE_HIRED', [{ kind: 'CREATE_AUDIT_LOG', params: { action: 'x' } }]);
    const ana = await createAssociate();
    const args = { trigger: 'ASSOCIATE_HIRED' as const, entityType: 'Associate', entityId: ana.id, context: {}, dedupeDays: 7 };
    expect((await inTenant(() => emit(args))).runs).toHaveLength(1);
    expect((await inTenant(() => emit(args))).runs).toHaveLength(0);
  });
});
