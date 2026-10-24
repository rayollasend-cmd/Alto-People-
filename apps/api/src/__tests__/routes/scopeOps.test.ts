import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { pinMidweekNoon } from '../../../test/clock.js';

/**
 * Reach on the operations, compliance and executive surfaces. One tenant,
 * two clients: North (stores N, in reach; and N2, out) and South (store S,
 * out). A site-scoped office account bound to N sees N's people only — on
 * every list, count and badge — never a second tenant's rows, never a
 * deactivated person where the list is of the employed, and a capped list
 * says it was capped.
 */

const app = () => createApp();
const T2 = '22222222-2222-4222-8222-222222222222';

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed ${email}: ${r.status}`);
  return a;
}

interface World {
  north: { id: string };
  south: { id: string };
  n: string;
  n2: string;
  s: string;
  nia: { id: string };
  sam: { id: string };
  gone: { id: string };
  other: { id: string };
  scoped: TestAgent<Test>;
  hr: TestAgent<Test>;
}

let w: World;

async function world(): Promise<World> {
  await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'tenant-two', name: 'Tenant Two' }, update: {} });
  const north = await prisma.client.create({ data: { name: 'North Co' } });
  const south = await prisma.client.create({ data: { name: 'South Co' } });
  const site = (name: string, clientId: string) => prisma.site.create({ data: { name, clientId, timezone: 'America/Chicago' } });
  const [n, n2, s] = await Promise.all([site('North One', north.id), site('North Two', north.id), site('South One', south.id)]);
  const nia = await createAssociate({ firstName: 'Nia', lastName: 'North' });
  const sam = await createAssociate({ firstName: 'Sam', lastName: 'South' });
  const gone = await createAssociate({ firstName: 'Gil', lastName: 'Gone' });
  const other = await createAssociate({ firstName: 'Ola', lastName: 'Other' });
  await prisma.associate.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } });
  await prisma.associate.update({ where: { id: other.id }, data: { tenantId: T2 } });
  const assign = (associateId: string, locationId: string) => prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: new Date('2026-01-01') } });
  await Promise.all([assign(nia.id, n.id), assign(sam.id, s.id), assign(gone.id, n.id)]);

  // Fresh addresses each test: the sign-in limiter counts per address.
  const tag = Math.random().toString(36).slice(2, 8);
  const { user: scopedUser } = await createUser({ role: 'HR_ADMINISTRATOR', email: `scoped-${tag}@example.com` });
  await prisma.user.update({ where: { id: scopedUser.id }, data: { scopeSiteIds: [n.id] } });
  const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR', email: `hr-${tag}@example.com` });
  return { north, south, n: n.id, n2: n2.id, s: s.id, nia, sam, gone, other, scoped: await loginAs(scopedUser.email), hr: await loginAs(hrUser.email) };
}

beforeEach(async () => {
  await truncateAll();
  w = await world();
});

const names = (rows: Array<{ associateName?: string; firstName?: string }>) => rows.map((r) => r.associateName ?? r.firstName);

describe('scheduling', () => {
  it('the roster and availability are the caller’s sites only; naming another store reads empty', async () => {
    const roster = await w.scoped.get('/scheduling/associates');
    expect(roster.status).toBe(200);
    const ids = roster.body.associates.map((a: { id: string }) => a.id);
    expect(ids).toContain(w.nia.id);
    expect(ids).not.toContain(w.sam.id);
    expect((await w.scoped.get(`/scheduling/associates?locationId=${w.s}`)).body.associates).toEqual([]);

    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    const avail = await w.scoped.get(`/scheduling/availability-overview?from=${from}&to=${to}`);
    expect(avail.status).toBe(200);
    const availIds = avail.body.associates.map((a: { associateId: string }) => a.associateId);
    expect(availIds).toContain(w.nia.id);
    expect(availIds).not.toContain(w.sam.id);
    expect(avail.body.truncated).toBe(false);
  });

  it('floor, targets, OT outlook and store trends never show a store out of reach', async () => {
    pinMidweekNoon();
    const floor = await w.scoped.get('/scheduling/floor-now');
    expect(floor.status).toBe(200);
    expect(floor.body.rows.map((r: { locationId: string }) => r.locationId)).not.toContain(w.s);
    const targets = await w.scoped.get('/scheduling/staffing-targets');
    const targetIds = targets.body.locations.map((l: { locationId: string }) => l.locationId);
    expect(targetIds).toContain(w.n);
    expect(targetIds).not.toContain(w.s);
    expect(targetIds).not.toContain(w.n2);

    // A shift this week for each — the radar names only Nia.
    const soon = new Date(Date.now() + 2 * 3_600_000);
    for (const [associateId, locationId, clientId] of [[w.nia.id, w.n, w.north.id], [w.sam.id, w.s, w.south.id]] as const) {
      await prisma.shift.create({ data: { clientId, locationId, position: 'Cashier', startsAt: soon, endsAt: new Date(soon.getTime() + 50 * 3_600_000), status: 'ASSIGNED', assignedAssociateId: associateId } });
    }
    const ot = await w.scoped.get('/scheduling/ot-outlook');
    expect(ot.status).toBe(200);
    const otNames = ot.body.rows.map((r: { associateName: string }) => r.associateName).join(' ');
    expect(otNames).not.toContain('Sam');
    expect(ot.body.truncated).toBe(false);

    const lastWeek = new Date(Date.now() - 8 * 86_400_000);
    for (const [associateId, locationId, clientId] of [[w.nia.id, w.n, w.north.id], [w.sam.id, w.s, w.south.id]] as const) {
      await prisma.timeEntry.create({ data: { associateId, locationId, clientId, clockInAt: lastWeek, clockOutAt: new Date(lastWeek.getTime() + 8 * 3_600_000), status: 'APPROVED' } });
    }
    const trends = await w.scoped.get('/scheduling/store-trends');
    expect(trends.status).toBe(200);
    expect(trends.body.stores.map((st: { locationId: string }) => st.locationId)).not.toContain(w.s);
    expect(trends.body.truncated).toBe(false);
  });
});

describe('expirations', () => {
  it('the caller’s employed people only, and old lapses never crowd out what is due soon', async () => {
    const q = await prisma.qualification.create({ data: { code: 'FORK', name: 'Forklift', isCert: true } });
    const soon = new Date(Date.now() + 5 * 86_400_000);
    for (const a of [w.nia, w.sam, w.gone, w.other]) {
      await prisma.associateQualification.create({ data: { associateId: a.id, qualificationId: q.id, expiresAt: soon } });
    }
    // 501 long-lapsed rows for Nia — once, the oldest-first cap emptied "due soon".
    // (one per qualification: a person holds each qualification once).
    await prisma.qualification.createMany({ data: Array.from({ length: 501 }, (_, i) => ({ code: `OLD${i}`, name: `Old ${i}` })) });
    const olds = await prisma.qualification.findMany({ where: { code: { startsWith: 'OLD' } }, select: { id: true } });
    await prisma.associateQualification.createMany({
      data: olds.map((o, i) => ({ associateId: w.nia.id, qualificationId: o.id, expiresAt: new Date(Date.UTC(2020, 0, 1 + i)) })),
    });

    const scoped = await w.scoped.get('/expirations');
    expect(scoped.status).toBe(200);
    expect(names(scoped.body.dueSoon)).toEqual(['Nia North']);
    expect(scoped.body.counts).toMatchObject({ expired: 501, dueSoon: 1 });
    expect(scoped.body.truncated.expired).toBe(true);

    const hr = await w.hr.get('/expirations');
    expect(names(hr.body.dueSoon).sort()).toEqual(['Nia North', 'Sam South']);

    const inbox = await w.scoped.get('/me/inbox');
    const exp = inbox.body.sources.find((s: { key: string }) => s.key === 'expirations');
    expect(exp?.count).toBe(502);
  });

  it('expiring courses: the coming ones are never pushed out by years of lapses', async () => {
    const course = await prisma.course.create({ data: { title: 'Food safety' } });
    await prisma.courseEnrollment.create({ data: { courseId: course.id, associateId: w.nia.id, status: 'COMPLETED', expiresAt: new Date(Date.now() + 3 * 86_400_000) } });
    await prisma.courseEnrollment.create({ data: { courseId: course.id, associateId: w.sam.id, status: 'COMPLETED', expiresAt: new Date(Date.now() + 3 * 86_400_000) } });
    const res = await w.scoped.get('/lms/expiring');
    expect(res.status).toBe(200);
    expect(res.body.expiring.map((e: { associateName: string }) => e.associateName)).toEqual(['Nia North']);
    expect(res.body.counts).toMatchObject({ expiring: 1, lapsed: 0 });
  });
});

describe('compliance', () => {
  it('I-9 and J-1 lists are the caller’s people, and say when capped', async () => {
    await prisma.i9Verification.create({ data: { associateId: w.nia.id } });
    await prisma.i9Verification.create({ data: { associateId: w.sam.id } });
    const i9 = await w.scoped.get('/compliance/i9');
    expect(i9.status).toBe(200);
    expect(i9.body.i9s.map((r: { associateId: string }) => r.associateId)).toEqual([w.nia.id]);
    expect(i9.body.truncated).toBe(false);
    const j1 = await w.scoped.get('/compliance/j1');
    expect(j1.status).toBe(200);
    expect(j1.body.truncated).toBe(false);
  });

  it('the scorecard opens only at a scope the caller wholly holds', async () => {
    expect((await w.scoped.get('/compliance-scorecard/onboarding')).status).toBe(403);
    // North has a store (N2) outside the binding.
    expect((await w.scoped.get(`/compliance-scorecard/onboarding?clientId=${w.north.id}`)).status).toBe(403);
    await prisma.site.update({ where: { id: w.n2 }, data: { isActive: false } });
    expect((await w.scoped.get(`/compliance-scorecard/onboarding?clientId=${w.north.id}`)).status).toBe(200);
    expect((await w.scoped.get(`/compliance-scorecard/onboarding?clientId=${w.south.id}`)).status).toBe(403);
    // Another tenant's client is not found, even unscoped.
    const theirs = await prisma.client.create({ data: { name: 'Their Co', tenantId: T2 } });
    expect((await w.hr.get(`/compliance-scorecard/onboarding?clientId=${theirs.id}`)).status).toBe(404);
  });

  it('EEO counts the employed people in reach, in the database', async () => {
    const nora = await createAssociate({ firstName: 'Nora', lastName: 'NorthTwo' });
    await prisma.associateAssignment.create({ data: { associateId: nora.id, locationId: w.n2, startedAt: new Date('2026-01-01') } });
    await prisma.associateEeo.create({ data: { associateId: w.nia.id, category: 'PROFESSIONALS', race: 'HISPANIC_LATINO', gender: 'FEMALE' } });
    const hr = await w.hr.get(`/eeo/report?clientId=${w.north.id}`);
    expect(hr.status).toBe(200);
    expect(hr.body.total).toBe(2); // Nia and Nora — never Gil (deactivated)
    const scoped = await w.scoped.get(`/eeo/report?clientId=${w.north.id}`);
    expect(scoped.body.total).toBe(1);
    const declined = scoped.body.buckets.reduce((n: number, b: { count: number }) => n + b.count, 0);
    expect(declined).toBe(1);
  });

  it('the kiosk PIN diagnosis never finds someone out of reach', async () => {
    const res = await w.scoped.get('/kiosk-pins/diagnose?associate=Sam');
    expect(res.status).toBe(200);
    expect(res.body.matchedPin).toBeNull();
    expect(res.body.diagnosis).toMatch(/No associate matches/);
  });
});

describe('people records', () => {
  it('assets: what is held at or by the caller’s reach, plus unassigned stock', async () => {
    const held = await prisma.asset.create({ data: { kind: 'BADGE', label: 'Badge N' } });
    const theirs = await prisma.asset.create({ data: { kind: 'BADGE', label: 'Badge S' } });
    await prisma.asset.create({ data: { kind: 'BADGE', label: 'Spare badge' } });
    await prisma.assetAssignment.create({ data: { assetId: held.id, associateId: w.nia.id } });
    await prisma.assetAssignment.create({ data: { assetId: theirs.id, associateId: w.sam.id } });
    const res = await w.scoped.get('/assets');
    expect(res.status).toBe(200);
    const labels = res.body.assets.map((a: { label: string }) => a.label).sort();
    expect(labels).toEqual(['Badge N', 'Spare badge']);
    expect(res.body.truncated).toBe(false);
    const asg = await w.scoped.get('/asset-assignments');
    expect(asg.body.assignments.map((a: { assetLabel: string }) => a.assetLabel)).toEqual(['Badge N']);
  });

  it('probation pages, and open ones read soonest end first', async () => {
    const start = new Date('2026-09-01');
    await prisma.probationPeriod.create({ data: { associateId: w.nia.id, startDate: start, endDate: new Date('2026-12-01'), status: 'ACTIVE' } });
    await prisma.probationPeriod.create({ data: { associateId: w.sam.id, startDate: start, endDate: new Date('2026-11-01'), status: 'ACTIVE' } });
    const scoped = await w.scoped.get('/probations?status=ACTIVE');
    expect(scoped.status).toBe(200);
    expect(scoped.body.probations.map((p: { associateId: string }) => p.associateId)).toEqual([w.nia.id]);
    expect(scoped.body).toMatchObject({ total: 1, page: 0, hasMore: false });
    const hr = await w.hr.get('/probations?status=ACTIVE');
    expect(hr.body.probations.map((p: { associateId: string }) => p.associateId)).toEqual([w.sam.id, w.nia.id]);
    expect((await w.scoped.get('/probations/summary')).body.active).toBe(1);
  });

  it('separations and discipline reach a former employee the lead managed — not one they didn’t', async () => {
    // Both have left: their assignments are closed.
    await prisma.associateAssignment.updateMany({ where: { associateId: { in: [w.nia.id, w.sam.id] } }, data: { endedAt: new Date() } });
    for (const a of [w.nia, w.sam]) {
      await prisma.separation.create({ data: { associateId: a.id, reason: 'VOLUNTARY_PERSONAL', lastDayWorked: new Date('2026-10-01') } });
    }
    const seps = await w.scoped.get('/separations');
    expect(seps.status).toBe(200);
    expect(seps.body.separations.map((x: { associateId: string }) => x.associateId)).toEqual([w.nia.id]);
    expect((await w.scoped.get('/separations/summary')).body.planned).toBe(1);
    const disc = await w.scoped.get('/disciplinary-actions');
    expect(disc.status).toBe(200);
    expect(disc.body.total).toBe(0);
  });

  it('HR cases: list, detail, summary and the badge share one reach', async () => {
    const mine = await prisma.hrCase.create({ data: { associateId: w.nia.id, category: 'OTHER', subject: 'North question', description: 'x' } });
    const theirs = await prisma.hrCase.create({ data: { associateId: w.sam.id, category: 'OTHER', subject: 'South question', description: 'x' } });
    const list = await w.scoped.get('/hr-cases');
    expect(list.status).toBe(200);
    expect(list.body.cases.map((c: { id: string }) => c.id)).toEqual([mine.id]);
    expect(list.body).toMatchObject({ total: 1, hasMore: false });
    expect((await w.scoped.get(`/hr-cases/${theirs.id}`)).status).toBe(404);
    expect((await w.scoped.get(`/hr-cases/${mine.id}`)).status).toBe(200);
    expect((await w.scoped.get('/hr-cases-summary')).body.openTotal).toBe(1);
    const inbox = await w.scoped.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'hr-cases')?.count).toBe(1);
  });
});

describe('company numbers', () => {
  it('the executive layer is the whole company: a site-scoped account is clamped out', async () => {
    expect((await w.scoped.get('/executive/summary')).status).toBe(403);
    expect((await w.scoped.get('/executive/batons')).status).toBe(403);
    expect((await w.hr.get('/executive/batons')).status).toBe(200);
  });

  it('the dashboard: the caller’s stores, and no company payroll for a narrowed account', async () => {
    const soon = new Date(Date.now() + 3_600_000);
    await prisma.shift.create({ data: { clientId: w.north.id, locationId: w.n, position: 'Cashier', startsAt: soon, endsAt: new Date(soon.getTime() + 3_600_000), status: 'OPEN' } });
    await prisma.shift.create({ data: { clientId: w.south.id, locationId: w.s, position: 'Cashier', startsAt: soon, endsAt: new Date(soon.getTime() + 3_600_000), status: 'OPEN' } });
    const scoped = await w.scoped.get('/analytics/dashboard');
    expect(scoped.status).toBe(200);
    expect(scoped.body.openShiftsNext30d).toBe(1);
    expect(scoped.body.netPaidLast30d).toBe(0);
    expect((await w.hr.get('/analytics/dashboard')).body.openShiftsNext30d).toBe(2);
  });
});
