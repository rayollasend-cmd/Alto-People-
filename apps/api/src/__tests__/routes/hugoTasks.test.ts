import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { sweepHugoTasks } from '../../lib/hugoTasks.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Hugo works for you — tasks (lib/hugoTasks). A task is started by the
 * person's tap, runs on the server while they do other things, keeps a
 * trail, and tells them when it is done or when only they can decide.
 * Asking coworkers to cover a shift is the one thing it does on their
 * behalf: the manager still approves, and nobody hears about every "no".
 */

const app = () => createApp();
const H = 3_600_000;
const D = 24 * H;

beforeEach(async () => {
  await truncateAll();
  await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@example.com' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
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

/** A store with Ana (who needs cover), two coworkers placed there, and a supervisor. */
async function store() {
  const client = await createClient('Walmart 1234');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const place = async (firstName: string, lastName: string) => {
    const a = await createAssociate({ firstName, lastName });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date(Date.now() - 30 * D) } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    return { associate: a, user };
  };
  const ana = await place('Ana', 'Lopez');
  const ben = await place('Ben', 'Moss');
  const cy = await place('Cy', 'Diaz');
  const dana = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
  const { user: supervisor } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: dana.id });
  const shift = (associateId: string | null, startsAt: Date, hours = 8) =>
    prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: site.id,
        position: 'Cashier',
        startsAt,
        endsAt: new Date(startsAt.getTime() + hours * H),
        status: associateId ? 'ASSIGNED' : 'OPEN',
        assignedAssociateId: associateId,
        publishedAt: new Date(),
      },
    });
  return { client, site, ana, ben, cy, supervisor, shift };
}

const inApp = (userId: string) => prisma.notification.findMany({ where: { recipientUserId: userId, channel: 'IN_APP' }, orderBy: { createdAt: 'asc' } });

/** The sweep, as the timer runs it: inside the tenant, at a moment of our choosing. */
const sweep = (at: Date = new Date()) => runWithTenant(ALTO_TENANT_ID, 'job', () => sweepHugoTasks(at));

