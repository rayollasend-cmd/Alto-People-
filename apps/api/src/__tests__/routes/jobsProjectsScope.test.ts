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
 * A Job and a Project both belong to a client: the rate card people clock
 * in against, and the cost code they book hours to. Both sets of writes
 * were guarded by a capability alone — manage:scheduling for jobs,
 * manage:time for projects — and SHIFT_SUPERVISOR holds both while being
 * clamped to one client everywhere else in the product.
 *
 * The list endpoints were already scoped, which is what made this easy to
 * miss: the supervisor could not SEE another store's jobs, and could still
 * rewrite them by id.
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

async function seed() {
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

  const theirJob = await prisma.job.create({
    data: { clientId: theirs.id, name: 'Night stocker', payRate: 19.5, billRate: 31 },
  });
  const theirProject = await prisma.project.create({
    data: { clientId: theirs.id, code: 'GP-REMODEL', name: 'Gulf Point remodel' },
  });

  const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return {
    mine,
    theirs,
    theirJob,
    theirProject,
    sup: await loginAs(supUser.email),
    hr: await loginAs(hrUser.email),
  };
}

describe('job profiles belong to a client', () => {
  it('will not let a supervisor re-rate another client’s job', async () => {
    const w = await seed();
    const res = await w.sup.patch(`/jobs/${w.theirJob.id}`).send({ payRate: 7.25 });
    expect(res.status).toBe(404);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: w.theirJob.id } });
    expect(Number(after.payRate)).toBe(19.5);
  });

  it('will not let a supervisor delete another client’s job', async () => {
    const w = await seed();
    expect((await w.sup.delete(`/jobs/${w.theirJob.id}`)).status).toBe(404);
    expect(
      (await prisma.job.findUniqueOrThrow({ where: { id: w.theirJob.id } })).deletedAt,
    ).toBeNull();
  });

  it('will not let a supervisor create a job at another client', async () => {
    const w = await seed();
    const res = await w.sup
      .post('/jobs')
      .send({ clientId: w.theirs.id, name: 'Planted', payRate: 99 });
    expect(res.status).toBe(404);
    expect(await prisma.job.count({ where: { clientId: w.theirs.id, name: 'Planted' } })).toBe(0);
  });

  it('still manages the supervisor’s own client’s jobs', async () => {
    const w = await seed();
    const created = await w.sup
      .post('/jobs')
      .send({ clientId: w.mine.id, name: 'Day stocker', payRate: 18 });
    expect(created.status).toBe(201);
    expect((await w.sup.patch(`/jobs/${created.body.id}`).send({ payRate: 18.5 })).status).toBe(200);
    expect((await w.sup.delete(`/jobs/${created.body.id}`)).status).toBe(204);
  });

  it('leaves HR able to manage every client’s jobs', async () => {
    const w = await seed();
    expect((await w.hr.patch(`/jobs/${w.theirJob.id}`).send({ payRate: 20 })).status).toBe(200);
    expect((await w.hr.delete(`/jobs/${w.theirJob.id}`)).status).toBe(204);
  });
});

describe('project cost codes belong to a client', () => {
  it('will not let a supervisor rename or retire another client’s project', async () => {
    const w = await seed();
    expect(
      (await w.sup.put(`/projects/${w.theirProject.id}`).send({ name: 'Renamed' })).status,
    ).toBe(404);
    expect((await w.sup.delete(`/projects/${w.theirProject.id}`)).status).toBe(404);

    const after = await prisma.project.findUniqueOrThrow({ where: { id: w.theirProject.id } });
    expect(after.name).toBe('Gulf Point remodel');
    expect(after.isActive).toBe(true);
  });

  it('will not let a supervisor create a project at another client', async () => {
    const w = await seed();
    const res = await w.sup
      .post('/projects')
      .send({ clientId: w.theirs.id, code: 'PLANTED', name: 'Planted' });
    expect(res.status).toBe(404);
    expect(await prisma.project.count({ where: { code: 'PLANTED' } })).toBe(0);
  });

  it('still manages the supervisor’s own client’s projects', async () => {
    const w = await seed();
    const created = await w.sup
      .post('/projects')
      .send({ clientId: w.mine.id, code: 'FB-SETUP', name: 'Front Beach setup' });
    expect(created.status).toBe(201);
    expect((await w.sup.put(`/projects/${created.body.id}`).send({ name: 'Setup' })).status).toBe(200);
    expect((await w.sup.delete(`/projects/${created.body.id}`)).status).toBe(204);
  });
});

describe('clocking in against a job', () => {
  /**
   * Self-service clock-in is manager-side (hourly associates use the kiosk
   * PIN), so the caller here is the supervisor — who is clamped to one
   * client everywhere else. The punch took any active job id and stamped
   * that job's clientId onto the entry. scopeTimeEntries filters on that
   * column, so the shift lands in another client's reports and portal and
   * vanishes from their own store's. Payroll pays from the compensation
   * record rather than the entry's payRate, so this moved reporting, not
   * money.
   */
  it('refuses a job at a client the supervisor is not assigned to', async () => {
    const w = await seed();
    const res = await w.sup.post('/time/me/clock-in').send({ jobId: w.theirJob.id });
    expect(res.status).toBe(404);
    expect(await prisma.timeEntry.count()).toBe(0);
  });

  it('takes a job at their own client', async () => {
    const w = await seed();
    const myJob = await prisma.job.create({
      data: { clientId: w.mine.id, name: 'Front stocker', payRate: 17 },
    });
    const res = await w.sup.post('/time/me/clock-in').send({ jobId: myJob.id });
    expect(res.status).toBe(201);
    const entry = await prisma.timeEntry.findFirstOrThrow({});
    expect(entry.clientId).toBe(w.mine.id);
    expect(Number(entry.payRate)).toBe(17);
  });

  it('still lets an org-wide manager clock in against any client’s job', async () => {
    const w = await seed();
    // The guard keys off client-boundedness, not placement: an operations
    // manager has no clientId and must not be narrowed by this.
    const mgrAssoc = await createAssociate({ firstName: 'Olu', lastName: 'Adeyemi' });
    const { user } = await createUser({
      role: 'OPERATIONS_MANAGER',
      associateId: mgrAssoc.id,
    });
    const mgr = await loginAs(user.email);
    expect((await mgr.post('/time/me/clock-in').send({ jobId: w.theirJob.id })).status).toBe(201);
  });
});
