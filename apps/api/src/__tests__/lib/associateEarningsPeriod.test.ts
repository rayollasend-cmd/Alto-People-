import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { computeAssociateEarnings } from '../../lib/associateEarnings.js';
import { endOfWeekUTC } from '../../lib/timeAnomalies.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

/**
 * One pay fact, one number (ASSOC-3/4/5/27): GET /time/me/earnings carries
 * the pay period running today — counted on the company's calendar day,
 * not the phone's — so Home's ring, My time's pay-period hero and Pay's
 * "pay before payday" read one earned figure and one take-home; the week's
 * take-home is its share of that same estimate; an open shift is priced at
 * its posted rate.
 */

const H = 3_600_000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Biweekly Sat→Fri anchored Sat Jan 3 2026: Oct 24 – Nov 6 pays Fri Nov 13. A Chicago store, $15/h. */
async function seed() {
  const client = await createClient();
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: store.id }, data: { timezone: 'America/Chicago' } });
  const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const schedule = await prisma.payrollSchedule.create({
    data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-01-03T00:00:00Z'), payDateOffsetDays: 7 },
  });
  await prisma.associate.update({ where: { id: associate.id }, data: { state: 'FL', payrollScheduleId: schedule.id, employmentType: 'W2_EMPLOYEE' } });
  await prisma.compensationRecord.create({
    data: { associateId: associate.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: 15, reason: 'HIRE' },
  });
  const shift = (clockInAt: string, hours: number, status: 'APPROVED' | 'COMPLETED' = 'APPROVED') =>
    prisma.timeEntry.create({
      data: { associateId: associate.id, clientId: client.id, locationId: store.id, clockInAt: new Date(clockInAt), clockOutAt: new Date(new Date(clockInAt).getTime() + hours * H), status },
    });
  return { client, store, associate, shift };
}

describe('the pay period on the earnings answer', () => {
  it('a Pacific evening counts the company’s day; the period, its day and its money', async () => {
    const s = await seed();
    // The period's first week: Sat Oct 24 – Thu Oct 29, 6:00–2:00 PM Chicago (8h), one approved, one awaiting review.
    await s.shift('2026-10-24T11:00:00Z', 8);
    await s.shift('2026-10-26T11:00:00Z', 8, 'COMPLETED');
    // The period before (Oct 10–23): never in this period.
    await s.shift('2026-10-23T11:00:00Z', 8);
    // Thu Oct 29, 11:00 PM Pacific = Fri Oct 30 06:00 UTC — already Friday for the company (Eastern).
    const now = new Date('2026-10-30T06:00:00Z');
    const e = await computeAssociateEarnings(prisma, s.associate.id, now);
    expect(e.period).toMatchObject({ start: '2026-10-24', end: '2026-11-06', payDate: '2026-11-13', today: '2026-10-30', day: 7, days: 14, workedHours: 16, earned: 240 });
    expect(e.timezone).toBeTruthy();
    // The week is the period's first: one take-home for the same hours.
    expect(e.earnedSoFar).toBe(240);
    expect(e.takeHome?.net).toBe(e.period?.takeHome?.net);
    expect(e.period?.takeHome?.net).toBeGreaterThan(0);
    expect(e.period?.takeHome?.net).toBeLessThan(240);
    // The week's days are the company's calendar days, Sat → Fri.
    expect(e.days.map((d) => d.date)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
  });

  it('the second week’s take-home is its share of the period’s, never a second figuring', async () => {
    const s = await seed();
    await s.shift('2026-10-24T11:00:00Z', 8);
    await s.shift('2026-11-02T12:00:00Z', 8); // Mon Nov 2 (CST)
    const now = new Date('2026-11-03T18:00:00Z');
    const e = await computeAssociateEarnings(prisma, s.associate.id, now);
    expect(e.period).toMatchObject({ start: '2026-10-24', earned: 240, workedHours: 16 });
    expect(e.earnedSoFar).toBe(120);
    const p = e.period!.takeHome!;
    expect(e.takeHome!.taxes).toBeCloseTo(p.taxes / 2, 1);
    expect(e.takeHome!.net).toBeCloseTo(p.net / 2, 1);
  });

  it('an evening shift at a Chicago store on the period’s last day stays in that period', async () => {
    const s = await seed();
    // Fri Nov 6, 7:00–11:00 PM CST = Sat Nov 7 01:00–05:00 UTC.
    await s.shift('2026-11-07T01:00:00Z', 4);
    const e = await computeAssociateEarnings(prisma, s.associate.id, new Date('2026-11-07T04:30:00Z'));
    expect(e.period).toMatchObject({ start: '2026-10-24', end: '2026-11-06', workedHours: 4, earned: 60 });
  });

  it('no pay schedule: no period, the card falls back to the week', async () => {
    const s = await seed();
    await prisma.associate.update({ where: { id: s.associate.id }, data: { payrollScheduleId: null } });
    const e = await computeAssociateEarnings(prisma, s.associate.id, new Date('2026-10-30T06:00:00Z'));
    expect(e.period).toBeNull();
  });
});

describe('open shifts are worth what they post (live clock)', () => {
  it('a $15.50 posted shift is $15.50 an hour, not their $15', async () => {
    const s = await seed();
    await prisma.application.create({ data: { associateId: s.associate.id, clientId: s.client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    const weekEnd = endOfWeekUTC(new Date()).getTime();
    const startsAt = new Date(Date.now() + 30 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 4 * H);
    const fits = endsAt.getTime() < weekEnd;
    await prisma.shift.create({
      data: { clientId: s.client.id, locationId: s.store.id, position: 'Stocker', startsAt, endsAt, status: 'OPEN', publishedAt: new Date(), payRate: 15.5 },
    });
    const e = await computeAssociateEarnings(prisma, s.associate.id);
    if (fits) {
      expect(e.openShifts.count).toBe(1);
      expect(e.openShifts.estAmount).toBeCloseTo(62, 1);
    } else {
      expect(e.openShifts.estAmount).toBe(0);
    }
  });
});
