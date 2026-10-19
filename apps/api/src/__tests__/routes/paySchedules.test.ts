import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import type { Test } from 'supertest';
import { createAssociate, createClient, createUser, prisma as testDb, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { prisma } from '../../db.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { desiredFor, patternSentence, type PersonFacts, type RuleRow } from '../../lib/payScheduleMembership.js';
import { flushScheduleRecompute } from '../../lib/payScheduleTriggers.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';

/**
 * Pay schedules decided by rules, effective-dated, and runs that pay
 * exactly the people on a schedule for their days on it.
 *
 *   Today is Monday Oct 19, 2026. "Weekly" runs Sat–Fri (Oct 17–23 now),
 *   "Biweekly" runs Sat–Fri fortnights (Oct 17–30 now, then Oct 31), both
 *   paid seven days after the period ends.
 */

const NOW = new Date('2026-10-19T15:00:00.000Z');

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await truncateAll();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await testDb.$disconnect();
});

type Agent = TestAgent<Test>;

async function seed() {
  const coastal = await createClient('Coastal Resort Holdings');
  const seaside = await createClient('Seaside Inn');
  const harbor = await createClient('Harbor Grill');
  const site = async (clientId: string) => testDb.site.findFirstOrThrow({ where: { clientId } });
  const [coastalSite, seasideSite, harborSite] = await Promise.all([site(coastal.id), site(seaside.id), site(harbor.id)]);
  const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const hr = await loginAs(agent(), hrUser.email);
  const weekly = await hr.post('/payroll/pay-schedules').send({ name: 'Weekly', frequency: 'WEEKLY', anchorDate: '2026-10-03', payDateOffsetDays: 7 });
  expect(weekly.status).toBe(201);
  const biweekly = await hr.post('/payroll/pay-schedules').send({ name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: '2026-10-03', payDateOffsetDays: 7 });
  expect(biweekly.status).toBe(201);
  return {
    hr,
    hrUser,
    coastal,
    seaside,
    harbor,
    coastalSite,
    seasideSite,
    harborSite,
    weekly: weekly.body.schedule as { id: string; name: string },
    biweekly: biweekly.body.schedule as { id: string; name: string },
  };
}

/** A working person placed at a site, hourly at $20, in a state payroll withholds for. */
async function worker(firstName: string, siteId: string) {
  const p = await createAssociate({ firstName, lastName: 'Worker' });
  await testDb.associate.update({ where: { id: p.id }, data: { state: 'KY' } });
  await testDb.associateAssignment.create({ data: { associateId: p.id, locationId: siteId, startedAt: new Date('2026-01-01') } });
  await testDb.compensationRecord.create({ data: { associateId: p.id, effectiveFrom: new Date('2026-01-01'), payType: 'HOURLY', amount: 20, reason: 'HIRE' } });
  return p;
}

async function hours(associateId: string, clientId: string, day: string, h: number) {
  await testDb.timeEntry.create({
    data: { associateId, clientId, clockInAt: new Date(`${day}T13:00:00.000Z`), clockOutAt: new Date(`${day}T${String(13 + h).padStart(2, '0')}:00:00.000Z`), status: 'APPROVED' },
  });
}

async function assignments(associateId: string) {
  const rows = await testDb.payrollScheduleAssignment.findMany({ where: { associateId }, orderBy: { effectiveFrom: 'asc' }, include: { schedule: { select: { name: true } } } });
  return rows.map((r) => ({ schedule: r.schedule.name, from: r.effectiveFrom.toISOString().slice(0, 10), to: r.effectiveTo?.toISOString().slice(0, 10) ?? null }));
}

async function clientRule(hr: Agent, scheduleId: string, clientId: string, effectiveFrom = '2026-10-19') {
  const res = await hr.post(`/payroll/pay-schedules/${scheduleId}/membership`).send({ add: [{ kind: 'CLIENT', clientId }], effectiveFrom });
  expect(res.status).toBe(200);
  return res.body.impact;
}

