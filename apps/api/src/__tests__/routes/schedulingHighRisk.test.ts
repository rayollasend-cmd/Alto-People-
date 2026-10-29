import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { pinMidweekNoon } from '../../../test/clock.js';

/**
 * FLOOR-31 (deep audit 2026-10-29): the Needs-you row "N of tomorrow's
 * shifts are held by high-risk attendees" opened the whole day with nothing
 * marked. GET /scheduling/shifts/high-risk names those shifts so the
 * schedule can open on them (?risk=1) — the radar's own definition, and
 * only the caller's: a one-client supervisor never learns another client's.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const H = 3_600_000;
const D = 24 * H;

async function riskyHolder(name: string, now: Date) {
  const a = await createAssociate({ firstName: name, lastName: 'Holder' });
  for (const back of [10, 20]) {
    await prisma.attendanceEvent.create({
      data: { associateId: a.id, kind: 'NO_CALL_NO_SHOW', points: 2, occurredOn: new Date(now.getTime() - back * D) },
    });
  }
  return a;
}

async function tomorrowShift(associateId: string, clientId: string, locationId: string, now: Date) {
  // Pinned at noon Eastern Wednesday: tomorrow 9 AM Eastern is +21h.
  const startsAt = new Date(now.getTime() + 21 * H);
  return prisma.shift.create({
    data: {
      clientId,
      locationId,
      position: 'Housekeeper',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 8 * H),
      status: 'ASSIGNED',
      assignedAssociateId: associateId,
      publishedAt: new Date(now.getTime() - D),
    },
  });
}

describe('GET /scheduling/shifts/high-risk', () => {
  it("names tomorrow's high-risk shifts — the caller's client's only — and never a calm holder's", async () => {
    const now = pinMidweekNoon();
    const mine = await createClient('Coastal Resort Holdings');
    const theirs = await createClient('Inland Grocers');
    const myStore = await prisma.site.findFirstOrThrow({ where: { clientId: mine.id } });
    const theirStore = await prisma.site.findFirstOrThrow({ where: { clientId: theirs.id } });

    const risky = await tomorrowShift((await riskyHolder('Rita', now)).id, mine.id, myStore.id, now);
    const calm = await tomorrowShift((await createAssociate({ firstName: 'Cal', lastName: 'Calm' })).id, mine.id, myStore.id, now);
    const elsewhere = await tomorrowShift((await riskyHolder('Otto', now)).id, theirs.id, theirStore.id, now);

    const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });
    const a = await loginAs(agent(), lead.email);
    const res = await a.get('/scheduling/shifts/high-risk');
    expect(res.status).toBe(200);
    const ids = (res.body.shifts as Array<{ shiftId: string; points: number }>).map((s) => s.shiftId);
    expect(ids).toEqual([risky.id]);
    expect(ids).not.toContain(calm.id);
    expect(ids).not.toContain(elsewhere.id);
    expect(res.body.shifts[0].points).toBeGreaterThanOrEqual(2.5);

    // The Needs-you row that counts them opens the schedule on them.
    const decisions = await a.get('/me/decisions');
    expect(decisions.status).toBe(200);
    const row = (decisions.body.decisions as Array<{ key: string; label: string; linkUrl: string }>).find((d) => d.key.startsWith('risk:tomorrow'));
    expect(row?.label).toMatch(/^1 of tomorrow's shifts is held by high-risk attendees/);
    expect(row?.linkUrl).toMatch(/^\/scheduling\?view=day&risk=1&date=\d{4}-\d{2}-\d{2}$/);

    // An org-wide scheduler sees both clients' flagged shifts.
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const b = await loginAs(agent(), hr.email);
    const all = await b.get('/scheduling/shifts/high-risk');
    expect(all.status).toBe(200);
    expect((all.body.shifts as Array<{ shiftId: string }>).map((s) => s.shiftId).sort()).toEqual([risky.id, elsewhere.id].sort());
  });

  it('is closed to an associate', async () => {
    pinMidweekNoon();
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(agent(), user.email);
    const res = await a.get('/scheduling/shifts/high-risk');
    expect(res.status).toBe(403);
  });
});
