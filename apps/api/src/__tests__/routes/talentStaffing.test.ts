import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The talent pages, shaped like a staffing company: career ladders that
 * know where you stand, succession by store and the 9-box, seasonal
 * 30/60/90 plans owned by a store lead, goals that cascade from the
 * company down, and skills, celebrations and assets that know which store
 * people work at — all inside the caller's tenant and reach.
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

async function storeOf(clientId: string) {
  return prisma.site.findFirstOrThrow({ where: { clientId } });
}

async function place(associateId: string, locationId: string) {
  await prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: new Date() } });
}

describe('career ladders', () => {
  it('the field leadership ladder places crew by role and measures the next rung', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const crew = await createAssociate({ firstName: 'Cal', lastName: 'Crew' });
    await prisma.associate.update({ where: { id: crew.id }, data: { hireDate: new Date(Date.now() - 5 * 30 * 86_400_000) } });
    await prisma.performanceReview.create({
      data: { associateId: crew.id, periodStart: new Date('2026-04-01'), periodEnd: new Date('2026-06-30'), overallRating: 4, summary: 'Good', status: 'SUBMITTED' },
    });
    const { user: crewUser } = await createUser({ role: 'ASSOCIATE', associateId: crew.id, email: 'cal@example.com' });
    const lead = await createAssociate({ firstName: 'Lee', lastName: 'Lead' });
    await createUser({ role: 'SHIFT_SUPERVISOR', associateId: lead.id, email: 'lee@example.com' });

    const a = await loginAs(hr.email);
    expect((await a.post('/career-ladders/templates/field-leadership')).status).toBe(201);
    expect((await a.post('/career-ladders/templates/field-leadership')).status).toBe(409);

    const me = await (await loginAs(crewUser.email)).get('/career-ladders/me/position');
    expect(me.status).toBe(200);
    expect(me.body.ladder.name).toBe('Field leadership');
    const crewRung = me.body.ladder.levels.find((l: { id: string }) => l.id === me.body.currentLevelId);
    expect(crewRung.title).toBe('Crew member');
    expect(me.body.placedBy).toBe('field');
    // Next rung (Lead): 3 months in the job and a 3 — both met.
    expect(me.body.next.title).toBe('Lead');
    expect(me.body.next.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tenure', met: true, need: 3 }),
        expect.objectContaining({ kind: 'review', met: true, have: 4, need: 3 }),
      ]),
    );
    expect(me.body.next.progressPct).toBe(100);

    // HR reads anyone's position; a shift supervisor sits on their rung by role.
    const leadPos = await a.get(`/career-ladders/people/${lead.id}/position`);
    const leadRung = leadPos.body.ladder.levels.find((l: { id: string }) => l.id === leadPos.body.currentLevelId);
    expect(leadRung.title).toBe('Shift supervisor');
    expect(leadPos.body.placedBy).toBe('role');
  });
});

