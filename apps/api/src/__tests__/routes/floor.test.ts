import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { setSmsTransportForTests } from '../../lib/sms.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The floor from a phone (field roles, 2026-10): an incident with a photo
 * filed by a supervisor who holds no manage:compliance; a flag a watch-only
 * lead raises in two taps and their shift supervisor acknowledges; the
 * week beyond tomorrow; one text to a wave; the last shift's handover; and
 * "Cover this shift" as one tap with three moves.
 */

const app = () => createApp();
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

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

async function world() {
  const client = await createClient('Walmart 218');
  const other = await createClient('Target 9');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  await prisma.associate.update({ where: { id: ana.id }, data: { phone: '+1 555 010 0100' } });
  await prisma.application.create({ data: { associateId: ana.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
  const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
  const { user: floor } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: client.id });
  await prisma.user.update({ where: { id: floor.id }, data: { leadUserId: lead.id } });
  const { user: otherLead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: other.id });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { client, other, site, ana, lead, floor, otherLead, hr };
}

describe('incidents from the floor', () => {
  it('a shift supervisor files an incident with a photo — it lands in the OSHA log at their own store, HR is told', async () => {
    const w = await world();
    const sup = await loginAs(w.lead.email);
    const res = await sup
      .post('/floor/incidents')
      .field('description', 'Slipped on the dock, landed on the right wrist.')
      .field('severity', 'MEDICAL_TREATMENT')
      .field('location', 'Receiving dock')
      .field('associateId', w.ana.id)
      // The clamp wins: naming another client changes nothing.
      .field('clientId', w.other.id)
      .attach('photo', TINY_PNG, { filename: 'dock.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ isRecordable: true, photo: true });
    const row = await prisma.oshaIncident.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.clientId).toBe(w.client.id);
    expect(row.locationId).toBe(w.site.id);
    expect(row.associateId).toBe(w.ana.id);
    expect(row.reportedById).toBe(w.lead.id);
    expect(row.photoKey).toMatch(/^tenants\/00000000-0000-4000-8000-000000000001\/incidents\//); // Brief 2-1 §9.6: under the tenant
    // The photo is theirs to see, and HR's.
    expect((await sup.get(`/floor/incidents/${row.id}/photo`)).status).toBe(200);
    const hr = await loginAs(w.hr.email);
    expect((await hr.get(`/floor/incidents/${row.id}/photo`)).status).toBe(200);
    await flushPendingNotifications();
    const told = await prisma.notification.findFirst({ where: { recipientUserId: w.hr.id, subject: { contains: 'Incident reported from the floor' } } });
    expect(told).not.toBeNull();
  });

  it('a watch-only floor supervisor reports a hazard — kept, not recordable; an associate cannot file at all', async () => {
    const w = await world();
    const floor = await loginAs(w.floor.email);
    const res = await floor.post('/floor/incidents').send({ description: 'Wet floor by dock 3, no sign out.', nearMiss: true });
    expect(res.status).toBe(201);
    expect(res.body.isRecordable).toBe(false);
    const row = await prisma.oshaIncident.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.isRecordable).toBe(false);
    expect(row.associateId).toBeNull();

    const { user } = await createUser({ role: 'ASSOCIATE', associateId: w.ana.id, email: w.ana.email });
    const assoc = await loginAs(user.email);
    expect((await assoc.post('/floor/incidents').send({ description: 'I fell over something.' })).status).toBe(403);
  });
});

describe('flags from the floor', () => {
  it('the floor lead raises a no-show in two taps; their shift supervisor sees it, counts it, and acknowledges it', async () => {
    const w = await world();
    const floor = await loginAs(w.floor.email);
    const raised = await floor.post('/floor/flags').send({ kind: 'NO_SHOW', associateId: w.ana.id, note: 'Not here 20 minutes in.' });
    expect(raised.status).toBe(201);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: w.lead.id, channel: 'IN_APP', subject: { contains: 'No-show — Ana Lopez' } } })).toBe(1);

    const sup = await loginAs(w.lead.email);
    const list = await sup.get('/floor/flags');
    expect(list.status).toBe(200);
    expect(list.body.flags).toHaveLength(1);
    expect(list.body.flags[0]).toMatchObject({ kind: 'NO_SHOW', status: 'OPEN', associate: { id: w.ana.id, name: 'Ana Lopez' } });
    const inbox = await sup.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'floor-flags')).toMatchObject({ count: 1, path: '/' });

    // Another store's supervisor never sees it.
    const other = await loginAs(w.otherLead.email);
    expect((await other.get('/floor/flags')).body.flags).toHaveLength(0);
    expect((await other.post(`/floor/flags/${raised.body.id}/ack`)).status).toBe(404);

    expect((await sup.post(`/floor/flags/${raised.body.id}/ack`)).status).toBe(200);
    expect((await sup.get('/floor/flags')).body.flags).toHaveLength(0);
    const flag = await prisma.floorFlag.findUniqueOrThrow({ where: { id: raised.body.id } });
    expect(flag.status).toBe('ACKNOWLEDGED');
    expect(flag.acknowledgedById).toBe(w.lead.id);
  });

  it('the watch-only lead gets the week at the store, and its counts in the Inbox', async () => {
    const w = await world();
    await prisma.shift.createMany({
      data: [
        { clientId: w.client.id, locationId: w.site.id, position: 'Stocker', startsAt: inHours(30), endsAt: inHours(36), status: 'OPEN', publishedAt: new Date() },
        { clientId: w.client.id, locationId: w.site.id, position: 'Stocker', startsAt: inHours(30), endsAt: inHours(36), status: 'ASSIGNED', assignedAssociateId: w.ana.id, publishedAt: new Date(), acknowledgedAt: new Date() },
        { clientId: w.other.id, position: 'Cashier', startsAt: inHours(30), endsAt: inHours(36), status: 'OPEN', publishedAt: new Date() },
      ],
    });
    const floor = await loginAs(w.floor.email);
    const week = await floor.get('/floor/week');
    expect(week.status).toBe(200);
    expect(week.body.days).toHaveLength(7);
    const total = week.body.days.reduce((n: number, d: { scheduled: number }) => n + d.scheduled, 0);
    expect(total).toBe(2); // the other client's shift is not theirs
    expect(week.body.days.reduce((n: number, d: { open: number }) => n + d.open, 0)).toBe(1);
    expect(week.body.days.reduce((n: number, d: { confirmed: number }) => n + d.confirmed, 0)).toBe(1);
    const inbox = await floor.get('/me/inbox');
    const keys = inbox.body.sources.map((s: { key: string }) => s.key);
    expect(keys).toContain('floor-watch');
    expect(keys).not.toContain('approvals');
  });
});

