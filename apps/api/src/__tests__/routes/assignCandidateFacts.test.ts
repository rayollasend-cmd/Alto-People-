import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { minuteOfDayInZone } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The Assign dialog's facts (ops walk 7): home store, hours after this
 * shift and the overtime premium, the shift's cost, reliability over 90
 * days, their window on the day, site history and credentials — on the
 * candidate row, so deciding never means leaving the dialog.
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
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

const TZ = 'America/New_York';
const H = 3_600_000;

/** The next Monday at least 8 days out, at hh:00 on the store's clock. */
function nextMondayAt(hh: number): Date {
  for (let d = 8; d < 16; d++) {
    const base = new Date(Date.now() + d * 86_400_000);
    base.setUTCSeconds(0, 0);
    const at = new Date(base.getTime() + (hh * 60 - minuteOfDayInZone(base, TZ)) * 60_000);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(at);
    if (wd === 'Mon') return at;
  }
  throw new Error('no Monday');
}

describe('GET /scheduling/shifts/:id/auto-fill facts', () => {
  it('each candidate carries the facts a scheduler decides on', async () => {
    const client = await createClient('Front Beach');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: site.id }, data: { timezone: TZ } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.application.create({ data: { associateId: ana.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date(Date.now() - 60 * 86_400_000) } });
    // Mon 4p–11p.
    await prisma.associateAvailability.create({ data: { associateId: ana.id, dayOfWeek: 1, startMinute: 16 * 60, endMinute: 23 * 60 } });
    // Two lates and a call-out in the last 90 days; an excused one doesn't count.
    const on = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
    await prisma.attendanceEvent.createMany({
      data: [
        { associateId: ana.id, kind: 'LATE', points: 0.5, occurredOn: on(10) },
        { associateId: ana.id, kind: 'LATE', points: 0.5, occurredOn: on(20) },
        { associateId: ana.id, kind: 'CALL_OUT', points: 1, occurredOn: on(30) },
        { associateId: ana.id, kind: 'NO_CALL_NO_SHOW', points: 2, occurredOn: on(5), excusedAt: new Date() },
      ],
    });
    // One shift worked at this site last week.
    await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Housekeeper', startsAt: on(7), endsAt: new Date(on(7).getTime() + 8 * H), status: 'COMPLETED', assignedAssociateId: ana.id, publishedAt: on(14) },
    });
    // A 36-hour week already on the books, so this 4-hour shift lands on overtime.
    const starts = nextMondayAt(17);
    for (let d = 1; d <= 4; d++) {
      const s = new Date(starts.getTime() + d * 86_400_000 - 9 * H);
      await prisma.shift.create({
        data: { clientId: client.id, locationId: site.id, position: 'Housekeeper', startsAt: s, endsAt: new Date(s.getTime() + 10 * H), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: new Date() },
      });
    }
    const forklift = await prisma.qualification.create({ data: { clientId: client.id, code: 'FORK', name: 'Forklift' } });
    const target = await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: site.id,
        position: 'Housekeeper',
        startsAt: starts,
        endsAt: new Date(starts.getTime() + 4 * H),
        status: 'OPEN',
        publishedAt: new Date(),
        payRate: 20,
        qualReqs: { create: { qualificationId: forklift.id } },
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.get(`/scheduling/shifts/${target.id}/auto-fill`);
    expect(res.status).toBe(200);
    const row = res.body.candidates.find((c: { associateId: string }) => c.associateId === ana.id);
    expect(row).toMatchObject({
      homeLocationName: site.name,
      // 4 × 9 paid hours (10h shifts carry an hour's break) + this 4h shift.
      weeklyMinutesScheduled: 36 * 60,
      projectedWeeklyMinutes: 40 * 60,
      hourlyRateCents: 2000,
      shiftCostCents: 8000,
      otPremiumCents: 0,
      reliability: { late: 2, noShow: 0, callOut: 1, days: 90 },
      availabilityLabel: 'Avail Mon 4:00 PM–11:00 PM',
      matchesAvailability: true,
      siteShiftsWorked: 1,
      distanceMiles: null,
      credentials: { required: ['Forklift'], missing: ['Forklift'] },
    });

    // One more hour and the premium appears: half-time on the hour past 40.
    await prisma.shift.update({ where: { id: target.id }, data: { endsAt: new Date(starts.getTime() + 5 * H) } });
    const longer = await a.get(`/scheduling/shifts/${target.id}/auto-fill`);
    const again = longer.body.candidates.find((c: { associateId: string }) => c.associateId === ana.id);
    expect(again).toMatchObject({ projectedWeeklyMinutes: 41 * 60, otPremiumCents: 1000, shiftCostCents: 10000 });

    // Holding the credential clears it; no window on the day says so.
    await prisma.associateQualification.create({ data: { associateId: ana.id, qualificationId: forklift.id } });
    await prisma.associateAvailability.deleteMany({ where: { associateId: ana.id } });
    const held = await a.get(`/scheduling/shifts/${target.id}/auto-fill`);
    const third = held.body.candidates.find((c: { associateId: string }) => c.associateId === ana.id);
    expect(third).toMatchObject({ credentials: { required: ['Forklift'], missing: [] }, availabilityLabel: 'No window on Mon', matchesAvailability: false });
  });
});
