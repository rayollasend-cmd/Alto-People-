import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * A cross-client transfer moves the associate — everywhere. It moves their
 * store assignment; their approved application stays filed under the
 * client they started at. Every "whose people are these?" that read the
 * application kept them at the OLD client (still on its roster, its count,
 * its directory filter) and never showed them at the NEW one. And Accounts
 * — who must move the worker in Fieldglass too — heard about it only when
 * Fieldglass registration was already on file, and only in the bell.
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
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Maria: hired at Walmart (approved application), working its store. */
async function seed(opts: { registeredAt?: 'walmart' | 'target' } = {}) {
  const walmart = await createClient('Walmart');
  const target = await createClient('Target');
  const walmartStore = await prisma.location.findFirstOrThrow({ where: { clientId: walmart.id } });
  const targetStore = await prisma.location.findFirstOrThrow({ where: { clientId: target.id } });
  await prisma.client.update({ where: { id: target.id }, data: { fieldglassSiteName: '4 - Onsite - FL - Destin' } });
  const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  await prisma.application.create({
    data: {
      associateId: maria.id,
      clientId: walmart.id,
      onboardingTrack: 'STANDARD',
      status: 'APPROVED',
      approvedAt: new Date('2026-06-01'),
    },
  });
  await prisma.associateAssignment.create({
    data: { associateId: maria.id, locationId: walmartStore.id, startedAt: new Date('2026-06-02') },
  });
  if (opts.registeredAt) {
    await prisma.fieldglassRegistration.create({
      data: { associateId: maria.id, clientId: opts.registeredAt === 'walmart' ? walmart.id : target.id },
    });
  }
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return { walmart, target, walmartStore, targetStore, maria, finance, hr: await loginAs(hr.email) };
}

async function transfer(hr: TestAgent<Test>, associateId: string, locationId: string) {
  const res = await hr
    .post(`/org/associates/${associateId}/transfer`)
    .send({ locationId, startedAt: today(), confirmCrossClient: true });
  expect(res.status).toBe(201);
  expect(res.body.crossClient).toBe(true);
  return res.body as { id: string };
}

describe('a transferred associate is counted and listed at the NEW client', () => {
  it('client list count, People directory filter, org list, and the store rosters all follow the transfer', async () => {
    const { walmart, target, targetStore, maria, hr } = await seed();

    const before = await hr.get('/clients');
    const countOf = (body: { clients: Array<{ id: string; activeAssociateCount: number }> }, id: string) =>
      body.clients.find((c) => c.id === id)!.activeAssociateCount;
    expect(countOf(before.body, walmart.id)).toBe(1);
    expect(countOf(before.body, target.id)).toBe(0);

    await transfer(hr, maria.id, targetStore.id);

    const after = await hr.get('/clients');
    expect(countOf(after.body, target.id)).toBe(1);
    expect(countOf(after.body, walmart.id)).toBe(0);

    const ids = (body: { associates?: Array<{ id: string }>; people?: Array<{ id: string }> }) =>
      (body.associates ?? body.people ?? []).map((p) => p.id);
    expect(ids((await hr.get(`/people/directory?clientId=${target.id}`)).body)).toContain(maria.id);
    expect(ids((await hr.get(`/people/directory?clientId=${walmart.id}`)).body)).not.toContain(maria.id);
    expect(ids((await hr.get(`/org/associates?clientId=${target.id}`)).body)).toContain(maria.id);
    expect(ids((await hr.get(`/org/associates?clientId=${walmart.id}`)).body)).not.toContain(maria.id);

    // The store rosters: the new client's supervisor schedules her; the old
    // client's no longer sees her.
    const { user: targetSup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: target.id });
    const { user: walmartSup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: walmart.id });
    const roster = async (email: string) =>
      ((await (await loginAs(email)).get('/scheduling/associates')).body.associates as Array<{ id: string }>).map((a) => a.id);
    expect(await roster(targetSup.email)).toContain(maria.id);
    expect(await roster(walmartSup.email)).not.toContain(maria.id);
  });

  it("separated people stop counting — the count is who works there now", async () => {
    const { walmart, maria, hr } = await seed();
    await prisma.associate.update({ where: { id: maria.id }, data: { separatedAt: new Date() } });
    const list = await hr.get('/clients');
    expect(list.body.clients.find((c: { id: string }) => c.id === walmart.id).activeAssociateCount).toBe(0);
  });

  it("the compliance scorecard scores her at the client she moved to", async () => {
    const { target, walmart, targetStore, maria, hr } = await seed();
    await transfer(hr, maria.id, targetStore.id);
    expect((await hr.get(`/compliance-scorecard/onboarding?clientId=${target.id}`)).body.activeAssociateCount).toBe(1);
    expect((await hr.get(`/compliance-scorecard/onboarding?clientId=${walmart.id}`)).body.activeAssociateCount).toBe(0);
  });
});

describe('Accounts hears about every transfer — bell AND email — to move the worker in Fieldglass', () => {
  it('not yet added in Fieldglass: "add them under the NEW client, not the old"', async () => {
    const { targetStore, maria, finance, hr } = await seed();
    const t = await transfer(hr, maria.id, targetStore.id);
    await flushPendingNotifications();

    const bell = await prisma.notification.findFirst({
      where: { recipientUserId: finance.id, channel: 'IN_APP', subject: { startsWith: 'Fieldglass transfer' } },
    });
    expect(bell?.subject).toBe('Fieldglass transfer — Maria Lopez: Walmart → Target');
    expect(bell?.body).toMatch(/moving from Walmart to Target/);
    expect(bell?.body).toMatch(/aren't marked as added in Fieldglass yet — add them under Target \(Fieldglass site "4 - Onsite - FL - Destin"\), not Walmart/);
    expect(bell?.linkUrl).toContain(`fgTransfer=${t.id}`);
    const email = await prisma.notification.findFirst({
      where: { recipientUserId: finance.id, channel: 'EMAIL', subject: 'Fieldglass transfer — Maria Lopez: Walmart → Target' },
    });
    expect(email).not.toBeNull();
  });

  it('registered under the old client: close there, add under the new one', async () => {
    const { targetStore, maria, finance, hr } = await seed({ registeredAt: 'walmart' });
    await transfer(hr, maria.id, targetStore.id);
    await flushPendingNotifications();
    const bell = await prisma.notification.findFirst({
      where: { recipientUserId: finance.id, channel: 'IN_APP', subject: { startsWith: 'Fieldglass transfer' } },
    });
    expect(bell?.body).toMatch(/close their worker record under Walmart and add them under Target/);
  });

  it('every transfer is its own news — moving back is told too, once each', async () => {
    const { walmartStore, targetStore, maria, finance, hr } = await seed();
    await transfer(hr, maria.id, targetStore.id);
    await transfer(hr, maria.id, walmartStore.id);
    await flushPendingNotifications();
    const subjects = (
      await prisma.notification.findMany({
        where: { recipientUserId: finance.id, channel: 'IN_APP', subject: { startsWith: 'Fieldglass transfer' } },
        orderBy: { createdAt: 'asc' },
        select: { subject: true },
      })
    ).map((n) => n.subject);
    expect(subjects).toEqual([
      'Fieldglass transfer — Maria Lopez: Walmart → Target',
      'Fieldglass transfer — Maria Lopez: Target → Walmart',
    ]);
  });
});
