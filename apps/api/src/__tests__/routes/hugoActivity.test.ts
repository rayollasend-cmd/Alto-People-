import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { HugoActivityItem } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * "See everything Hugo did" (GET /hugo/activity, lib/hugoActivity): the
 * person's own history, newest first — every line on their tasks' trails,
 * notes they accepted or put away, actions they confirmed through him, the
 * moment this period's allowance ran out. Only their rows; paged by a
 * cursor that never skips or repeats a line, even when two share a moment.
 */

const app = () => createApp();
const MIN = 60_000;
const H = 60 * MIN;

beforeEach(async () => {
  await truncateAll();
  await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@example.com' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function person(first: string) {
  const a = await createAssociate({ firstName: first, lastName: 'Test' });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
  return user;
}

/** One person's Hugo history, at known moments from t0. */
async function history(userId: string, t0: number, tag: string) {
  const task = await prisma.hugoTask.create({
    data: { userId, kind: 'WATCH_PAYCHECK', status: 'DONE', params: { kind: 'WATCH_PAYCHECK', key: 'WATCH_PAYCHECK' }, subject: {}, expiresAt: new Date(t0 + 30 * 24 * H), completedAt: new Date(t0 + H), linkUrl: '/payroll' },
  });
  const ev = (code: string, at: number, data: Record<string, unknown> = {}) => prisma.hugoTaskEvent.create({ data: { taskId: task.id, code, data: data as object, createdAt: new Date(at) } });
  const started = await ev('STARTED', t0);
  const paid = await ev('PAID', t0 + H, { periodStart: '2026-10-10', periodEnd: '2026-10-23' });
  // Two lines in the same millisecond: the page boundary must not split them wrongly.
  const tieA = await ev('DONE', t0 + 2 * H);
  const tieB = await ev('EXPIRED', t0 + 2 * H);
  // A goal's thinking step is bookkeeping, not something done for them.
  const goal = await prisma.hugoTask.create({ data: { userId, kind: 'GOAL', status: 'WAITING', params: {}, subject: { goal: `${tag} goal` }, expiresAt: new Date(t0 + 14 * 24 * H) } });
  await prisma.hugoTaskEvent.create({ data: { taskId: goal.id, code: 'STEP', data: { tier: 'fast' }, createdAt: new Date(t0 + 150 * MIN) } });
  const delivered = await prisma.hugoTaskEvent.create({ data: { taskId: goal.id, code: 'UPDATE', data: { text: `${tag} update` }, createdAt: new Date(t0 + 160 * MIN) } });
  const dismissed = await prisma.hugoNote.create({ data: { userId, kind: 'DIRECT_DEPOSIT_MISSING', subjectKey: `${tag}-dd`, data: { payday: '2026-10-30' }, status: 'DISMISSED', actedAt: new Date(t0 + 30 * MIN), expiresAt: new Date(t0 + 7 * 24 * H) } });
  const accepted = await prisma.hugoNote.create({ data: { userId, kind: 'OPEN_SHIFT_MATCH', subjectKey: `${tag}-os`, data: {}, status: 'ACCEPTED', actedAt: new Date(t0 + 90 * MIN), expiresAt: new Date(t0 + 7 * 24 * H) } });
  // A note still new is not something they did.
  await prisma.hugoNote.create({ data: { userId, kind: 'CREDENTIAL_EXPIRING', subjectKey: `${tag}-cr`, data: {}, status: 'NEW', expiresAt: new Date(t0 + 7 * 24 * H) } });
  const act = (status: 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'PROPOSED', resultStatus: number | null, at: number, result: object = {}) =>
    prisma.assistantAction.create({ data: { userId, kind: 'call_out', params: {}, title: `${tag} call out of Friday`, status, resultStatus, result, expiresAt: new Date(at + 10 * MIN), decidedAt: status === 'PROPOSED' ? null : new Date(at) } });
  const done = await act('CONFIRMED', 201, t0 + 3 * H);
  const pending = await act('CONFIRMED', 202, t0 + 4 * H, { pending: true });
  const failed = await act('FAILED', 409, t0 + 5 * H);
  await act('CANCELLED', null, t0 + 5 * H + MIN);
  await act('PROPOSED', null, t0 + 5 * H + 2 * MIN);
  return { task, started, paid, tieA, tieB, delivered, dismissed, accepted, done, pending, failed };
}

describe('GET /hugo/activity', () => {
  it('lists only the caller’s history, newest first, from every source — and pages it without a gap or a repeat', async () => {
    const ana = await person('Ana');
    const ben = await person('Ben');
    const t0 = Date.now() - 8 * H;
    const a = await history(ana.id, t0, 'Ana');
    const b = await history(ben.id, t0 + MIN, 'Ben');
    // Ana's allowance ran out on her second call.
    await prisma.hugoProfile.create({ data: { userId: ana.id, allowanceCycleStartedAt: new Date(t0 - 24 * H) } });
    await prisma.hugoUsage.create({ data: { userId: ana.id, purpose: 'chat', tier: 'fast', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 600_000, createdAt: new Date(t0 + 6 * H) } });
    const crossed = await prisma.hugoUsage.create({ data: { userId: ana.id, purpose: 'recurring', tier: 'fast', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 500_000, createdAt: new Date(t0 + 7 * H) } });

    const agent = await loginAs(ana.email);
    const all = await agent.get('/hugo/activity?limit=100');
    expect(all.status).toBe(200);
    const items = all.body.items as HugoActivityItem[];
    expect(all.body.next).toBeNull();
    const [tieFirst, tieSecond] = [a.tieA.id, a.tieB.id].sort().reverse();
    expect(items.map((i) => `${i.kind}:${i.code}:${i.id}`)).toEqual([
      `usage:USED_UP:${crossed.id}`,
      `action:FAILED:${a.failed.id}`,
      `action:SENT_FOR_APPROVAL:${a.pending.id}`,
      `action:DONE:${a.done.id}`,
      `task:UPDATE:${a.delivered.id}`,
      `task:${tieFirst === a.tieA.id ? 'DONE' : 'EXPIRED'}:${tieFirst}`,
      `task:${tieSecond === a.tieA.id ? 'DONE' : 'EXPIRED'}:${tieSecond}`,
      `note:ACCEPTED:${a.accepted.id}`,
      `task:PAID:${a.paid.id}`,
      `note:DISMISSED:${a.dismissed.id}`,
      `task:STARTED:${a.started.id}`,
    ]);
    // Each line names what it is about — and nothing of Ben's.
    expect(items.find((i) => i.id === a.paid.id)).toMatchObject({ task: { id: a.task.id, kind: 'WATCH_PAYCHECK' }, data: { periodStart: '2026-10-10' }, linkUrl: '/payroll' });
    expect(items.find((i) => i.id === a.dismissed.id)).toMatchObject({ note: { kind: 'DIRECT_DEPOSIT_MISSING', data: { payday: '2026-10-30' } } });
    expect(items.find((i) => i.id === a.done.id)).toMatchObject({ data: { title: 'Ana call out of Friday', action: 'call_out' }, linkUrl: '/' });
    expect(items.find((i) => i.id === a.failed.id)!.linkUrl).toBeNull();
    const text = JSON.stringify(all.body);
    for (const id of Object.values(b).map((x) => x.id)) expect(text).not.toContain(id);
    expect(text).not.toContain('Ben');

    // Page by page, three at a time: the same lines, in the same order, once each.
    const paged: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await agent.get(`/hugo/activity?limit=3${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      expect(r.status).toBe(200);
      paged.push(...(r.body.items as HugoActivityItem[]).map((x) => x.id));
      before = r.body.next;
      if (!before) break;
    }
    expect(paged).toEqual(items.map((x) => x.id));

    // Ben sees his own, none of Ana's.
    const benAll = (await (await loginAs(ben.email)).get('/hugo/activity')).body;
    expect(benAll.items.map((i: HugoActivityItem) => i.id)).toEqual(expect.arrayContaining([b.paid.id, b.done.id]));
    const benText = JSON.stringify(benAll);
    for (const id of [...Object.values(a).map((x) => x.id), crossed.id]) expect(benText).not.toContain(id);
  });

  it('refuses a bad page marker, and an account the assistant doesn’t serve', async () => {
    const ana = await person('Ana');
    const agent = await loginAs(ana.email);
    expect((await agent.get('/hugo/activity?before=yesterday')).status).toBe(400);
    expect((await agent.get('/hugo/activity?before=2026-10-29T10:00:00.000Z~not-an-id')).status).toBe(400);
    expect((await agent.get('/hugo/activity?limit=500')).status).toBe(400);
    // A bare time is a fine marker too.
    expect((await agent.get(`/hugo/activity?before=${encodeURIComponent(new Date().toISOString())}`)).status).toBe(200);
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL' });
    expect((await (await loginAs(portal.email)).get('/hugo/activity')).status).toBe(403);
  });
});
