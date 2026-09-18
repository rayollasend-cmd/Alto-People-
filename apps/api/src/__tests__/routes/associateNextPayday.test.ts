import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * GET /payroll/me/next-payday — the associate's next check and the days it
 * covers: their own pay schedule, else their client's, else the org default.
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
    expect(res.body).toEqual({ nextPayday: null });
  });

  it('the org default: a Friday, on or after today, paying the Mon–Sun week before it', async () => {
    const { agent } = await associateAgent();
    await schedule({ name: 'Weekly (org)' });
    const { nextPayday } = (await agent.get('/payroll/me/next-payday')).body;
    expect(nextPayday.schedule).toBe('Weekly (org)');
    const pay = new Date(`${nextPayday.payDate}T12:00:00Z`);
    expect(pay.getUTCDay()).toBe(5);
    const today = new Date().toISOString().slice(0, 10);
    expect(nextPayday.payDate >= today).toBe(true);
    const end = new Date(`${nextPayday.periodEnd}T12:00:00Z`);
    expect((pay.getTime() - end.getTime()) / 86_400_000).toBe(5);
  });

  it("their client's schedule beats the org default; their own beats both", async () => {
    const { agent, client, associate } = await associateAgent();
    await schedule({ name: 'Weekly (org)' });
    await schedule({ name: 'Walmart biweekly', clientId: client.id, frequency: 'BIWEEKLY' });
    expect((await agent.get('/payroll/me/next-payday')).body.nextPayday.schedule).toBe('Walmart biweekly');
    const own = await schedule({ name: 'Maria special' });
    await prisma.associate.update({ where: { id: associate.id }, data: { payrollScheduleId: own.id } });
    expect((await agent.get('/payroll/me/next-payday')).body.nextPayday.schedule).toBe('Maria special');
  });
});