describe('find cover for my shift', () => {
  it('asks one free coworker at a time, fewest hours first; a "no" moves on quietly; the approval closes it with one notice', async () => {
    const s = await store();
    const mine = await s.shift(s.ana.associate.id, new Date(Date.now() + 2 * D));
    // Ben already works that week; Cy doesn't — Cy is asked first.
    await s.shift(s.ben.associate.id, new Date(Date.now() + 3 * D));
    const ana = await loginAs(s.ana.user.email);

    const started = await ana.post('/hugo/tasks').send({ task: { kind: 'FIND_COVER', shiftId: mine.id }, source: 'chat' });
    expect(started.status).toBe(201);
    expect(started.body.existing).toBe(false);
    const task = started.body.task;
    expect(task.status).toBe('WAITING');
    expect(task.events.map((e: { code: string }) => e.code)).toEqual(['STARTED', 'ASKED']);
    expect(task.events[1].data).toEqual({ name: 'Cy D.' });
    expect(task.progress).toEqual({ done: 1, total: 2 });
    expect(task.subject.shift).toMatchObject({ id: mine.id, site: 'Walmart 1234', position: 'Cashier' });

    const ask1 = await prisma.shiftSwapRequest.findFirstOrThrow({ where: { shiftId: mine.id } });
    expect(ask1).toMatchObject({ counterpartyAssociateId: s.cy.associate.id, requesterAssociateId: s.ana.associate.id, status: 'PENDING_PEER' });
    await flushPendingNotifications();
    // The coworker is asked; the manager hears only once someone says yes.
    expect((await inApp(s.cy.user.id)).map((n) => n.category)).toEqual(['swap_peer_request']);
    expect(await inApp(s.supervisor.id)).toHaveLength(0);

    // The same tap twice is the same task.
    const again = await ana.post('/hugo/tasks').send({ task: { kind: 'FIND_COVER', shiftId: mine.id } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ existing: true, task: { id: task.id } });

    // Cy says no: Hugo asks Ben at once — and Ana is not pinged about the "no".
    const cy = await loginAs(s.cy.user.email);
    expect((await cy.post(`/scheduling/swap-requests/${ask1.id}/peer-decline`).send({})).status).toBe(200);
    await flushPendingNotifications();
    const ask2 = await prisma.shiftSwapRequest.findFirstOrThrow({ where: { shiftId: mine.id, counterpartyAssociateId: s.ben.associate.id } });
    expect(ask2.status).toBe('PENDING_PEER');
    expect((await inApp(s.ana.user.id)).filter((n) => n.category === 'swap_peer_declined')).toHaveLength(0);

    // Ben says yes: waiting on the manager, who hears now.
    const ben = await loginAs(s.ben.user.email);
    expect((await ben.post(`/scheduling/swap-requests/${ask2.id}/peer-accept`).send({})).status).toBe(200);
    await flushPendingNotifications();
    let view = (await ana.get(`/hugo/tasks/${task.id}`)).body.task;
    expect(view.status).toBe('WAITING');
    expect(view.events.map((e: { code: string }) => e.code)).toEqual(['STARTED', 'ASKED', 'DECLINED', 'ASKED', 'ACCEPTED']);
    expect((await inApp(s.supervisor.id)).length).toBeGreaterThan(0);
    expect((await inApp(s.ana.user.id)).filter((n) => n.category === 'swap_peer_accepted')).toHaveLength(0);

    // Approved: the shift is Ben's, the task is done, and Ana gets one notice — Hugo's, with the disclosure.
    const owner = await loginAs('owner@example.com');
    const approved = await owner.post(`/scheduling/swap-requests/${ask2.id}/manager-approve`).send({});
    expect(approved.status).toBe(200);
    await flushPendingNotifications();
    view = (await ana.get(`/hugo/tasks/${task.id}`)).body.task;
    expect(view).toMatchObject({ status: 'DONE', result: { coveredBy: 'Ben M.' }, seen: false });
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: mine.id } })).assignedAssociateId).toBe(s.ben.associate.id);
    const told = (await inApp(s.ana.user.id)).filter((n) => n.category?.startsWith('hugo_') || n.category === 'swap_manager_approved');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ category: 'hugo_task_done', subject: 'Your shift is covered', linkUrl: '/scheduling' });
    expect(told[0]!.body).toContain('Ben Moss is working');
    expect(told[0]!.body).toMatch(/AI agent/);
    expect(told[0]!.byAgentId).not.toBeNull();

    // Seen: it stops counting on the badge.
    expect((await ana.get('/hugo/summary')).body).toMatchObject({ working: 0, needsYou: 0, unseenDone: 1 });
    expect((await ana.post('/hugo/seen').send({ tasks: [task.id] })).body.tasks).toBe(1);
    expect((await ana.get('/hugo/summary')).body.unseenDone).toBe(0);
  });

  it('an unanswered ask is withdrawn after its window — the coworker is told quietly — and the next one is asked', async () => {
    const s = await store();
    const mine = await s.shift(s.ana.associate.id, new Date(Date.now() + 2 * D));
    const ana = await loginAs(s.ana.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'FIND_COVER', shiftId: mine.id } })).body;
    const first = await prisma.shiftSwapRequest.findFirstOrThrow({ where: { shiftId: mine.id } });

    // Seven hours later nobody answered (the window is a quarter of the time left, at most six hours).
    await sweep(new Date(Date.now() + 7 * H));
    await flushPendingNotifications();
    expect((await prisma.shiftSwapRequest.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('CANCELLED');
    const firstPeer = first.counterpartyAssociateId === s.ben.associate.id ? s.ben.user : s.cy.user;
    const closed = (await inApp(firstPeer.id)).filter((n) => n.category === 'swap_request_closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]!.body).toContain('Nothing to do');
    const row = await prisma.hugoTask.findUniqueOrThrow({ where: { id: task.id }, include: { events: { orderBy: { createdAt: 'asc' } } } });
    expect(row.events.map((e) => e.code)).toEqual(['STARTED', 'ASKED', 'NO_ANSWER', 'ASKED']);
    expect(await prisma.shiftSwapRequest.count({ where: { shiftId: mine.id, status: 'PENDING_PEER' } })).toBe(1);
  });

  it('with no one free it needs the person: keep trying, pass it to the supervisor, or stop', async () => {
    const s = await store();
    const when = new Date(Date.now() + 2 * D);
    const mine = await s.shift(s.ana.associate.id, when);
    // Both coworkers already work then.
    await s.shift(s.ben.associate.id, when);
    await s.shift(s.cy.associate.id, when);
    const ana = await loginAs(s.ana.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'FIND_COVER', shiftId: mine.id } })).body;
    expect(task).toMatchObject({ status: 'NEEDS_YOU', needs: 'NO_ONE_LEFT', choices: ['KEEP_TRYING', 'ASK_SUPERVISOR', 'STOP'], seen: false });
    await flushPendingNotifications();
    const notice = (await inApp(s.ana.user.id)).find((n) => n.category === 'hugo_task_needs_you');
    expect(notice).toMatchObject({ subject: 'No one could take your shift yet', linkUrl: `/?hugo=task:${task.id}` });
    expect(notice!.body).toContain("You're still on this shift");
    expect((await ana.get('/hugo/summary')).body.needsYou).toBe(1);

    // An answer that isn't on offer is refused.
    expect((await ana.post(`/hugo/tasks/${task.id}/respond`).send({ choice: 'NUDGE_AGAIN' })).status).toBe(400);

    // Keep trying: back to work, quietly, hourly.
    const kept = await ana.post(`/hugo/tasks/${task.id}/respond`).send({ choice: 'KEEP_TRYING' });
    expect(kept.status).toBe(200);
    expect(kept.body.task.status).toBe('WAITING');
    expect(kept.body.task.events.map((e: { code: string }) => e.code)).toContain('KEPT_TRYING');

    // Ben's clash goes away; the next look asks him.
    await prisma.shift.updateMany({ where: { assignedAssociateId: s.ben.associate.id }, data: { status: 'CANCELLED' } });
    await sweep(new Date(Date.now() + 2 * H));
    expect(await prisma.shiftSwapRequest.count({ where: { shiftId: mine.id, counterpartyAssociateId: s.ben.associate.id, status: 'PENDING_PEER' } })).toBe(1);

    // Stopping withdraws the ask in flight.
    const stopped = await ana.post(`/hugo/tasks/${task.id}/cancel`).send({});
    expect(stopped.status).toBe(200);
    expect(stopped.body.task.status).toBe('CANCELLED');
    expect(await prisma.shiftSwapRequest.count({ where: { shiftId: mine.id, status: 'PENDING_PEER' } })).toBe(0);
    expect((await ana.post(`/hugo/tasks/${task.id}/cancel`).send({})).status).toBe(409);
  });

  it('passing it to the supervisor opens a thread with them and closes the task', async () => {
    const s = await store();
    const when = new Date(Date.now() + 2 * D);
    const mine = await s.shift(s.ana.associate.id, when);
    await s.shift(s.ben.associate.id, when);
    await s.shift(s.cy.associate.id, when);
    const ana = await loginAs(s.ana.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'FIND_COVER', shiftId: mine.id } })).body;
    const passed = await ana.post(`/hugo/tasks/${task.id}/respond`).send({ choice: 'ASK_SUPERVISOR' });
    expect(passed.status).toBe(200);
    expect(passed.body.task.status).toBe('DONE');
    expect(passed.body.task.result.passedTo.who).toBe('Dana Reyes');
    expect(passed.body.task.result.passedTo.url).toMatch(/^\/messages\//);
    const msg = await prisma.message.findFirstOrThrow({ where: { senderId: s.ana.user.id } });
    expect(msg.body).toContain('I need cover for my shift');
  });

  it('refuses a shift too soon, someone else\'s shift, and a shift already being swapped', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    const soon = await s.shift(s.ana.associate.id, new Date(Date.now() + 2 * H));
    expect((await ana.post('/hugo/tasks').send({ task: { kind: 'FIND_COVER', shiftId: soon.id } })).body.error.code).toBe('too_soon');
    const bens = await s.shift(s.ben.associate.id, new Date(Date.now() + 2 * D));
    expect((await ana.post('/hugo/tasks').send({ task: { kind: 'FIND_COVER', shiftId: bens.id } })).status).toBe(404);
    const mine = await s.shift(s.ana.associate.id, new Date(Date.now() + 3 * D));
    await prisma.shiftSwapRequest.create({ data: { shiftId: mine.id, requesterAssociateId: s.ana.associate.id, counterpartyAssociateId: s.cy.associate.id, status: 'PENDING_PEER' } });
    const r = await ana.post('/hugo/tasks').send({ task: { kind: 'FIND_COVER', shiftId: mine.id } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('swap_in_flight');
    // An office account with no pay of its own can't watch a paycheck.
    const owner = await loginAs('owner@example.com');
    expect((await owner.post('/hugo/tasks').send({ task: { kind: 'WATCH_PAYCHECK' } })).status).toBe(403);
  });

  it('a shift that starts with no cover found is said plainly: you are still on it', async () => {
    const s = await store();
    const when = new Date(Date.now() + 2 * D);
    const mine = await s.shift(s.ana.associate.id, when);
    await s.shift(s.ben.associate.id, when);
    await s.shift(s.cy.associate.id, when);
    const ana = await loginAs(s.ana.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'FIND_COVER', shiftId: mine.id } })).body;
    await sweep(new Date(when.getTime() - 30 * 60_000));
    await flushPendingNotifications();
    expect((await prisma.hugoTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('EXPIRED');
    const n = (await inApp(s.ana.user.id)).find((x) => x.subject === "Your shift wasn't covered");
    expect(n?.body).toContain("You're still on this shift");
  });
});

