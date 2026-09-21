import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The qualification routes are guarded by manage:scheduling, which
 * SHIFT_SUPERVISOR holds — and SHIFT_SUPERVISOR is clamped to one client by
 * scopeShifts, scopeAssociates and scopeClients everywhere else in the
 * product. The capability answers "may this person manage schedules"; it
 * was being read as "may this person manage EVERY client's schedules".
 *
 * The consequences are not read leaks. Qualifications are what
 * assertCanClaimOpenShift consults, so a write here moves who may work
 * which shift, at a client the caller has nothing to do with.
 *
 * Scope misses are 404 rather than 403 throughout: an id belonging to
 * another client should be indistinguishable from one that does not exist.
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
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

/**
 * Two stores. A supervisor at the first; a worker, a shift and a
 * client-scoped qualification at the second. Plus one GLOBAL qualification,
 * which belongs to the org rather than to either store.
 */
async function seedTwoStores() {
  const mine = await createClient('Front Beach');
  const theirs = await createClient('Gulf Point');

  const supAssoc = await createAssociate({ firstName: 'Dana', lastName: 'Lead' });
  await prisma.application.create({
    data: { associateId: supAssoc.id, clientId: mine.id, onboardingTrack: 'STANDARD', status: 'APPROVED' },
  });
  const { user: supUser } = await createUser({
    role: 'SHIFT_SUPERVISOR',
    clientId: mine.id,
    associateId: supAssoc.id,
  });

  // A worker on the OTHER store's roster.
  const theirWorker = await createAssociate({ firstName: 'Marisol', lastName: 'Reyes' });
  await prisma.application.create({
    data: { associateId: theirWorker.id, clientId: theirs.id, onboardingTrack: 'STANDARD', status: 'APPROVED' },
  });

  // And one on the supervisor's own, so the tests can show the guard
  // permits the legitimate case rather than simply refusing everything.
  const myWorker = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
  await prisma.application.create({
    data: { associateId: myWorker.id, clientId: mine.id, onboardingTrack: 'STANDARD', status: 'APPROVED' },
  });

  const globalQual = await prisma.qualification.create({
    data: { clientId: null, code: 'FORKLIFT', name: 'Forklift certified', isCert: true },
  });
  const theirQual = await prisma.qualification.create({
    data: { clientId: theirs.id, code: 'GULF_POS', name: 'Gulf Point POS' },
  });

  const theirShift = await prisma.shift.create({
    data: {
      clientId: theirs.id,
      position: 'Stocker',
      startsAt: inHours(48),
      endsAt: inHours(54),
      status: 'OPEN',
      publishedAt: new Date(),
    },
  });

  const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });

  return {
    mine,
    theirs,
    theirWorker,
    myWorker,
    globalQual,
    theirQual,
    theirShift,
    sup: await loginAs(supUser.email),
    hr: await loginAs(hrUser.email),
  };
}

describe('the qualification catalog', () => {
  it('will not let a supervisor edit or delete another client’s qualification', async () => {
    const w = await seedTwoStores();

    expect(
      (await w.sup.put(`/qualifications/${w.theirQual.id}`).send({ name: 'Renamed' })).status,
    ).toBe(404);
    expect((await w.sup.delete(`/qualifications/${w.theirQual.id}`)).status).toBe(404);

    const after = await prisma.qualification.findUniqueOrThrow({ where: { id: w.theirQual.id } });
    expect(after.name).toBe('Gulf Point POS');
    expect(after.deletedAt).toBeNull();
  });

  it('will not let a supervisor edit or delete a GLOBAL qualification', async () => {
    const w = await seedTwoStores();

    // Reading it is fine — that is how they attach "Forklift certified" to
    // their own shift. Renaming it renames it for every client at once, and
    // soft-deleting it drops the requirement from every client's shifts,
    // silently widening who may claim them.
    expect(
      (await w.sup.put(`/qualifications/${w.globalQual.id}`).send({ name: 'Renamed' })).status,
    ).toBe(404);
    expect((await w.sup.delete(`/qualifications/${w.globalQual.id}`)).status).toBe(404);

    const after = await prisma.qualification.findUniqueOrThrow({ where: { id: w.globalQual.id } });
    expect(after.name).toBe('Forklift certified');
    expect(after.deletedAt).toBeNull();

    // The catalog list still shows it to them.
    const list = await w.sup.get('/qualifications');
    expect(list.status).toBe(200);
    expect(list.body.qualifications.map((q: { code: string }) => q.code)).toContain('FORKLIFT');
  });

  it('files a supervisor’s new qualification under their own client, not globally', async () => {
    const w = await seedTwoStores();

    // The form does not send a clientId, so every qualification a
    // supervisor created used to land as a GLOBAL one.
    const res = await w.sup.post('/qualifications').send({ code: 'BEACH_POS', name: 'Beach POS' });
    expect(res.status).toBe(201);
    const created = await prisma.qualification.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(created.clientId).toBe(w.mine.id);

    // An explicit clientId for someone else is ignored, not honoured.
    const forged = await w.sup
      .post('/qualifications')
      .send({ code: 'FORGED', name: 'Forged', clientId: w.theirs.id });
    expect(forged.status).toBe(201);
    const forgedRow = await prisma.qualification.findUniqueOrThrow({ where: { id: forged.body.id } });
    expect(forgedRow.clientId).toBe(w.mine.id);
  });

  it('still lets HR manage the global catalog', async () => {
    const w = await seedTwoStores();

    const created = await w.hr.post('/qualifications').send({ code: 'SAFETY', name: 'Safety' });
    expect(created.status).toBe(201);
    expect(
      (await prisma.qualification.findUniqueOrThrow({ where: { id: created.body.id } })).clientId,
    ).toBeNull();

    expect(
      (await w.hr.put(`/qualifications/${w.globalQual.id}`).send({ name: 'Forklift (renewed)' })).status,
    ).toBe(200);
    expect((await w.hr.delete(`/qualifications/${w.theirQual.id}`)).status).toBe(204);
  });
});

