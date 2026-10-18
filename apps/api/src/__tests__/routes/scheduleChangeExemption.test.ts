import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { unpaidPremiums } from '../../lib/predictabilityPay.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * A late change the law excuses (the worker asked, a swap, a pick-up, an
 * emergency) can be excused after the fact — with a note, by someone who
 * answers for pay, and only until payroll has paid it. Payroll skips it.
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
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function premium(associateId: string, extra: Record<string, unknown> = {}) {
  return prisma.scheduleChangePremium.create({
    data: { associateId, workDate: new Date('2026-11-02'), change: 'moved', noticeDays: 3, premiumHours: 1, rule: 'Chicago Fair Workweek', live: true, ...extra },
  });
}

describe('excusing a schedule-change premium', () => {
  it('needs a lawful reason and a note, stops payroll paying it, and can be taken back', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const row = await premium(ana.id);
    const a = await loginAs(hr.email);
    const range = [new Date('2026-11-01'), new Date('2026-11-08')] as const;

    expect((await unpaidPremiums(prisma, ALTO_TENANT_ID, [ana.id], ...range)).length).toBe(1);
    expect((await a.patch(`/labor-rules/schedule-changes/${row.id}`).send({ exemptReason: 'BECAUSE' })).status).toBe(400);
    expect((await a.patch(`/labor-rules/schedule-changes/${row.id}`).send({ exemptReason: 'EMPLOYEE_REQUESTED' })).status).toBe(400);

    const ok = await a.patch(`/labor-rules/schedule-changes/${row.id}`).send({ exemptReason: 'EMPLOYEE_REQUESTED', note: 'Asked by text on Tuesday.' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ exempt: true, exemptReason: 'EMPLOYEE_REQUESTED' });
    expect((await unpaidPremiums(prisma, ALTO_TENANT_ID, [ana.id], ...range)).length).toBe(0);

    expect((await a.patch(`/labor-rules/schedule-changes/${row.id}`).send({ exemptReason: null })).body.exempt).toBe(false);
    expect((await unpaidPremiums(prisma, ALTO_TENANT_ID, [ana.id], ...range)).length).toBe(1);
  });

  it('refuses a premium already paid, and people who don’t answer for pay', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', email: 'sup@example.com' });
    const ana = await createAssociate();
    const paid = await premium(ana.id, { payrollRunId: '00000000-0000-4000-8000-0000000000aa' });
    const open = await premium(ana.id);
    const a = await loginAs(hr.email);
    expect((await a.patch(`/labor-rules/schedule-changes/${paid.id}`).send({ exemptReason: 'EMERGENCY', note: 'Storm.' })).status).toBe(409);
    const s = await loginAs(sup.email);
    expect((await s.patch(`/labor-rules/schedule-changes/${open.id}`).send({ exemptReason: 'EMERGENCY', note: 'Storm.' })).status).toBe(403);
  });
});