describe('tell me when', () => {
  it('a paycheck: done the moment it is paid, with the paystub one tap away', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'WATCH_PAYCHECK' } })).body;
    expect(task.status).toBe('WAITING');

    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-16'), status: 'DISBURSED', totalGross: 800, totalTax: 0, totalNet: 800, totalEmployerTax: 0 } });
    const item = await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: s.ana.associate.id, hoursWorked: 40, hourlyRate: 20, grossPay: 800, federalWithholding: 0, netPay: 800, status: 'DISBURSED', disbursedAt: new Date() } });
    await sweep(new Date(Date.now() + 16 * 60_000));
    await flushPendingNotifications();
    const view = (await ana.get(`/hugo/tasks/${task.id}`)).body.task;
    expect(view).toMatchObject({ status: 'DONE', linkUrl: `/payroll?item=${item.id}`, result: { paycheck: { itemId: item.id, periodStart: '2026-10-03', periodEnd: '2026-10-16' } } });
    const n = (await inApp(s.ana.user.id)).find((x) => x.category === 'hugo_task_done');
    expect(n).toMatchObject({ subject: 'Your paycheck is ready', linkUrl: `/payroll?item=${item.id}` });
    // The amount never rides a notice.
    expect(n!.body).not.toMatch(/\$|800/);
  });

  it('a time-off decision closes the watch without a second notice (the decision already told them)', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    expect((await ana.post('/hugo/tasks').send({ task: { kind: 'WATCH_TIME_OFF' } })).body.error.code).toBe('nothing_pending');
    const req = await prisma.timeOffRequest.create({ data: { associateId: s.ana.associate.id, category: 'PTO', startDate: new Date('2026-12-01'), endDate: new Date('2026-12-02'), requestedMinutes: 960 } });
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'WATCH_TIME_OFF' } })).body;
    expect(task.subject.timeOff).toEqual([{ id: req.id, startDate: '2026-12-01', endDate: '2026-12-02' }]);
    await prisma.timeOffRequest.update({ where: { id: req.id }, data: { status: 'APPROVED', decidedAt: new Date() } });
    await sweep(new Date(Date.now() + 11 * 60_000));
    await flushPendingNotifications();
    const view = (await ana.get(`/hugo/tasks/${task.id}`)).body.task;
    expect(view.status).toBe('DONE');
    expect(view.events.at(-1)).toMatchObject({ code: 'DECIDED', data: { status: 'APPROVED', startDate: '2026-12-01' } });
    expect((await inApp(s.ana.user.id)).filter((n) => n.category?.startsWith('hugo_'))).toHaveLength(0);
  });

  it('a document: verified is done; rejected needs a new upload', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    const doc = await prisma.documentRecord.create({ data: { associateId: s.ana.associate.id, kind: 'ID', filename: 'license.jpg', mimeType: 'image/jpeg', size: 10 } });
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'WATCH_DOCUMENT', documentId: doc.id } })).body;
    await prisma.documentRecord.update({ where: { id: doc.id }, data: { status: 'REJECTED', rejectionReason: 'Photo is blurry' } });
    await sweep(new Date(Date.now() + 11 * 60_000));
    await flushPendingNotifications();
    const view = (await ana.get(`/hugo/tasks/${task.id}`)).body.task;
    expect(view).toMatchObject({ status: 'NEEDS_YOU', needs: 'REUPLOAD', choices: ['GOT_IT'] });
    const n = (await inApp(s.ana.user.id)).find((x) => x.category === 'hugo_task_needs_you');
    expect(n!.body).toContain('license.jpg');
    expect(n!.body).toContain('Photo is blurry');
    const ok = await ana.post(`/hugo/tasks/${task.id}/respond`).send({ choice: 'GOT_IT' });
    expect(ok.body.task.status).toBe('DONE');
  });

  it('open shifts: tells them when one that fits comes up', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'WATCH_OPEN_SHIFTS', days: 7 } })).body;
    expect(task.status).toBe('WAITING');
    const open = await s.shift(null, new Date(Date.now() + 3 * D));
    await sweep(new Date(Date.now() + 31 * 60_000));
    await flushPendingNotifications();
    const view = (await ana.get(`/hugo/tasks/${task.id}`)).body.task;
    expect(view).toMatchObject({ status: 'DONE', linkUrl: `/marketplace?shift=${open.id}` });
    expect(view.result.shifts[0].id).toBe(open.id);
  });
});

