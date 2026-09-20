import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { minuteOfDayInZone } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { generateDeviceToken, hashDeviceToken, hmacPin } from '../../lib/kioskAuth.js';
import { _resetKioskRateLimit } from '../../lib/kioskRateLimit.js';
import { runOpsSopSweep } from '../../lib/storeShiftSop.js';
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
 * Every supervisor completes their shift's SOP and hands over, every shift:
 * clocking in opens the SOP assigned to the store shift they're working;
 * they can't clock out — in the app or at the kiosk — until it's submitted
 * (done, or incomplete with a written reason) with a handover note; it's
 * reminded before the shift ends and escalated if still open after.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
  _resetKioskRateLimit();
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
const mod = (h: number) => minuteOfDayInZone(new Date(Date.now() + h * H), TZ);

/** A store whose "Swing" window runs from an hour ago to seven hours from
 *  now, with a two-item SOP assigned, and a supervisor who leads it. */
async function seed(opts: { assignSop?: boolean } = {}) {
  const client = await createClient('Front Beach');
  const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.location.update({ where: { id: store.id }, data: { timezone: TZ } });
  await prisma.staffingTarget.create({
    data: {
      locationId: store.id,
      targetCount: 6,
      effectiveFrom: new Date('2026-01-01'),
      label: 'Swing',
      startMinute: mod(-1),
      endMinute: mod(7),
    },
  });
  const template = await prisma.opsSopTemplate.create({
    data: {
      name: 'Swing Standard',
      department: 'F&D',
      period: 'EVENING',
      tasks: {
        create: [
          { section: 'Open', order: 1, title: 'Walk the floor', responseType: 'CHECK', required: true },
          { section: 'Open', order: 2, title: 'Check the coolers', responseType: 'CHECK', required: true },
        ],
      },
    },
  });

  const a = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
  const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: a.id });
  await prisma.associateAssignment.create({
    data: { associateId: a.id, locationId: store.id, startedAt: new Date('2026-01-01') },
  });
  await prisma.supervisorShiftWindow.create({ data: { userId: sup.id, locationId: store.id, label: 'Swing' } });

  const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
  const opsAgent = await loginAs(ops.email);
  if (opts.assignSop !== false) {
    const put = await opsAgent
      .put('/ops/store-shifts')
      .send({ locationId: store.id, label: 'Swing', templateId: template.id });
    expect(put.status).toBe(200);
  }

  // The store's kiosk and the supervisor's PIN.
  const pin = '4321';
  await prisma.kioskPin.create({ data: { clientId: client.id, associateId: a.id, pinHmac: hmacPin(pin) } });
  const { plaintext, prefix } = generateDeviceToken();
  await prisma.kioskDevice.create({
    data: {
      clientId: client.id,
      locationId: store.id,
      name: 'Front Beach kiosk',
      tokenHash: hashDeviceToken(plaintext),
      tokenPrefix: prefix,
      tokenExpiresAt: new Date(Date.now() + 90 * 24 * H),
    },
  });
  return { client, store, template, sup, ops, opsAgent, kiosk: { deviceToken: plaintext, pin } };
}

async function finishTasks(agent: TestAgent<Test>, shiftId: string) {
  const detail = await agent.get(`/ops/shifts/${shiftId}`);
  for (const t of detail.body.tasks as Array<{ id: string }>) {
    expect((await agent.patch(`/ops/tasks/${t.id}`).send({ status: 'DONE' })).status).toBe(200);
  }
}

