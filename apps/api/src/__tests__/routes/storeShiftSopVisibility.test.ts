import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { minuteOfDayInZone } from '@alto-people/shared';
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
 * "They were assigned an SOP and the shift supervisor can't see it."
 *
 * The SOP is assigned to a STORE (StoreShiftSop: location + window label).
 * The supervisor's shift is assigned to a STORE
 * (SupervisorShiftWindow: user + location + label). The clock-in resolved
 * the store from neither: it used the time entry's locationId, which comes
 * from resolveAssociateGeofence — the associate's open assignment, or,
 * failing that, the client's OLDEST active Location.
 *
 * At a client with one store those three agree and nobody notices. At a
 * client with two — the original record and the store Alto actually
 * staffs — the punch names the wrong one, storeShiftAt finds no SOP on any
 * of its windows, and returns null. Null is the same answer it gives for
 * "this store has no SOPs configured", so nothing was logged and nothing
 * was shown. The supervisor clocked in and the shift simply did not open.
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

const TZ = 'America/New_York';
const H = 3_600_000;
/** Minute-of-day `h` hours from now, so the window always contains now. */
const mod = (h: number) => minuteOfDayInZone(new Date(Date.now() + h * H), TZ);

/**
 * The shape that broke, named after the store it broke at: a client whose
 * FIRST location is the original account record, and whose second is the
 * store being staffed. The supervisor leads the Overnight window there.
 */
async function seedTwoStoreClient(opts: { assignAssociateToStore?: boolean } = {}) {
  // createClient makes a default Location named after the client — this is
  // the older row, and the one the geofence fallback picks.
  const client = await createClient('Walmart Neighborhood Market SRB');
  const originalRecord = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  const store = await prisma.location.create({
    data: { clientId: client.id, name: 'Neighbor Hood Market SRB', timezone: TZ },
  });
  await prisma.location.update({ where: { id: originalRecord.id }, data: { timezone: TZ } });

  await prisma.staffingTarget.create({
    data: {
      locationId: store.id,
      targetCount: 6,
      effectiveFrom: new Date('2026-01-01'),
      label: 'Overnight',
      startMinute: mod(-1),
      endMinute: mod(7),
    },
  });

  const template = await prisma.opsSopTemplate.create({
    data: {
      name: 'Overnight Standard',
      department: 'F&D',
      period: 'OVERNIGHT',
      tasks: {
        create: [
          { section: 'Open', order: 1, title: 'Walk the floor', responseType: 'CHECK', required: true },
        ],
      },
    },
  });

  const assoc = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
  const { user: sup } = await createUser({
    role: 'SHIFT_SUPERVISOR',
    clientId: client.id,
    associateId: assoc.id,
  });
  if (opts.assignAssociateToStore) {
    await prisma.associateAssignment.create({
      data: { associateId: assoc.id, locationId: store.id, startedAt: new Date('2026-01-01') },
    });
  }
  // The supervisor's shift IS on record — this is the statement the
  // clock-in was ignoring.
  await prisma.supervisorShiftWindow.create({
    data: { userId: sup.id, locationId: store.id, label: 'Overnight' },
  });

  const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
  const opsAgent = await loginAs(ops.email);
  const put = await opsAgent
    .put('/ops/store-shifts')
    .send({ locationId: store.id, label: 'Overnight', templateId: template.id });
  expect(put.status).toBe(200);

  return {
    client,
    originalRecord,
    store,
    template,
    sup,
    opsAgent,
    supAgent: await loginAs(sup.email),
  };
}

describe('the SOP opens at the store the supervisor actually leads', () => {
  it('opens even when the punch resolves the client’s other location', async () => {
    const w = await seedTwoStoreClient();

    const punch = await w.supAgent.post('/time/me/clock-in').send({});
    expect(punch.status).toBe(201);

    const opened = await prisma.opsShift.findFirst({
      where: { openedById: w.sup.id, status: 'ACTIVE' },
      select: { locationId: true, windowLabel: true, templateId: true },
    });
    expect(opened).not.toBeNull();
    expect(opened!.locationId).toBe(w.store.id);
    expect(opened!.windowLabel).toBe('Overnight');
    expect(opened!.templateId).toBe(w.template.id);
  });

  it('still prefers the store they actually punched in at', async () => {
    // A supervisor covering a sibling store is punched in THERE, and that
    // has to keep winning over their usual assignment — the fallback is
    // second, not first.
    const w = await seedTwoStoreClient({ assignAssociateToStore: true });
    const covering = await prisma.location.create({
      data: { clientId: w.client.id, name: 'Covering Store', timezone: TZ },
    });
    await prisma.staffingTarget.create({
      data: {
        locationId: covering.id,
        targetCount: 4,
        effectiveFrom: new Date('2026-01-01'),
        label: 'Overnight',
        startMinute: mod(-1),
        endMinute: mod(7),
      },
    });
    const otherTemplate = await prisma.opsSopTemplate.create({
      data: { name: 'Covering Standard', department: 'GM', period: 'OVERNIGHT' },
    });
    const put = await w.opsAgent
      .put('/ops/store-shifts')
      .send({ locationId: covering.id, label: 'Overnight', templateId: otherTemplate.id });
    expect(put.status).toBe(200);

    // Move their assignment to the store they are covering tonight.
    await prisma.associateAssignment.updateMany({
      where: { associateId: w.sup.associateId! },
      data: { locationId: covering.id },
    });

    expect((await w.supAgent.post('/time/me/clock-in').send({})).status).toBe(201);
    const opened = await prisma.opsShift.findFirstOrThrow({
      where: { openedById: w.sup.id, status: 'ACTIVE' },
      select: { locationId: true, templateId: true },
    });
    expect(opened.locationId).toBe(covering.id);
    expect(opened.templateId).toBe(otherTemplate.id);
  });
});

