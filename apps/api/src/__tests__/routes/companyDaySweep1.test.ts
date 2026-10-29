import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { callerToday } from '../../lib/applicationFilters.js';
import { activeDelegationsTo } from '../../lib/delegations.js';
import { compEffectiveDay } from '../../lib/payChanges.js';
import { rideRateOn } from '../../lib/rideAuthorization.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import { addDaysToKey } from '../../lib/timezone.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The company-day sweep (2026-10-29), group 1. "Today" is the company's
 * calendar day (Eastern by default), never UTC's — which is already tomorrow
 * from 8 PM Eastern / 5 PM Pacific. Each case runs at 11:30 PM Eastern.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** The most recent 03:30 UTC: 11:30 PM (EDT) or 10:30 PM (EST) the evening before in New York. */
function easternEvening(): { at: Date; today: string; utcDay: string } {
  const real = new Date();
  const at = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate(), 3, 30));
  if (at.getTime() > real.getTime()) at.setUTCDate(at.getUTCDate() - 1);
  // The UTC day is what the test proves the code no longer uses.
  return { at, today: dateKeyInZone(at, 'America/New_York'), utcDay: at.toISOString().slice(0, 10) };
}

function pinClock(at: Date): void {
  vi.useFakeTimers({ toFake: ['Date'], now: at });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

describe('the company day, not UTC', () => {
  it('a filter with no day named counts from the company’s today', () => {
    const { at, today, utcDay } = easternEvening();
    expect(today).not.toBe(utcDay);
    expect(callerToday(undefined, at)).toBe(today);
    expect(callerToday('2026-03-04', at)).toBe('2026-03-04');
  });

  it('a pay change is dated by its named day, or by the company’s day it was made', () => {
    expect(compEffectiveDay(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01');
    // "Effective now" at 11:30 PM Eastern on Oct 29 is Oct 29, not UTC's Oct 30.
    expect(compEffectiveDay(new Date('2026-10-30T03:30:00.000Z'))).toBe('2026-10-29');
  });

  it('a cover that ends today still covers at 11:30 PM Eastern', async () => {
    const { at, today } = easternEvening();
    const { user: from } = await createUser({ role: 'MANAGER' });
    const { user: to } = await createUser({ role: 'MANAGER' });
    await prisma.teamDelegation.create({
      data: { fromUserId: from.id, toUserId: to.id, startsOn: new Date(`${addDaysToKey(today, -3)}T00:00:00.000Z`), endsOn: new Date(`${today}T00:00:00.000Z`) },
    });
    expect(await activeDelegationsTo(to.id, at)).toHaveLength(1);
  });

  it('tomorrow’s ride rate is not in force on tonight’s ride', async () => {
    const { at, today } = easternEvening();
    const tomorrow = addDaysToKey(today, 1);
    await prisma.transportRate.createMany({
      data: [
        { fareCents: 500, noShowFeeCents: 100, effectiveFrom: new Date('2024-01-01T00:00:00.000Z'), effectiveTo: new Date(`${today}T00:00:00.000Z`) },
        { fareCents: 700, noShowFeeCents: 150, effectiveFrom: new Date(`${tomorrow}T00:00:00.000Z`) },
      ],
    });
    expect((await rideRateOn(prisma, at))?.fareCents).toBe(500);
  });

  it('today’s birthday is still today’s at 11:30 PM Eastern — on the list and on the person’s home', async () => {
    const { at, today } = easternEvening();
    const person = await createAssociate({ firstName: 'Bea', lastName: 'Birthday' });
    await prisma.associate.update({ where: { id: person.id }, data: { dob: new Date(`1992-${today.slice(5)}T00:00:00.000Z`) /* a leap year: Feb 29 exists */ } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: self } = await createUser({ role: 'ASSOCIATE', associateId: person.id });
    const desk = await loginAs(hr.email);
    const mine = await loginAs(self.email);

    pinClock(at);
    const list = await desk.get('/celebrations/upcoming?days=7');
    expect(list.status).toBe(200);
    const bea = (list.body.items as Array<{ associateName: string; kind: string; date: string }>).find((i) => i.associateName === 'Bea Birthday');
    expect(bea).toMatchObject({ kind: 'BIRTHDAY', date: today });

    const ribbon = await mine.get('/celebrations/me');
    expect(ribbon.status).toBe(200);
    expect(ribbon.body.birthday).toBe(true);
  });
});
