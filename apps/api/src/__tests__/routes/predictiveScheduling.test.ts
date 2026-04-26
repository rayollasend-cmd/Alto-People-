import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

async function createClientInState(state: string | null) {
  return prisma.client.create({
    data: {
      name: `Client ${Math.random().toString(36).slice(2, 8)}`,
      industry: 'hospitality',
      status: 'ACTIVE',
      state,
    },
  });
}

const future = (offsetMin: number) =>
  new Date(Date.now() + offsetMin * 60_000).toISOString();

describe('predictive scheduling — POST /scheduling/shifts', () => {
  it('NY shift inside the 14-day window without lateNoticeReason → 400', async () => {
    const client = await createClientInState('NY');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),         // 1 hour out
      endsAt: future(60 * 8),
      hourlyRate: 18.5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('late_notice_reason_required');
  });

  it('NY shift inside the 14-day window WITH reason → 201, persists reason + publishedAt', async () => {
    const client = await createClientInState('NY');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60 * 24),    // 24 hours out
      endsAt: future(60 * 32),
      lateNoticeReason: 'Mutual agreement — associate volunteered to cover Mei sick call',
    });
    expect(res.status).toBe(201);
    expect(res.body.lateNoticeReason).toMatch(/mutual agreement/i);
    expect(res.body.publishedAt).toBeTruthy();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'shift.created', entityId: res.body.id },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit!.metadata)).toContain('lateNotice');
  });

  it('NY shift far in the future (15 days out) → 201 with NO lateNoticeReason needed', async () => {
    const client = await createClientInState('NY');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60 * 24 * 15),
      endsAt: future(60 * 24 * 15 + 60 * 8),
    });
    expect(res.status).toBe(201);
    expect(res.body.lateNoticeReason).toBeNull();
    expect(res.body.publishedAt).toBeTruthy();
  });

  it('CA shift inside the 14-day window → 201 (CA has no fair-workweek law)', async () => {
    const client = await createClientInState('CA');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    expect(res.status).toBe(201);
    expect(res.body.lateNoticeReason).toBeNull();
    expect(res.body.publishedAt).toBeTruthy();
  });

  it('null-state client (federal default) → 201 even inside window', async () => {
    const client = await createClientInState(null);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    expect(res.status).toBe(201);
    expect(res.body.publishedAt).toBeTruthy();
  });

  it('DRAFT shift skips enforcement (not yet published)', async () => {
    const client = await createClientInState('OR');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
      status: 'DRAFT',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.publishedAt).toBeNull();
    expect(res.body.lateNoticeReason).toBeNull();
  });
});

describe('predictive scheduling — PATCH /scheduling/shifts/:id (DRAFT→OPEN transition)', () => {
  it('IL DRAFT→OPEN inside the window without reason → 400', async () => {
    const client = await createClientInState('IL');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const created = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
      status: 'DRAFT',
    });
    expect(created.status).toBe(201);

    const patched = await a.patch(`/scheduling/shifts/${created.body.id}`).send({
      status: 'OPEN',
    });
    expect(patched.status).toBe(400);
    expect(patched.body.error?.code).toBe('late_notice_reason_required');
  });

  it('WA DRAFT→OPEN inside the window WITH reason → 200, stamps publishedAt', async () => {
    const client = await createClientInState('WA');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const created = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Cook',
      startsAt: future(60 * 4),
      endsAt: future(60 * 12),
      status: 'DRAFT',
    });
    const patched = await a.patch(`/scheduling/shifts/${created.body.id}`).send({
      status: 'OPEN',
      lateNoticeReason: 'Emergency — host walked off, need cover tonight',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.publishedAt).toBeTruthy();
    expect(patched.body.lateNoticeReason).toMatch(/emergency/i);
  });

  it('OPEN→ASSIGNED is NOT a re-publish — no late-notice check', async () => {
    const client = await createClientInState('NY');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    // Publish far in the future first so creation succeeds without reason.
    const created = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60 * 24 * 20),
      endsAt: future(60 * 24 * 20 + 60 * 8),
    });
    const originalPublishedAt = created.body.publishedAt;

    const patched = await a.patch(`/scheduling/shifts/${created.body.id}`).send({
      status: 'ASSIGNED',
    });
    expect(patched.status).toBe(200);
    // publishedAt should NOT have been bumped on this transition.
    expect(patched.body.publishedAt).toBe(originalPublishedAt);
  });
});