describe('succession by store and the 9-box', () => {
  it('names a bench per store, reads its strength, and keeps a site-bound lead to their stores', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const north = await createClient('North Co');
    const south = await createClient('South Co');
    const northStore = await storeOf(north.id);
    const southStore = await storeOf(south.id);
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Next' });
    await place(ana.id, northStore.id);
    const gone = await createAssociate({ firstName: 'Gil', lastName: 'Gone' });
    await prisma.associate.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } });

    const a = await loginAs(hr.email);
    const before = await a.get('/succession/stores');
    expect(before.body.summary).toMatchObject({ empty: 2, covered: 0 });

    const added = await a.post(`/succession/stores/${northStore.id}/bench`).send({ associateId: ana.id, readiness: 'READY_6_MONTHS' });
    expect(added.status).toBe(201);
    expect((await a.post(`/succession/stores/${northStore.id}/bench`).send({ associateId: ana.id, readiness: 'READY_NOW' })).status).toBe(409);
    expect((await a.post(`/succession/stores/${northStore.id}/bench`).send({ associateId: gone.id, readiness: 'READY_NOW' })).status).toBe(404);

    let north1 = (await a.get('/succession/stores')).body.stores.find((s: { id: string }) => s.id === northStore.id);
    expect(north1.strength).toBe('thin');
    expect((await a.patch(`/succession/bench/${added.body.id}`).send({ readiness: 'READY_NOW' })).status).toBe(200);
    north1 = (await a.get('/succession/stores')).body.stores.find((s: { id: string }) => s.id === northStore.id);
    expect(north1.strength).toBe('covered');

    // A regional HR lead bound to the south store neither sees nor edits the north.
    const { user: southHr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'south@example.com' });
    await prisma.user.update({ where: { id: southHr.id }, data: { scopeSiteIds: [southStore.id] } });
    const s = await loginAs(southHr.email);
    const seen = (await s.get('/succession/stores')).body.stores.map((x: { id: string }) => x.id);
    expect(seen).toEqual([southStore.id]);
    expect((await s.post(`/succession/stores/${northStore.id}/bench`).send({ associateId: ana.id, readiness: 'READY_NOW' })).status).toBe(404);
    expect((await s.delete(`/succession/bench/${added.body.id}`)).status).toBe(404);
  });

  it('places people on performance × potential and lists who is missing one', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const star = await createAssociate({ firstName: 'Sia', lastName: 'Star' });
    const fresh = await createAssociate({ firstName: 'Fin', lastName: 'Fresh' });
    for (const p of [star, fresh]) {
      await prisma.performanceReview.create({ data: { associateId: p.id, periodStart: new Date('2026-04-01'), periodEnd: new Date('2026-06-30'), overallRating: p === star ? 5 : 3, summary: 'x', status: 'SUBMITTED' } });
    }
    const a = await loginAs(hr.email);
    expect((await a.put(`/succession/potential/${star.id}`).send({ potential: 3 })).status).toBe(200);
    expect((await a.put(`/succession/potential/${star.id}`).send({ potential: 4 })).status).toBe(400);
    const box = await a.get('/succession/nine-box');
    const byName = new Map(box.body.people.map((p: { name: string }) => [p.name, p]));
    expect(byName.get('Sia Star')).toMatchObject({ performance: 3, potential: 3 });
    expect(byName.get('Fin Fresh')).toMatchObject({ performance: 2, potential: null });
  });
});

describe('30/60/90 plans', () => {
  it('a seasonal plan runs the season from the first shift, owned by the store’s shift supervisor', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const client = await createClient('Coastal');
    const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', email: 'lead@example.com', clientId: client.id });
    const hire = await createAssociate({ firstName: 'New', lastName: 'Hire' });
    const a = await loginAs(hr.email);

    const owners = await a.get('/ramp-plans/owners');
    expect(owners.body.owners.map((o: { id: string }) => o.id)).toContain(lead.id);
    expect((await a.post('/ramp-plans').send({ associateId: hire.id, startDate: '2026-11-01', template: 'SEASONAL', managerId: '00000000-0000-4000-8000-0000000000ff' })).status).toBe(404);

    const made = await a.post('/ramp-plans').send({ associateId: hire.id, startDate: '2026-11-01', template: 'SEASONAL', managerId: lead.id });
    expect(made.status).toBe(201);
    const plan = (await a.get(`/ramp-plans/by-associate/${hire.id}`)).body.plan;
    expect(plan.template).toBe('SEASONAL');
    expect(plan.milestones.map((m: { dayCheckpoint: number }) => m.dayCheckpoint)).toEqual([1, 7, 14, 28, 42, 56]);
    const row = (await a.get('/ramp-plans')).body.plans[0];
    expect(row.milestones).toHaveLength(6);
  });
});

describe('goals that cascade', () => {
  it('company → team → person, loops refused, children re-homed when a goal goes', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const a = await loginAs(hr.email);
    const period = { periodStart: '2026-01-01', periodEnd: '2026-12-31' };

    expect((await a.post('/performance/goals').send({ scope: 'COMPANY', associateId: ana.id, title: 'x', ...period })).status).toBe(400);
    expect((await a.post('/performance/goals').send({ scope: 'PERSON', title: 'x', ...period })).status).toBe(400);
    const company = await a.post('/performance/goals').send({ scope: 'COMPANY', title: '98% fill rate', ...period });
    const team = await a.post('/performance/goals').send({ scope: 'TEAM', title: 'Front Beach fill rate', parentGoalId: company.body.id, ...period });
    const person = await a.post('/performance/goals').send({ scope: 'PERSON', associateId: ana.id, title: 'Cover 2 weekends a month', parentGoalId: team.body.id, ...period });
    expect([company.status, team.status, person.status]).toEqual([201, 201, 201]);

    // The company goal can't align under its own grandchild.
    expect((await a.put(`/performance/goals/${company.body.id}`).send({ parentGoalId: person.body.id })).status).toBe(409);

    const goals = (await a.get('/performance/goals')).body.goals as Array<{ id: string; scope: string; parentGoalId: string | null; ownerUserId: string | null }>;
    expect(goals.find((g) => g.id === team.body.id)).toMatchObject({ scope: 'TEAM', parentGoalId: company.body.id, ownerUserId: hr.id });

    expect((await a.delete(`/performance/goals/${team.body.id}`)).status).toBe(204);
    const after = await prisma.goal.findUniqueOrThrow({ where: { id: person.body.id } });
    expect(after.parentGoalId).toBe(company.body.id);
  });
});