describe('clocking in opens the store shift SOP', () => {
  it('opens the SOP assigned to the shift they are working, due when the window ends, and tells them', async () => {
    const { sup, store } = await seed();
    const agent = await loginAs(sup.email);
    expect((await agent.post('/time/me/clock-in').send({})).status).toBe(201);

    const mine = await agent.get('/ops/my-sop');
    expect(mine.status).toBe(200);
    expect(mine.body.sop).toMatchObject({
      windowLabel: 'Swing',
      locationName: store.name,
      sopDone: 0,
      sopTotal: 2,
      requiredOpen: 2,
      handoverCount: 0,
    });
    // Due when the window ends — seven hours out, to the minute.
    const due = new Date(mine.body.sop.dueAt).getTime();
    expect(Math.abs(due - (Date.now() + 7 * H))).toBeLessThan(2 * 60_000);

    await flushPendingNotifications();
    const told = await prisma.notification.findFirst({
      where: { recipientUserId: sup.id, subject: 'Your Swing SOP is open', channel: 'IN_APP' },
    });
    expect(told?.linkUrl).toBe(`/ops?tab=shift&shift=${mine.body.sop.id}`);
  });

  it('opens nothing when the store shift has no SOP assigned — and never blocks the clock', async () => {
    const { sup } = await seed({ assignSop: false });
    const agent = await loginAs(sup.email);
    expect((await agent.post('/time/me/clock-in').send({})).status).toBe(201);
    expect((await agent.get('/ops/my-sop')).body.sop).toBeNull();
    expect((await agent.post('/time/me/clock-out').send({})).status).toBe(200);
  });
});

describe("no clock-out until it's submitted", () => {
  it('in the app: refused while open; submitted done with a handover, it lets them go', async () => {
    const { sup } = await seed();
    const agent = await loginAs(sup.email);
    await agent.post('/time/me/clock-in').send({});
    const sopId = (await agent.get('/ops/my-sop')).body.sop.id;

    const refused = await agent.post('/time/me/clock-out').send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('sop_open');
    expect(refused.body.error.message).toMatch(/Submit your Swing SOP/);

    await finishTasks(agent, sopId);
    // Done, but no handover yet.
    const noHandover = await agent.post(`/ops/shifts/${sopId}/close`).send({});
    expect(noHandover.body.error.code).toBe('handover_required');
    await agent.post(`/ops/shifts/${sopId}/handover`).send({
      items: [{ kind: 'NOTE', body: 'Cooler 2 running warm — maintenance called.', priority: 'MEDIUM' }],
    });
    const submitted = await agent.post(`/ops/shifts/${sopId}/close`).send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.shift).toMatchObject({ closedIncomplete: false, handoverNone: false });
    // Nothing open now — the end-of-shift screen knows what was submitted.
    const after = await agent.get('/ops/my-sop');
    expect(after.body).toMatchObject({ sop: null, submitted: { id: sopId, windowLabel: 'Swing', closedIncomplete: false } });

    expect((await agent.post('/time/me/clock-out').send({})).status).toBe(200);
  });

  it('the way out: submitted incomplete WITH a reason, leadership hears, and they can clock out', async () => {
    const { sup } = await seed();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(sup.email);
    await agent.post('/time/me/clock-in').send({});
    const sopId = (await agent.get('/ops/my-sop')).body.sop.id;

    const noReason = await agent.post(`/ops/shifts/${sopId}/close`).send({ handoverNone: true });
    expect(noReason.body.error.code).toBe('reason_required');
    const out = await agent
      .post(`/ops/shifts/${sopId}/close`)
      .send({ handoverNone: true, incompleteReason: 'Family emergency — leaving early.' });
    expect(out.status).toBe(200);
    expect(out.body.shift).toMatchObject({ closedIncomplete: true, incompleteReason: 'Family emergency — leaving early.' });

    await flushPendingNotifications();
    const flag = await prisma.notification.findFirst({ where: { recipientUserId: hr.id, category: 'ops.incomplete_close', channel: 'IN_APP' } });
    expect(flag?.body).toMatch(/Family emergency/);
    expect((await agent.post('/time/me/clock-out').send({})).status).toBe(200);
  });

  it('at the kiosk: the clock-in opens it; the clock-out is refused at the keypad and at the punch until it is submitted', async () => {
    const { sup, kiosk } = await seed();
    const punchIn = await request(app()).post('/kiosk/punch').send(kiosk);
    expect(punchIn.body.action).toBe('CLOCK_IN');
    const agent = await loginAs(sup.email);
    const sopId = (await agent.get('/ops/my-sop')).body.sop.id;
    expect(sopId).toBeTruthy();

    _resetKioskRateLimit();
    const keypad = await request(app()).post('/kiosk/verify-pin').send(kiosk);
    expect(keypad.status).toBe(409);
    expect(keypad.body.error.code).toBe('sop_open');
    expect(keypad.body.error.message).toMatch(/Submit your Swing SOP/);
    const punchOut = await request(app()).post('/kiosk/punch').send(kiosk);
    expect(punchOut.status).toBe(409);
    expect(await prisma.timeEntry.count({ where: { status: 'ACTIVE' } })).toBe(1);

    await finishTasks(agent, sopId);
    await agent.post(`/ops/shifts/${sopId}/close`).send({ handoverNone: true });
    _resetKioskRateLimit();
    const done = await request(app()).post('/kiosk/punch').send(kiosk);
    expect(done.status).toBe(200);
    expect(done.body.action).toBe('CLOCK_OUT');
  });

  it("a clock-out queued while the kiosk was offline isn't refused later — the sweep chases the SOP instead", async () => {
    const { kiosk } = await seed();
    await request(app()).post('/kiosk/punch').send(kiosk);
    _resetKioskRateLimit();
    const replay = await request(app())
      .post('/kiosk/punch')
      .send({ ...kiosk, clientPunchedAt: new Date(Date.now() - 60_000).toISOString() });
    expect(replay.status).toBe(200);
    expect(replay.body.action).toBe('CLOCK_OUT');
  });
});

