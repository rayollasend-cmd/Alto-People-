import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The "as of a date" roster on the Audit packet tab (owner, 2026-11-03): for
 * an I-9 inspection notice, everyone on the books on one day, with their I-9
 * and E-Verify facts and how long the I-9 must be kept. Someone who left
 * after the day is on it; someone hired after it is not. The caller's reach
 * applies, and so does the packet's own capability.
 */

const DATE = '2026-06-15';
const app = () => createApp();
let clientId: string;

beforeEach(async () => {
  await truncateAll();
  clientId = (await createClient()).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function login(role: 'HR_ADMINISTRATOR' | 'OPERATIONS_MANAGER', scopeSiteIds: string[] = []): Promise<TestAgent<Test>> {
  const { user } = await createUser({ role });
  if (scopeSiteIds.length) await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds } });
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

/** Hired on `hired` (a day), with the approved application that makes a hire. */
async function hire(firstName: string, hired: string, extra: { deactivatedAt?: Date } = {}) {
  const a = await prisma.associate.create({
    data: {
      firstName,
      lastName: 'Roster',
      email: `${firstName.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@roster.example`,
      hireDate: new Date(`${hired}T00:00:00.000Z`),
      ...extra,
    },
  });
  await prisma.application.create({
    data: { associateId: a.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date(`${hired}T15:00:00.000Z`) },
  });
  return a;
}

/** A completed separation: last day worked `lastDay`, recorded the day after. */
async function separate(associateId: string, lastDay: string) {
  const completedAt = new Date(`${lastDay}T12:00:00.000Z`);
  completedAt.setUTCDate(completedAt.getUTCDate() + 1);
  await prisma.separation.create({
    data: { associateId, reason: 'VOLUNTARY_PERSONAL', status: 'COMPLETE', lastDayWorked: new Date(`${lastDay}T00:00:00.000Z`), completedAt },
  });
  await prisma.associate.update({ where: { id: associateId }, data: { separatedAt: completedAt } });
}

describe('GET /audit-packets/roster-as-of', () => {
  it('lists everyone on the books that day — including people who left after it, not people hired after it', async () => {
    const ann = await hire('Ann', '2025-01-10');
    await prisma.i9Verification.create({
      data: {
        associateId: ann.id,
        section1CompletedAt: new Date('2025-01-10T15:00:00.000Z'),
        section2CompletedAt: new Date('2025-01-12T15:00:00.000Z'),
        eVerifyCaseNumber: '2025011200001AB',
        eVerifyStatus: 'EMPLOYMENT_AUTHORIZED',
        workAuthExpiresAt: new Date('2027-03-31T00:00:00.000Z'),
      },
    });
    const sam = await hire('Sam', '2024-03-01');
    await separate(sam.id, '2026-08-31'); // left after the day: on it
    const lee = await hire('Lee', '2025-05-05');
    await separate(lee.id, DATE); // their last day was that day: on it
    const old = await hire('Olga', '2020-01-02');
    await separate(old.id, '2026-05-31'); // gone before the day
    await hire('Nina', '2026-07-01'); // hired after the day
    const paused = await hire('Pat', '2025-02-01', { deactivatedAt: new Date('2026-09-01T12:00:00.000Z') });
    // Onboarding for the first time: never hired, never on the books.
    const onb = await prisma.associate.create({ data: { firstName: 'Ona', lastName: 'Roster', email: 'ona@roster.example' } });
    await prisma.application.create({ data: { associateId: onb.id, clientId, onboardingTrack: 'STANDARD', status: 'SUBMITTED' } });

    const hr = await login('HR_ADMINISTRATOR');
    const res = await hr.get(`/audit-packets/roster-as-of?date=${DATE}`);
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(DATE);
    const names = res.body.rows.map((r: { firstName: string }) => r.firstName).sort();
    expect(names).toEqual(['Ann', 'Lee', 'Pat', 'Sam']);
    expect(res.body.total).toBe(4);
    expect(res.body.stillEmployed).toBe(2);
    expect(res.body.leftSince).toBe(2);
    expect(res.body.noSection2).toBe(3);

    const byName = Object.fromEntries(res.body.rows.map((r: { firstName: string }) => [r.firstName, r]));
    expect(byName.Ann).toMatchObject({
      associateId: ann.id,
      hiredOn: '2025-01-10',
      separatedOn: null,
      section1On: '2025-01-10',
      section2On: '2025-01-12',
      eVerifyCaseNumber: '2025011200001AB',
      eVerifyStatus: 'EMPLOYMENT_AUTHORIZED',
      eVerifyStatusWords: 'Employment authorized',
      workAuthEndsOn: '2027-03-31',
      // Still employed: the I-9 is kept for as long as they work here.
      retainUntil: null,
    });
    // The later of three years from hire (2027-03-01) and a year from leaving (2027-08-31).
    expect(byName.Sam).toMatchObject({ hiredOn: '2024-03-01', separatedOn: '2026-08-31', retainUntil: '2027-08-31', workStatus: 'SEPARATED', employment: 'Separated' });
    // Three years from hire is the later mark here.
    expect(byName.Lee).toMatchObject({ separatedOn: DATE, retainUntil: '2028-05-05' });
    expect(byName.Pat).toMatchObject({ workStatus: 'DEACTIVATED', employment: 'Paused', separatedOn: null });
    expect(byName).not.toHaveProperty('Olga');
    expect(paused.id).toBe(byName.Pat.associateId);

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'compliance.as_of_roster_viewed' } });
    expect(audit?.metadata).toMatchObject({ date: DATE, people: 4 });
  });

  it("keeps to the caller's reach: a site-bound HR account sees its site's people, including those who left", async () => {
    const north = await prisma.site.create({ data: { name: 'North Store', clientId, timezone: 'America/New_York' } });
    const south = await prisma.site.create({ data: { name: 'South Store', clientId, timezone: 'America/New_York' } });
    const here = await hire('Nora', '2025-01-10');
    await prisma.associateAssignment.create({ data: { associateId: here.id, locationId: north.id, startedAt: new Date('2025-01-10') } });
    const left = await hire('Ned', '2025-01-10');
    await prisma.associateAssignment.create({ data: { associateId: left.id, locationId: north.id, startedAt: new Date('2025-01-10'), endedAt: new Date('2026-08-31') } });
    await separate(left.id, '2026-08-31');
    const there = await hire('Sid', '2025-01-10');
    await prisma.associateAssignment.create({ data: { associateId: there.id, locationId: south.id, startedAt: new Date('2025-01-10') } });

    const hr = await login('HR_ADMINISTRATOR', [north.id]);
    const res = await hr.get(`/audit-packets/roster-as-of?date=${DATE}`);
    expect(res.status).toBe(200);
    const names = res.body.rows.map((r: { firstName: string }) => r.firstName).sort();
    expect(names).toEqual(['Ned', 'Nora']);
    expect(JSON.stringify(res.body)).not.toContain(there.id);
  });

  it('asks for the packet capability and a real day, not one in the future', async () => {
    const ops = await login('OPERATIONS_MANAGER');
    expect((await ops.get(`/audit-packets/roster-as-of?date=${DATE}`)).status).toBe(403);

    const hr = await login('HR_ADMINISTRATOR');
    expect((await hr.get('/audit-packets/roster-as-of')).status).toBe(400);
    expect((await hr.get('/audit-packets/roster-as-of?date=2026-13-40')).status).toBe(400);
    const future = await hr.get('/audit-packets/roster-as-of?date=2999-01-01');
    expect(future.status).toBe(400);
    expect(future.body.error.code).toBe('future_date');
  });
});
