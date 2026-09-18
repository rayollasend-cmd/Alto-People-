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
 * One open-shift rule for every surface. The Open shifts page (/shifts/open)
 * used to list every OPEN shift at every client in the org — unpublished
 * ones too — filtered only by qualifications, and took claims at clients
 * the associate had never worked for; My schedule's section showed only the
 * clients they're placed at. Now both lists — and both claim endpoints —
 * read lib/openShiftEligibility.
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

async function seed() {
  const mine = await createClient('Walmart');
  const other = await createClient('Target');
  const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  await prisma.application.create({
    data: { associateId: maria.id, clientId: mine.id, onboardingTrack: 'STANDARD', status: 'APPROVED' },
  });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: maria.id });
  const open = (clientId: string, startH: number, extra: Record<string, unknown> = {}) =>
    prisma.shift.create({
      data: {
        clientId,
        position: 'Stocker',
        startsAt: inHours(startH),
        endsAt: inHours(startH + 6),
        status: 'OPEN',
        publishedAt: new Date(),
        ...extra,
      },
    });
  return { mine, other, maria, agent: await loginAs(user.email), open };
}

const ids = (body: { shifts: Array<{ id: string }> }) => body.shifts.map((s) => s.id).sort();

describe('one open-shift rule — the Open shifts page and My schedule list the same shifts', () => {
  it('only published shifts at clients they are placed at, that they are free for', async () => {
    const { mine, other, maria, agent, open } = await seed();
    const ok = await open(mine.id, 48);
    await open(other.id, 48); // a client they don't work for
    await open(mine.id, 72, { publishedAt: null }); // not published yet
    // Overlapping a shift of their own.
    await prisma.shift.create({
      data: {
        clientId: mine.id,
        position: 'Stocker',
        startsAt: inHours(98),
        endsAt: inHours(104),
        status: 'ASSIGNED',
        assignedAssociateId: maria.id,
        publishedAt: new Date(),
      },
    });
    await open(mine.id, 100);

    const marketplace = await agent.get('/shifts/open');
    const schedule = await agent.get('/scheduling/me/open-shifts');
    expect(marketplace.status).toBe(200);
    expect(ids(marketplace.body)).toEqual([ok.id]);
    expect(ids(schedule.body)).toEqual([ok.id]);
  });

  it('a required qualification they lack keeps a shift off both lists', async () => {
    const { mine, agent, open } = await seed();
    const forklift = await prisma.qualification.create({ data: { code: 'FORK', name: 'Forklift' } });
    const s = await open(mine.id, 48);
    await prisma.shiftQualificationRequirement.create({ data: { shiftId: s.id, qualificationId: forklift.id } });
    expect(ids((await agent.get('/shifts/open')).body)).toEqual([]);
    expect(ids((await agent.get('/scheduling/me/open-shifts')).body)).toEqual([]);
  });
});

describe('claiming follows the same rule, on both endpoints', () => {
  it('refuses a shift at a client they are not placed at', async () => {
    const { other, agent, open } = await seed();
    const s = await open(other.id, 48);
    for (const path of [`/shifts/${s.id}/claim`, `/scheduling/me/open-shifts/${s.id}/claim`]) {
      const res = await agent.post(path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code, path).toBe('not_placed_at_client');
    }
    expect(await prisma.openShiftClaim.count()).toBe(0);
  });

  it('refuses an unpublished shift, and one they lack the qualification for — on both', async () => {
    const { mine, agent, open } = await seed();
    const draft = await open(mine.id, 48, { publishedAt: null });
    expect((await agent.post(`/shifts/${draft.id}/claim`)).status).toBe(404);
    const forklift = await prisma.qualification.create({ data: { code: 'FORK', name: 'Forklift' } });
    const s = await open(mine.id, 60);
    await prisma.shiftQualificationRequirement.create({ data: { shiftId: s.id, qualificationId: forklift.id } });
    for (const path of [`/shifts/${s.id}/claim`, `/scheduling/me/open-shifts/${s.id}/claim`]) {
      const res = await agent.post(path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.message, path).toMatch(/Forklift/);
    }
  });

  it('takes the claim when the rule allows it', async () => {
    const { mine, agent, open } = await seed();
    const s = await open(mine.id, 48);
    expect((await agent.post(`/shifts/${s.id}/claim`)).status).toBe(201);
    expect(await prisma.openShiftClaim.count({ where: { shiftId: s.id, status: 'PENDING' } })).toBe(1);
  });
});
