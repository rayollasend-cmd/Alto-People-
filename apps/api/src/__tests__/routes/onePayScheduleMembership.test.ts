import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { nextPaydayFor } from '../../lib/associatePayday.js';
import { membershipWindows, membershipWindowsFor, scheduleMembershipFor } from '../../lib/payScheduleMembership.js';

/**
 * One definition of "on a pay schedule" (F500 SH-4).
 *
 * Before: Readiness read the legacy Associate.payrollScheduleId (22 missing),
 * Pay schedules read the assignments (10), and My pay fell back to the
 * client's or the first org schedule — a payday no run would pay. Now one
 * rule (lib/payScheduleMembership scheduleMembershipFor), the one a run pays
 * by, answers every surface; the same seeded people must give the same count
 * on Readiness, Pay schedules, the payroll home and the Inbox.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function seed() {
  const client = await createClient('Coastal');
  const live = await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-09-12'), payDateOffsetDays: 7 } });
  const retired = await prisma.payrollSchedule.create({ data: { name: 'Old weekly', frequency: 'WEEKLY', anchorDate: new Date('2026-01-03'), payDateOffsetDays: 6, isActive: false } });
  const hire = async (first: string) => {
    const a = await createAssociate({ firstName: first, lastName: 'Test' });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    return a;
  };
  const today = new Date();
  // Members.
  const legacy = await hire('Legacy'); // the old per-person picker, no assignment history
  await prisma.associate.update({ where: { id: legacy.id }, data: { payrollScheduleId: live.id } });
  const assigned = await hire('Assigned'); // an assignment in force
  await prisma.payrollScheduleAssignment.create({ data: { associateId: assigned.id, scheduleId: live.id, effectiveFrom: new Date(today.getTime() - 60 * DAY), source: 'DEFAULT' } });
  const booked = await hire('Booked'); // a move booked to start in three weeks
  await prisma.payrollScheduleAssignment.create({ data: { associateId: booked.id, scheduleId: live.id, effectiveFrom: new Date(ymd(new Date(today.getTime() + 21 * DAY))), source: 'RULE' } });
  // On no schedule.
  const stale = await hire('Stale'); // the mirror still names the schedule, but the assignment ended
  await prisma.associate.update({ where: { id: stale.id }, data: { payrollScheduleId: live.id } });
  await prisma.payrollScheduleAssignment.create({ data: { associateId: stale.id, scheduleId: live.id, effectiveFrom: new Date(today.getTime() - 90 * DAY), effectiveTo: new Date(today.getTime() - 30 * DAY), source: 'DEFAULT' } });
  const nobody = await hire('Nobody'); // nothing at all — the dev data's 10
  const onRetired = await hire('Retired'); // on a schedule no run will be made on
  await prisma.associate.update({ where: { id: onRetired.id }, data: { payrollScheduleId: retired.id } });
  // Not who a run is for: paused, onboarding, on file only.
  const paused = await hire('Paused');
  await prisma.associate.update({ where: { id: paused.id }, data: { deactivatedAt: new Date() } });
  const onboarding = await createAssociate({ firstName: 'Onboarding', lastName: 'Test' });
  await prisma.application.create({ data: { associateId: onboarding.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'DRAFT' } });
  await createAssociate({ firstName: 'OnFile', lastName: 'Test' });
  return { live, legacy, assigned, booked, stale, nobody, onRetired, paused, onboarding };
}

describe('one definition of "on a pay schedule"', () => {
  it('Readiness, Pay schedules, the payroll home and the Inbox give the same number', async () => {
    const s = await seed();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);

    const readiness = await a.get('/payroll/readiness');
    expect(readiness.status).toBe(200);
    // The people a run is for: the six hired and employed — not paused, onboarding or on file only.
    expect(readiness.body.total).toBe(6);
    const missing = (readiness.body.rows as Array<{ firstName: string; flags: { payScheduleAssigned: boolean } }>)
      .filter((r) => !r.flags.payScheduleAssigned)
      .map((r) => r.firstName)
      .sort();
    expect(missing).toEqual(['Nobody', 'Retired', 'Stale']);

    const schedules = await a.get('/payroll/pay-schedules');
    expect(schedules.status).toBe(200);
    expect(schedules.body.unassigned).toBe(3);

    const unassigned = await a.get('/payroll/pay-schedules/unassigned');
    expect(unassigned.status).toBe(200);

    const upcoming = await a.get('/payroll/upcoming');
    expect(upcoming.status).toBe(200);
    expect(upcoming.body.peopleOnNoSchedule).toBe(3);

    const inbox = await a.get('/me/inbox');
    const src = (inbox.body.sources as Array<{ key: string; count: number }>).find((x) => x.key === 'pay-schedule-unassigned');
    expect(src?.count).toBe(3);

    // The resolver itself, person by person.
    const m = await scheduleMembershipFor(prisma, [s.legacy.id, s.assigned.id, s.booked.id, s.stale.id, s.nobody.id, s.onRetired.id]);
    expect(m.get(s.legacy.id)).toMatchObject({ scheduleId: s.live.id, legacy: true });
    expect(m.get(s.assigned.id)).toMatchObject({ scheduleId: s.live.id, legacy: false });
    expect(m.get(s.booked.id)).toMatchObject({ scheduleId: s.live.id });
    expect(m.get(s.stale.id)).toBeNull();
    expect(m.get(s.nobody.id)).toBeNull();
    expect(m.get(s.onRetired.id)).toBeNull();
  });

  it('My pay promises a payday only to members — the 22-vs-10 person gets none', async () => {
    const s = await seed();
    expect(await nextPaydayFor(s.nobody.id)).toBeNull();
    expect(await nextPaydayFor(s.stale.id)).toBeNull();
    expect(await nextPaydayFor(s.onRetired.id)).toBeNull();
    const member = await nextPaydayFor(s.assigned.id);
    expect(member?.schedule).toBe('Biweekly');
    // The booked mover's first payday pays a period that includes her first day on the schedule.
    const booked = await nextPaydayFor(s.booked.id);
    const start = ymd(new Date(Date.now() + 21 * DAY));
    expect(booked!.periodEnd >= start).toBe(true);
    expect(booked!.periodStart <= start || booked!.periodStart > ymd(new Date())).toBe(true);

    // The associate's page is told why there is no date.
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: s.nobody.id });
    const a = await loginAs(agent(), user.email);
    expect((await a.get('/payroll/me/next-payday')).body).toEqual({ nextPayday: null, notOnSchedule: true });
  });

  it('who a run pays, for every schedule at once: the same answer one schedule at a time gives, in two queries (Sentry API-13)', async () => {
    const s = await seed();
    const weekly = await prisma.payrollSchedule.create({ data: { name: 'Weekly', frequency: 'WEEKLY', anchorDate: new Date('2026-09-12'), payDateOffsetDays: 6 } });
    await prisma.payrollScheduleAssignment.create({ data: { associateId: s.nobody.id, scheduleId: weekly.id, effectiveFrom: new Date('2026-10-01'), effectiveTo: new Date('2026-10-14'), source: 'RULE' } });
    const ranges = [
      { scheduleId: s.live.id, from: ymd(new Date(Date.now() - 20 * DAY)), to: ymd(new Date(Date.now() + 30 * DAY)) },
      { scheduleId: weekly.id, from: '2026-10-08', to: '2026-10-20' },
    ];
    const assignments = vi.spyOn(prisma.payrollScheduleAssignment, 'findMany');
    const people = vi.spyOn(prisma.associate, 'findMany');
    const batch = await membershipWindowsFor(prisma, ranges);
    expect(assignments).toHaveBeenCalledTimes(1);
    expect(people).toHaveBeenCalledTimes(1);
    assignments.mockRestore();
    people.mockRestore();
    for (const r of ranges) {
      const one = await membershipWindows(prisma, r.scheduleId, r.from, r.to);
      expect(Object.fromEntries(batch.get(r.scheduleId)!)).toEqual(Object.fromEntries(one));
    }
    // The weekly range clips Nobody's two weeks to the days it asks about.
    expect(batch.get(weekly.id)!.get(s.nobody.id)).toEqual([{ start: '2026-10-08', end: '2026-10-14' }]);
    // The legacy member is on the live schedule for the whole range; an assignment that ended before it is not.
    expect(batch.get(s.live.id)!.get(s.legacy.id)).toEqual([{ start: ranges[0]!.from, end: ranges[0]!.to }]);
    expect(batch.get(s.live.id)!.has(s.stale.id)).toBe(false);
  });
});
