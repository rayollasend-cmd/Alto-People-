import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { nextPaydayFor } from '../../lib/associatePayday.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import { DEFAULT_TIMEZONE } from '../../lib/timezone.js';

/**
 * GET /payroll/me/next-payday — the associate's next check and the days it
 * covers, on the pay schedule they are ON (lib/payScheduleMembership — the
 * rule a run pays by). F500 SH-4: a schedule they are not on (their
 * client's, the org's) no longer promises a payday no run would pay.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function associateAgent() {
  const client = await createClient('Walmart');
  const a = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  await prisma.application.create({
    data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' },
  });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
  const agent = request.agent(createApp());
  await agent.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
  return { agent, client, associate: a };
}

const schedule = (data: { name: string; clientId?: string | null; frequency?: 'WEEKLY' | 'BIWEEKLY' }) =>
  prisma.payrollSchedule.create({
    data: {
      name: data.name,
      clientId: data.clientId ?? null,
      frequency: data.frequency ?? 'WEEKLY',
      anchorDate: new Date('2026-01-05'), // a Monday
      payDateOffsetDays: 5,
    },
  });

describe('GET /payroll/me/next-payday', () => {
  it('null when no pay schedule is set up', async () => {
    const { agent } = await associateAgent();
    const res = await agent.get('/payroll/me/next-payday');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nextPayday: null, notOnSchedule: false });
  });

  it('a schedule they are not on promises nothing — and says they are on none', async () => {
    const { agent } = await associateAgent();
    await schedule({ name: 'Weekly (org)' });
    const res = await agent.get('/payroll/me/next-payday');
    expect(res.body).toEqual({ nextPayday: null, notOnSchedule: true });
  });

  it('on a schedule: a Friday after today, paying the Mon–Sun week before it', async () => {
    const { agent, associate } = await associateAgent();
    const org = await schedule({ name: 'Weekly (org)' });
    await prisma.payrollScheduleAssignment.create({ data: { associateId: associate.id, scheduleId: org.id, effectiveFrom: new Date('2026-01-05'), source: 'DEFAULT' } });
    const { nextPayday } = (await agent.get('/payroll/me/next-payday')).body;
    expect(nextPayday.schedule).toBe('Weekly (org)');
    const pay = new Date(`${nextPayday.payDate}T12:00:00Z`);
    expect(pay.getUTCDay()).toBe(5);
    // "Today" the way the route means it — the org calendar day, not UTC
    // (between 8pm and midnight Eastern the UTC date is already tomorrow).
    const today = dateKeyInZone(new Date(), DEFAULT_TIMEZONE);
    expect(nextPayday.payDate > today).toBe(true);
    const end = new Date(`${nextPayday.periodEnd}T12:00:00Z`);
    expect((pay.getTime() - end.getTime()) / 86_400_000).toBe(5);
  });

  it('membership decides, not the client: the schedule they are on, never their client’s by default', async () => {
    const { agent, client, associate } = await associateAgent();
    await schedule({ name: 'Weekly (org)' });
    await schedule({ name: 'Walmart biweekly', clientId: client.id, frequency: 'BIWEEKLY' });
    expect((await agent.get('/payroll/me/next-payday')).body.nextPayday).toBeNull();
    // The legacy per-person picker (no assignment history) still makes a member.
    const own = await schedule({ name: 'Maria special' });
    await prisma.associate.update({ where: { id: associate.id }, data: { payrollScheduleId: own.id } });
    expect((await agent.get('/payroll/me/next-payday')).body.nextPayday.schedule).toBe('Maria special');
    // A retired schedule pays nobody.
    await prisma.payrollSchedule.update({ where: { id: own.id }, data: { isActive: false } });
    expect((await agent.get('/payroll/me/next-payday')).body.nextPayday).toBeNull();
  });
});

describe("Alto's pay rule — biweekly Sat→Fri, paid the Friday after", () => {
  async function altoAssociate() {
    const a = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const s = await prisma.payrollSchedule.create({
      data: {
        name: 'Biweekly · Sat–Fri · paid the Friday after',
        frequency: 'BIWEEKLY',
        anchorDate: new Date('2026-09-12'),
        payDateOffsetDays: 7,
      },
    });
    // On it since the spring (the company default put her there).
    await prisma.payrollScheduleAssignment.create({ data: { associateId: a.id, scheduleId: s.id, effectiveFrom: new Date('2026-05-02'), source: 'DEFAULT' } });
    return a.id;
  }

  it('a move booked to start later: the first payday is the new schedule’s first period that pays her days', async () => {
    const a = await createAssociate({ firstName: 'Ana', lastName: 'Mover' });
    const s = await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-09-12'), payDateOffsetDays: 7 } });
    // Booked from Sat Oct 10 (the period Oct 10–23, paid Fri Oct 30).
    await prisma.payrollScheduleAssignment.create({ data: { associateId: a.id, scheduleId: s.id, effectiveFrom: new Date('2026-10-10'), source: 'RULE' } });
    // On Mon Sep 21 the schedule's next payday is Oct 2 (Sep 12–25), but she isn't on it until Oct 10.
    expect(await nextPaydayFor(a.id, new Date('2026-09-21T15:00:00.000Z'))).toMatchObject({ payDate: '2026-10-30', periodStart: '2026-10-10', periodEnd: '2026-10-23' });
  });

  it('on payday (Fri Sep 18, paying Aug 29–Sep 11) the next payday is Fri Oct 2, for Sep 12–25', async () => {
    const id = await altoAssociate();
    // Morning, evening, and 9:30 PM Eastern (already the 19th in UTC):
    // payday until midnight, and the next one is Oct 2.
    for (const at of ['2026-09-18T13:00:00.000Z', '2026-09-18T23:30:00.000Z', '2026-09-19T01:30:00.000Z']) {
      expect(await nextPaydayFor(id, new Date(at))).toMatchObject({
        payDate: '2026-10-02',
        periodStart: '2026-09-12',
        periodEnd: '2026-09-25',
        paidToday: { periodStart: '2026-08-29', periodEnd: '2026-09-11' },
      });
    }
    // After midnight Eastern it's no longer payday.
    expect((await nextPaydayFor(id, new Date('2026-09-19T05:00:00.000Z')))?.paidToday).toBeNull();
  });

  it('the evening before payday, payday is still tomorrow — and mid-period it is the Friday after the period', async () => {
    const id = await altoAssociate();
    // Thu Sep 17, 10 PM Eastern (already Sep 18 in UTC).
    expect(await nextPaydayFor(id, new Date('2026-09-18T02:00:00.000Z'))).toMatchObject({
      payDate: '2026-09-18',
      periodStart: '2026-08-29',
      periodEnd: '2026-09-11',
    });
    expect(await nextPaydayFor(id, new Date('2026-09-23T15:00:00.000Z'))).toMatchObject({ payDate: '2026-10-02' });
    // Oct 2 itself pays Sep 12–25; next is Oct 16 for Sep 26–Oct 9.
    expect(await nextPaydayFor(id, new Date('2026-10-02T15:00:00.000Z'))).toMatchObject({
      payDate: '2026-10-16',
      periodStart: '2026-09-26',
      periodEnd: '2026-10-09',
    });
  });
});
