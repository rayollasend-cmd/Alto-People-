import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * F500 G2 — a supervisor's "My shift" before they clock in shows what the
 * shift will need: their own shift, the notes the last shift left, the SOPs
 * on the windows they lead (with item counts) and who is scheduled today.
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

const H = 3_600_000;

describe('GET /ops/shift-preview', () => {
  it('names the shift, the open handover notes, the led SOPs with item counts and today\'s crew — inside the client', async () => {
    const client = await createClient('Front Beach');
    const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const other = await createClient('Other Store');
    const otherStore = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });

    const dana = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: dana.id });
    await prisma.supervisorShiftWindow.create({ data: { userId: sup.id, locationId: store.id, label: 'Swing' } });

    const template = await prisma.opsSopTemplate.create({
      data: {
        name: 'Swing Standard',
        department: 'Frozen & Dairy',
        period: 'EVENING',
        tasks: {
          create: [
            { section: 'Open', order: 1, title: 'Walk the floor', responseType: 'CHECK', required: true },
            { section: 'Open', order: 2, title: 'Check the coolers', responseType: 'CHECK', required: true },
            { section: 'Close', order: 3, title: 'Lock the cage', responseType: 'CHECK', required: true },
          ],
        },
      },
    });
    await prisma.storeShiftSop.create({ data: { locationId: store.id, label: 'Swing', templateId: template.id } });

    // Dana's own shift, running now, and a crew member's. Not "in an hour":
    // after 11 PM on the company calendar that lands on tomorrow.
    const now = Date.now();
    const start = new Date(now);
    await prisma.shift.create({
      data: { clientId: client.id, locationId: store.id, position: 'Shift Supervisor', startsAt: start, endsAt: new Date(start.getTime() + 8 * H), status: 'ASSIGNED', assignedAssociateId: dana.id },
    });
    const marcus = await createAssociate({ firstName: 'Marcus', lastName: 'Hill' });
    await prisma.shift.create({
      data: { clientId: client.id, locationId: store.id, position: 'Stocker', startsAt: start, endsAt: new Date(start.getTime() + 8 * H), status: 'ASSIGNED', assignedAssociateId: marcus.id },
    });
    // Another client's crew never shows.
    const stranger = await createAssociate({ firstName: 'Other', lastName: 'Person' });
    await prisma.shift.create({
      data: { clientId: other.id, locationId: otherStore.id, position: 'Stocker', startsAt: start, endsAt: new Date(start.getTime() + 8 * H), status: 'ASSIGNED', assignedAssociateId: stranger.id },
    });

    // The last shift at this store closed two hours ago with two notes, one decided.
    const { user: prev } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const closed = await prisma.opsShift.create({
      data: {
        clientId: client.id,
        locationId: store.id,
        position: 'Shift Supervisor',
        department: 'Frozen & Dairy',
        period: 'MORNING',
        dateKey: orgDateKey(new Date(now)),
        status: 'CLOSED',
        openedById: prev.id,
        openedAt: new Date(now - 10 * H),
        closedAt: new Date(now - 2 * H),
      },
    });
    await prisma.opsHandoverItem.create({ data: { fromShiftId: closed.id, body: 'Cooler 3 door sticks', priority: 'HIGH' } });
    await prisma.opsHandoverItem.create({ data: { fromShiftId: closed.id, body: 'Already handled', status: 'DISMISSED' } });

    const agent = await loginAs(sup.email);
    const res = await agent.get('/ops/shift-preview');
    expect(res.status).toBe(200);
    expect(res.body.myShift).toMatchObject({ position: 'Shift Supervisor', store: store.name });
    expect(new Date(res.body.myShift.startsAt).getTime()).toBe(start.getTime());
    expect(res.body.handover).toHaveLength(1);
    expect(res.body.handover[0]).toMatchObject({ body: 'Cooler 3 door sticks', priority: 'HIGH', department: 'Frozen & Dairy' });
    expect(res.body.sops).toEqual([
      expect.objectContaining({ name: 'Swing Standard', window: 'Swing', items: 3, store: store.name }),
    ]);
    expect(res.body.crew.map((c: { name: string }) => c.name).sort()).toEqual(['Dana Reyes', 'Marcus Hill']);

    // A supervisor of the other client sees none of it.
    const { user: otherSup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: other.id });
    const theirs = await (await loginAs(otherSup.email)).get('/ops/shift-preview');
    expect(theirs.status).toBe(200);
    expect(theirs.body.handover).toEqual([]);
    expect(theirs.body.sops).toEqual([]);
    expect(theirs.body.crew.map((c: { name: string }) => c.name)).toEqual(['Other Person']);
    // Asking for the first client by id is clamped to their own.
    const clamped = await (await loginAs(otherSup.email)).get(`/ops/shift-preview?clientId=${client.id}`);
    expect(clamped.body.crew.map((c: { name: string }) => c.name)).toEqual(['Other Person']);
  });
});
