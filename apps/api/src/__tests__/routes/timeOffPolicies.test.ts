import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { accruePeriodGrants, accruePolicyLeaveForEntry, resolvePoliciesForAssociate, syncPolicyEntitlements } from '../../lib/timeOffPolicy.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Time-off policies: how leave is earned, for whom; the most specific
 * assignment wins; accrual per hour, per month, and the yearly grant.
 */

const app = () => createApp();
const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

async function person(opts: { hireDaysAgo?: number } = {}) {
  const client = await createClient();
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const associate = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
  await prisma.associate.update({ where: { id: associate.id }, data: { state: 'FL', hireDate: new Date(Date.now() - (opts.hireDaysAgo ?? 400) * DAY) } });
  await prisma.associateAssignment.create({ data: { associateId: associate.id, locationId: site.id, startedAt: new Date(Date.now() - 100 * DAY) } });
  return { client, site, associate };
}

async function approvedEntry(associateId: string, clientId: string, hours: number) {
  const clockIn = new Date('2026-05-04T13:00:00Z');
  return prisma.timeEntry.create({
    data: { associateId, clientId, clockInAt: clockIn, clockOutAt: new Date(clockIn.getTime() + hours * 3_600_000), status: 'APPROVED' },
  });
}

describe('policy resolution and accrual', () => {
  it('earns per hour worked, capped, and a site policy beats the org-wide one', async () => {
    const { client, site, associate } = await person();
    const all = await prisma.timeOffPolicy.create({
      data: { name: 'Vacation — everyone', category: 'VACATION', accrualMode: 'PER_HOUR_WORKED', accrualPerHour: 0.05, assignments: { create: [{ scopeKind: 'ALL' }] } },
    });
    const resolved = await resolvePoliciesForAssociate(prisma, associate.id);
    expect(resolved.get('VACATION')?.id).toBe(all.id);

    const entry = await approvedEntry(associate.id, client.id, 10);
    const out = await accruePolicyLeaveForEntry(prisma, entry.id);
    expect(out).toEqual([{ category: 'VACATION', policyId: all.id, earnedMinutes: 30 }]);
    // Idempotent.
    expect(await accruePolicyLeaveForEntry(prisma, entry.id)).toEqual([]);
    const bal = await prisma.timeOffBalance.findUniqueOrThrow({ where: { associateId_category: { associateId: associate.id, category: 'VACATION' } } });
    expect(bal.balanceMinutes).toBe(30);

    // The site's own, richer policy wins for people there, and caps.
    const siteP = await prisma.timeOffPolicy.create({
      data: { name: 'Vacation — Front Beach', category: 'VACATION', accrualMode: 'PER_HOUR_WORKED', accrualPerHour: 0.1, capMinutes: 60, assignments: { create: [{ scopeKind: 'SITE', scopeId: site.id }] } },
    });
    expect((await resolvePoliciesForAssociate(prisma, associate.id)).get('VACATION')?.id).toBe(siteP.id);
    const e2 = await prisma.timeEntry.create({
      data: { associateId: associate.id, clientId: client.id, clockInAt: new Date('2026-05-05T13:00:00Z'), clockOutAt: new Date('2026-05-05T23:00:00Z'), status: 'APPROVED' },
    });
    const out2 = await accruePolicyLeaveForEntry(prisma, e2.id);
    // 10h × 0.1 = 60 min, but the cap of 60 leaves room for only 30.
    expect(out2[0].earnedMinutes).toBe(30);
  });

  it('waits out the waiting period and raises the rate by tenure', async () => {
    const { client, associate } = await person({ hireDaysAgo: 10 });
    await prisma.timeOffPolicy.create({
      data: {
        name: 'PTO',
        category: 'PTO',
        accrualMode: 'PER_HOUR_WORKED',
        accrualPerHour: 0.05,
        waitingPeriodDays: 90,
        tenureTiers: [{ afterMonths: 12, accrualPerHour: 0.1 }],
        assignments: { create: [{ scopeKind: 'ALL' }] },
      },
    });
    const entry = await approvedEntry(associate.id, client.id, 10);
    expect(await accruePolicyLeaveForEntry(prisma, entry.id)).toEqual([]);
    await prisma.associate.update({ where: { id: associate.id }, data: { hireDate: new Date('2024-01-01T00:00:00Z') } });
    const out = await accruePolicyLeaveForEntry(prisma, entry.id);
    expect(out[0].earnedMinutes).toBe(60);
  });

  it('grants monthly once per month, and keeps the yearly entitlement in step', async () => {
    const { associate } = await person();
    await prisma.timeOffPolicy.create({
      data: { name: 'Bereavement', category: 'BEREAVEMENT', accrualMode: 'PER_PERIOD', minutesPerPeriod: 120, assignments: { create: [{ scopeKind: 'ALL' }] } },
    });
    const now = new Date('2026-10-17T12:00:00Z');
    expect((await accruePeriodGrants(now)).granted).toBe(1);
    expect((await accruePeriodGrants(now)).granted).toBe(0);
    expect((await accruePeriodGrants(new Date('2026-11-02T12:00:00Z'))).granted).toBe(1);
    const bal = await prisma.timeOffBalance.findUniqueOrThrow({ where: { associateId_category: { associateId: associate.id, category: 'BEREAVEMENT' } } });
    expect(bal.balanceMinutes).toBe(240);

    const annual = await prisma.timeOffPolicy.create({
      data: { name: 'Vacation — 80h', category: 'VACATION', accrualMode: 'ANNUAL_GRANT', annualMinutes: 4800, carryoverMaxMinutes: 600, assignments: { create: [{ scopeKind: 'ALL' }] } },
    });
    await syncPolicyEntitlements(prisma, associate.id);
    const ent = await prisma.timeOffEntitlement.findUniqueOrThrow({ where: { associateId_category: { associateId: associate.id, category: 'VACATION' } } });
    expect(ent).toMatchObject({ annualMinutes: 4800, carryoverMaxMinutes: 600, policyId: annual.id });
  });
});

