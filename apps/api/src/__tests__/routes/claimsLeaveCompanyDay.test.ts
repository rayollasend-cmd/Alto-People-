import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Deep audit 2026-10-29.
 *   CODE-24: a page number the route can't use is the client's mistake — a
 *            400, never a 500 from Prisma's skip (`?page=1e9`, `?page=1.5`).
 *   CODE-14: the claims desks count "overdue" against the company's day,
 *            not UTC's — at 11:30 PM Eastern a response due today is not
 *            overdue yet.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function hrAgent(): Promise<TestAgent<Test>> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

describe('paging inputs (CODE-24)', () => {
  it('answers 400 for a page Prisma could not skip to, and 200 for a real one', async () => {
    const a = await hrAgent();
    for (const path of ['/leave/cases', '/claims/unemployment', '/claims/workers-comp']) {
      for (const page of ['1.5', '0', '100000000', '1e20']) {
        const r = await a.get(`${path}?page=${page}`);
        expect(r.status, `${path}?page=${page}`).toBe(400);
      }
      const ok = await a.get(`${path}?page=2`);
      expect(ok.status, `${path}?page=2`).toBe(200);
    }
  });
});

describe('the company day (CODE-14)', () => {
  it('a response due today is not overdue at 11:30 PM Eastern, when UTC is already tomorrow', async () => {
    const a = await hrAgent();
    // 03:30 UTC is 23:30 (EDT) or 22:30 (EST) the evening before in New York.
    const real = new Date();
    const pinned = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate(), 3, 30));
    if (pinned.getTime() > real.getTime()) pinned.setUTCDate(pinned.getUTCDate() - 1);
    const easternToday = dateKeyInZone(pinned, 'America/New_York');
    expect(easternToday).not.toBe(pinned.toISOString().slice(0, 10));

    const worker = await createAssociate({ firstName: 'Una', lastName: 'Claim' });
    await prisma.unemploymentClaim.create({
      data: {
        associateId: worker.id,
        state: 'NY',
        claimDate: new Date(`${easternToday}T00:00:00.000Z`),
        noticeReceivedAt: new Date(`${easternToday}T00:00:00.000Z`),
        responseDueAt: new Date(`${easternToday}T00:00:00.000Z`),
      },
    });

    vi.useFakeTimers({ toFake: ['Date'], now: pinned });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const r = await a.get('/claims/unemployment/summary');
    expect(r.status).toBe(200);
    expect(r.body.overdue).toBe(0);
    expect(r.body.responsesDueThisWeek).toBe(1);
  });
});
