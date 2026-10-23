import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { teamNumbers } from '../../lib/teamNumbers.js';
import { dateKeyInZone, startOfWeekUTC } from '../../lib/timeAnomalies.js';
import type { SessionUser } from '../../types/express.js';

/**
 * My team in numbers (F500 2026-10-22): on the clock, scheduled today,
 * hours this week against the schedule, lates and no-shows over seven days
 * and overtime risk — the caller's own reports only.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const TZ = 'America/New_York';

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function store(name: string) {
  const client = await createClient(name);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  return { client, site };
}

async function shift(clientId: string, siteId: string, startsAt: Date, hours: number, associateId: string, status: 'ASSIGNED' | 'COMPLETED' | 'CANCELLED' = 'ASSIGNED') {
  return prisma.shift.create({
    data: {
      clientId,
      locationId: siteId,
      position: 'Housekeeper',
      startsAt,
      endsAt: new Date(startsAt.getTime() + hours * HOUR),
      status,
      assignedAssociateId: associateId,
      publishedAt: new Date(startsAt.getTime() - 7 * DAY),
    },
  });
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function team() {
  const boss = await createAssociate({ firstName: 'Mia', lastName: 'Boss' });
  const [ana, ben, cy, zed] = await Promise.all([
    createAssociate({ firstName: 'Ana', lastName: 'Reyes' }),
    createAssociate({ firstName: 'Ben', lastName: 'Cole' }),
    createAssociate({ firstName: 'Cy', lastName: 'Park' }),
    createAssociate({ firstName: 'Zed', lastName: 'Else' }),
  ]);
  await prisma.associate.updateMany({ where: { id: { in: [ana.id, ben.id, cy.id] } }, data: { managerId: boss.id } });
  const { user } = await createUser({ role: 'MANAGER', associateId: boss.id });
  return { boss, ana, ben, cy, zed, user };
}

describe('teamNumbers', () => {
  it('counts the team’s clock, today, hours against the schedule, lates and no-shows, and overtime risk', async () => {
    // Wednesday Oct 14, 2026, 3 PM Eastern. The workweek began Saturday Oct 10.
    const now = new Date('2026-10-14T19:00:00Z');
    const a = await store('Harbor Inn');
    const { ana, ben, cy, zed, user } = await team();

    // Ana: four 10-hour days (40 h), on the clock since 1 PM (2 h), a 4-hour
    // shift today with 2 h still ahead → 44 h projected: overtime risk.
    for (const d of ['10', '11', '12', '13']) {
      await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: a.client.id, clockInAt: new Date(`2026-10-${d}T12:00:00Z`), clockOutAt: new Date(`2026-10-${d}T22:00:00Z`), status: 'APPROVED' } });
    }
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: a.client.id, clockInAt: new Date('2026-10-14T17:00:00Z'), status: 'ACTIVE' } });
    await shift(a.client.id, a.site.id, new Date('2026-10-14T17:00:00Z'), 4, ana.id);
    // A pulled shift is not scheduled.
    await shift(a.client.id, a.site.id, new Date('2026-10-14T22:00:00Z'), 3, ana.id, 'CANCELLED');

    // Ben: worked yesterday's 4-hour shift from 9:10 (3 h 50 m, late), has
    // tomorrow's 4-hour shift; a no-show on Oct 8 (inside seven days), one on
    // Oct 7 (outside) and an excused late (not counted).
    const yesterday = await shift(a.client.id, a.site.id, new Date('2026-10-13T13:00:00Z'), 4, ben.id, 'COMPLETED');
    await prisma.timeEntry.create({ data: { associateId: ben.id, clientId: a.client.id, shiftId: yesterday.id, clockInAt: new Date('2026-10-13T13:10:00Z'), clockOutAt: new Date('2026-10-13T17:00:00Z'), status: 'APPROVED' } });
    await shift(a.client.id, a.site.id, new Date('2026-10-15T13:00:00Z'), 4, ben.id);
    await prisma.attendanceEvent.createMany({
      data: [
        { associateId: ben.id, shiftId: yesterday.id, clientId: a.client.id, kind: 'LATE', points: 0.5, occurredOn: day('2026-10-13') },
        { associateId: ben.id, clientId: a.client.id, kind: 'NO_CALL_NO_SHOW', points: 2, occurredOn: day('2026-10-08'), source: 'MANUAL' },
        { associateId: ben.id, clientId: a.client.id, kind: 'NO_CALL_NO_SHOW', points: 2, occurredOn: day('2026-10-07'), source: 'MANUAL' },
        { associateId: ben.id, clientId: a.client.id, kind: 'LATE', points: 0.5, occurredOn: day('2026-10-12'), source: 'MANUAL', excusedAt: new Date() },
        { associateId: ben.id, clientId: a.client.id, kind: 'CALL_OUT', points: 1, occurredOn: day('2026-10-12'), source: 'MANUAL' },
      ],
    });

    // Cy: a 2-hour shift later today, nothing worked.
    await shift(a.client.id, a.site.id, new Date('2026-10-14T21:00:00Z'), 2, cy.id);

    // Zed is not on the team: none of this counts.
    await prisma.timeEntry.create({ data: { associateId: zed.id, clientId: a.client.id, clockInAt: new Date('2026-10-14T16:00:00Z'), status: 'ACTIVE' } });
    await shift(a.client.id, a.site.id, new Date('2026-10-14T16:00:00Z'), 4, zed.id);
    await prisma.attendanceEvent.create({ data: { associateId: zed.id, clientId: a.client.id, kind: 'LATE', points: 0.5, occurredOn: day('2026-10-14'), source: 'MANUAL' } });

    const n = await teamNumbers({ ...user, associateId: user.associateId } as unknown as SessionUser, now);
    expect(n.weekStart).toBe('2026-10-10');
    expect(n).toMatchObject({
      onClockNow: 1,
      scheduledToday: 2,
      // Ana 42 + Ben 3.8
      hoursWorked: 45.8,
      // Ana 4 + Ben 4 (yesterday) + Ben 4 (tomorrow) + Cy 2
      hoursScheduled: 14,
      lateOrNoShow7d: 2,
      lateOrNoShowPeople7d: 1,
      overtimeRisk: 1,
      overtimeThresholdHours: 40,
    });
    expect(n.people.get(ana.id)).toEqual({ workedHours: 42, projectedHours: 44, onClock: true, lateOrNoShow7d: 0 });
    expect(n.people.get(ben.id)).toEqual({ workedHours: 3.8, projectedHours: 7.8, onClock: false, lateOrNoShow7d: 2 });
    expect(n.people.get(cy.id)).toEqual({ workedHours: 0, projectedHours: 2, onClock: false, lateOrNoShow7d: 0 });
    expect(n.people.has(zed.id)).toBe(false);
  });

  it('is all zeros for someone with no reports', async () => {
    const lone = await createAssociate({ firstName: 'Lone', lastName: 'Lead' });
    const { user } = await createUser({ role: 'MANAGER', associateId: lone.id });
    const n = await teamNumbers({ ...user } as unknown as SessionUser, new Date('2026-10-14T19:00:00Z'));
    expect(n).toMatchObject({ onClockNow: 0, scheduledToday: 0, hoursWorked: 0, hoursScheduled: 0, lateOrNoShow7d: 0, overtimeRisk: 0 });
    expect(n.people.size).toBe(0);
  });
});

describe('GET /team/dashboard and /team/reports', () => {
  it('sends the team numbers with the pending counts, and each report’s week on the list', async () => {
    const a = await store('Harbor Inn');
    const { ana, ben, zed, user } = await team();
    const now = Date.now();
    // On the clock since half an hour ago, when that is still this week.
    const inAt = new Date(Math.max(now - 30 * 60_000, startOfWeekUTC(new Date()).getTime() + 60_000));
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: a.client.id, clockInAt: inAt, status: 'ACTIVE' } });
    await prisma.timeEntry.create({ data: { associateId: zed.id, clientId: a.client.id, clockInAt: inAt, status: 'ACTIVE' } });
    await prisma.attendanceEvent.create({ data: { associateId: ben.id, clientId: a.client.id, kind: 'LATE', points: 0.5, occurredOn: day(dateKeyInZone(new Date(now), TZ)), source: 'MANUAL' } });

    const http = await loginAs(agent(), user.email);
    const dash = await http.get('/team/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.directReports).toBe(3);
    expect(dash.body.team).toMatchObject({ onClockNow: 1, lateOrNoShow7d: 1, lateOrNoShowPeople7d: 1, overtimeThresholdHours: 40 });
    expect(dash.body.team.people).toBeUndefined();

    const list = await http.get('/team/reports');
    const byName = Object.fromEntries(list.body.reports.map((r: { firstName: string; week: unknown }) => [r.firstName, r.week]));
    expect(byName.Ana).toMatchObject({ onClock: true, lateOrNoShow7d: 0 });
    expect(byName.Ben).toMatchObject({ onClock: false, lateOrNoShow7d: 1, workedHours: 0 });
    expect(byName.Zed).toBeUndefined();
  });
});