describe('the policies desk', () => {
  it('creates, assigns, lists with scope names, updates and retires', async () => {
    const { client } = await person();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const bad = await agent.post('/time-off/policies').send({ name: 'Broken', category: 'PTO', accrualMode: 'PER_HOUR_WORKED' });
    expect(bad.status).toBe(400);
    const created = await agent.post('/time-off/policies').send({ name: 'PTO — hourly', category: 'PTO', accrualMode: 'PER_HOUR_WORKED', accrualPerHour: 0.0333, capMinutes: 2400 });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const assigned = await agent.put(`/time-off/policies/${id}/assignments`).send({ assignments: [{ scopeKind: 'CLIENT', scopeId: client.id }] });
    expect(assigned.status).toBe(200);
    expect(assigned.body.assignments).toHaveLength(1);
    const list = await agent.get('/time-off/policies');
    expect(list.status).toBe(200);
    expect(list.body.policies).toHaveLength(1);
    expect(list.body.scopeNames[client.id]).toBe(client.name);
    const scopes = await agent.get('/time-off/policies/scopes');
    expect(scopes.body.CLIENT.some((c: { id: string }) => c.id === client.id)).toBe(true);
    const updated = await agent.patch(`/time-off/policies/${id}`).send({ waitingPeriodDays: 30 });
    expect(updated.status).toBe(200);
    expect(updated.body.waitingPeriodDays).toBe(30);
    const gone = await agent.delete(`/time-off/policies/${id}`);
    expect(gone.status).toBe(200);
    expect((await agent.get('/time-off/policies')).body.policies).toHaveLength(0);

    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(assoc.email)).post('/time-off/policies').send({})).status).toBe(403);
  });
});
