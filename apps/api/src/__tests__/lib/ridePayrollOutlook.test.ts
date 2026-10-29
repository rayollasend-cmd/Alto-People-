import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { nextPaydayFor } from '../../lib/associatePayday.js';
import { ridePayrollOutlook } from '../../lib/ridePayrollOutlook.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The Ride page and Home say what payroll will actually take (coordinator
 * note after ASSOC-1): payroll never takes a fare below the minimum wage, so
 * a rider paid AT the minimum (Maria, $15/h in Florida) can't have any fare
 * come out of pay — GET /transport/me used to promise "$40 comes out Fri".
 */

const H = 3_600_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** Biweekly Sat→Fri paid the Friday after: Sep 12–25 pays Fri Oct 2. Florida ($15 minimum). */
async function seed(rate: number) {
  const client = await createClient();
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const schedule = await prisma.payrollSchedule.create({
    data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-01-03T00:00:00Z'), payDateOffsetDays: 7 },
  });
  await prisma.associate.update({ where: { id: associate.id }, data: { state: 'FL', payrollScheduleId: schedule.id } });
  await prisma.compensationRecord.create({
    data: { associateId: associate.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: rate, reason: 'HIRE' },
  });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const shift = (clockInAt: string, hours: number) =>
    prisma.timeEntry.create({
      data: { associateId: associate.id, clientId: client.id, locationId: store.id, clockInAt: new Date(clockInAt), clockOutAt: new Date(new Date(clockInAt).getTime() + hours * H), status: 'APPROVED' },
    });
  const ride = (serviceDate: string, chargeCents = 500, extra: Record<string, unknown> = {}) =>
    prisma.ride.create({
      data: {
        associateId: associate.id,
        direction: 'TO_WORK',
        locationId: store.id,
        address: '12 Oak St',
        targetAt: new Date(`${serviceDate}T13:00:00.000Z`),
        serviceDate,
        status: 'COMPLETED',
        fareCents: 500,
        noShowFeeCents: 100,
        chargeCents,
        authorizedSignatureId: randomUUID(),
        createdById: hr.id,
        ...extra,
      },
    });
  return { associate, shift, ride };
}

// Tue Sep 15: early in the Sep 12–25 period, the pay preview isn't open yet.
const EARLY = new Date('2026-09-15T15:00:00Z');
// Wed Sep 30: the preview for Fri Oct 2 is open.
const OPEN = new Date('2026-09-30T15:00:00Z');

describe('ridePayrollOutlook', () => {
  it('paid at the minimum wage: nothing can come out of pay, whatever the hours — said at once', async () => {
    const s = await seed(15);
    await s.shift('2026-09-14T13:00:00Z', 8);
    await s.ride('2026-09-14');
    await s.ride('2026-09-15');
    await s.ride('2026-09-28'); // the payday after: not this check's
    await s.ride('2026-09-16', 500, { authorizedSignatureId: null }); // unsigned: never taken
    for (const now of [EARLY, OPEN]) {
      expect(await ridePayrollOutlook(prisma, s.associate.id, '2026-09-25', now)).toEqual({ takeCents: 0, keptCents: 1000, reason: 'MINIMUM_WAGE', minimumWageCents: 1500, state: 'FL' });
    }
  });

  it('above the minimum: payroll’s own plan once the preview is open; not known before', async () => {
    const s = await seed(20);
    await s.shift('2026-09-14T13:00:00Z', 8);
    await s.ride('2026-09-14');
    await s.ride('2026-09-15', 100);
    expect(await ridePayrollOutlook(prisma, s.associate.id, '2026-09-25', OPEN)).toMatchObject({ takeCents: 600, keptCents: 0, reason: null });
    expect(await ridePayrollOutlook(prisma, s.associate.id, '2026-09-25', EARLY)).toMatchObject({ takeCents: null, keptCents: 0, reason: null });
  });

  it('a check too small above the minimum keeps what does not fit', async () => {
    const s = await seed(16);
    await s.shift('2026-09-14T13:00:00Z', 4); // $64 gross, $4 above the $60 floor
    await s.ride('2026-09-14');
    await s.ride('2026-09-15', 100);
    expect(await ridePayrollOutlook(prisma, s.associate.id, '2026-09-25', OPEN)).toMatchObject({ takeCents: 100, keptCents: 500, reason: 'CHECK_TOO_SMALL' });
  });

  it('nothing owed through the period: no outlook', async () => {
    const s = await seed(15);
    await s.ride('2026-09-28');
    expect(await ridePayrollOutlook(prisma, s.associate.id, '2026-09-25', OPEN)).toBeNull();
  });
});

describe('GET /transport/me', () => {
  it('a minimum-wage rider’s charges say payroll takes nothing on the coming payday', async () => {
    const s = await seed(15);
    const payday = (await nextPaydayFor(s.associate.id))!;
    await s.ride(payday.periodEnd, 2000);
    await s.ride(payday.periodEnd, 2000);
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: s.associate.id });
    const me = await (await loginAs(agent(), user.email)).get('/transport/me');
    expect(me.status).toBe(200);
    expect(me.body.charges).toMatchObject({
      pendingCents: 4000,
      nextPayday: { payDate: payday.payDate, periodEnd: payday.periodEnd },
      payroll: { takeCents: 0, keptCents: 4000, reason: 'MINIMUM_WAGE', minimumWageCents: 1500, state: 'FL' },
    });
  });
});
