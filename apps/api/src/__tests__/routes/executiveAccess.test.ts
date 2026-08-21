import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The Executive/Chairman contract: read everything strategic, write
 * nothing. Pins the privilege-escalation fix (user-admin and branding
 * writes used to be gated on view:hr-admin, which the "read-only" role
 * holds) and the view:executive read unlocks (labor telemetry, client
 * statements, pulse results, the executive summary + board pack).
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a
    .post('/auth/login')
    .send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

describe('executive is truly read-only', () => {
  it('cannot change users, unlock accounts, force resets, or edit branding', async () => {
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const { user: victim } = await createUser({ role: 'ASSOCIATE' });
    const agent = await loginAs(exec.email);

    const promote = await agent
      .patch(`/admin/users/${victim.id}`)
      .send({ role: 'HR_ADMINISTRATOR' });
    expect(promote.status).toBe(403);

    const unlock = await agent.post(`/admin/users/${victim.id}/unlock`);
    expect(unlock.status).toBe(403);

    const reset = await agent.post(`/admin/users/${victim.id}/force-password-reset`);
    expect(reset.status).toBe(403);

    const brand = await agent
      .patch('/admin/org/settings')
      .send({ orgName: 'Hijacked Inc' });
    expect(brand.status).toBe(403);

    // The victim's role is untouched.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(after.role).toBe('ASSOCIATE');

    // Reads still work: the user list stays visible.
    const list = await agent.get('/admin/users');
    expect(list.status).toBe(200);
  });

  it('HR admin can still manage users after the gate change', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const agent = await loginAs(hr.email);
    const res = await agent
      .patch(`/admin/users/${target.id}`)
      .send({ status: 'DISABLED' });
    expect(res.status).toBe(200);
  });
});

describe('executive read unlocks', () => {
  it('reads labor telemetry, statements, and the executive summary; writes still 403', async () => {
    const client = await createClient();
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const agent = await loginAs(exec.email);

    expect((await agent.get('/scheduling/floor-now')).status).toBe(200);
    expect((await agent.get('/scheduling/ot-outlook')).status).toBe(200);
    expect((await agent.get('/scheduling/kpis')).status).toBe(200);
    expect((await agent.get(`/clients/${client.id}/statements`)).status).toBe(200);
    expect((await agent.get('/pulse-surveys')).status).toBe(200);

    const summary = await agent.get('/executive/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.workforce).toBeDefined();
    expect(summary.body.lastWeek.workedHours).toBeDefined();

    const pack = await agent.get('/executive/board-pack.pdf');
    expect(pack.status).toBe(200);
    expect(pack.headers['content-type']).toContain('application/pdf');

    // Statement drafting stays with payroll.
    const draft = await agent
      .post(`/clients/${client.id}/statements`)
      .send({ periodStart: '2026-07-01', periodEnd: '2026-07-31' });
    expect(draft.status).toBe(403);
    // Survey creation stays with manage:org.
    const survey = await agent
      .post('/pulse-surveys')
      .send({ question: 'How are we doing?', closesAt: new Date(Date.now() + 86400000).toISOString() });
    expect(survey.status).toBe(403);
  });

  it('command center: receivables, targets, pipeline — exec reads, admins write', async () => {
    const client = await createClient();
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const execAgent = await loginAs(exec.email);
    const hrAgent = await loginAs(hr.email);

    // An old unpaid FINAL statement lands in receivables aged 60+.
    const stmt = await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        periodEnd: new Date('2026-05-31T00:00:00Z'),
        status: 'FINAL',
        number: 77,
        finalizedAt: new Date(Date.now() - 70 * 86_400_000),
        snapshot: { totals: { amount: 1234.56 } },
      },
    });
    const recv = await execAgent.get('/executive/receivables');
    expect(recv.status).toBe(200);
    expect(recv.body.totals.outstandingCount).toBe(1);
    expect(recv.body.totals.aging.days60plus).toBeCloseTo(1234.56, 2);

    // Exec cannot record payment; payroll can — and it clears the AR.
    expect(
      (await execAgent.post(`/clients/${client.id}/statements/${stmt.id}/mark-paid`)).status,
    ).toBe(403);
    const paid = await hrAgent
      .post(`/clients/${client.id}/statements/${stmt.id}/mark-paid`)
      .send({ paymentRef: 'ACH-889' });
    expect(paid.status).toBe(200);
    expect(paid.body.paidAt).not.toBeNull();
    const recv2 = await execAgent.get('/executive/receivables');
    expect(recv2.body.totals.outstandingCount).toBe(0);
    expect(recv2.body.totals.avgDaysToPay).toBeGreaterThan(0);

    // Targets: exec reads, cannot write; admin sets, pace shows up.
    const q = `${new Date().getUTCFullYear()}-Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`;
    expect(
      (await execAgent.put('/executive/targets').send({ quarter: q, revenueTarget: 100000 }))
        .status,
    ).toBe(403);
    expect(
      (await hrAgent.put('/executive/targets').send({ quarter: q, revenueTarget: 100000, marginTarget: 25000 }))
        .status,
    ).toBe(200);
    const targets = await execAgent.get('/executive/targets');
    expect(targets.status).toBe(200);
    expect(targets.body.targets.revenueTarget).toBe(100000);
    expect(targets.body.actuals.headcount).toBeDefined();

    // Pipeline: admin writes, exec reads, exec cannot write.
    expect(
      (await execAgent.post('/executive/prospects').send({ name: 'Target PCB' })).status,
    ).toBe(403);
    const created = await hrAgent
      .post('/executive/prospects')
      .send({ name: 'Target PCB', estWeeklyHours: 200, estBillRate: 22 });
    expect(created.status).toBe(201);
    const list = await execAgent.get('/executive/prospects');
    expect(list.status).toBe(200);
    expect(list.body.prospects).toHaveLength(1);
    expect(list.body.prospects[0].stage).toBe('LEAD');

    // Summary carries the new intelligence blocks.
    const summary = await execAgent.get('/executive/summary');
    expect(summary.body.rates.billRate).toBeGreaterThan(0);
    expect(summary.body.turnover.costPerSeparation).toBeGreaterThan(0);
    expect(Array.isArray(summary.body.league)).toBe(true);
    expect(Array.isArray(summary.body.concentration)).toBe(true);
  });

  it('a client-scoped supervisor cannot read the executive surfaces', async () => {
    const client = await createClient();
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const agent = await loginAs(sup.email);
    expect((await agent.get('/executive/summary')).status).toBe(403);
    expect((await agent.get('/executive/board-pack.pdf')).status).toBe(403);
  });
});
