import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The insight pages' data: expirations by the shift they block, people
 * analytics by store and tenure, and the staffing plan — each inside the
 * caller's reach.
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
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function store(name: string) {
  const client = await createClient(name);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  return { client, site };
}

async function placed(first: string, siteId: string) {
  const a = await createAssociate({ firstName: first, lastName: 'Test' });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: siteId, startedAt: new Date(Date.now() - 30 * DAY) } });
  return a;
}

describe('GET /expirations/risk', () => {
  it('names the shift each lapse blocks, by the shift’s rule or the site’s; drops former people and ancient lapses', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { client, site } = await store('Coastal');
    const food = await prisma.qualification.create({ data: { code: 'FOOD', name: 'Food handler', isCert: true } });
    const forklift = await prisma.qualification.create({ data: { code: 'FORK', name: 'Forklift', isCert: true } });
    const ana = await placed('Ana', site.id);
    const ben = await placed('Ben', site.id);
    const gone = await placed('Gil', site.id);
    await prisma.associate.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } });
    const soon = new Date(Date.now() + 5 * DAY);
    await prisma.associateQualification.create({ data: { associateId: ana.id, qualificationId: food.id, expiresAt: soon } });
    await prisma.associateQualification.create({ data: { associateId: ben.id, qualificationId: forklift.id, expiresAt: soon } });
    await prisma.associateQualification.create({ data: { associateId: gone.id, qualificationId: food.id, expiresAt: soon } });
    await prisma.associateQualification.create({ data: { associateId: ben.id, qualificationId: food.id, expiresAt: new Date(Date.now() - 400 * DAY) } });
    // Ana's shift requires the card itself; the store requires forklift of everyone.
    const at = new Date(Date.now() + 10 * DAY);
    const anaShift = await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Cook', startsAt: at, endsAt: new Date(at.getTime() + 8 * 3_600_000), status: 'ASSIGNED', assignedAssociateId: ana.id } });
    await prisma.shiftQualificationRequirement.create({ data: { shiftId: anaShift.id, qualificationId: food.id } });
    await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Stocker', startsAt: at, endsAt: new Date(at.getTime() + 8 * 3_600_000), status: 'ASSIGNED', assignedAssociateId: ben.id } });
    await prisma.credentialRequirement.create({ data: { kind: 'QUALIFICATION', qualificationId: forklift.id, locationId: site.id, label: 'Forklift' } });

    const a = await loginAs(hr.email);
    const res = await a.get('/expirations/risk?days=90');
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ id: string; associateName: string; qualificationName: string; storeName: string; blockingShift: { requiredBy: string } | null }>;
    expect(items.map((i) => i.associateName).sort()).toEqual(['Ana Test', 'Ben Test']);
    const anaItem = items.find((i) => i.associateName === 'Ana Test')!;
    const benItem = items.find((i) => i.associateName === 'Ben Test')!;
    expect(anaItem.storeName).toBe(site.name);
    expect(anaItem.blockingShift?.requiredBy).toBe('shift');
    expect(benItem.blockingShift?.requiredBy).toBe('site');
    expect(res.body.atRisk).toHaveLength(2);
    const row = (res.body.timeline as Array<{ storeId: string; perWeek: number[] }>).find((r) => r.storeId === site.id)!;
    expect(row.perWeek.reduce((s, n) => s + n, 0)).toBe(2);
  });

  it('a site-bound office account sees only its sites’ people', async () => {
    const north = await store('North');
    const south = await store('South');
    const q = await prisma.qualification.create({ data: { code: 'Q', name: 'Card' } });
    const n = await placed('Nia', north.site.id);
    const s = await placed('Sam', south.site.id);
    for (const p of [n, s]) await prisma.associateQualification.create({ data: { associateId: p.id, qualificationId: q.id, expiresAt: new Date(Date.now() + 3 * DAY) } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops@example.com' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [north.site.id] } });
    const a = await loginAs(ops.email);
    const names = ((await a.get('/expirations/risk')).body.items as Array<{ associateName: string }>).map((i) => i.associateName);
    expect(names).toEqual(['Nia Test']);
  });
});

describe('GET /people-analytics — the staffing cut', () => {
  it('splits separations by store and how long they had been there; survival curves by cohort', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { site } = await store('Coastal');
    const quick = await placed('Quin', site.id);
    const hired = new Date(Date.now() - 40 * DAY);
    await prisma.associate.update({ where: { id: quick.id }, data: { hireDate: hired, separatedAt: new Date(hired.getTime() + 3 * DAY) } });
    await placed('Stay', site.id);
    const a = await loginAs(hr.email);
    const res = await a.get('/people-analytics?months=3');
    expect(res.status).toBe(200);
    const row = (res.body.turnoverGrid.rows as Array<{ storeId: string; bands: number[]; separations: number }>).find((r) => r.storeId === site.id)!;
    expect(row.separations).toBe(1);
    expect(row.bands[0]).toBe(1); // the first week
    expect(res.body.turnoverGrid.bands.map((b: { key: string }) => b.key)).toEqual(['week1', 'weeks2to4', 'months2to3', 'later']);
    expect(Array.isArray(res.body.survival)).toBe(true);
    expect(res.body.absenceTrend).toHaveLength(3);
    expect(res.body.timeToFill.byClient).toBeDefined();
  });
});

describe('GET /headcount/staffing-plan', () => {
  it('heads required from the store’s targets against heads placed, priced at the bill rate', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { client, site } = await store('Coastal');
    await prisma.staffingTarget.create({ data: { locationId: site.id, targetCount: 10, effectiveFrom: new Date(Date.now() - 10 * DAY) } });
    await placed('Ana', site.id);
    await placed('Ben', site.id);
    await prisma.shiftRateDefault.create({ data: { clientId: client.id, position: 'Stocker', payRate: 15, billRate: 25, effectiveFrom: new Date(Date.now() - 10 * DAY) } });

    const a = await loginAs(hr.email);
    const res = await a.get('/headcount/staffing-plan?weeks=4');
    expect(res.status).toBe(200);
    expect(res.body.weeks).toHaveLength(4);
    const st = (res.body.stores as Array<{ storeId: string; placed: number; weeks: Array<{ required: number; gap: number; hours: number; budget: number | null; source: string }> }>).find((s) => s.storeId === site.id)!;
    // 10 on the floor a day → 70 slots → 14 people at 5 shifts each → 16 with the 10% reserve.
    expect(st.weeks[0]).toMatchObject({ required: 16, gap: 14, hours: 560, budget: 14_000, source: 'targets' });
    expect(st.placed).toBe(2);
    expect(res.body.priced).toBe(1);
  });

  it('a site-bound account plans only its own stores', async () => {
    const north = await store('North');
    await store('South');
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops@example.com' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [north.site.id] } });
    const a = await loginAs(ops.email);
    const ids = ((await a.get('/headcount/staffing-plan')).body.stores as Array<{ storeId: string }>).map((s) => s.storeId);
    expect(ids).toEqual([north.site.id]);
  });
});
