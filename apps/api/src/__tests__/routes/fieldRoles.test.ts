import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import request, { type Test } from 'supertest';
import { env } from '../../config/env.js';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { seasonWeeks } from '../../lib/seasonPlanner.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The field roles (2026-10), the rest of the pack:
 *   - the associate's counted Needs you comes from /me/inbox
 *   - the associate is in the messenger: their supervisors and the desks, nobody else
 *   - the credential wallet and its shared link
 *   - the pickup feed names a site they have not worked at
 *   - money on a job is withheld from the store-bound supervisor
 *   - the face wall carries a phone for the shift supervisor only
 *   - the Workforce Manager places the supervisor corps, sees labor dollars and proposals by store
 *   - a season plan tried on the live week: preview, apply as drafts, discard
 */

const app = () => createApp();
const DAY = 86_400_000;
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

async function placedAssociate(clientId: string, first = 'Ana', last = 'Lopez') {
  const a = await createAssociate({ firstName: first, lastName: last });
  await prisma.application.create({ data: { associateId: a.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id, email: a.email });
  return { associate: a, user };
}

describe("the associate's counted Needs you", () => {
  it('counts what is theirs to do, from the same inbox the badge reads', async () => {
    const client = await createClient('Walmart 218');
    const { associate, user } = await placedAssociate(client.id);
    // Availability on file, so "Set when you can work" isn't one of the counted items.
    await prisma.associateAvailability.create({ data: { associateId: associate.id, dayOfWeek: 1, startMinute: 480, endMinute: 1020 } });
    await prisma.agreement.create({ data: { associateId: associate.id, kind: 'NDA', status: 'PENDING_SIGNATURE' } });
    await prisma.shift.create({ data: { clientId: client.id, position: 'Stocker', startsAt: inHours(30), endsAt: inHours(36), status: 'ASSIGNED', assignedAssociateId: associate.id, publishedAt: new Date() } });
    const course = await prisma.course.create({ data: { title: 'Forklift safety', isRequired: true, status: 'PUBLISHED' } });
    await prisma.courseEnrollment.create({ data: { courseId: course.id, associateId: associate.id, status: 'ASSIGNED' } });
    const a = await loginAs(user.email);
    const body = (await a.get('/me/inbox')).body as { total: number; sources: Array<{ key: string; count: number; path: string }> };
    const by = new Map(body.sources.map((s) => [s.key, s]));
    expect(by.get('my-agreements')).toMatchObject({ count: 1, path: '/agreements' });
    expect(by.get('my-shifts')).toMatchObject({ count: 1, path: '/scheduling' });
    expect(by.get('my-training')).toMatchObject({ count: 1, path: '/learning' });
    expect(body.total).toBe(3);
    // Nothing that is a manager's decision.
    for (const desk of ['approvals', 'kiosk-review', 'floor-flags']) expect(by.has(desk)).toBe(false);
  });
});

describe('the associate in the messenger', () => {
  it('reaches the supervisors where they are placed and the desks — never another store, a store manager, or another associate', async () => {
    const mine = await createClient('Walmart 218');
    const other = await createClient('Target 9');
    const { user: me } = await placedAssociate(mine.id);
    const { user: peer } = await placedAssociate(mine.id, 'Ben', 'Ray');
    const { user: mySup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });
    const { user: theirSup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: other.id });
    const { user: store } = await createUser({ role: 'CLIENT_PORTAL', clientId: mine.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const a = await loginAs(me.email);
    const dir = await a.get('/messages/directory');
    expect(dir.status).toBe(200);
    const ids = (dir.body.people as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([mySup.id, hr.id]));
    for (const no of [theirSup.id, store.id, peer.id]) expect(ids).not.toContain(no);

    expect((await a.post('/messages/conversations').send({ participantIds: [mySup.id], body: 'Running ten late.' })).status).toBe(201);
    for (const no of [theirSup.id, store.id, peer.id]) {
      expect((await a.post('/messages/conversations').send({ participantIds: [no] })).status).toBe(403);
    }
    // The supervisor reaches them back; the store manager still cannot.
    const sup = await loginAs(mySup.email);
    expect((await sup.post('/messages/conversations').send({ participantIds: [me.id], body: 'Thanks for the heads-up.' })).status).toBe(201);
    const theirs = await loginAs(theirSup.email);
    expect((await theirs.post('/messages/conversations').send({ participantIds: [me.id] })).status).toBe(403);
    const mgr = await loginAs(store.email);
    expect((await mgr.post('/messages/conversations').send({ participantIds: [me.id] })).status).toBe(403);
    // Their unread count rides in the inbox.
    const inbox = (await a.get('/me/inbox')).body as { sources: Array<{ key: string; count: number }> };
    expect(inbox.sources.find((s) => s.key === 'messages')?.count).toBe(1);
  });
});

describe('the credential wallet', () => {
  it('lists what they hold with its state, and a shared link shows it without a login until it expires', async () => {
    const client = await createClient('Walmart 218');
    const { associate, user } = await placedAssociate(client.id);
    const q = await prisma.qualification.create({ data: { clientId: client.id, code: 'FORKLIFT', name: 'Forklift certified' } });
    await prisma.associateQualification.create({ data: { associateId: associate.id, qualificationId: q.id, expiresAt: new Date(Date.now() + 10 * DAY) } });
    const course = await prisma.course.create({ data: { title: 'Food safety', status: 'PUBLISHED' } });
    await prisma.courseEnrollment.create({ data: { courseId: course.id, associateId: associate.id, status: 'COMPLETED', completedAt: new Date() } });

    const a = await loginAs(user.email);
    const mine = await a.get('/me/wallet');
    expect(mine.status).toBe(200);
    expect(mine.body.person.name).toBe('Ana Lopez');
    const titles = (mine.body.items as Array<{ title: string; state: string; issuer: string | null }>).map((i) => [i.title, i.state, i.issuer]);
    expect(titles).toEqual(expect.arrayContaining([['Forklift certified', 'expiring', 'Walmart 218'], ['Food safety', 'valid', null]]));

    const shared = await a.post('/me/wallet/share').send({ days: 7 });
    expect(shared.status).toBe(201);
    expect(shared.body.path).toBe(`/w/${shared.body.token}`);
    const pub = await request(app()).get(`/wallet/public/${shared.body.token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.person.name).toBe('Ana Lopez');
    expect(pub.body.items).toHaveLength(2);
    expect(JSON.stringify(pub.body)).not.toContain(associate.email);
    expect((await request(app()).get('/wallet/public/not-a-token')).status).toBe(404);
    // A real link past its days is gone (410), not "not valid" (F500 G5).
    const stale = jwt.sign({ sub: associate.id, t: ALTO_TENANT_ID, exp: Math.floor(Date.now() / 1000) - 60 }, env.JWT_SECRET, { algorithm: 'HS256', audience: 'alto:wallet-share' });
    expect((await request(app()).get(`/wallet/public/${stale}`)).status).toBe(410);

    // A staff account with no associate record has no wallet.
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    expect((await (await loginAs(hr.email)).get('/me/wallet')).status).toBe(403);
  });
});

describe('the pickup feed', () => {
  it('names the store, and says when it is one they have not worked at', async () => {
    const client = await createClient('Walmart');
    const home = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const away = await prisma.site.create({ data: { clientId: client.id, name: 'Pier Park' } });
    const { associate, user } = await placedAssociate(client.id);
    await prisma.associateAssignment.create({ data: { associateId: associate.id, locationId: home.id, startedAt: new Date() } });
    await prisma.shift.createMany({
      data: [
        { clientId: client.id, locationId: home.id, position: 'Stocker', startsAt: inHours(48), endsAt: inHours(54), status: 'OPEN', publishedAt: new Date() },
        { clientId: client.id, locationId: away.id, position: 'Stocker', startsAt: inHours(72), endsAt: inHours(78), status: 'OPEN', publishedAt: new Date() },
      ],
    });
    const res = await (await loginAs(user.email)).get('/shifts/open');
    expect(res.status).toBe(200);
    const by = new Map((res.body.shifts as Array<{ locationId: string; locationName: string; newForYou: boolean }>).map((s) => [s.locationId, s]));
    expect(by.get(home.id)).toMatchObject({ newForYou: false });
    expect(by.get(away.id)).toMatchObject({ locationName: 'Pier Park', newForYou: true });
  });
});

describe('money on a job', () => {
  it('is withheld from the store-bound supervisor on read and refused on write; HR still sees and sets it', async () => {
    const client = await createClient('Walmart 218');
    const job = await prisma.job.create({ data: { clientId: client.id, name: 'Stocker', billRate: 31.5, payRate: 18 } });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const s = await loginAs(sup.email);
    const list = await s.get('/jobs');
    expect(list.status).toBe(200);
    expect(list.body.jobs[0]).toMatchObject({ name: 'Stocker', billRate: null, payRate: null });
    expect((await s.patch(`/jobs/${job.id}`).send({ payRate: 25 })).status).toBe(403);
    expect((await s.post('/jobs').send({ clientId: client.id, name: 'Lead', billRate: 40 })).status).toBe(403);
    // The name is still theirs to keep tidy.
    const renamed = await s.patch(`/jobs/${job.id}`).send({ name: 'Night stocker' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Night stocker', billRate: null, payRate: null });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = await loginAs(hr.email);
    expect((await h.get('/jobs')).body.jobs[0]).toMatchObject({ billRate: 31.5, payRate: 18 });
    expect((await h.patch(`/jobs/${job.id}`).send({ payRate: 19 })).body.payRate).toBe(19);
  });
});

describe('the face wall', () => {
  it('carries a phone and a messenger login for the shift supervisor only', async () => {
    const client = await createClient('Walmart 218');
    const { associate, user: assocUser } = await placedAssociate(client.id);
    await prisma.associate.update({ where: { id: associate.id }, data: { phone: '+1 555 010 0100' } });
    const now = Date.now();
    await prisma.shift.create({ data: { clientId: client.id, position: 'Stocker', startsAt: new Date(now + 3_600_000), endsAt: new Date(now + 4 * 3_600_000), status: 'ASSIGNED', assignedAssociateId: associate.id, publishedAt: new Date() } });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const { user: floor } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: client.id });
    const { user: store } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const rowFor = async (email: string) => {
      const r = await (await loginAs(email)).get('/client-portal/day');
      expect(r.status).toBe(200);
      return (r.body.roster as Array<{ associateId: string; phone?: string; messageUserId?: string }>).find((x) => x.associateId === associate.id)!;
    };
    expect(await rowFor(sup.email)).toMatchObject({ phone: '+1 555 010 0100', messageUserId: assocUser.id });
    for (const email of [floor.email, store.email]) {
      const row = await rowFor(email);
      expect(row.phone).toBeUndefined();
      expect(row.messageUserId).toBeUndefined();
    }
  });
});

describe('the Workforce Manager', () => {
  it('places a supervisor at a client and store without Users & access; a client change drops the old shift', async () => {
    const a = await createClient('Walmart 218');
    const b = await createClient('Target 9');
    const siteA = await prisma.site.findFirstOrThrow({ where: { clientId: a.id } });
    const siteB = await prisma.site.findFirstOrThrow({ where: { clientId: b.id } });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: a.id });
    await prisma.supervisorShiftWindow.create({ data: { userId: sup.id, locationId: siteA.id, label: 'Morning' } });
    const { user: hrTarget } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const w = await loginAs(wfm.email);

    expect((await w.patch(`/workforce/supervisors/${sup.id}`).send({ clientId: b.id, locationId: siteA.id })).status).toBe(400);
    const moved = await w.patch(`/workforce/supervisors/${sup.id}`).send({ clientId: b.id, locationId: siteB.id });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ clientId: b.id, locationId: siteB.id, windowsDropped: true });
    expect(await prisma.supervisorShiftWindow.count({ where: { userId: sup.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'user.placed_by_field', entityId: sup.id } })).toBe(1);
    // Only the supervisor roles; and not by the supervisor themself.
    expect((await w.patch(`/workforce/supervisors/${hrTarget.id}`).send({ clientId: a.id })).status).toBe(400);
    const s = await loginAs(sup.email);
    expect((await s.patch(`/workforce/supervisors/${sup.id}`).send({ clientId: a.id })).status).toBe(403);
    // The list carries placement for the corps page.
    const list = await w.get('/workforce/supervisors');
    expect(list.body.supervisors.find((x: { userId: string }) => x.userId === sup.id)).toMatchObject({ clientId: b.id, locationId: siteB.id, windows: [] });
  });

  it('sees labor dollars and pending agent proposals on each store tile; the store supervisor gets no money', async () => {
    const client = await createClient('Walmart 218');
    const now = Date.now();
    const open = await prisma.shift.create({ data: { clientId: client.id, position: 'Stocker', startsAt: new Date(now + 3_600_000), endsAt: new Date(now + 5 * 3_600_000), status: 'OPEN', publishedAt: new Date(), payRate: 20 } });
    // The built-in agents need an owner: the tenant's oldest admin.
    await createUser({ role: 'HR_ADMINISTRATOR' });
    await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const agentProfile = await prisma.agentProfile.findFirstOrThrow();
    await prisma.agentProposal.create({ data: { tenantId: ALTO_TENANT_ID, workerId: agentProfile.workerId, capabilityKey: 'shift.fill', subjectType: 'Shift', subjectId: open.id, payload: {} } });
    const res = await (await loginAs(wfm.email)).get('/workforce/overview');
    expect(res.status).toBe(200);
    const tile = res.body.today.stores.find((s: { clientId: string }) => s.clientId === client.id);
    expect(tile.laborToday).toBe(80);
    expect(tile.laborUnpriced).toBe(0);
    expect(tile.proposalsPending).toBe(1);

    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const mine = await (await loginAs(sup.email)).get('/workforce/overview');
    expect(mine.body.today.stores[0].laborToday).toBeNull();
  });
});

describe('a season plan on the live week', () => {
  it('previews the gap against the calendar, applies it as tagged drafts, and discards exactly those', async () => {
    const client = await createClient('Walmart');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const w = await loginAs(wfm.email);
    const today = new Date();
    const start = new Date(today.getTime() - 14 * DAY).toISOString().slice(0, 10);
    const end = new Date(today.getTime() + 60 * DAY).toISOString().slice(0, 10);
    const weeks = seasonWeeks(start, end);
    const created = await w.post('/season-plans').send({
      name: 'Try it',
      clientId: client.id,
      seasonStart: start,
      seasonEnd: end,
      sites: [{ locationId: site.id, bedsAvailable: 0, demand: weeks.map((week) => ({ week, day: 2, evening: 0, overnight: 0 })) }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const week = weeks[weeks.length - 2]!;

    const preview = await w.get(`/season-plans/${id}/live?week=${week}`);
    expect(preview.status).toBe(200);
    expect(preview.body.week).toBe(week);
    expect(preview.body.totals).toMatchObject({ planned: 14, scheduled: 0, gap: 14, drafted: 0 });

    const applied = await w.post(`/season-plans/${id}/live/apply`).send({ week });
    expect(applied.status).toBe(201);
    expect(applied.body.created).toBe(14);
    const drafts = await prisma.shift.findMany({ where: { locationId: site.id, status: 'DRAFT' } });
    expect(drafts).toHaveLength(14);
    expect(drafts.every((d) => d.notes?.startsWith(`season-plan:${id}:${week}`))).toBe(true);
    const again = await w.get(`/season-plans/${id}/live?week=${week}`);
    expect(again.body.totals).toMatchObject({ gap: 0, drafted: 14 });

    // A draft someone else made is never taken back.
    await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Stocker', startsAt: new Date(`${week}T15:00:00Z`), endsAt: new Date(`${week}T23:00:00Z`), status: 'DRAFT' } });
    const discarded = await w.post(`/season-plans/${id}/live/discard`).send({ week });
    expect(discarded.body.removed).toBe(14);
    expect(await prisma.shift.count({ where: { locationId: site.id, status: 'DRAFT' } })).toBe(1);

    // The store supervisor cannot write the plan into the week.
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    expect((await (await loginAs(sup.email)).post(`/season-plans/${id}/live/apply`).send({ week })).status).toBe(403);
  });
});