describe('a supervisor with nothing scheduled still has a way in', () => {
  /**
   * The Floor page's "Nothing scheduled today" is driven by published
   * Shift rows, which have nothing to do with SOPs. A client that runs
   * store-ops standards without publishing per-person shifts offered the
   * supervisor an empty picker — so when the clock-in also failed to
   * resolve their store, there was no way in at all.
   */
  it('offers the SOP their window has assigned, with no shifts scheduled', async () => {
    const w = await seedTwoStoreClient();
    expect(await prisma.shift.count()).toBe(0);
    expect((await w.supAgent.post('/time/me/clock-in').send({})).status).toBe(201);
    // Close the auto-opened one so this tests the hand-open path.
    await prisma.opsShift.updateMany({
      where: { openedById: w.sup.id },
      data: { status: 'CANCELLED' },
    });

    const opts = await w.supAgent.get('/ops/open-options');
    expect(opts.status).toBe(200);
    expect(opts.body.positions).toEqual([]);
    expect(opts.body.storeShift).not.toBeNull();
    expect(opts.body.storeShift.label).toBe('Overnight');
    expect(opts.body.storeShift.locationName).toBe('Neighbor Hood Market SRB');
    expect(opts.body.storeShift.sops[0].templateName).toBe('Overnight Standard');

    const opened = await w.supAgent.post('/ops/shifts/open').send({ storeShift: true });
    expect(opened.status).toBe(201);
    const shift = await prisma.opsShift.findUniqueOrThrow({
      where: { id: opened.body.shiftId },
      select: { locationId: true, windowLabel: true, templateId: true },
    });
    // The ASSIGNED standard — not one inferred from a position name and
    // the hour, which is how the wrong SOP gets picked.
    expect(shift.locationId).toBe(w.store.id);
    expect(shift.windowLabel).toBe('Overnight');
    expect(shift.templateId).toBe(w.template.id);
  });

  it('says so plainly when no SOP is assigned to a live window', async () => {
    const w = await seedTwoStoreClient();
    await prisma.storeShiftSop.deleteMany({});
    expect((await w.supAgent.post('/time/me/clock-in').send({})).status).toBe(201);

    const opts = await w.supAgent.get('/ops/open-options');
    expect(opts.body.storeShift).toBeNull();
    const res = await w.supAgent.post('/ops/shifts/open').send({ storeShift: true });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('no_store_shift');
  });
});

describe('the assignment screen shows what the clock-in would honour', () => {
  it('stops listing an SOP whose template was retired', async () => {
    const w = await seedTwoStoreClient();

    const before = await w.opsAgent.get(`/ops/store-shifts?clientId=${w.client.id}`);
    expect(before.status).toBe(200);
    const windowOf = (body: { stores: { locationId: string; windows: { label: string; templateIds: string[] }[] }[] }) =>
      body.stores.find((s) => s.locationId === w.store.id)!.windows.find((x) => x.label === 'Overnight')!;
    expect(windowOf(before.body).templateIds).toEqual([w.template.id]);

    // Retiring the standard is what makes the two disagree: storeShiftAt
    // skips it, so the supervisor gets nothing, while the assignment screen
    // kept showing the window as covered.
    await prisma.opsSopTemplate.update({
      where: { id: w.template.id },
      data: { retiredAt: new Date(), active: false },
    });

    const after = await w.opsAgent.get(`/ops/store-shifts?clientId=${w.client.id}`);
    expect(windowOf(after.body).templateIds).toEqual([]);

    // And the supervisor genuinely gets nothing, which is now what the
    // screen says.
    expect((await w.supAgent.post('/time/me/clock-in').send({})).status).toBe(201);
    expect(await prisma.opsShift.count({ where: { openedById: w.sup.id } })).toBe(0);
  });
});