describe('the resolver', () => {
  const facts: PersonFacts = { associateId: 'p', name: 'P', clientId: 'c', siteId: 's', departmentId: 'd', payType: 'HOURLY', legacyScheduleId: null };
  const rule = (id: string, scheduleId: string, kind: string, extra: Partial<RuleRow> = {}): RuleRow => ({
    id,
    scheduleId,
    kind,
    clientId: kind === 'CLIENT' ? 'c' : null,
    siteId: kind === 'SITE' ? 's' : null,
    departmentId: kind === 'DEPARTMENT' ? 'd' : null,
    payType: kind === 'PAY_TYPE' ? 'HOURLY' : null,
    associateId: kind === 'INDIVIDUAL' || kind === 'EXCLUDE' ? 'p' : null,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    ...extra,
  });
  const opts = { defaultScheduleId: 'DEF', activeScheduleIds: new Set(['A', 'B', 'C', 'D', 'E', 'DEF']) };

  it('the most specific rule wins: individual › site › department › client › pay type › default', () => {
    const all = [rule('1', 'E', 'PAY_TYPE'), rule('2', 'D', 'CLIENT'), rule('3', 'C', 'DEPARTMENT'), rule('4', 'B', 'SITE'), rule('5', 'A', 'INDIVIDUAL')];
    expect(desiredFor(facts, all, '2026-10-19', opts).scheduleId).toBe('A');
    expect(desiredFor(facts, all.slice(0, 4), '2026-10-19', opts).scheduleId).toBe('B');
    expect(desiredFor(facts, all.slice(0, 3), '2026-10-19', opts).scheduleId).toBe('C');
    expect(desiredFor(facts, all.slice(0, 2), '2026-10-19', opts).scheduleId).toBe('D');
    expect(desiredFor(facts, all.slice(0, 1), '2026-10-19', opts).scheduleId).toBe('E');
    expect(desiredFor(facts, [], '2026-10-19', opts)).toMatchObject({ scheduleId: 'DEF', kind: 'DEFAULT' });
  });

  it('an exclusion takes that schedule away; equal claims from two schedules are a conflict; dates matter', () => {
    expect(desiredFor(facts, [rule('1', 'B', 'SITE'), rule('2', 'D', 'CLIENT'), rule('x', 'B', 'EXCLUDE')], '2026-10-19', opts).scheduleId).toBe('D');
    const c = desiredFor(facts, [rule('1', 'B', 'CLIENT'), rule('2', 'D', 'CLIENT')], '2026-10-19', opts);
    expect(c.scheduleId).toBeNull();
    expect(c.conflict).toMatch(/both claim/);
    const later = [rule('1', 'B', 'CLIENT', { effectiveFrom: new Date('2026-10-31') })];
    expect(desiredFor(facts, later, '2026-10-19', opts).scheduleId).toBe('DEF');
    expect(desiredFor(facts, later, '2026-10-31', opts).scheduleId).toBe('B');
  });

  it('says the pattern in words', () => {
    expect(patternSentence({ frequency: 'BIWEEKLY', anchorDate: '2026-10-03', payDateOffsetDays: 7 })).toBe('Every other week, Saturday to Friday, paid the Friday a week later');
    expect(patternSentence({ frequency: 'WEEKLY', anchorDate: '2026-10-03', payDateOffsetDays: 5 })).toBe('Every week, Saturday to Friday, paid the next Wednesday');
  });
});

