import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { resetFairWorkweekCache } from '../../lib/fairWorkweek.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Audit Tier 1 #9, the API side: every shift says whether its site owes
 * predictability pay for changes (`fairWorkweekNoticeDays`), and a
 * `changeReason` on the four schedule writes reaches the premium record
 * as an exemption.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
  resetFairWorkweekCache();
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

async function siteIn(state: string, city: string | null) {
  const client = await createClient(`${state} ${city ?? 'store'}`);
  await prisma.client.update({ where: { id: client.id }, data: { state } });
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { state, city, timezone: 'America/New_York' } });
  return { client, site };
}

async function hire(clientId: string) {
  const a = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
  await prisma.application.create({ data: { associateId: a.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
  return a;
}

async function premiumsFor(associateId: string, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const rows = await prisma.scheduleChangePremium.findMany({ where: { associateId } });
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return prisma.scheduleChangePremium.findMany({ where: { associateId } });
}

describe('fairWorkweekNoticeDays on the shift', () => {
  it('a New York City site serializes its 14-day window; a Florida site serializes null', async () => {
    const nyc = await siteIn('NY', 'New York');
    const fl = await siteIn('FL', 'Destin');
    const starts = new Date(Date.now() + 20 * 86_400_000);
    const ends = new Date(starts.getTime() + 8 * 3_600_000);
    const inNyc = await prisma.shift.create({ data: { clientId: nyc.client.id, locationId: nyc.site.id, position: 'Cook', startsAt: starts, endsAt: ends, status: 'OPEN', publishedAt: new Date() } });
    const inFl = await prisma.shift.create({ data: { clientId: fl.client.id, locationId: fl.site.id, position: 'Cook', startsAt: starts, endsAt: ends, status: 'OPEN', publishedAt: new Date() } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const list = await a.get(`/scheduling/shifts?from=${new Date(starts.getTime() - 3_600_000).toISOString()}&to=${new Date(ends.getTime() + 3_600_000).toISOString()}`);
    expect(list.status).toBe(200);
    const byId = new Map((list.body.shifts as { id: string; fairWorkweekNoticeDays: number | null }[]).map((s) => [s.id, s.fairWorkweekNoticeDays]));
    expect(byId.get(inNyc.id)).toBe(14);
    expect(byId.get(inFl.id)).toBeNull();
  });
});

describe('changeReason on the schedule writes', () => {
  it('PATCH with changeReason records the premium as exempt; without one the premium is owed', async () => {
    const { client, site } = await siteIn('NY', 'New York');
    const ana = await hire(client.id);
    const starts = new Date(Date.now() + 3 * 86_400_000);
    const mk = () =>
      prisma.shift.create({
        data: { clientId: client.id, locationId: site.id, position: 'Cook', startsAt: starts, endsAt: new Date(starts.getTime() + 8 * 3_600_000), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: new Date(), assignedAt: new Date() },
      });
    const excused = await mk();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    // Cut two hours at the worker's request: inside the window, excused.
    const cut = await a.patch(`/scheduling/shifts/${excused.id}`).send({
      endsAt: new Date(starts.getTime() + 6 * 3_600_000).toISOString(),
      changeReason: 'EMPLOYEE_REQUESTED',
      lateNoticeReason: 'Asked for a shorter day.',
    });
    expect(cut.status).toBe(200);
    expect(cut.body.fairWorkweekNoticeDays).toBe(14);
    const rows = await premiumsFor(ana.id);
    expect(rows).toEqual([expect.objectContaining({ shiftId: excused.id, change: 'reduced', exempt: true, exemptReason: 'EMPLOYEE_REQUESTED', premiumCents: 0 })]);

    // A reason the law doesn't name is refused outright, never silently
    // recorded as owed or excused.
    expect((await a.post(`/scheduling/shifts/${excused.id}/cancel`).send({ reason: 'Slow night', changeReason: 'BECAUSE' })).status).toBe(400);
    // Without one, the premium is owed.
    const owed = await a.post(`/scheduling/shifts/${excused.id}/cancel`).send({ reason: 'Slow night' });
    expect(owed.status).toBe(200);
    const after = await premiumsFor(ana.id, 1);
    for (let i = 0; i < 20 && after.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after.splice(0, after.length, ...(await prisma.scheduleChangePremium.findMany({ where: { associateId: ana.id } })));
    }
    expect(after.find((r) => r.change === 'cancelled')).toMatchObject({ exempt: false, exemptReason: null });
  });

  it('assign and unassign carry changeReason through their input schemas', async () => {
    const { client, site } = await siteIn('NY', 'New York');
    const ana = await hire(client.id);
    const starts = new Date(Date.now() + 3 * 86_400_000);
    const open = await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Cook', startsAt: starts, endsAt: new Date(starts.getTime() + 8 * 3_600_000), status: 'OPEN', publishedAt: new Date() },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const assign = await a.post(`/scheduling/shifts/${open.id}/assign`).send({ associateId: ana.id, changeReason: 'VOLUNTARY_PICKUP' });
    expect(assign.status).toBe(200);
    expect((await premiumsFor(ana.id))[0]).toMatchObject({ change: 'added', exempt: true, exemptReason: 'VOLUNTARY_PICKUP' });
    const release = await a.post(`/scheduling/shifts/${open.id}/unassign`).send({ changeReason: 'MUTUAL_SWAP' });
    expect(release.status).toBe(200);
    for (let i = 0; i < 20; i++) {
      if ((await prisma.scheduleChangePremium.count({ where: { associateId: ana.id } })) >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const rows = await prisma.scheduleChangePremium.findMany({ where: { associateId: ana.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.change, r.exemptReason])).toEqual([
      ['added', 'VOLUNTARY_PICKUP'],
      ['cancelled', 'MUTUAL_SWAP'],
    ]);
  });
});