describe('the crew and the handover', () => {
  it('one text to everyone on a wave, kept in the log; nobody at another store', async () => {
    const w = await world();
    const ben = await createAssociate({ firstName: 'Ben', lastName: 'Ray' });
    const mine = await prisma.shift.create({ data: { clientId: w.client.id, position: 'Stocker', startsAt: inHours(2), endsAt: inHours(8), status: 'ASSIGNED', assignedAssociateId: w.ana.id, publishedAt: new Date() } });
    const noPhone = await prisma.shift.create({ data: { clientId: w.client.id, position: 'Stocker', startsAt: inHours(2), endsAt: inHours(8), status: 'ASSIGNED', assignedAssociateId: ben.id, publishedAt: new Date() } });
    const theirs = await prisma.shift.create({ data: { clientId: w.other.id, position: 'Stocker', startsAt: inHours(2), endsAt: inHours(8), status: 'ASSIGNED', assignedAssociateId: w.ana.id, publishedAt: new Date() } });
    const sup = await loginAs(w.lead.email);
    const res = await sup.post('/floor/crew-text').send({ shiftIds: [mine.id, noPhone.id, theirs.id], body: 'Dock 2 opens at 5:45 — side door.' });
    expect(res.status).toBe(200);
    // With no SMS provider the text is NOT sent, the row says so, and the
    // answer names why — never "sent: 1" for a text that went nowhere.
    expect(res.body).toMatchObject({ sent: 0, failed: 0, optedOut: 0, noPhone: ['Ben Ray'], notConfigured: expect.stringMatching(/Texting isn’t connected/) });
    const logged = await prisma.notification.findMany({ where: { category: 'crew-text' } });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ channel: 'SMS', recipientPhone: '+1 555 010 0100', senderUserId: w.lead.id, status: 'NOT_CONFIGURED' });
    // With a provider, the same call sends and the row is SENT with the SID.
    setSmsTransportForTests(async () => ({ sid: 'SM-crew', status: 'queued' }));
    try {
      const again = await sup.post('/floor/crew-text').send({ shiftIds: [mine.id], body: 'Dock 2 opens at 5:45 — side door.' });
      expect(again.body).toMatchObject({ sent: 1, notConfigured: null });
      const sentRow = await prisma.notification.findFirst({ where: { category: 'crew-text', status: 'SENT' } });
      expect(sentRow).toMatchObject({ externalRef: 'SM-crew' });
    } finally {
      setSmsTransportForTests(null);
    }
    // The floor lead holds no message:crew.
    const floor = await loginAs(w.floor.email);
    expect((await floor.post('/floor/crew-text').send({ shiftIds: [mine.id], body: 'x' })).status).toBe(403);
  });

  it("the last shift's undecided handover notes reach the lead coming on", async () => {
    const w = await world();
    const shift = await prisma.opsShift.create({
      data: { clientId: w.client.id, locationId: w.site.id, department: 'Grocery', departments: ['Grocery'], period: 'EVENING', position: 'Evening lead', dateKey: '2026-10-16', openedById: w.lead.id, status: 'CLOSED' },
    });
    await prisma.opsHandoverItem.createMany({
      data: [
        { fromShiftId: shift.id, kind: 'EQUIPMENT', body: 'Pallet jack 3 is down.', priority: 'HIGH' },
        { fromShiftId: shift.id, kind: 'NOTE', body: 'Decided already.', priority: 'LOW', status: 'REVIEWED', decidedAt: new Date() },
      ],
    });
    const sup = await loginAs(w.lead.email);
    const res = await sup.get('/floor/handover');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ kind: 'EQUIPMENT', priority: 'HIGH', from: { shiftId: shift.id, position: 'Evening lead' } });
    const other = await loginAs(w.otherLead.email);
    expect((await other.get('/floor/handover')).body.items).toHaveLength(0);
  });
});

