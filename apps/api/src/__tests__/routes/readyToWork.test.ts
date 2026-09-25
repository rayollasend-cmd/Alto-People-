import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { runReadyToWorkNudgeSweep } from '../../lib/readyToWork.js';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The ready-to-work handoff, end to end through the routes:
 *   - issuing the clock-in number tells the store's shift supervisors (with
 *     the associate's card) and the associate (with the supervisors' card)
 *   - the supervisor's queue lists the hire until a first shift exists
 *   - HR's status line says who was told and whether it closed
 *   - the nudge sweep pages the store again and tells Workforce
 *   - approval needs a store when the client has more than one
 */

const app = () => createApp();
const HOUR = 3600_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

async function storeWithWindow(clientId: string, name = 'Northgate') {
  const location = await prisma.location.create({ data: { clientId, name, city: 'Destin', state: 'FL' } });
  await prisma.staffingTarget.create({
    data: {
      locationId: location.id,
      label: 'Day',
      startMinute: 8 * 60,
      endMinute: 16 * 60,
      targetCount: 6,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  return location;
}

async function hiredAssociate(clientId: string, locationId: string | null) {
  const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez', email: `maria-${Date.now()}@example.com` });
  await prisma.associate.update({ where: { id: associate.id }, data: { phone: '850-555-0101', hireDate: new Date('2026-09-20T00:00:00.000Z') } });
  const application = await createApplicationWithChecklist({ associateId: associate.id, clientId });
  await prisma.application.update({
    where: { id: application.id },
    data: { status: 'APPROVED', approvedAt: new Date(), position: 'Server', locationId },
  });
  if (locationId) {
    await prisma.associateAssignment.create({
      data: { associateId: associate.id, locationId, startedAt: new Date('2026-09-20T00:00:00.000Z'), reason: 'test' },
    });
  }
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
  return { associate, user };
}

describe('POST /kiosk-pins → ready-to-work handoff', () => {
  it('tells the store’s shift supervisors and the associate, and lists the hire in the supervisor’s queue', async () => {
    const client = await createClient('Acme Resort');
    const store = await storeWithWindow(client.id);
    const other = await storeWithWindow(client.id, 'Southgate');
    const lead = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, email: 'lead@example.com' });
    const elsewhere = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, email: 'elsewhere@example.com' });
    await prisma.supervisorShiftWindow.create({ data: { userId: lead.user.id, locationId: store.id, label: 'Day' } });
    await prisma.supervisorShiftWindow.create({ data: { userId: elsewhere.user.id, locationId: other.id, label: 'Day' } });
    const hr = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { associate, user: associateUser } = await hiredAssociate(client.id, store.id);

    const asHr = await loginAs(hr.user.email);
    const issued = await asHr.post('/kiosk-pins').send({ associateId: associate.id, clientId: client.id });
    expect(issued.status).toBe(201);
    await flushPendingNotifications();

    // The store's lead hears, with the card and the scheduling deep link.
    const toLead = await prisma.notification.findMany({ where: { recipientUserId: lead.user.id, channel: 'IN_APP' } });
    expect(toLead).toHaveLength(1);
    expect(toLead[0]!.subject).toContain('Maria Lopez');
    expect(toLead[0]!.body).toContain('850-555-0101');
    expect(toLead[0]!.body).toContain('Northgate');
    expect(toLead[0]!.linkUrl).toBe(`/scheduling?associate=${associate.id}`);
    // The supervisor of the OTHER store does not.
    expect(await prisma.notification.count({ where: { recipientUserId: elsewhere.user.id } })).toBe(0);
    // The associate hears, with the lead's card.
    const toAssociate = await prisma.notification.findMany({ where: { recipientUserId: associateUser.id, channel: 'IN_APP' } });
    expect(toAssociate).toHaveLength(1);
    expect(toAssociate[0]!.body).toContain('lead@example.com');
    expect(toAssociate[0]!.body).toContain('Northgate');

    const row = await prisma.readyToWorkHandoff.findUnique({ where: { associateId: associate.id } });
    expect(row?.locationId).toBe(store.id);
    expect(row?.supervisorUserIds).toEqual([lead.user.id]);
    expect(row?.fallbackToClient).toBe(false);

    // The lead's queue shows the hire; the other supervisor's is empty.
    const asLead = await loginAs(lead.user.email);
    const queue = await asLead.get('/ready-to-work/mine');
    expect(queue.status).toBe(200);
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0].associate.name).toBe('Maria Lopez');
    expect(queue.body.items[0].store.name).toBe('Northgate');
    const asElsewhere = await loginAs(elsewhere.user.email);
    expect((await asElsewhere.get('/ready-to-work/mine')).body.items).toHaveLength(0);

    // The associate's kit.
    const asAssociate = await loginAs(associateUser.email);
    const kit = await asAssociate.get('/self/me/ready-to-work');
    expect(kit.status).toBe(200);
    expect(kit.body.kit.store.name).toBe('Northgate');
    expect(kit.body.kit.supervisors.map((s: { email: string }) => s.email)).toEqual(['lead@example.com']);
    expect(kit.body.kit.supervisors[0].windows).toEqual(['Day']);
    expect(kit.body.kit.firstShiftAt).toBeNull();

    // HR's line: told, not closed.
    const status = await asHr.get(`/ready-to-work/associates/${associate.id}`);
    expect(status.status).toBe(200);
    expect(status.body.status.closed).toBe(false);
    expect(status.body.status.supervisors[0].name).toBeTruthy();

    // A first shift closes it: gone from the queue, dated on HR's line.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: store.id,
        position: 'Server',
        startsAt: new Date(Date.now() + 48 * HOUR),
        endsAt: new Date(Date.now() + 56 * HOUR),
        status: 'ASSIGNED',
        assignedAssociateId: associate.id,
        assignedAt: new Date(),
      },
    });
    expect((await asLead.get('/ready-to-work/mine')).body.items).toHaveLength(0);
    const closed = await asHr.get(`/ready-to-work/associates/${associate.id}`);
    expect(closed.body.status.closed).toBe(true);
    expect(closed.body.status.firstShiftAt).not.toBeNull();
    // The associate still sees the kit (with the shift date) until they punch in.
    expect((await asAssociate.get('/self/me/ready-to-work')).body.kit.firstShiftAt).not.toBeNull();
  });

  it('pages every supervisor at the client, flagged, when nobody leads the store — and tells HR when there is none', async () => {
    const client = await createClient('Acme Resort');
    const store = await storeWithWindow(client.id);
    const anyone = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, email: 'anyone@example.com' });
    const hr = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { associate } = await hiredAssociate(client.id, store.id);

    const asHr = await loginAs(hr.user.email);
    expect((await asHr.post('/kiosk-pins').send({ associateId: associate.id, clientId: client.id })).status).toBe(201);
    await flushPendingNotifications();

    const row = await prisma.readyToWorkHandoff.findUnique({ where: { associateId: associate.id } });
    expect(row?.fallbackToClient).toBe(true);
    expect(row?.supervisorUserIds).toEqual([anyone.user.id]);
    expect(await prisma.notification.count({ where: { recipientUserId: anyone.user.id, channel: 'IN_APP' } })).toBe(1);
    // Nobody leads a window at the store, so the whole client's queue holds the hire.
    const asAnyone = await loginAs(anyone.user.email);
    expect((await asAnyone.get('/ready-to-work/mine')).body.items[0].fallbackToClient).toBe(true);

    // No supervisor at all: HR is told.
    await prisma.user.update({ where: { id: anyone.user.id }, data: { status: 'DISABLED' } });
    const { associate: second } = await hiredAssociate(client.id, store.id);
    expect((await asHr.post('/kiosk-pins').send({ associateId: second.id, clientId: client.id })).status).toBe(201);
    await flushPendingNotifications();
    const toHr = await prisma.notification.findMany({ where: { recipientUserId: hr.user.id, channel: 'IN_APP' } });
    expect(toHr.some((n) => n.subject?.startsWith('No supervisor to hand'))).toBe(true);
  });

  it('nudges the store once and tells Workforce when no first shift follows', async () => {
    const client = await createClient('Acme Resort');
    const store = await storeWithWindow(client.id);
    const lead = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, email: 'lead@example.com' });
    await prisma.supervisorShiftWindow.create({ data: { userId: lead.user.id, locationId: store.id, label: 'Day' } });
    const wfm = await createUser({ role: 'WORKFORCE_MANAGER', email: 'wfm@example.com' });
    const hr = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { associate } = await hiredAssociate(client.id, store.id);
    const asHr = await loginAs(hr.user.email);
    expect((await asHr.post('/kiosk-pins').send({ associateId: associate.id, clientId: client.id })).status).toBe(201);
    await flushPendingNotifications();

    // Too early: nothing.
    expect(await runReadyToWorkNudgeSweep(new Date(Date.now() + 1 * HOUR))).toBe(0);
    // Past the window: the lead hears again, Workforce hears, once.
    expect(await runReadyToWorkNudgeSweep(new Date(Date.now() + 49 * HOUR))).toBe(1);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: lead.user.id, channel: 'IN_APP' } })).toBe(2);
    const toWfm = await prisma.notification.findMany({ where: { recipientUserId: wfm.user.id, channel: 'IN_APP' } });
    expect(toWfm).toHaveLength(1);
    expect(toWfm[0]!.subject).toContain('No first shift yet');
    expect(await runReadyToWorkNudgeSweep(new Date(Date.now() + 80 * HOUR))).toBe(0);
    const status = await asHr.get(`/ready-to-work/associates/${associate.id}`);
    expect(status.body.status.nudgedAt).not.toBeNull();
  });
});