describe('membership by rules', () => {
  it('a client rule previews, then puts its people on the schedule from the running period (no notice)', async () => {
    const s = await seed();
    const ana = await worker('Ana', s.coastalSite.id);
    const ben = await worker('Ben', s.coastalSite.id);
    await worker('Cy', s.seasideSite.id);

    const preview = await s.hr.post(`/payroll/pay-schedules/${s.weekly.id}/membership/preview`).send({ add: [{ kind: 'CLIENT', clientId: s.coastal.id }], effectiveFrom: '2026-10-19' });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ effectiveFrom: '2026-10-19', joins: 2, leaves: 0, conflicts: 0, truncated: false });
    expect(preview.body.movingFrom).toEqual([{ scheduleId: null, name: 'No schedule', count: 2 }]);
    expect(preview.body.people.map((p: { name: string }) => p.name).sort()).toEqual(['Ana Worker', 'Ben Worker']);
    expect(preview.body.people[0]).toMatchObject({ toScheduleName: 'Weekly', effectiveFrom: '2026-10-17', because: 'Client: Coastal Resort Holdings' });
    expect(preview.body.people[0].transition.firstNewPayDate).toBe('2026-10-30');
    // A preview writes nothing.
    expect(await testDb.payrollScheduleRule.count()).toBe(0);

    await clientRule(s.hr, s.weekly.id, s.coastal.id);
    expect(await assignments(ana.id)).toEqual([{ schedule: 'Weekly', from: '2026-10-17', to: null }]);
    expect((await testDb.associate.findUniqueOrThrow({ where: { id: ben.id } })).payrollScheduleId).toBe(s.weekly.id);
    await flushPendingNotifications();
    expect(await testDb.notification.count({ where: { recipientUserId: s.hrUser.id, category: 'payroll' } })).toBe(0);

    const list = await s.hr.get('/payroll/pay-schedules');
    expect(list.status).toBe(200);
    const weekly = list.body.schedules.find((x: { id: string }) => x.id === s.weekly.id);
    expect(weekly).toMatchObject({ people: 2, clients: [{ id: s.coastal.id, name: 'Coastal Resort Holdings' }], pattern: 'Every week, Saturday to Friday, paid the Friday a week later' });
    expect(weekly.nextPeriod).toMatchObject({ periodStart: '2026-10-10', periodEnd: '2026-10-16', payDate: '2026-10-23' });
    expect(list.body.unassigned).toBe(1); // Cy

    // Adding the same rule again changes nothing.
    const again = await s.hr.post(`/payroll/pay-schedules/${s.weekly.id}/membership/preview`).send({ add: [{ kind: 'CLIENT', clientId: s.coastal.id }], effectiveFrom: '2026-10-19' });
    expect(again.body).toMatchObject({ joins: 0, unchanged: 0 });
  });

  it('a transfer moves a person automatically at the new schedule’s next period, and payroll gets a notice', async () => {
    const s = await seed();
    const ana = await worker('Ana', s.coastalSite.id);
    await clientRule(s.hr, s.weekly.id, s.coastal.id);
    await clientRule(s.hr, s.biweekly.id, s.seaside.id);
    expect(await assignments(ana.id)).toEqual([{ schedule: 'Weekly', from: '2026-10-17', to: null }]);

    // The transfer, written the way any route writes it — the database client notices.
    await runWithTenant(ALTO_TENANT_ID, 'job', async () => {
      await prisma.associateAssignment.updateMany({ where: { associateId: ana.id, endedAt: null }, data: { endedAt: new Date('2026-10-18') } });
      await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: s.seasideSite.id, startedAt: new Date('2026-10-19') } });
    });
    await flushScheduleRecompute();

    expect(await assignments(ana.id)).toEqual([
      { schedule: 'Weekly', from: '2026-10-17', to: '2026-10-30' },
      { schedule: 'Biweekly', from: '2026-10-31', to: null },
    ]);
    // Still Weekly today: the mirror flips when the move starts.
    expect((await testDb.associate.findUniqueOrThrow({ where: { id: ana.id } })).payrollScheduleId).toBe(s.weekly.id);

    await flushPendingNotifications();
    const notes = await testDb.notification.findMany({ where: { recipientUserId: s.hrUser.id, category: 'payroll', channel: 'IN_APP' } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.subject).toBe('1 person moves pay schedules');
    expect(notes[0]!.body).toContain('Ana Worker — Weekly → Biweekly from Oct 31 (transferred; Ana works for Seaside Inn)');
    expect(notes[0]!.linkUrl).toBe(`/payroll/schedules/${s.biweekly.id}`);
    await flushPendingAudits();
    expect(await testDb.auditLog.count({ where: { action: 'payroll.schedule.auto_move', entityId: ana.id } })).toBe(1);

    // The roster says so, and the history tells it.
    const roster = await s.hr.get(`/payroll/pay-schedules/${s.weekly.id}/people`);
    expect(roster.body.groups[0].people[0]).toMatchObject({ name: 'Ana Worker', pendingMove: { toScheduleName: 'Biweekly', effectiveFrom: '2026-10-31' } });
    expect(roster.body.groups[0].people[0].issues.map((i: { code: string }) => i.code)).toContain('MOVING_SCHEDULE');
    const history = await s.hr.get(`/payroll/pay-schedules/${s.biweekly.id}/history`);
    expect(history.body.events.map((e: { summary: string }) => e.summary)).toContain('Ana Worker moves here from Oct 31 (transfer)');
    expect(history.body.events.some((e: { kind: string }) => e.kind === 'RULE_ADDED')).toBe(true);
  });

  it('a hire lands on the schedule its client’s rule names, from the period that is running', async () => {
    const s = await seed();
    await clientRule(s.hr, s.biweekly.id, s.harbor.id);
    const hire = await createAssociate({ firstName: 'Dee', lastName: 'New' });
    await testDb.application.create({ data: { associateId: hire.id, clientId: s.harbor.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date(), startDate: new Date('2026-10-20') } });
    await runWithTenant(ALTO_TENANT_ID, 'job', async () => {
      const { queueScheduleRecompute } = await import('../../lib/payScheduleTriggers.js');
      queueScheduleRecompute([hire.id], 'HIRE');
    });
    await flushScheduleRecompute();
    expect(await assignments(hire.id)).toEqual([{ schedule: 'Biweekly', from: '2026-10-17', to: null }]);
    await flushPendingNotifications();
    const note = await testDb.notification.findFirstOrThrow({ where: { recipientUserId: s.hrUser.id, category: 'payroll', channel: 'IN_APP' } });
    expect(note.body).toContain('Dee New — no schedule → Biweekly from Oct 17 (hired; Dee works for Harbor Grill)');

    const mine = await s.hr.get(`/associates/${hire.id}/pay-schedule`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ current: { scheduleId: s.biweekly.id, since: '2026-10-17', because: 'Client: Harbor Grill' }, ruleDefault: { scheduleId: s.biweekly.id }, nextPayDate: '2026-11-06' });
  });

  it('a move by hand starts on the chosen date, ends the old claim, and the person record shows it pending', async () => {
    const s = await seed();
    const ana = await worker('Ana', s.coastalSite.id);
    await clientRule(s.hr, s.weekly.id, s.coastal.id);
    const move = await s.hr.post('/payroll/pay-schedules/move').send({ toScheduleId: s.biweekly.id, associateIds: [ana.id], effectiveFrom: '2026-10-31' });
    expect(move.status).toBe(200);
    expect(move.body.impact).toMatchObject({ joins: 1, movingFrom: [{ scheduleId: s.weekly.id, name: 'Weekly', count: 1 }] });
    expect(move.body.impact.people[0].transition).toMatchObject({ lastOldPayDate: '2026-11-06', firstNewPayDate: '2026-11-20' });
    expect(await assignments(ana.id)).toEqual([
      { schedule: 'Weekly', from: '2026-10-17', to: '2026-10-30' },
      { schedule: 'Biweekly', from: '2026-10-31', to: null },
    ]);
    const person = await s.hr.get(`/associates/${ana.id}/pay-schedule`);
    expect(person.body).toMatchObject({ current: { scheduleId: s.weekly.id }, pending: { scheduleId: s.biweekly.id, effectiveFrom: '2026-10-31', because: 'Individual' }, ruleDefault: { scheduleId: s.weekly.id } });
    await flushPendingNotifications();
    expect(await testDb.notification.count({ where: { category: 'payroll' } })).toBe(0);

    // PUT back to Weekly: the individual override moves with it.
    const back = await s.hr.put(`/associates/${ana.id}/pay-schedule`).send({ scheduleId: s.weekly.id });
    expect(back.status).toBe(200);
    expect(back.body.pending).toBeNull();
    expect(await assignments(ana.id)).toEqual([{ schedule: 'Weekly', from: '2026-10-17', to: null }]);
  });

  it('ending a rule takes its people off from that date', async () => {
    const s = await seed();
    const ana = await worker('Ana', s.coastalSite.id);
    await clientRule(s.hr, s.weekly.id, s.coastal.id);
    const detail = await s.hr.get(`/payroll/pay-schedules/${s.weekly.id}`);
    expect(detail.body.schedule.rules).toHaveLength(1);
    expect(detail.body.schedule.rules[0]).toMatchObject({ kind: 'CLIENT', clientName: 'Coastal Resort Holdings', matches: 1, effectiveFrom: '2026-10-19', effectiveTo: null });
    const ruleId = detail.body.schedule.rules[0].id;
    const ended = await s.hr.delete(`/payroll/pay-schedules/${s.weekly.id}/rules/${ruleId}`).send({ effectiveFrom: '2026-10-24' });
    expect(ended.status).toBe(200);
    expect(ended.body.impact).toMatchObject({ leaves: 1 });
    expect(await assignments(ana.id)).toEqual([{ schedule: 'Weekly', from: '2026-10-17', to: '2026-10-23' }]);
    // Refused while a rule or a person is on it.
    expect((await s.hr.delete(`/payroll/pay-schedules/${s.weekly.id}`)).status).toBe(409);
  });
});