describe('cover this shift', () => {
  it('posts the shift, asks the bench, and says when the agent will propose — one tap', async () => {
    const w = await world();
    await createUser({ role: 'ASSOCIATE', associateId: w.ana.id, email: w.ana.email });
    const shift = await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.site.id, position: 'Stocker', startsAt: inHours(20), endsAt: inHours(26), status: 'OPEN', publishedAt: null } });
    const sup = await loginAs(w.lead.email);
    const res = await sup.post(`/floor/cover/${shift.id}`).send({});
    expect(res.status).toBe(200);
    const steps = res.body.steps as Array<{ key: string; status: string; detail: string }>;
    expect(steps.map((s) => s.key)).toEqual(['post', 'bench', 'agent']);
    expect(steps[0]).toMatchObject({ status: 'done', detail: 'Posted to Open shifts.' });
    expect(steps[1]!.status).toBe('done');
    expect(steps[1]!.detail).toMatch(/invited|already asked/);
    // Just posted: the bench gets its two hours before the agent steps in.
    expect(steps[2]!.status).toBe('waiting');
    const after = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.status).toBe('OPEN');
    expect(after.publishedAt).not.toBeNull();
  });

  it('an assigned shift is covered only when the person is released; another store’s shift is not found', async () => {
    const w = await world();
    const held = await prisma.shift.create({ data: { clientId: w.client.id, position: 'Stocker', startsAt: inHours(20), endsAt: inHours(26), status: 'ASSIGNED', assignedAssociateId: w.ana.id, publishedAt: new Date(), acknowledgedAt: new Date() } });
    const theirs = await prisma.shift.create({ data: { clientId: w.other.id, position: 'Stocker', startsAt: inHours(20), endsAt: inHours(26), status: 'OPEN', publishedAt: new Date() } });
    const sup = await loginAs(w.lead.email);
    expect((await sup.post(`/floor/cover/${held.id}`).send({})).status).toBe(409);
    expect((await sup.post(`/floor/cover/${theirs.id}`).send({})).status).toBe(404);
    const released = await sup.post(`/floor/cover/${held.id}`).send({ release: true, reason: 'Called out sick.' });
    expect(released.status).toBe(200);
    expect(released.body.steps[0].detail).toBe('Released and posted to Open shifts.');
    const after = await prisma.shift.findUniqueOrThrow({ where: { id: held.id } });
    expect(after).toMatchObject({ status: 'OPEN', assignedAssociateId: null, acknowledgedAt: null });
    expect(after.notes).toContain('Called out sick.');
  });
});
