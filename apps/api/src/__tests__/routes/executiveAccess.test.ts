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