describe('payroll runs by schedule', () => {
  it('a run pays only its schedule’s people for their days on it — a weekly → biweekly split', async () => {
    const s = await seed();
    const ana = await worker('Ana', s.coastalSite.id);
    const ben = await worker('Ben', s.coastalSite.id);
    const cy = await worker('Cy', s.harborSite.id); // on no schedule
    await clientRule(s.hr, s.weekly.id, s.coastal.id);
    await s.hr.post('/payroll/pay-schedules/move').send({ toScheduleId: s.biweekly.id, associateIds: [ana.id], effectiveFrom: '2026-10-31' }).expect(200);

    await hours(ana.id, s.coastal.id, '2026-10-27', 4); // on Weekly
    await hours(ana.id, s.coastal.id, '2026-11-02', 8); // on Biweekly
    await hours(ben.id, s.coastal.id, '2026-11-02', 5);
    await hours(cy.id, s.harbor.id, '2026-11-02', 6);

    const bi = await s.hr.post('/payroll/runs').send({ periodStart: '2026-10-31', periodEnd: '2026-11-13', payrollScheduleId: s.biweekly.id });
    expect(bi.status).toBe(201);
    expect(bi.body).toMatchObject({ payrollScheduleId: s.biweekly.id, payrollScheduleName: 'Biweekly' });
    expect(bi.body.items.map((i: { associateId: string; hoursWorked: number }) => [i.associateId, i.hoursWorked])).toEqual([[ana.id, 8]]);

    const lastWeek = await s.hr.post('/payroll/runs/preview').send({ periodStart: '2026-10-24', periodEnd: '2026-10-30', payrollScheduleId: s.weekly.id });
    expect(lastWeek.status).toBe(200);
    const items = lastWeek.body.items as Array<{ associateId: string; hoursWorked: number }>;
    expect(items.map((i) => [i.associateId, i.hoursWorked])).toEqual([[ana.id, 4]]);

    const weekly = await s.hr.post('/payroll/runs').send({ periodStart: '2026-10-31', periodEnd: '2026-11-06', payrollScheduleId: s.weekly.id });
    expect(weekly.body.items.map((i: { associateId: string }) => i.associateId)).toEqual([ben.id]);

    // Cy has time and no schedule: a warning, not a silent drop.
    const exc = await s.hr.post('/payroll/runs/exceptions').send({ periodStart: '2026-10-31', periodEnd: '2026-11-06', payrollScheduleId: s.weekly.id });
    expect(exc.status).toBe(200);
    expect(exc.body.exceptions.filter((e: { kind: string }) => e.kind === 'UNASSIGNED_SCHEDULE').map((e: { associateId: string }) => e.associateId)).toEqual([cy.id]);

    // Without a schedule, a run is what it always was: everyone with time.
    const legacy = await s.hr.post('/payroll/runs/preview').send({ periodStart: '2026-10-31', periodEnd: '2026-11-06' });
    const legacyItems = legacy.body.items as Array<{ associateId: string }>;
    expect(legacyItems.map((i) => i.associateId).sort()).toEqual([ana.id, ben.id, cy.id].sort());

    const upcoming = await s.hr.get('/payroll/upcoming');
    expect(upcoming.status).toBe(200);
    // The period paid next on each (Oct 23): from before anyone joined either.
    const by = [...upcoming.body.bySchedule].sort((a: { scheduleName: string }, b: { scheduleName: string }) => a.scheduleName.localeCompare(b.scheduleName));
    expect(by.map((b: { scheduleName: string; periodStart: string; payDate: string; people: number }) => [b.scheduleName, b.periodStart, b.payDate, b.people])).toEqual([
      ['Biweekly', '2026-10-03', '2026-10-23', 0],
      ['Weekly', '2026-10-10', '2026-10-23', 0],
    ]);
  });

  it('the pre-payroll checks look only at the days a run pays — a move mid-period splits them too', async () => {
    const s = await seed();
    const ana = await worker('Ana', s.coastalSite.id);
    await clientRule(s.hr, s.weekly.id, s.coastal.id);
    // By hand, from Wednesday Oct 28: Weekly has her Oct 24–27, Biweekly from Oct 28.
    await s.hr.post('/payroll/pay-schedules/move').send({ toScheduleId: s.biweekly.id, associateIds: [ana.id], effectiveFrom: '2026-10-28' }).expect(200);
    await hours(ana.id, s.coastal.id, '2026-10-26', 4);
    // Clocked out Thursday, not yet approved — Biweekly's day.
    await testDb.timeEntry.create({ data: { associateId: ana.id, clientId: s.coastal.id, clockInAt: new Date('2026-10-29T13:00:00.000Z'), clockOutAt: new Date('2026-10-29T19:00:00.000Z'), status: 'COMPLETED' } });

    const kinds = async (scheduleId: string, periodStart: string, periodEnd: string) => {
      const res = await s.hr.post('/payroll/runs/exceptions').send({ periodStart, periodEnd, payrollScheduleId: scheduleId });
      expect(res.status).toBe(200);
      return (res.body.exceptions as Array<{ kind: string; associateId: string }>).filter((e) => e.associateId === ana.id).map((e) => e.kind);
    };
    expect(await kinds(s.weekly.id, '2026-10-24', '2026-10-30')).not.toContain('UNAPPROVED_TIME');
    expect(await kinds(s.weekly.id, '2026-10-24', '2026-10-30')).toContain('MISSING_W4');
    expect(await kinds(s.biweekly.id, '2026-10-17', '2026-10-30')).toContain('UNAPPROVED_TIME');
    // Her approved Monday is Weekly's, so Biweekly has nothing of hers to check against a W-4.
    expect(await kinds(s.biweekly.id, '2026-10-17', '2026-10-30')).not.toContain('MISSING_W4');
  });

  it('a schedule from another tenant’s reach is refused for a run', async () => {
    const s = await seed();
    const res = await s.hr.post('/payroll/runs').send({ periodStart: '2026-10-31', periodEnd: '2026-11-13', payrollScheduleId: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(404);
  });
});

describe('schedules over time', () => {
  it('a pattern change waits for a future period start and shows on the calendar; paydays move for holidays', async () => {
    const s = await seed();
    const bad = await s.hr.patch(`/payroll/pay-schedules/${s.weekly.id}`).send({ payDateOffsetDays: 5, effectiveFrom: '2026-10-20' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('not_a_period_start');
    expect((await s.hr.patch(`/payroll/pay-schedules/${s.weekly.id}`).send({ payDateOffsetDays: 5 })).status).toBe(400);

    const ok = await s.hr.patch(`/payroll/pay-schedules/${s.weekly.id}`).send({ payDateOffsetDays: 5, effectiveFrom: '2026-10-24' });
    expect(ok.status).toBe(200);
    expect(ok.body.schedule.pendingVersion).toEqual({ effectiveFrom: '2026-10-24', pattern: 'Every week, Saturday to Friday, paid the next Wednesday' });
    expect(ok.body.schedule.versions).toHaveLength(2);

    const cal = await s.hr.get(`/payroll/pay-schedules/${s.weekly.id}/calendar?months=1`);
    expect(cal.status).toBe(200);
    // The calendar opens on the period being paid next (it can already be over); find the two by their start.
    const periods = cal.body.periods as Array<{ periodStart: string }>;
    const first = periods.find((p) => p.periodStart === '2026-10-17');
    const second = periods.find((p) => p.periodStart === '2026-10-24');
    expect(periods[0]!.periodStart <= '2026-10-17').toBe(true);
    expect(first).toMatchObject({ periodStart: '2026-10-17', payDate: '2026-10-30', versionChange: false });
    expect(second).toMatchObject({ periodStart: '2026-10-24', periodEnd: '2026-10-30', payDate: '2026-11-04', versionChange: true });

    const bi = await s.hr.get(`/payroll/pay-schedules/${s.biweekly.id}/calendar?months=3`);
    const yearEnd = bi.body.periods.find((p: { periodStart: string }) => p.periodStart === '2026-12-12');
    expect(yearEnd).toMatchObject({ periodEnd: '2026-12-25', payDate: '2026-12-31', unadjustedPayDate: '2027-01-01' });
    expect(yearEnd.adjustedFor).toMatch(/New Year/);

    const preview = await s.hr.get('/payroll/pay-schedules/preview-pattern?frequency=SEMIMONTHLY&anchorDate=2026-10-01&payDateOffsetDays=0&months=1');
    expect(preview.status).toBe(200);
    expect(preview.body.periods[0]).toMatchObject({ periodStart: '2026-10-16', periodEnd: '2026-10-31' });
  });

  it('a pattern whose periods don’t line up gets one short bridge period — previewed, then on the calendar and the run’s payday', async () => {
    const s = await seed();
    // Every other week (… Oct 31–Nov 13, Nov 14–27) → twice a month from Nov 14: the half-month Nov 1–15 began before the change.
    const preview = await s.hr.get(`/payroll/pay-schedules/preview-pattern?frequency=SEMIMONTHLY&anchorDate=2026-11-14&payDateOffsetDays=4&months=1&scheduleId=${s.biweekly.id}&effectiveFrom=2026-11-14`);
    expect(preview.status).toBe(200);
    expect(preview.body.periods[0]).toMatchObject({ periodStart: '2026-11-14', periodEnd: '2026-11-15', payDate: '2026-11-19', bridge: true, versionChange: true });
    expect(preview.body.periods[1]).toMatchObject({ periodStart: '2026-11-16', periodEnd: '2026-11-30', payDate: '2026-12-04' });
    expect(preview.body.periods[1].bridge).toBeUndefined();

    const ok = await s.hr.patch(`/payroll/pay-schedules/${s.biweekly.id}`).send({ frequency: 'SEMIMONTHLY', payDateOffsetDays: 4, effectiveFrom: '2026-11-14' });
    expect(ok.status).toBe(200);
    const cal = await s.hr.get(`/payroll/pay-schedules/${s.biweekly.id}/calendar?months=3`);
    const starts = (cal.body.periods as Array<{ periodStart: string; periodEnd: string }>).map((p) => `${p.periodStart}..${p.periodEnd}`);
    // Every day once: the old fortnight ends the day before, the bridge, then whole half-months.
    expect(starts).toEqual(expect.arrayContaining(['2026-10-31..2026-11-13', '2026-11-14..2026-11-15', '2026-11-16..2026-11-30', '2026-12-01..2026-12-15']));
    expect(cal.body.periods.find((p: { periodStart: string }) => p.periodStart === '2026-10-31')).toMatchObject({ payDate: '2026-11-20', versionChange: false });

    // The old pattern's last period keeps its payday (offset 7), the bridge is paid on the new one's.
    const run = async (periodStart: string, periodEnd: string) => {
      const r = await s.hr.post('/payroll/runs').send({ periodStart, periodEnd, payrollScheduleId: s.biweekly.id });
      expect(r.status).toBe(201);
      return r.body.id as string;
    };
    const { payDateFor } = await import('../../lib/banking/funding.js');
    const [oldRun, bridgeRun] = [await run('2026-10-31', '2026-11-13'), await run('2026-11-14', '2026-11-15')];
    await runWithTenant(ALTO_TENANT_ID, 'job', async () => {
      expect(await payDateFor(prisma, oldRun)).toBe('2026-11-20');
      expect(await payDateFor(prisma, bridgeRun)).toBe('2026-11-19');
    });
  });

  it('the old schedule endpoints still work, and assign goes through the rules', async () => {
    const s = await seed();
    const ana = await worker('Ana', s.coastalSite.id);
    const list = await s.hr.get('/payroll/schedules');
    expect(list.status).toBe(200);
    expect(list.body.schedules).toHaveLength(2);
    const res = await s.hr.post(`/payroll/schedules/${s.biweekly.id}/assign`).send({ associateIds: [ana.id] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assigned: 1 });
    expect((await testDb.associate.findUniqueOrThrow({ where: { id: ana.id } })).payrollScheduleId).toBe(s.biweekly.id);
    expect(await testDb.payrollScheduleRule.count({ where: { associateId: ana.id, kind: 'INDIVIDUAL', scheduleId: s.biweekly.id } })).toBe(1);
    expect(await assignments(ana.id)).toEqual([{ schedule: 'Biweekly', from: '2026-10-17', to: null }]);
    // Reassigning moves them today, as the old endpoint always did.
    await s.hr.post(`/payroll/schedules/${s.weekly.id}/assign`).send({ associateIds: [ana.id] }).expect(200);
    expect((await testDb.associate.findUniqueOrThrow({ where: { id: ana.id } })).payrollScheduleId).toBe(s.weekly.id);
    expect(await assignments(ana.id)).toEqual([
      { schedule: 'Biweekly', from: '2026-10-17', to: '2026-10-18' },
      { schedule: 'Weekly', from: '2026-10-19', to: null },
    ]);
  });
});

describe('finding people', () => {
  it('candidates are everyone — new hires included — with an exact total, a cursor and facets', async () => {
    const s = await seed();
    await worker('Ana', s.coastalSite.id);
    const ben = await worker('Ben', s.coastalSite.id);
    await hours(ben.id, s.coastal.id, '2026-10-12', 4);
    const hire = await createAssociate({ firstName: 'Dee', lastName: 'New' });
    await testDb.application.create({ data: { associateId: hire.id, clientId: s.harbor.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    const gone = await worker('Eve', s.coastalSite.id);
    await testDb.associate.update({ where: { id: gone.id }, data: { separatedAt: new Date('2026-10-01') } });

    const page1 = await s.hr.get('/payroll/pay-schedules/candidates?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.people).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await s.hr.get(`/payroll/pay-schedules/candidates?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.people).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
    const everyone = [...page1.body.people, ...page2.body.people];
    expect(everyone.find((p: { name: string }) => p.name === 'Dee New')).toMatchObject({ status: 'NEW_HIRE', clientName: 'Harbor Grill' });
    expect(everyone.find((p: { name: string }) => p.name === 'Ben Worker')).toMatchObject({ status: 'ACTIVE', siteName: 'Coastal Resort Holdings' });
    expect(page1.body.facets.clients).toEqual([
      { id: s.coastal.id, name: 'Coastal Resort Holdings', count: 2 },
      { id: s.harbor.id, name: 'Harbor Grill', count: 1 },
    ]);

    const hires = await s.hr.get('/payroll/pay-schedules/candidates?status=NEW_HIRE');
    expect(hires.body.people.map((p: { name: string }) => p.name)).toEqual(['Dee New']);
    const byName = await s.hr.get('/payroll/pay-schedules/candidates?q=ben%20work');
    expect(byName.body.total).toBe(1);
    const inactive = await s.hr.get('/payroll/pay-schedules/candidates?status=INACTIVE');
    expect(inactive.body.people.map((p: { name: string }) => p.name)).toEqual(['Eve Worker']);

    const unassigned = await s.hr.get('/payroll/pay-schedules/unassigned');
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.total).toBe(3);
    const inbox = await s.hr.get('/me/inbox');
    if (inbox.status === 200) {
      const src = (inbox.body.sources as Array<{ key: string; count: number; path: string }>).find((x) => x.key === 'pay-schedule-unassigned');
      expect(src).toMatchObject({ count: 3, path: '/payroll/schedules?view=unassigned' });
    }
  });

  it('the roster says who is ready and where to fix who isn’t', async () => {
    const s = await seed();
    const ana = await worker('Ana', s.coastalSite.id);
    await clientRule(s.hr, s.weekly.id, s.coastal.id);
    const roster = await s.hr.get(`/payroll/pay-schedules/${s.weekly.id}/people`);
    expect(roster.status).toBe(200);
    expect(roster.body.totals).toEqual({ total: 1, ready: 0, attention: 0, blocked: 1 });
    expect(roster.body.groups[0]).toMatchObject({ clientName: 'Coastal Resort Holdings', counts: { total: 1, blocked: 1 } });
    const p = roster.body.groups[0].people[0];
    expect(p).toMatchObject({ name: 'Ana Worker', payType: 'HOURLY', rateLabel: '$20.00/h', onScheduleSince: '2026-10-17', because: 'Client: Coastal Resort Holdings', readiness: 'BLOCKED', isNewHire: false });
    expect(p.issues.find((i: { code: string }) => i.code === 'NO_PAYOUT')).toEqual({ code: 'NO_PAYOUT', level: 'BLOCKED', label: 'No bank account or pay card — nothing to pay into', fixPath: `/people/${ana.id}?tab=pay`, fixLabel: 'Add a payout method' });
    expect(p.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['NO_W4', 'NO_SSN', 'FIRST_CHECK']));
    const blocked = await s.hr.get(`/payroll/pay-schedules/${s.weekly.id}/people?view=ready`);
    expect(blocked.body.totals.total).toBe(0);
  });

  it('people without payroll access are turned away; schedules outside reach are not found', async () => {
    const s = await seed();
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: s.coastal.id });
    const sup = await loginAs(agent(), user.email);
    expect((await sup.get('/payroll/pay-schedules')).status).toBe(403);
    const ana = await worker('Ana', s.coastalSite.id);
    expect((await sup.put(`/associates/${ana.id}/pay-schedule`).send({ scheduleId: s.weekly.id })).status).toBe(403);
    expect((await s.hr.get('/payroll/pay-schedules/11111111-1111-4111-8111-111111111111')).status).toBe(404);
    expect((await s.hr.get('/payroll/pay-schedules/not-a-uuid')).status).toBe(404);
  });
});
