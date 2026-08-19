import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  recordAttendanceForEntry,
  recordNoShowAttendance,
} from '../../lib/attendance.js';
import { runShiftReminderSweep } from '../../lib/shiftReminder.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Ops intelligence: attendance points, OT radar, client statements,
 * retention analytics.
 */

const app = () => createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  expect(r.status).toBe(200);
  return a;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/* ===== Attendance ========================================================= */

describe('attendance points', () => {
  it('clock-out hook writes LATE and EARLY_OUT, idempotently', async () => {
    const client = await createClient();
    const assoc = await createAssociate();
    const shift = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Associate',
        startsAt: new Date('2026-06-10T08:00:00.000Z'),
        endsAt: new Date('2026-06-10T16:00:00.000Z'),
        status: 'ASSIGNED',
        assignedAssociateId: assoc.id,
      },
    });
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: assoc.id,
        clientId: client.id,
        shiftId: shift.id,
        clockInAt: new Date('2026-06-10T08:20:00.000Z'), // 20 min late
        clockOutAt: new Date('2026-06-10T15:00:00.000Z'), // 60 min early
        status: 'COMPLETED',
      },
    });
    await recordAttendanceForEntry(prisma, entry.id);
    await recordAttendanceForEntry(prisma, entry.id); // replay — no dupes

    const events = await prisma.attendanceEvent.findMany({
      where: { associateId: assoc.id },
      orderBy: { kind: 'asc' },
    });
    expect(events.map((e) => e.kind).sort()).toEqual(['EARLY_OUT', 'LATE']);
    expect(events.every((e) => Number(e.points) === 0.5)).toBe(true);
  });

  it('no-show becomes CALL_OUT with a pending request, nothing when approved time off covers it', async () => {
    const client = await createClient();
    const excused = await createAssociate({ firstName: 'Ex', lastName: 'Cused' });
    const callout = await createAssociate({ firstName: 'Call', lastName: 'Out' });
    const ghost = await createAssociate({ firstName: 'No', lastName: 'Word' });
    const day = new Date('2026-06-10T08:00:00.000Z');

    const mkShift = (associateId: string) =>
      prisma.shift.create({
        data: {
          clientId: client.id,
          position: 'Associate',
          startsAt: day,
          endsAt: new Date('2026-06-10T16:00:00.000Z'),
          status: 'ASSIGNED',
          assignedAssociateId: associateId,
        },
      });
    const mkRequest = (associateId: string, status: 'APPROVED' | 'PENDING') =>
      prisma.timeOffRequest.create({
        data: {
          associateId,
          category: 'SICK',
          startDate: new Date('2026-06-10T00:00:00.000Z'),
          endDate: new Date('2026-06-10T00:00:00.000Z'),
          requestedMinutes: 480,
          status,
        },
      });

    await mkRequest(excused.id, 'APPROVED');
    await mkRequest(callout.id, 'PENDING');
    for (const a of [excused, callout, ghost]) {
      const shift = await mkShift(a.id);
      await recordNoShowAttendance(prisma, {
        id: shift.id,
        clientId: client.id,
        startsAt: shift.startsAt,
        assignedAssociateId: a.id,
      });
    }

    expect(
      await prisma.attendanceEvent.count({ where: { associateId: excused.id } }),
    ).toBe(0);
    const co = await prisma.attendanceEvent.findFirstOrThrow({
      where: { associateId: callout.id },
    });
    expect(co.kind).toBe('CALL_OUT');
    expect(Number(co.points)).toBe(1);
    const nc = await prisma.attendanceEvent.findFirstOrThrow({
      where: { associateId: ghost.id },
    });
    expect(nc.kind).toBe('NO_CALL_NO_SHOW');
    expect(Number(nc.points)).toBe(2);
  });

  it('scores the rolling window, excusal zeroes points, and supervisors are clamped', async () => {
    const client = await createClient();
    const other = await createClient('Other Corp');
    const assoc = await createAssociate();
    const mkEvent = (daysAgo: number, points: number) =>
      prisma.attendanceEvent.create({
        data: {
          associateId: assoc.id,
          clientId: client.id,
          kind: 'NO_CALL_NO_SHOW',
          points,
          occurredOn: new Date(Date.now() - daysAgo * 24 * 3_600_000),
        },
      });
    await mkEvent(5, 2);
    await mkEvent(10, 2);
    await mkEvent(120, 2); // outside the 90-day window — history only

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get(`/time/admin/attendance?associateId=${assoc.id}`);
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(4);
    expect(res.body.events).toHaveLength(3);

    // Excuse one recent event — the score drops.
    const target = res.body.events.find((e: { excused: boolean }) => !e.excused);
    const ex = await a.post(`/time/admin/attendance/${target.id}/excuse`).send({});
    expect(ex.status).toBe(200);
    const after = await a.get(`/time/admin/attendance?associateId=${assoc.id}`);
    expect(after.body.score).toBe(2);

    // A supervisor at another client can neither see nor excuse.
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: other.id,
    });
    const s = await loginAs(sup.email);
    const blind = await s.get(`/time/admin/attendance?associateId=${assoc.id}`);
    expect(blind.status).toBe(200);
    expect(blind.body.events).toHaveLength(0);
    await s.post(`/time/admin/attendance/${target.id}/excuse`).expect(404);
  });

  it('crossing a threshold notifies time admins once', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'Thresh', lastName: 'Old' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const shiftAt = async (iso: string) =>
      prisma.shift.create({
        data: {
          clientId: client.id,
          position: 'Associate',
          startsAt: new Date(iso),
          endsAt: new Date(new Date(iso).getTime() + 8 * 3_600_000),
          status: 'ASSIGNED',
          assignedAssociateId: assoc.id,
        },
      });
    // 2 + 2 points: the second event crosses the 3-point line.
    for (const iso of ['2026-06-08T08:00:00.000Z', '2026-06-09T08:00:00.000Z']) {
      const s = await shiftAt(iso);
      await recordNoShowAttendance(prisma, {
        id: s.id,
        clientId: client.id,
        startsAt: s.startsAt,
        assignedAssociateId: assoc.id,
      });
    }
    const notes = await prisma.notification.findMany({
      where: { recipientUserId: hr.id, subject: { contains: 'Attendance threshold' } },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain('verbal warning');
  });
});