describe('the handover reaches the next shift at the store', () => {
  it("the next SOP at the store opens with the last shift's notes waiting", async () => {
    const { sup, store, client } = await seed();
    const agent = await loginAs(sup.email);
    await agent.post('/time/me/clock-in').send({});
    const first = (await agent.get('/ops/my-sop')).body.sop.id;
    await finishTasks(agent, first);
    await agent.post(`/ops/shifts/${first}/handover`).send({
      items: [{ kind: 'EQUIPMENT', body: 'Freezer 3 door seal torn.', priority: 'MEDIUM' }],
    });
    await agent.post(`/ops/shifts/${first}/close`).send({});
    await agent.post('/time/me/clock-out').send({});

    // The relief supervisor at the same store clocks in.
    const b = await createAssociate({ firstName: 'Omar', lastName: 'Diaz' });
    const { user: relief } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: b.id });
    await prisma.associateAssignment.create({ data: { associateId: b.id, locationId: store.id, startedAt: new Date('2026-01-01') } });
    const reliefAgent = await loginAs(relief.email);
    await reliefAgent.post('/time/me/clock-in').send({});
    const second = (await reliefAgent.get('/ops/my-sop')).body.sop.id;
    const detail = await reliefAgent.get(`/ops/shifts/${second}`);
    expect((detail.body.handoverIn as Array<{ body: string }>).map((h) => h.body)).toEqual(['Freezer 3 door seal torn.']);
    expect(detail.body.shift.locationName).toBe(store.name);

    // The loop closes both ways: the note is acknowledged before this
    // shift's SOP can be submitted.
    await finishTasks(reliefAgent, second);
    const unread = await reliefAgent.post(`/ops/shifts/${second}/close`).send({ handoverNone: true });
    expect(unread.status).toBe(400);
    expect(unread.body.error.code).toBe('handover_unread');
    const noteId = (detail.body.handoverIn as Array<{ id: string }>)[0]!.id;
    expect((await reliefAgent.post(`/ops/handover/${noteId}/decide`).send({ action: 'REVIEW', shiftId: second })).status).toBe(200);
    expect((await reliefAgent.post(`/ops/shifts/${second}/close`).send({ handoverNone: true })).status).toBe(200);
  });
});

describe('reminded before the end, escalated after', () => {
  it('reminds the supervisor 30 minutes before the window ends, escalates 30 minutes after — once each', async () => {
    const { sup } = await seed();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(sup.email);
    await agent.post('/time/me/clock-in').send({});
    const sop = (await agent.get('/ops/my-sop')).body.sop;
    const due = new Date(sop.dueAt).getTime();

    expect(await runOpsSopSweep(prisma, new Date(due - 2 * H))).toEqual({ reminded: 0, escalated: 0 });
    expect(await runOpsSopSweep(prisma, new Date(due - 20 * 60_000))).toEqual({ reminded: 1, escalated: 0 });
    expect(await runOpsSopSweep(prisma, new Date(due - 10 * 60_000))).toEqual({ reminded: 0, escalated: 0 });
    expect(await runOpsSopSweep(prisma, new Date(due + 40 * 60_000))).toEqual({ reminded: 0, escalated: 1 });
    expect(await runOpsSopSweep(prisma, new Date(due + 90 * 60_000))).toEqual({ reminded: 0, escalated: 0 });

    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: sup.id, subject: 'Submit your Swing SOP', channel: 'IN_APP' } })).toBe(1);
    expect(await prisma.notification.count({ where: { recipientUserId: hr.id, category: 'ops.sop_overdue', channel: 'IN_APP' } })).toBe(1);
  });
});

