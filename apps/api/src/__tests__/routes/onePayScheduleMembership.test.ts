import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { nextPaydayFor } from '../../lib/associatePayday.js';
import { scheduleMembershipFor } from '../../lib/payScheduleMembership.js';

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
});