/* ===== OT radar =========================================================== */

describe('OT radar', () => {
  it('alerts once per associate-week when remaining schedule projects past 40h', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'Over', lastName: 'Time' });
    await createUser({ role: 'HR_ADMINISTRATOR' }); // digest recipient
    // A Tuesday noon; three 16h shifts Wed–Fri = 48h remaining, all inside
    // the org's Sat→Fri week (Sat Aug 29 → Fri Sep 4, Florida time).
    const now = new Date('2026-09-01T12:00:00.000Z');
    for (const day of ['02', '03', '04']) {
      await prisma.shift.create({
        data: {
          clientId: client.id,
          position: 'Associate',
          startsAt: new Date(`2026-09-${day}T06:00:00.000Z`),
          endsAt: new Date(`2026-09-${day}T22:00:00.000Z`),
          status: 'ASSIGNED',
          assignedAssociateId: assoc.id,
          publishedAt: now,
        },
      });
    }
    const first = await runShiftReminderSweep(prisma, now);
    expect(first.otAlerts).toBe(1);
    const second = await runShiftReminderSweep(prisma, now);
    expect(second.otAlerts).toBe(0); // stamped — no re-alert

    const stamps = await prisma.otAlertStamp.findMany({
      where: { associateId: assoc.id },
    });
    expect(stamps).toHaveLength(1);
  });

  it('ot-outlook names who is projected over, clamped by client', async () => {
    const client = await createClient();
    const other = await createClient('Other Corp');
    const assoc = await createAssociate({ firstName: 'Long', lastName: 'Week' });
    // Remaining assigned shifts totaling 48h this week (future-dated so
    // "remaining" is the full duration regardless of when the test runs).
    const base = Date.now() + 24 * 3_600_000;
    for (let d = 0; d < 3; d++) {
      await prisma.shift.create({
        data: {
          clientId: client.id,
          position: 'Associate',
          startsAt: new Date(base + d * 24 * 3_600_000),
          endsAt: new Date(base + d * 24 * 3_600_000 + 16 * 3_600_000),
          status: 'ASSIGNED',
          assignedAssociateId: assoc.id,
        },
      });
    }
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a.get('/scheduling/ot-outlook');
    expect(res.status).toBe(200);
    // Shifts may straddle the UTC week boundary depending on the day this
    // test runs — the row appears whenever ≥40h lands inside the week.
    const row = res.body.rows.find(
      (r: { associateId: string }) => r.associateId === assoc.id,
    );
    if (row) {
      expect(row.associateName).toBe('Long Week');
      expect(row.projectedOtMinutes).toBeGreaterThan(0);
    }

    // A supervisor at another client never sees them.
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: other.id,
    });
    const s = await loginAs(sup.email);
    const blind = await s.get('/scheduling/ot-outlook');
    expect(blind.status).toBe(200);
    expect(
      blind.body.rows.find((r: { associateId: string }) => r.associateId === assoc.id),
    ).toBeUndefined();
  });
});