describe('POST /onboarding/applications/:id/approve — the store', () => {
  async function approvable(clientId: string) {
    const associate = await createAssociate({ email: `hire-${Date.now()}@example.com` });
    const application = await createApplicationWithChecklist({ associateId: associate.id, clientId });
    // Every task complete so the checklist gate lets the approval through.
    await prisma.onboardingTask.updateMany({
      where: { checklist: { applicationId: application.id } },
      data: { status: 'DONE', completedAt: new Date() },
    });
    await prisma.application.update({ where: { id: application.id }, data: { status: 'SUBMITTED', submittedAt: new Date() } });
    return { associate, application };
  }

  it('asks for a store when the client has several and the application names none, then stamps the chosen one', async () => {
    const client = await createClient('Acme Resort');
    const a = await prisma.location.create({ data: { clientId: client.id, name: 'Northgate' } });
    await prisma.location.create({ data: { clientId: client.id, name: 'Southgate' } });
    const hr = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { associate, application } = await approvable(client.id);
    const asHr = await loginAs(hr.user.email);

    const noStore = await asHr
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: '2026-10-01', acknowledgeWarnings: true });
    expect(noStore.status).toBe(409);
    expect(noStore.body.error ?? noStore.body.code).toBe('store_required');

    const withStore = await asHr
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: '2026-10-01', acknowledgeWarnings: true, locationId: a.id });
    expect(withStore.status).toBe(204);
    const stamped = await prisma.application.findUnique({ where: { id: application.id }, select: { locationId: true, status: true } });
    expect(stamped).toEqual({ locationId: a.id, status: 'APPROVED' });
    const assignment = await prisma.associateAssignment.findFirst({ where: { associateId: associate.id, endedAt: null } });
    expect(assignment?.locationId).toBe(a.id);
  });

  it('assigns the only store on its own', async () => {
    const client = await createClient('Acme Resort');
    const only = await prisma.location.create({ data: { clientId: client.id, name: 'Northgate' } });
    const hr = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { associate, application } = await approvable(client.id);
    const asHr = await loginAs(hr.user.email);
    const res = await asHr
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: '2026-10-01', acknowledgeWarnings: true });
    expect(res.status).toBe(204);
    const assignment = await prisma.associateAssignment.findFirst({ where: { associateId: associate.id, endedAt: null } });
    expect(assignment?.locationId).toBe(only.id);
  });
});