describe('chase confirmations (a desk)', () => {
  it('nudges everyone unconfirmed in the desk\'s reach, counts, and reports when all are in', async () => {
    const s = await store();
    const other = await createClient('Target 9');
    const otherSite = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    const tomorrow = new Date(Date.now() + D);
    const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
    const a = await s.shift(s.ana.associate.id, tomorrow);
    const b = await s.shift(s.ben.associate.id, tomorrow);
    // Another client's shift is not this desk's to chase.
    await prisma.shift.create({ data: { clientId: other.id, locationId: otherSite.id, position: 'X', startsAt: tomorrow, endsAt: new Date(tomorrow.getTime() + 8 * H), status: 'ASSIGNED', assignedAssociateId: s.cy.associate.id, publishedAt: new Date() } });
    const sup = await loginAs(s.supervisor.email);
    const started = await sup.post('/hugo/tasks').send({ task: { kind: 'CHASE_CONFIRMATIONS', date: day(tomorrow) } });
    expect(started.status).toBe(201);
    expect(started.body.task).toMatchObject({ status: 'WAITING', progress: { done: 0, total: 2 } });
    expect(started.body.task.events[1]).toMatchObject({ code: 'NUDGED', data: { count: 2 } });
    await flushPendingNotifications();
    expect((await inApp(s.ana.user.id)).map((n) => n.category)).toContain('shift_confirm');
    expect((await inApp(s.cy.user.id)).map((n) => n.category)).not.toContain('shift_confirm');

    await prisma.shift.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { acknowledgedAt: new Date() } });
    await sweep(new Date(Date.now() + 21 * 60_000));
    await flushPendingNotifications();
    const view = (await sup.get(`/hugo/tasks/${started.body.task.id}`)).body.task;
    expect(view).toMatchObject({ status: 'DONE', progress: { done: 2, total: 2 } });
    expect((await inApp(s.supervisor.id)).find((n) => n.category === 'hugo_task_done')?.subject).toMatch(/^Everyone confirmed for /);
  });

  it('at the cutoff, who is still out is the desk\'s to decide — nudge again, or leave it', async () => {
    const s = await store();
    const tomorrow = new Date(Date.now() + D);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(tomorrow);
    await s.shift(s.ana.associate.id, tomorrow);
    const sup = await loginAs(s.supervisor.email);
    const { task } = (await sup.post('/hugo/tasks').send({ task: { kind: 'CHASE_CONFIRMATIONS', date: day } })).body;
    const row = await prisma.hugoTask.findUniqueOrThrow({ where: { id: task.id } });
    await prisma.hugoTask.update({ where: { id: task.id }, data: { state: { ...(row.state as object), cutoffAt: new Date(Date.now() - 60_000).toISOString() }, nextCheckAt: new Date(Date.now() - 1000) } });
    await sweep();
    await flushPendingNotifications();
    const view = (await sup.get(`/hugo/tasks/${task.id}`)).body.task;
    expect(view).toMatchObject({ status: 'NEEDS_YOU', needs: 'STILL_UNCONFIRMED', choices: ['NUDGE_AGAIN', 'GOT_IT'] });
    expect(view.result.unconfirmed[0].name).toBe('Ana Lopez');
    expect((await inApp(s.supervisor.id)).find((n) => n.category === 'hugo_task_needs_you')?.body).toContain('Ana Lopez');
    const again = await sup.post(`/hugo/tasks/${task.id}/respond`).send({ choice: 'NUDGE_AGAIN' });
    expect(again.body.task.status).toBe('WAITING');
    expect(again.body.task.events.at(-1).code).toBe('NUDGED');
  });

  it('an associate cannot chase', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    expect((await ana.post('/hugo/tasks').send({ task: { kind: 'CHASE_CONFIRMATIONS' } })).status).toBe(403);
  });
});