describe('assigning each store shift its SOP', () => {
  it("lists the store's shifts with their SOP; only the library's owners assign; the window must exist", async () => {
    const { sup, store, template, opsAgent, client } = await seed();
    const list = await opsAgent.get(`/ops/store-shifts?clientId=${client.id}`);
    expect(list.status).toBe(200);
    expect(list.body.stores[0].windows).toEqual([
      expect.objectContaining({ label: 'Swing', templateId: template.id }),
    ]);
    expect(list.body.templates.map((t: { name: string }) => t.name)).toContain('Swing Standard');

    const bogus = await opsAgent.put('/ops/store-shifts').send({ locationId: store.id, label: 'Graveyard', templateId: template.id });
    expect(bogus.body.error.code).toBe('window_not_found');
    const supTry = await (await loginAs(sup.email))
      .put('/ops/store-shifts')
      .send({ locationId: store.id, label: 'Swing', templateId: null });
    expect(supTry.status).toBe(403);

    expect((await opsAgent.put('/ops/store-shifts').send({ locationId: store.id, label: 'Swing', templateId: null })).status).toBe(200);
    expect(await prisma.storeShiftSop.count()).toBe(0);
  });
});

describe('a supervisor covering more than one department', () => {
  /**
   * Alto staffs several departments in the same store, and one supervisor
   * works the floor across all of them. StoreShiftSop was unique on
   * (locationId, label), so the second department's SOP could not be
   * attached at all — assigning it overwrote the first — and storeShiftAt
   * took candidates[0] and dropped the rest without a word. The checklist
   * looked complete because it was complete for ONE department.
   */
  async function secondDepartment(storeId: string, opsAgent: TestAgent<Test>) {
    const grocery = await prisma.opsSopTemplate.create({
      data: {
        name: 'Grocery Swing',
        department: 'Grocery',
        period: 'EVENING',
        tasks: {
          create: [
            { section: 'Open', order: 1, title: 'Face the aisles', responseType: 'CHECK', required: true },
          ],
        },
      },
    });
    const put = await opsAgent
      .put('/ops/store-shifts')
      .send({ locationId: storeId, label: 'Swing', templateId: grocery.id });
    expect(put.status).toBe(200);
    return grocery;
  }

  it('keeps both SOPs on the window instead of the second replacing the first', async () => {
    const { store, template, opsAgent } = await seed();
    const grocery = await secondDepartment(store.id, opsAgent);

    const rows = await prisma.storeShiftSop.findMany({
      where: { locationId: store.id, label: 'Swing' },
      select: { templateId: true },
    });
    expect(rows.map((r) => r.templateId).sort()).toEqual([template.id, grocery.id].sort());
  });

  it('opens ONE shift carrying every department, sectioned by department', async () => {
    const { store, sup, kiosk, opsAgent } = await seed();
    await secondDepartment(store.id, opsAgent);

    const punchIn = await request(app()).post('/kiosk/punch').send(kiosk);
    expect(punchIn.body.action).toBe('CLOCK_IN');
    const agent = await loginAs(sup.email);
    const sop = (await agent.get('/ops/my-sop')).body.sop;

    // One tour of the floor is one shift — not one per department.
    expect(await prisma.opsShift.count({ where: { locationId: store.id } })).toBe(1);

    const shift = await prisma.opsShift.findUniqueOrThrow({
      where: { id: sop.id },
      include: { tasks: { select: { title: true, section: true, required: true } } },
    });
    // The coverage ledger: what this shift actually carried.
    expect(shift.departments.slice().sort()).toEqual(['F&D', 'Grocery']);
    // Every department's work is on the one checklist...
    expect(shift.tasks).toHaveLength(3);
    expect(shift.tasks.map((t) => t.title)).toContain('Face the aisles');
    expect(shift.tasks.map((t) => t.title)).toContain('Check the coolers');
    // ...told apart by section, so it reads as a floor rather than a pile.
    expect(new Set(shift.tasks.map((t) => t.section))).toEqual(
      new Set(['F&D · Open', 'Grocery · Open']),
    );
    // And the portal is told what ran, not one template's name for three.
    expect(shift.templateName).toMatch(/\+1 more/);
  });

  it('will not let a shift close with one department finished and the other untouched', async () => {
    const { store, sup, kiosk, opsAgent } = await seed();
    await secondDepartment(store.id, opsAgent);
    await request(app()).post('/kiosk/punch').send(kiosk);
    const agent = await loginAs(sup.email);
    const sopId = (await agent.get('/ops/my-sop')).body.sop.id;

    // Clear only the F&D half.
    const tasks = await prisma.opsTask.findMany({ where: { opsShiftId: sopId } });
    for (const t of tasks.filter((x) => x.section?.startsWith('F&D'))) {
      expect((await agent.patch(`/ops/tasks/${t.id}`).send({ status: 'DONE' })).status).toBe(200);
    }

    const res = await agent.post(`/ops/shifts/${sopId}/close`).send({ handoverNone: true });
    // Closing is still possible — it just takes saying why, and the count
    // spans the whole floor rather than the department that finished.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('reason_required');
    expect(res.body.error.message).toMatch(/1 required item is still open/);
  });

  it('lists every SOP on a window, and drops one without clearing the rest', async () => {
    const { store, template, opsAgent } = await seed();
    const grocery = await secondDepartment(store.id, opsAgent);

    const listed = await opsAgent.get(`/ops/store-shifts?clientId=${store.clientId}`);
    expect(listed.status).toBe(200);
    const win = listed.body.stores
      .flatMap((st: { windows: { label: string; templateIds: string[] }[] }) => st.windows)
      .find((w: { label: string }) => w.label === 'Swing');
    expect(win.templateIds.sort()).toEqual([template.id, grocery.id].sort());

    // Taking Grocery off must not take F&D with it — clearing the whole
    // window is a different act and still has its own path.
    const drop = await opsAgent
      .put('/ops/store-shifts')
      .send({ locationId: store.id, label: 'Swing', templateId: null, removeTemplateId: grocery.id });
    expect(drop.status).toBe(200);
    const left = await prisma.storeShiftSop.findMany({
      where: { locationId: store.id, label: 'Swing' },
      select: { templateId: true },
    });
    expect(left.map((r) => r.templateId)).toEqual([template.id]);
  });

  it('replacing within a department swaps it, rather than stacking two', async () => {
    const { store, template, opsAgent } = await seed();
    const newer = await prisma.opsSopTemplate.create({
      data: { name: 'Swing Standard v2', department: 'F&D', period: 'EVENING' },
    });
    const put = await opsAgent
      .put('/ops/store-shifts')
      .send({ locationId: store.id, label: 'Swing', templateId: newer.id });
    expect(put.status).toBe(200);
    const rows = await prisma.storeShiftSop.findMany({
      where: { locationId: store.id, label: 'Swing' },
      select: { templateId: true },
    });
    // One SOP per department still holds — this is a newer F&D SOP, not
    // a second one, and a supervisor must not run both.
    expect(rows.map((r) => r.templateId)).toEqual([newer.id]);
    expect(rows.map((r) => r.templateId)).not.toContain(template.id);
  });

  it('a single-department store is untouched — no section is renamed', async () => {
    const { store, sup, kiosk } = await seed();
    await request(app()).post('/kiosk/punch').send(kiosk);
    const agent = await loginAs(sup.email);
    const sopId = (await agent.get('/ops/my-sop')).body.sop.id;
    const shift = await prisma.opsShift.findUniqueOrThrow({
      where: { id: sopId },
      include: { tasks: { select: { section: true } } },
    });
    expect(shift.departments).toEqual(['F&D']);
    // Qualifying a section only earns its keep when there is something to
    // tell apart; one department keeps the template's own wording.
    expect(new Set(shift.tasks.map((t) => t.section))).toEqual(new Set(['Open']));
    expect(shift.templateName).toBe('Swing Standard');
    expect(store.id).toBeTruthy();
  });
});
