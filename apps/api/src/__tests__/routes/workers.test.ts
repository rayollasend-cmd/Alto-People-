import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensurePersonWorkers, scheduleWorkerOnShift } from '../../lib/workers.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
// The app's client carries the Shift.workerId adapter; the test client does not.
import { prisma as appDb } from '../../db.js';

/**
 * Workers (Brief 1D-1 acceptance).
 *
 *   An AGENT and a ROBOT worker are created with owners and scheduled on
 *   a site; no worker can be saved without an owner; every associate is a
 *   PERSON worker whose shifts carry the worker id without any scheduling
 *   screen changing; the page's "without an owner" list is empty.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const HOUR = 3_600_000;

async function world() {
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
  return { client, site, hr, wfm };
}

describe('agents and robots', () => {
  it('creates an AGENT and a ROBOT with owners, puts them at a site and on shifts', async () => {
    const w = await world();
    const admin = await loginAs(agent(), w.hr.email);

    const bot = await admin.post('/workers').send({
      type: 'ROBOT',
      name: 'Servi 01',
      ownerUserId: w.wfm.id,
      capabilities: ['food-service', 'room-delivery'],
      locationId: w.site.id,
      status: 'ACTIVE',
    });
    expect(bot.status).toBe(201);
    expect(bot.body).toMatchObject({ type: 'ROBOT', name: 'Servi 01', status: 'ACTIVE', capabilities: ['food-service', 'room-delivery'] });
    expect(bot.body.owner).toMatchObject({ id: w.wfm.id });
    expect(bot.body.sites).toHaveLength(1);
    expect(bot.body.sites[0]).toMatchObject({ locationId: w.site.id, siteName: w.site.name, endedAt: null, source: 'worker' });

    const ai = await admin.post('/workers').send({ type: 'AGENT', name: 'Messaging assistant', ownerUserId: w.hr.id, capabilities: ['messaging', 'schedule-read'] });
    expect(ai.status).toBe(201);
    expect(ai.body.status).toBe('ONBOARDING');
    // Placed later, through the shared assignment model.
    const placed = await admin.post(`/workers/${ai.body.id}/assignments`).send({ locationId: w.site.id, startedAt: '2026-10-01' });
    expect(placed.status).toBe(200);
    expect(placed.body.sites[0]).toMatchObject({ locationId: w.site.id, startedAt: '2026-10-01', source: 'worker' });

    // Onboarding workers cannot work yet; active ones can.
    const shift = await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Runner', startsAt: new Date(Date.now() + 24 * HOUR), endsAt: new Date(Date.now() + 32 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    const scheduled = await admin.post(`/workers/${bot.body.id}/shifts/${shift.id}`);
    expect(scheduled.status).toBe(200);
    expect(scheduled.body).toEqual({ shiftId: shift.id, workerId: bot.body.id, associateId: null });
    const row = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(row).toMatchObject({ workerId: bot.body.id, assignedAssociateId: null, status: 'ASSIGNED' });
    expect((await admin.get(`/workers/${bot.body.id}`)).body.upcomingShifts).toBe(1);

    await admin.patch(`/workers/${bot.body.id}`).send({ status: 'SUSPENDED' });
    const second = await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Runner', startsAt: new Date(Date.now() + 48 * HOUR), endsAt: new Date(Date.now() + 56 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    const refused = await admin.post(`/workers/${bot.body.id}/shifts/${second.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('worker_not_available');

    await flushPendingAudits();
    const audits = await prisma.auditLog.findMany({ where: { workerId: bot.body.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['worker.created', 'shift.assigned_worker', 'worker.updated']);

    const list = await admin.get('/workers?type=ROBOT');
    expect(list.body.workers.map((x: { name: string }) => x.name)).toEqual(['Servi 01']);
    expect(list.body.counts.ROBOT.SUSPENDED).toBe(1);
    expect(list.body.counts.AGENT.ONBOARDING).toBe(1);
    expect(list.body.withoutOwner).toEqual([]);
  });

  it('no worker can be saved without an owner — not by the API, not by the database', async () => {
    const w = await world();
    const admin = await loginAs(agent(), w.hr.email);
    const noOwner = await admin.post('/workers').send({ type: 'ROBOT', name: 'Orphan', capabilities: [] });
    expect(noOwner.status).toBe(400);
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: w.client.id });
    const badOwner = await admin.post('/workers').send({ type: 'ROBOT', name: 'Orphan', ownerUserId: portal.id });
    expect(badOwner.status).toBe(400);
    expect(badOwner.body.error.code).toBe('owner_not_eligible');
    const gone = await admin.post('/workers').send({ type: 'AGENT', name: 'Orphan', ownerUserId: '00000000-0000-4000-8000-000000000000' });
    expect(gone.body.error.code).toBe('owner_not_found');
    // The column itself refuses a null.
    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO "Worker" ("type", "name", "ownerUserId", "updatedAt") VALUES ('ROBOT', 'Orphan', NULL, now())`),
    ).rejects.toThrow();
    // And an owner cannot be deleted out from under a worker.
    await admin.post('/workers').send({ type: 'ROBOT', name: 'Servi 02', ownerUserId: w.wfm.id });
    await expect(prisma.user.delete({ where: { id: w.wfm.id } })).rejects.toThrow();
  });

  it('is read with the org and written by those who manage it', async () => {
    const w = await world();
    const { user: chair } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const c = await loginAs(agent(), chair.email);
    expect((await c.get('/workers')).status).toBe(200);
    expect((await c.post('/workers').send({ type: 'ROBOT', name: 'X', ownerUserId: w.hr.id })).status).toBe(403);
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(agent(), assoc.email);
    expect((await a.get('/workers')).status).toBe(403);
  });
});

describe('people are workers too', () => {
  it('a new hire gets a PERSON worker owned by whoever hired them; the sweep covers everyone else', async () => {
    const w = await world();
    // An associate created outside the API (an import): no worker yet.
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    expect(await prisma.worker.findUnique({ where: { associateId: ana.id } })).toBeNull();
    const admin = await loginAs(agent(), w.hr.email);
    expect((await admin.get('/workers')).body.associatesWithoutWorker).toBe(1);

    const made = await ensurePersonWorkers(prisma);
    expect(made).toBe(1);
    const person = await prisma.worker.findUniqueOrThrow({ where: { associateId: ana.id } });
    expect(person).toMatchObject({ type: 'PERSON', name: 'Ana Lopez', status: 'ACTIVE' });
    // The oldest org-wide admin owns an unmanaged person.
    expect(person.ownerUserId).toBe(w.hr.id);
    expect(await ensurePersonWorkers(prisma)).toBe(0);

    // A manager's account, when the associate has a manager with one.
    const lead = await createAssociate({ firstName: 'Lee', lastName: 'Park' });
    const { user: leadUser } = await createUser({ role: 'SHIFT_SUPERVISOR', associateId: lead.id, clientId: w.client.id });
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Chen' });
    await prisma.associate.update({ where: { id: bo.id }, data: { managerId: lead.id } });
    await ensurePersonWorkers(prisma);
    expect((await prisma.worker.findUniqueOrThrow({ where: { associateId: bo.id } })).ownerUserId).toBe(leadUser.id);

    // Status follows the associate record.
    await prisma.associate.update({ where: { id: bo.id }, data: { deactivatedAt: new Date() } });
    await ensurePersonWorkers(prisma);
    expect((await prisma.worker.findUniqueOrThrow({ where: { associateId: bo.id } })).status).toBe('SUSPENDED');

    // A person's status and name are not edited on the worker.
    const personRow = await prisma.worker.findUniqueOrThrow({ where: { associateId: ana.id } });
    const refused = await admin.patch(`/workers/${personRow.id}`).send({ status: 'OFFBOARDED' });
    expect(refused.body.error.code).toBe('person_follows_associate');
    // But the owner and capabilities are.
    const ok = await admin.patch(`/workers/${personRow.id}`).send({ ownerUserId: w.wfm.id, capabilities: ['stocking', 'driving'] });
    expect(ok.status).toBe(200);
    expect(ok.body.owner.id).toBe(w.wfm.id);

    const list = await admin.get('/workers');
    expect(list.body.counts.PERSON.ACTIVE).toBe(2);
    expect(list.body.counts.PERSON.SUSPENDED).toBe(1);
    expect(list.body.withoutOwner).toEqual([]);
    expect(list.body.associatesWithoutWorker).toBe(0);
  });

  it('every scheduling write carries the worker, without the scheduling code knowing', async () => {
    const w = await world();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: w.site.id, startedAt: new Date('2026-01-01') } });
    await ensurePersonWorkers(prisma);
    const person = await prisma.worker.findUniqueOrThrow({ where: { associateId: ana.id } });

    const hr = await loginAs(agent(), w.hr.email);
    const shift = await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Server', startsAt: new Date(Date.now() + 24 * HOUR), endsAt: new Date(Date.now() + 32 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    // The ordinary assign route — untouched by this brief.
    expect((await hr.post(`/scheduling/shifts/${shift.id}/assign`).send({ associateId: ana.id })).status).toBe(200);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).workerId).toBe(person.id);
    // Unassign clears it.
    await appDb.shift.update({ where: { id: shift.id }, data: { assignedAssociateId: null, status: 'OPEN' } });
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).workerId).toBeNull();
    // A create with an associate carries it too.
    const created = await appDb.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Server', startsAt: new Date(Date.now() + 48 * HOUR), endsAt: new Date(Date.now() + 56 * HOUR), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: new Date() },
    });
    expect(created.workerId).toBe(person.id);
    // The worker adapter, for a person, assigns the associate as before.
    const viaWorker = await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Server', startsAt: new Date(Date.now() + 72 * HOUR), endsAt: new Date(Date.now() + 80 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    const r = await scheduleWorkerOnShift(prisma, viaWorker.id, person.id);
    expect(r.associateId).toBe(ana.id);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: viaWorker.id } })).assignedAssociateId).toBe(ana.id);
    expect((await hr.get(`/workers/${person.id}`)).body.sites[0]).toMatchObject({ locationId: w.site.id, source: 'associate' });
  });
});

describe('the roster reads people the way the People directory does (F500 G1 /workers)', () => {
  const DAY = 86_400_000;
  async function people() {
    const w = await world();
    const approve = (associateId: string) =>
      prisma.application.create({ data: { associateId, clientId: w.client.id, locationId: w.site.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date(Date.now() - 30 * DAY) } });
    const place = (associateId: string, locationId = w.site.id) => prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: new Date('2026-05-01') } });
    // Working: placed, punched two days ago.
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Working' });
    await approve(ana.id);
    await place(ana.id);
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: w.client.id, locationId: w.site.id, clockInAt: new Date(Date.now() - 2 * DAY), clockOutAt: new Date(Date.now() - 2 * DAY + 8 * HOUR), status: 'APPROVED' } });
    // No recent shifts: placed, no work.
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Idle' });
    await approve(bo.id);
    await place(bo.id);
    // Paused (the worker account reads Suspended).
    const fay = await createAssociate({ firstName: 'Fay', lastName: 'Paused' });
    await approve(fay.id);
    await place(fay.id);
    await prisma.associate.update({ where: { id: fay.id }, data: { deactivatedAt: new Date(Date.now() - DAY) } });
    // Separated (the worker account reads Offboarded).
    const gus = await createAssociate({ firstName: 'Gus', lastName: 'Separated' });
    await approve(gus.id);
    await prisma.associate.update({ where: { id: gus.id }, data: { separatedAt: new Date(Date.now() - 5 * DAY) } });
    // Onboarding: a draft, nothing approved.
    const ed = await createAssociate({ firstName: 'Ed', lastName: 'Onboarding' });
    await prisma.application.create({ data: { associateId: ed.id, clientId: w.client.id, onboardingTrack: 'STANDARD', status: 'DRAFT' } });
    await ensurePersonWorkers(prisma);
    return { ...w, ana, bo, fay, gus, ed };
  }

  it('each person carries the directory status, and the People counts are the directory tiles', async () => {
    const w = await people();
    const hr = await loginAs(agent(), w.hr.email);
    const list = await hr.get('/workers');
    expect(list.status).toBe(200);
    const byName = new Map<string, { status: string; workStatus: string }>(list.body.workers.map((x: { name: string; status: string; workStatus: string }) => [x.name, x]));
    expect(byName.get('Ana Working')).toMatchObject({ status: 'ACTIVE', workStatus: 'ACTIVE' });
    // The account says Active; where Bo stands at work is "No recent shifts" — the word the People page uses.
    expect(byName.get('Bo Idle')).toMatchObject({ status: 'ACTIVE', workStatus: 'PLACED_NOT_ACTIVE' });
    expect(byName.get('Fay Paused')).toMatchObject({ status: 'SUSPENDED', workStatus: 'DEACTIVATED' });
    expect(byName.get('Gus Separated')).toMatchObject({ status: 'OFFBOARDED', workStatus: 'SEPARATED' });
    expect(byName.get('Ed Onboarding')).toMatchObject({ workStatus: 'ONBOARDING' });

    // One base for every page: on the books = 3 (Ana, Bo, Fay), 5 on file — the directory's tiles exactly.
    expect(list.body.people).toMatchObject({ ACTIVE: 1, PLACED_NOT_ACTIVE: 1, NOT_PLACED: 0, ONBOARDING: 1, DEACTIVATED: 1, SEPARATED: 1, onTheBooks: 3, total: 5 });
    const summary = await hr.get('/people/directory/summary');
    expect(summary.status).toBe(200);
    for (const k of ['ACTIVE', 'PLACED_NOT_ACTIVE', 'NOT_PLACED', 'ONBOARDING', 'DEACTIVATED', 'SEPARATED', 'onTheBooks', 'total']) {
      expect(list.body.people[k]).toBe(summary.body[k]);
    }
    const headcount = await hr.get('/headcount/overview');
    expect(headcount.body.onTheBooks).toBe(list.body.people.onTheBooks);
  });

  it('sends each face it has, and null when none is on file (no guessed photo URL to 404)', async () => {
    const w = await people();
    const lead = await createAssociate({ firstName: 'Lee', lastName: 'Lead' });
    await prisma.associate.update({ where: { id: lead.id }, data: { photoS3Key: 'photos/lee.jpg', photoUpdatedAt: new Date(1_700_000_000_000) } });
    await prisma.associate.update({ where: { id: w.ana.id }, data: { managerId: lead.id } });
    await prisma.associate.update({ where: { id: w.bo.id }, data: { managerId: w.fay.id } });
    const hr = await loginAs(agent(), w.hr.email);
    const list = await hr.get('/workers');
    const byName = new Map<string, { manager?: { photoUrl: string | null }; owner: { photoUrl: string | null } }>(list.body.workers.map((x: { name: string }) => [x.name, x]));
    expect(byName.get('Ana Working')!.manager!.photoUrl).toBe(`/api/associates/${lead.id}/photo?v=1700000000000`);
    expect(byName.get('Bo Idle')!.manager!.photoUrl).toBeNull();
    // The HR owner has no photo on file.
    expect(byName.get('Ana Working')!.owner.photoUrl).toBeNull();
  });

  it('a site-bound office account counts only the people at its sites (list, counts and people alike)', async () => {
    const w = await people();
    const north = await createClient('North Co');
    const northStore = await prisma.site.findFirstOrThrow({ where: { clientId: north.id } });
    const nia = await createAssociate({ firstName: 'Nia', lastName: 'North' });
    await prisma.associateAssignment.create({ data: { associateId: nia.id, locationId: northStore.id, startedAt: new Date('2026-05-01') } });
    await ensurePersonWorkers(prisma);
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [northStore.id] } });
    const a = await loginAs(agent(), ops.email);
    const list = await a.get('/workers');
    expect(list.status).toBe(200);
    const persons = (list.body.workers as Array<{ type: string; name: string }>).filter((x) => x.type === 'PERSON').map((x) => x.name);
    expect(persons).toEqual(['Nia North']);
    // The tiles count the same reach: one person, not the tenant's six.
    expect(list.body.counts.PERSON.ACTIVE + list.body.counts.PERSON.SUSPENDED + list.body.counts.PERSON.OFFBOARDED + list.body.counts.PERSON.ONBOARDING).toBe(1);
    expect(list.body.people).toMatchObject({ total: 1, onTheBooks: 1, NOT_PLACED: 0 });
    void w;
  });
});