describe('ownership, limits and the off switch', () => {
  it('a task is its owner\'s alone', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'WATCH_PAYCHECK' } })).body;
    const ben = await loginAs(s.ben.user.email);
    expect((await ben.get(`/hugo/tasks/${task.id}`)).status).toBe(404);
    expect((await ben.post(`/hugo/tasks/${task.id}/cancel`).send({})).status).toBe(404);
    expect((await ben.get('/hugo/tasks')).body.tasks).toEqual([]);
    expect((await ana.get('/hugo/tasks')).body.tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
  });

  it('with Hugo switched off nothing starts and the badge reads zero', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    await prisma.agentProfile.updateMany({ where: { builtInKey: 'whatsapp-assistant' }, data: { suspendedAt: new Date() } });
    expect((await ana.post('/hugo/tasks').send({ task: { kind: 'WATCH_PAYCHECK' } })).status).toBe(409);
    expect((await ana.get('/hugo/summary')).body).toEqual({ working: 0, needsYou: 0, unseenDone: 0, newNotes: 0 });
  });
});

describe('handing work over in the chat', () => {
  it('answers with a Start card, never the task itself', async () => {
    const s = await store();
    const mine = await s.shift(s.ana.associate.id, new Date(Date.now() + 2 * D));
    const ana = await loginAs(s.ana.user.email);
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'America/New_York' }).format(mine.startsAt);
    const cover = await ana.post('/hugo/ask').send({ text: `can you find someone to cover my shift on ${weekday}?` });
    expect(cover.status).toBe(200);
    expect(cover.body.intent).toBe('TASK_FIND_COVER');
    expect(cover.body.offers).toHaveLength(1);
    expect(cover.body.offers[0].task).toEqual({ kind: 'FIND_COVER', shiftId: mine.id });
    expect(cover.body.reply).toContain('Your manager still approves');
    expect(await prisma.hugoTask.count()).toBe(0);
    expect(await prisma.shiftSwapRequest.count()).toBe(0);

    const paid = await ana.post('/hugo/ask').send({ text: 'tell me when I get paid' });
    expect(paid.body.intent).toBe('TASK_TELL_ME_WHEN');
    expect(paid.body.offers.map((o: { task: { kind: string } }) => o.task.kind)).toEqual(['WATCH_PAYCHECK']);

    const off = await ana.post('/hugo/ask').send({ text: 'let me know when my time off is decided' });
    expect(off.body.offers).toEqual([]);
    expect(off.body.reply).toMatch(/nothing waiting/i);

    const list = await ana.post('/hugo/ask').send({ text: 'what are you working on?' });
    expect(list.body).toMatchObject({ intent: 'TASK_LIST', view: 'tasks' });

    // The chips name the work Hugo can take.
    const me = await ana.get('/hugo');
    expect(me.body.can.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['TASK_FIND_COVER', 'TASK_TELL_ME_WHEN']));
  });

  it('speaks the person\'s language in the reply', async () => {
    const s = await store();
    await prisma.user.update({ where: { id: s.ana.user.id }, data: { language: 'es' } });
    const ana = await loginAs(s.ana.user.email);
    const r = await ana.post('/hugo/ask').send({ text: 'avísame cuando me paguen' });
    expect(r.body.intent).toBe('TASK_TELL_ME_WHEN');
    expect(r.body.reply).toMatch(/Toca Empezar/);
  });
});