describe('HR cancels an SOP opened by mistake', () => {
  it('lifts the clock-out gate and lets the right one be opened after', async () => {
    const w = await seedTwoStoreClient();
    expect((await w.supAgent.post('/time/me/clock-in').send({})).status).toBe(201);
    const wrong = await prisma.opsShift.findFirstOrThrow({
      where: { openedById: w.sup.id, status: 'ACTIVE' },
    });

    // Clocking out is refused while it is open — that gate is the whole
    // point of the feature, and the reason a mistake is expensive.
    const blocked = await w.supAgent.post('/time/me/clock-out').send({});
    expect(blocked.status).toBe(409);

    const cancel = await w.opsAgent
      .post(`/ops/shifts/${wrong.id}/cancel`)
      .send({ reason: 'Afternoon supervisor opened the morning standard.' });
    expect(cancel.status).toBe(200);

    const after = await prisma.opsShift.findUniqueOrThrow({ where: { id: wrong.id } });
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelledReason).toContain('morning standard');

    // The gate is lifted.
    expect((await w.supAgent.post('/time/me/clock-out').send({})).status).toBe(200);

    // And the occurrence is free again: a cancelled SOP must not count as
    // "this shift already had one", or voiding a mistake would block the
    // correct SOP for the rest of the night.
    expect((await w.supAgent.post('/time/me/clock-in').send({})).status).toBe(201);
    const reopened = await prisma.opsShift.findFirst({
      where: { openedById: w.sup.id, status: 'ACTIVE' },
      select: { id: true, locationId: true },
    });
    expect(reopened).not.toBeNull();
    expect(reopened!.id).not.toBe(wrong.id);
    expect(reopened!.locationId).toBe(w.store.id);
  });

  it('leaves no trace in the numbers — a voided shift is not a failed one', async () => {
    const w = await seedTwoStoreClient();
    expect((await w.supAgent.post('/time/me/clock-in').send({})).status).toBe(201);
    const wrong = await prisma.opsShift.findFirstOrThrow({
      where: { openedById: w.sup.id, status: 'ACTIVE' },
    });

    const listed = async () => {
      const r = await w.opsAgent.get(`/ops/shifts?clientId=${w.client.id}`);
      expect(r.status).toBe(200);
      return (r.body.shifts as { id: string }[]).map((x) => x.id);
    };
    expect(await listed()).toContain(wrong.id);

    expect(
      (await w.opsAgent.post(`/ops/shifts/${wrong.id}/cancel`).send({ reason: 'Wrong standard.' }))
        .status,
    ).toBe(200);

    // Gone from the default list: an SOP with 0 of 1 items done, left in
    // the client's report forever, is exactly what cancelling is for.
    expect(await listed()).not.toContain(wrong.id);

    // Still findable when HR asks for it by name — the record is not erased,
    // it is just not counted.
    const asked = await w.opsAgent.get(`/ops/shifts?clientId=${w.client.id}&status=CANCELLED`);
    expect(asked.status).toBe(200);
    expect((asked.body.shifts as { id: string }[]).map((x) => x.id)).toContain(wrong.id);
  });

  it('is HR’s, not the supervisor’s', async () => {
    // A supervisor who could cancel their own SOP could walk out of any
    // shift by cancelling on the way — the gate would mean nothing.
    const w = await seedTwoStoreClient();
    expect((await w.supAgent.post('/time/me/clock-in').send({})).status).toBe(201);
    const open = await prisma.opsShift.findFirstOrThrow({
      where: { openedById: w.sup.id, status: 'ACTIVE' },
    });

    const res = await w.supAgent
      .post(`/ops/shifts/${open.id}/cancel`)
      .send({ reason: 'I would rather not do this one.' });
    expect(res.status).toBe(403);
    expect(
      (await prisma.opsShift.findUniqueOrThrow({ where: { id: open.id } })).status,
    ).toBe('ACTIVE');
  });

  it('wants a reason, and refuses a shift that was already submitted', async () => {
    const w = await seedTwoStoreClient();
    expect((await w.supAgent.post('/time/me/clock-in').send({})).status).toBe(201);
    const open = await prisma.opsShift.findFirstOrThrow({
      where: { openedById: w.sup.id, status: 'ACTIVE' },
    });

    const noReason = await w.opsAgent.post(`/ops/shifts/${open.id}/cancel`).send({});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('reason_required');

    await prisma.opsShift.update({ where: { id: open.id }, data: { status: 'CLOSED' } });
    const closed = await w.opsAgent
      .post(`/ops/shifts/${open.id}/cancel`)
      .send({ reason: 'Changed my mind about this record.' });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('shift_closed');
  });
});