describe('skills, celebrations and assets know the store', () => {
  it('skills search shows where people work, their next free day and certifications, and filters by store', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const client = await createClient('Coastal');
    const store = await storeOf(client.id);
    const forklift = await prisma.skill.create({ data: { name: 'Forklift' } });
    const near = await createAssociate({ firstName: 'Nia', lastName: 'Near' });
    const far = await createAssociate({ firstName: 'Fay', lastName: 'Far' });
    await place(near.id, store.id);
    for (const p of [near, far]) await prisma.associateSkill.create({ data: { associateId: p.id, skillId: forklift.id, level: 'ADVANCED' } });
    const cert = await prisma.qualification.create({ data: { code: 'FORK', name: 'Forklift licence', isCert: true } });
    await prisma.associateQualification.create({ data: { associateId: near.id, qualificationId: cert.id, expiresAt: new Date(Date.now() + 90 * 86_400_000) } });
    const today = new Date();
    await prisma.shift.create({ data: { clientId: client.id, locationId: store.id, position: 'Picker', startsAt: today, endsAt: new Date(today.getTime() + 3_600_000), status: 'ASSIGNED', assignedAssociateId: near.id } });

    const a = await loginAs(hr.email);
    const all = await a.get('/skills/search').query({ q: 'fork' });
    const nia = all.body.associates.find((x: { name: string }) => x.name === 'Nia Near');
    expect(nia.place).toMatchObject({ locationId: store.id, clientName: 'Coastal' });
    expect(nia.certifications).toEqual([expect.objectContaining({ name: 'Forklift licence', isCert: true })]);
    expect(nia.nextFreeDay).not.toBe(today.toISOString().slice(0, 10));
    const atStore = await a.get('/skills/search').query({ q: 'fork', locationId: store.id });
    expect(atStore.body.associates.map((x: { name: string }) => x.name)).toEqual(['Nia Near']);
  });

  it('a shift supervisor sees their own crew’s celebrations; HR can narrow to a store', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const mine = await createClient('Mine');
    const other = await createClient('Other');
    const mineStore = await storeOf(mine.id);
    const otherStore = await storeOf(other.id);
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 3);
    const dob = new Date(Date.UTC(1990, soon.getUTCMonth(), soon.getUTCDate()));
    const crew = await createAssociate({ firstName: 'Cam', lastName: 'Crew' });
    const stranger = await createAssociate({ firstName: 'Sam', lastName: 'Stranger' });
    await prisma.associate.update({ where: { id: crew.id }, data: { dob } });
    await prisma.associate.update({ where: { id: stranger.id }, data: { dob } });
    await place(crew.id, mineStore.id);
    await place(stranger.id, otherStore.id);
    const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', email: 'lead@example.com', clientId: mine.id });
    await prisma.user.update({ where: { id: lead.id }, data: { locationId: mineStore.id } });

    const leadView = await (await loginAs(lead.email)).get('/celebrations/upcoming');
    expect(leadView.status).toBe(200);
    expect(leadView.body.items.map((i: { associateName: string }) => i.associateName)).toEqual(['Cam Crew']);
    expect(leadView.body.items[0]).toMatchObject({ locationId: mineStore.id, clientName: 'Mine' });

    const hrView = await (await loginAs(hr.email)).get('/celebrations/upcoming').query({ locationId: otherStore.id });
    expect(hrView.body.items.map((i: { associateName: string }) => i.associateName)).toEqual(['Sam Stranger']);
  });

  it('assets are kept at a store, filter by it, and include field kit', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const client = await createClient('Coastal');
    const store = await storeOf(client.id);
    const a = await loginAs(hr.email);
    expect((await a.post('/assets').send({ kind: 'PPE', label: 'Hi-vis vest #4', locationId: store.id })).status).toBe(201);
    expect((await a.post('/assets').send({ kind: 'DEVICE', label: 'Scanner' })).status).toBe(201);
    expect((await a.post('/assets').send({ kind: 'BADGE', label: 'x', locationId: '00000000-0000-4000-8000-0000000000ff' })).status).toBe(404);
    const atStore = await a.get('/assets').query({ locationId: store.id });
    expect(atStore.body.assets).toEqual([expect.objectContaining({ kind: 'PPE', storeName: store.name, clientName: 'Coastal' })]);
  });
});