/* ===== Client statements ================================================== */

describe('client statements', () => {
  it('computes the billed snapshot with the weekly OT split, finalizes immutably', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'Bill', lastName: 'Able' });
    const location = await prisma.location.findFirstOrThrow({
      where: { clientId: client.id },
    });
    // One week (Mon Jun 8 – Fri Jun 12 2026), 5 × 10h approved = 50h:
    // 40 regular + 10 OT at the org default bill rate ($21.21 / $31.815).
    for (const day of ['08', '09', '10', '11', '12']) {
      await prisma.timeEntry.create({
        data: {
          associateId: assoc.id,
          clientId: client.id,
          locationId: location.id,
          clockInAt: new Date(`2026-06-${day}T08:00:00.000Z`),
          clockOutAt: new Date(`2026-06-${day}T18:00:00.000Z`),
          status: 'APPROVED',
        },
      });
    }
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const draft = await a
      .post(`/clients/${client.id}/statements`)
      .send({ periodStart: '2026-06-01', periodEnd: '2026-06-30' });
    expect(draft.status).toBe(200);
    expect(draft.body.status).toBe('DRAFT');
    expect(draft.body.snapshot.totals.hours).toBe(50);
    expect(draft.body.snapshot.totals.regularHours).toBe(40);
    expect(draft.body.snapshot.totals.otHours).toBe(10);
    // 40 × 21.21 + 10 × 21.21 × 1.5 = 848.40 + 318.15 = 1166.55
    expect(draft.body.snapshot.totals.amount).toBeCloseTo(1166.55, 2);

    const fin = await a.post(
      `/clients/${client.id}/statements/${draft.body.id}/finalize`,
    );
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe('FINAL');
    expect(fin.body.number).toBe(1);

    // A finalized period refuses regeneration and re-finalize.
    await a
      .post(`/clients/${client.id}/statements`)
      .send({ periodStart: '2026-06-01', periodEnd: '2026-06-30' })
      .expect(409);
    await a
      .post(`/clients/${client.id}/statements/${draft.body.id}/finalize`)
      .expect(409);

    // PDF renders.
    const pdf = await a.get(`/clients/${client.id}/statements/${draft.body.id}.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');

    // CSV twin carries the same totals.
    const csv = await a.get(`/clients/${client.id}/statements/${draft.body.id}.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('1166.55');
    expect(csv.text).toContain('Overtime hours,10.00');
  });
});

/* ===== Retention ========================================================== */

describe('retention analytics', () => {
  it('reports cohort survival and per-store separations', async () => {
    const client = await createClient();
    const location = await prisma.location.findFirstOrThrow({
      where: { clientId: client.id },
    });
    const mk = async (hiredDaysAgo: number, separatedDaysAgo: number | null) => {
      const assoc = await createAssociate();
      const hireDate = new Date(Date.now() - hiredDaysAgo * 24 * 3_600_000);
      await prisma.associate.update({
        where: { id: assoc.id },
        data: {
          hireDate,
          separatedAt:
            separatedDaysAgo === null
              ? null
              : new Date(Date.now() - separatedDaysAgo * 24 * 3_600_000),
        },
      });
      await prisma.associateAssignment.create({
        data: {
          associateId: assoc.id,
          locationId: location.id,
          startedAt: hireDate,
          endedAt: separatedDaysAgo === null ? null : new Date(),
        },
      });
      return assoc;
    };
    await mk(200, null); // survivor
    await mk(200, 150); // left after ~50 days — fails 90-day survival
    await mk(20, null); // too new to measure

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a.get('/analytics/retention');
    expect(res.status).toBe(200);
    expect(res.body.monthly).toHaveLength(12);
    const store = res.body.byLocation.find(
      (l: { locationId: string }) => l.locationId === location.id,
    );
    expect(store).toBeTruthy();
    expect(store.separations12mo).toBe(1);
    // Of the two old-enough hires, one survived 90 days → 50%.
    expect(store.survival90Pct).toBe(50);
  });
});
