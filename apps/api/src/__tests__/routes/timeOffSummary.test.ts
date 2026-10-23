import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * F500 G2 — GET /time-off/admin/summary: who is out today, this workweek,
 * what waits, what starts in the next 14 days, and the rows of the two-week
 * "Who's off" strip — counted in people, inside the caller's reach.
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

const plus = (key: string, days: number) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const day = (key: string) => new Date(`${key}T00:00:00Z`);

describe('GET /time-off/admin/summary', () => {
  it('counts people out today, this week, pending and upcoming, and lists the next two weeks', async () => {
    const today = orgDateKey(new Date());
    const [ann, ben, cy, eve, fay, gus] = await Promise.all(
      ['Ann', 'Ben', 'Cy', 'Eve', 'Fay', 'Gus'].map((n) => createAssociate({ firstName: n, lastName: 'Test' })),
    );
    const req = (a: { id: string }, from: number, to: number, status: 'APPROVED' | 'PENDING' | 'DENIED') =>
      prisma.timeOffRequest.create({
        data: { associateId: a.id, category: 'VACATION', startDate: day(plus(today, from)), endDate: day(plus(today, to)), requestedMinutes: 480, status },
      });
    await req(ann!, -1, 1, 'APPROVED'); // out today and this week
    await req(ann!, 12, 12, 'APPROVED'); // and again in 12 days
    await req(cy!, 10, 11, 'APPROVED'); // upcoming, inside the strip
    await req(ben!, 20, 22, 'APPROVED'); // past the horizon
    await req(eve!, -30, -25, 'APPROVED'); // long over
    await req(fay!, 2, 3, 'PENDING');
    await req(gus!, 0, 0, 'DENIED');

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const res = await (await loginAs(hr.email)).get('/time-off/admin/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ today, outToday: 1, outThisWeek: 1, pending: 1, upcoming: 2 });
    expect(res.body.whosOff.map((r: { name: string; startDate: string }) => `${r.name} ${r.startDate}`)).toEqual([
      `Ann Test ${plus(today, -1)}`,
      `Cy Test ${plus(today, 10)}`,
      `Ann Test ${plus(today, 12)}`,
    ]);
    expect(res.body.horizonEnd).toBe(plus(today, 13));
  });

  it("a supervisor reads only their own client's people", async () => {
    const today = orgDateKey(new Date());
    const client = await createClient('Front Beach');
    const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const mine = await createAssociate({ firstName: 'Mine', lastName: 'Placed' });
    const other = await createAssociate({ firstName: 'Other', lastName: 'Elsewhere' });
    await prisma.associateAssignment.create({ data: { associateId: mine.id, locationId: store.id, startedAt: new Date('2026-01-01') } });
    for (const a of [mine, other]) {
      await prisma.timeOffRequest.create({
        data: { associateId: a.id, category: 'PTO', startDate: day(today), endDate: day(today), requestedMinutes: 480, status: 'APPROVED' },
      });
      await prisma.timeOffRequest.create({
        data: { associateId: a.id, category: 'PTO', startDate: day(plus(today, 3)), endDate: day(plus(today, 3)), requestedMinutes: 480, status: 'PENDING' },
      });
    }
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const res = await (await loginAs(sup.email)).get('/time-off/admin/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outToday: 1, pending: 1 });
    expect(res.body.whosOff.map((r: { name: string }) => r.name)).toEqual(['Mine Placed']);

    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: mine.id });
    expect((await (await loginAs(assoc.email)).get('/time-off/admin/summary')).status).toBe(403);
  });
});
