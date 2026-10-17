import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

const sent = vi.hoisted(() => [] as Array<{ to: string | null; body: string }>);
vi.mock('../../lib/notifications.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/notifications.js')>();
  return {
    ...real,
    send: vi.fn(async (input: Parameters<typeof real.send>[0]) => {
      sent.push({ to: input.recipient.email, body: input.body });
      return { externalRef: 'test', status: 'SENT' as const };
    }),
  };
});

import { createApp } from '../../app.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { inSendWindow, quarterOf } from '../../lib/clientNps.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The executive's two new numbers: client NPS (one question a quarter to
 * every store manager, answered outside the portal) and agent ROI.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
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

const tokens = () => sent.map((s) => s.body.match(/\/nps\/([A-Za-z0-9_-]+)/)?.[1]).filter(Boolean) as string[];

describe('client NPS', () => {
  it('quarters and the send window', () => {
    expect(quarterOf(new Date('2026-10-17T00:00:00Z'))).toBe('2026-Q4');
    expect(inSendWindow(new Date('2026-10-03T00:00:00Z'))).toBe(true);
    expect(inSendWindow(new Date('2026-11-03T00:00:00Z'))).toBe(false);
  });

  it('one wave a quarter to every store manager; they answer on a signed link; the executive reads it per client', async () => {
    const walmart = await createClient('Walmart');
    const target = await createClient('Target');
    const { user: w } = await createUser({ role: 'CLIENT_PORTAL', clientId: walmart.id });
    await createUser({ role: 'CLIENT_PORTAL', clientId: target.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = await loginAs(hr.email);

    const s = await h.post('/executive/nps/send').send({});
    expect(s.status).toBe(201);
    expect(s.body.invited).toBe(2);
    expect((await h.post('/executive/nps/send').send({})).status).toBe(409);
    const [t1, t2] = tokens();
    expect(t1 && t2).toBeTruthy();

    // Outside the portal, no login.
    const page = await request(app()).get(`/nps/${t1}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ answered: false, closed: false });
    expect((await request(app()).post(`/nps/${t1}`).send({ score: 10, comment: 'Great crew.' })).status).toBe(200);
    expect((await request(app()).post(`/nps/${t2}`).send({ score: 4 })).status).toBe(200);
    expect((await request(app()).post(`/nps/${t2}`).send({ score: 11 })).status).toBe(400);

    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const e = await loginAs(exec.email);
    const r = await e.get('/executive/nps');
    expect(r.status).toBe(200);
    expect(r.body.current).toMatchObject({ invited: 2, responded: 2, promoters: 1, detractors: 1, nps: 0 });
    expect(r.body.byClient.map((c: { clientName: string; nps: number }) => [c.clientName, c.nps]).sort()).toEqual([['Target', -100], ['Walmart', 100]]);
    expect(r.body.comments[0]).toMatchObject({ comment: 'Great crew.', score: 10 });
    // The executive reads; only manage:clients sends.
    expect((await e.post('/executive/nps/remind')).status).toBe(403);
    // The store manager's portal account cannot read the results.
    expect((await (await loginAs(w.email)).get('/executive/nps')).status).toBe(403);
  });
});

describe('agent ROI', () => {
  it('hours saved from accepted proposals and assistant answers, against reported spend', async () => {
    await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@example.com' });
    await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
    const agent = await prisma.agentProfile.findFirstOrThrow({ where: { builtInKey: { not: 'whatsapp-assistant' } } });
    await prisma.agentProposal.createMany({
      data: [
        { workerId: agent.workerId, capabilityKey: 'shift.fill', subjectType: 'Shift', payload: {}, status: 'EXECUTED' },
        { workerId: agent.workerId, capabilityKey: 'shift.fill', subjectType: 'Shift', payload: {}, status: 'APPROVED' },
        { workerId: agent.workerId, capabilityKey: 'shift.fill', subjectType: 'Shift', payload: {}, status: 'REJECTED' },
      ],
    });
    await prisma.agentSpend.create({ data: { workerId: agent.workerId, amountCents: 500 } });
    await prisma.auditLog.createMany({
      data: [
        { action: 'hugo.asked', entityType: 'Hugo', entityId: 'MODEL', metadata: { source: 'model' } },
        { action: 'hugo.asked', entityType: 'Hugo', entityId: 'DESK', metadata: { source: 'rules' } },
      ],
    });
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const r = await (await loginAs(exec.email)).get('/executive/agent-roi');
    expect(r.status).toBe(200);
    expect(r.body.proposals).toMatchObject({ filed: 3, accepted: 2, rejected: 1, acceptancePct: 67 });
    expect(r.body.assistant).toMatchObject({ answers: 2, modelAnswers: 1 });
    // 2 × 25 min (shift.fill) + 4 + 2 min of answers = 56 min ≈ 0.9 h.
    expect(r.body.hoursSaved).toBe(0.9);
    // 500 reported + 4 cents for the model answer.
    expect(r.body.costCents).toBe(504);
    expect(r.body.estimate).toBe(true);

    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(assoc.email)).get('/executive/agent-roi')).status).toBe(403);
  });
});