describe('a worker’s qualifications', () => {
  it('will not let a supervisor grant one to another client’s worker', async () => {
    const w = await seedTwoStores();

    const res = await w.sup
      .post(`/qualifications/associates/${w.theirWorker.id}`)
      .send({ qualificationId: w.globalQual.id });
    expect(res.status).toBe(404);
    expect(
      await prisma.associateQualification.count({ where: { associateId: w.theirWorker.id } }),
    ).toBe(0);
  });

  it('will not let a supervisor REVOKE another client’s worker’s certification', async () => {
    const w = await seedTwoStores();
    // The one that matters most: assertCanClaimOpenShift reads this table,
    // so revoking it takes the worker out of their own store's open shifts.
    const grant = await prisma.associateQualification.create({
      data: { associateId: w.theirWorker.id, qualificationId: w.globalQual.id },
    });

    const res = await w.sup.delete(
      `/qualifications/associates/${w.theirWorker.id}/${grant.id}`,
    );
    expect(res.status).toBe(404);
    expect(
      (await prisma.associateQualification.findUniqueOrThrow({ where: { id: grant.id } })).deletedAt,
    ).toBeNull();
  });

  it('will not let a supervisor read another client’s worker’s record', async () => {
    const w = await seedTwoStores();
    expect((await w.sup.get(`/qualifications/associates/${w.theirWorker.id}`)).status).toBe(404);
  });

  it('still lets a supervisor grant and revoke on their OWN roster', async () => {
    const w = await seedTwoStores();

    const granted = await w.sup
      .post(`/qualifications/associates/${w.myWorker.id}`)
      .send({ qualificationId: w.globalQual.id });
    expect(granted.status).toBe(201);

    expect((await w.sup.get(`/qualifications/associates/${w.myWorker.id}`)).status).toBe(200);
    expect(
      (await w.sup.delete(`/qualifications/associates/${w.myWorker.id}/${granted.body.id}`)).status,
    ).toBe(204);
  });

  it('refuses a qualification the caller cannot see, even on their own roster', async () => {
    const w = await seedTwoStores();
    const res = await w.sup
      .post(`/qualifications/associates/${w.myWorker.id}`)
      .send({ qualificationId: w.theirQual.id });
    expect(res.status).toBe(404);
  });
});

describe('a shift’s requirements', () => {
  it('will not let a supervisor add a requirement to another client’s shift', async () => {
    const w = await seedTwoStores();
    const res = await w.sup
      .post(`/shifts/${w.theirShift.id}/qualifications`)
      .send({ qualificationId: w.globalQual.id });
    expect(res.status).toBe(404);
    expect(
      await prisma.shiftQualificationRequirement.count({ where: { shiftId: w.theirShift.id } }),
    ).toBe(0);
  });

  it('will not let a supervisor strip a requirement off another client’s shift', async () => {
    const w = await seedTwoStores();
    // Removing the requirement is what makes an open shift claimable by
    // anyone at all — a widening, not a tidy-up.
    const req = await prisma.shiftQualificationRequirement.create({
      data: { shiftId: w.theirShift.id, qualificationId: w.globalQual.id },
    });

    const res = await w.sup.delete(`/shifts/${w.theirShift.id}/qualifications/${req.id}`);
    expect(res.status).toBe(404);
    expect(
      await prisma.shiftQualificationRequirement.count({ where: { id: req.id } }),
    ).toBe(1);
  });

  it('will not read another client’s shift requirements', async () => {
    const w = await seedTwoStores();
    expect((await w.sup.get(`/shifts/${w.theirShift.id}/qualifications`)).status).toBe(404);
  });

  it('still manages requirements on the supervisor’s own shifts', async () => {
    const w = await seedTwoStores();
    const myShift = await prisma.shift.create({
      data: {
        clientId: w.mine.id,
        position: 'Stocker',
        startsAt: inHours(48),
        endsAt: inHours(54),
        status: 'OPEN',
        publishedAt: new Date(),
      },
    });

    const added = await w.sup
      .post(`/shifts/${myShift.id}/qualifications`)
      .send({ qualificationId: w.globalQual.id });
    expect(added.status).toBe(201);

    // A double-click used to hit the (shiftId, qualificationId) unique and
    // come back a 500. The requirement is already there, which is what was
    // asked for.
    const again = await w.sup
      .post(`/shifts/${myShift.id}/qualifications`)
      .send({ qualificationId: w.globalQual.id });
    expect(again.status).toBe(200);
    expect(again.body.alreadyRequired).toBe(true);
    expect(again.body.id).toBe(added.body.id);

    expect((await w.sup.get(`/shifts/${myShift.id}/qualifications`)).status).toBe(200);
    expect(
      (await w.sup.delete(`/shifts/${myShift.id}/qualifications/${added.body.id}`)).status,
    ).toBe(204);
  });
});
