import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { minuteOfDayInZone } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The labor-rules engine at the publish gate (audit Tier 1 #11). A minor
 * past their school-day hours blocks the week; an adult's short rest
 * warns and publishes. The preflight shows the same findings first.
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

/** `daysOut` days from now, at hh:00 on the store's clock. */
function atStore(daysOut: number, hh: number): Date {
  const base = new Date(Date.now() + daysOut * 86_400_000);
  base.setUTCSeconds(0, 0);
  return new Date(base.getTime() + (hh * 60 - minuteOfDayInZone(base, TZ)) * 60_000);
}

/** A school day at least 16 days out (outside any notice window): Mon–Fri, not June–August. */
function schoolDayOut(): number {
  for (let d = 16; d < 120; d++) {
    const at = atStore(d, 12);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'numeric' }).formatToParts(at);
    const wd = parts.find((p) => p.type === 'weekday')?.value;
    const m = Number(parts.find((p) => p.type === 'month')?.value);
    if (wd && wd !== 'Sat' && wd !== 'Sun' && !(m >= 6 && m <= 8)) return d;
  }
  throw new Error('no school day found');
}

async function siteIn(state: string, city: string | null) {
  const client = await createClient(`${state} ${city ?? 'store'}`);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { state, city, timezone: TZ } });
  return { client, site };
}

async function hire(clientId: string, first: string, dob: Date | null) {
  const a = await createAssociate({ firstName: first, lastName: 'Worker' });
  await prisma.associate.update({ where: { id: a.id }, data: { dob } });
  await prisma.application.create({ data: { associateId: a.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
  return a;
}

const draft = (clientId: string, locationId: string, associateId: string, startsAt: Date, hours: number) =>
  prisma.shift.create({
    data: { clientId, locationId, position: 'Stocker', startsAt, endsAt: new Date(startsAt.getTime() + hours * 3_600_000), status: 'DRAFT', assignedAssociateId: associateId, payRate: 16 },
  });

const window = (from: Date, to: Date) => `from=${from.toISOString()}&to=${to.toISOString()}`;

describe('labor rules at publish', () => {
  it("a 16-year-old's 10-hour school day is blocked: the preflight names it and publish-week refuses the batch", async () => {
    const { client, site } = await siteIn('FL', 'Destin');
    const dob = new Date(Date.now() - 16.5 * 365.25 * 86_400_000);
    const minor = await hire(client.id, 'Minor', dob);
    const adult = await hire(client.id, 'Adult', new Date('1990-01-01'));
    const day = schoolDayOut();
    const bad = await draft(client.id, site.id, minor.id, atStore(day, 8), 10);
    const fine = await draft(client.id, site.id, adult.id, atStore(day, 8), 8);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const from = atStore(day, 0);
    const to = atStore(day + 1, 0);
    const pf = await a.get(`/scheduling/publish-preflight?${window(from, to)}`);
    expect(pf.status).toBe(200);
    expect(pf.body.laborFindings).toEqual([
      expect.objectContaining({ rule: 'MINOR_DAILY', severity: 'block', shiftId: bad.id, associateId: minor.id, associateName: 'Minor Worker' }),
    ]);
    expect(pf.body.laborFindings[0].reason).toMatch(/Age 16: 10\.00 h on a school day > 8, .*US-FL/);
    // The review sheet's totals and who would be told.
    expect(pf.body.totals).toMatchObject({ shifts: 2, hours: 16, costCents: 16 * 16 * 100, deltaHoursVsLastWeek: null, deltaCostCentsVsLastWeek: null });
    expect(pf.body.notifyCount).toBe(2);
    expect(pf.body.openShiftIds).toEqual([]);

    const pub = await a.post('/scheduling/publish-week').send({ weekStart: from.toISOString(), weekEnd: to.toISOString() });
    expect(pub.status).toBe(409);
    expect(pub.body.error.code).toBe('labor_rules_block');
    expect(pub.body.error.message).toMatch(/^1 shift can't be published: Age 16/);
    expect(pub.body.error.details.findings).toEqual([expect.objectContaining({ rule: 'MINOR_DAILY', shiftId: bad.id })]);
    // Nothing published — not even the adult's clean shift.
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: fine.id } })).status).toBe('DRAFT');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe('DRAFT');
  });

  it("an adult's short rest between two shifts warns and still publishes, with the warning in the answer", async () => {
    const { client, site } = await siteIn('IL', 'Chicago');
    const adult = await hire(client.id, 'Adult', new Date('1990-01-01'));
    const day = schoolDayOut();
    // 14:00–22:00, then 06:00 the next morning: 8 hours between < Chicago's 10.
    const first = await draft(client.id, site.id, adult.id, atStore(day, 14), 8);
    const second = await draft(client.id, site.id, adult.id, atStore(day + 1, 6), 8);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const from = atStore(day, 0);
    const to = atStore(day + 2, 0);
    const pf = await a.get(`/scheduling/publish-preflight?${window(from, to)}`);
    expect(pf.status).toBe(200);
    expect(pf.body.laborFindings.map((f: { rule: string; severity: string }) => [f.rule, f.severity])).toEqual([
      ['REST_BETWEEN_SHIFTS', 'warn'],
      ['REST_BETWEEN_SHIFTS', 'warn'],
    ]);
    // The old rest-gap scan now says who and which shifts.
    expect(pf.body.restGaps).toEqual([expect.objectContaining({ associateId: adult.id, shiftIds: [first.id, second.id], gapHours: 8 })]);

    const pub = await a.post('/scheduling/publish-week').send({ weekStart: from.toISOString(), weekEnd: to.toISOString() });
    expect(pub.status).toBe(200);
    expect(pub.body.published).toBe(2);
    expect(pub.body.laborWarnings).toHaveLength(2);
    expect(pub.body.laborWarnings[0]).toMatchObject({ rule: 'REST_BETWEEN_SHIFTS', severity: 'warn', associateId: adult.id });
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('ASSIGNED');
  });

  it('a week with nothing the rules object to publishes with no warnings', async () => {
    const { client, site } = await siteIn('FL', 'Destin');
    const adult = await hire(client.id, 'Adult', new Date('1990-01-01'));
    const day = schoolDayOut();
    await draft(client.id, site.id, adult.id, atStore(day, 8), 8);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const pub = await a.post('/scheduling/publish-week').send({ weekStart: atStore(day, 0).toISOString(), weekEnd: atStore(day + 1, 0).toISOString() });
    expect(pub.status).toBe(200);
    expect(pub.body.published).toBe(1);
    expect(pub.body.laborWarnings).toBeUndefined();
  });
});
