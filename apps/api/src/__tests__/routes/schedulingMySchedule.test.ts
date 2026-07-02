import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { runShiftReminderSweep } from '../../lib/shiftReminder.js';

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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

/** Associate + ACTIVE user + open assignment at the client's default
 *  location — passes both the schedulable-pool and placed-client gates. */
async function mkPlaced(clientId: string, firstName: string, lastName: string) {
  const a = await createAssociate({ firstName, lastName });
  const { user } = await createUser({ role: 'ASSOCIATE', email: a.email, associateId: a.id });
  const loc = await prisma.location.findFirstOrThrow({ where: { clientId } });
  await prisma.associateAssignment.create({
    data: { associateId: a.id, locationId: loc.id, startedAt: new Date() },
  });
  return { associate: a, user };
}

function mkShift(over: Record<string, unknown>) {
  return prisma.shift.create({
    data: {
      position: 'Server',
      startsAt: hoursFromNow(24),
      endsAt: hoursFromNow(32),
      status: 'ASSIGNED',
      publishedAt: new Date(),
      ...over,
    } as never,
  });
}

describe('open-shift pickup', () => {
  it('lists eligible open shifts, excludes other clients and conflicts', async () => {
    const client = await createClient();
    const otherClient = await createClient();
    const { associate: me, user } = await mkPlaced(client.id, 'Maria', 'Lopez');

    const open = await mkShift({
      clientId: client.id,
      status: 'OPEN',
      assignedAssociateId: null,
    });
    // Different client — not placed there, must not appear.
    await mkShift({ clientId: otherClient.id, status: 'OPEN', assignedAssociateId: null });
    // Overlaps my own shift — filtered.
    const clashing = await mkShift({
      clientId: client.id,
      status: 'OPEN',
      assignedAssociateId: null,
      startsAt: hoursFromNow(48),
      endsAt: hoursFromNow(56),
    });
    await mkShift({
      clientId: client.id,
      assignedAssociateId: me.id,
      startsAt: hoursFromNow(47),
      endsAt: hoursFromNow(50),
    });
    // Unpublished — invisible.
    await mkShift({
      clientId: client.id,
      status: 'OPEN',
      assignedAssociateId: null,
      publishedAt: null,
      startsAt: hoursFromNow(72),
      endsAt: hoursFromNow(80),
    });

    const agent = await loginAs(user.email);
    const res = await agent.get('/scheduling/me/open-shifts');
    expect(res.status).toBe(200);
    const ids = res.body.shifts.map((s: { id: string }) => s.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(clashing.id);
    expect(ids).toHaveLength(1);
    expect(res.body.shifts[0].myClaimStatus).toBeNull();
  });

  it('claim → manager approve assigns the shift and rejects rival claims', async () => {
    const client = await createClient();
    const { associate: me, user } = await mkPlaced(client.id, 'Maria', 'Lopez');
    const { associate: rival, user: rivalUser } = await mkPlaced(client.id, 'Riv', 'Al');
    const open = await mkShift({
      clientId: client.id,
      status: 'OPEN',
      assignedAssociateId: null,
    });

    const meAgent = await loginAs(user.email);
    const claim = await meAgent.post(`/scheduling/me/open-shifts/${open.id}/claim`);
    expect(claim.status).toBe(201);
    expect(claim.body.status).toBe('PENDING');

    const rivalAgent = await loginAs(rivalUser.email);
    const rivalClaim = await rivalAgent.post(`/scheduling/me/open-shifts/${open.id}/claim`);
    expect(rivalClaim.status).toBe(201);

    // Double-request from the same person is a 409.
    const dup = await meAgent.post(`/scheduling/me/open-shifts/${open.id}/claim`);
    expect(dup.status).toBe(409);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const pending = await hrAgent.get('/scheduling/open-shift-claims');
    expect(pending.status).toBe(200);
    expect(pending.body.claims).toHaveLength(2);

    const approve = await hrAgent.post(`/scheduling/open-shift-claims/${claim.body.id}/approve`);
    expect(approve.status).toBe(200);

    const shiftAfter = await prisma.shift.findUniqueOrThrow({ where: { id: open.id } });
    expect(shiftAfter.status).toBe('ASSIGNED');
    expect(shiftAfter.assignedAssociateId).toBe(me.id);

    // Rival's claim auto-rejected; approving it now 409s.
    const rivalAfter = await prisma.openShiftClaim.findFirstOrThrow({
      where: { associateId: rival.id, shiftId: open.id },
    });
    expect(rivalAfter.status).toBe('REJECTED');
    const approveRival = await hrAgent.post(
      `/scheduling/open-shift-claims/${rivalAfter.id}/approve`,
    );
    expect(approveRival.status).toBe(409);
  });

  it('claim is blocked on approved-time-off days', async () => {
    const client = await createClient();
    const { associate: me, user } = await mkPlaced(client.id, 'Maria', 'Lopez');
    const open = await mkShift({
      clientId: client.id,
      status: 'OPEN',
      assignedAssociateId: null,
    });
    const day = new Date(open.startsAt.toISOString().slice(0, 10) + 'T00:00:00Z');
    await prisma.timeOffRequest.create({
      data: {
        associateId: me.id,
        category: 'VACATION',
        startDate: day,
        endDate: day,
        requestedMinutes: 480,
        status: 'APPROVED',
      },
    });
    const agent = await loginAs(user.email);
    const res = await agent.post(`/scheduling/me/open-shifts/${open.id}/claim`);
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.body.code).toBeDefined();
  });
});

describe('shift acknowledgment', () => {
  it('stamps once, stays idempotent, 404s on foreign shifts', async () => {
    const client = await createClient();
    const { associate: me, user } = await mkPlaced(client.id, 'Maria', 'Lopez');
    const other = await createAssociate();
    const mine = await mkShift({ clientId: client.id, assignedAssociateId: me.id });
    const foreign = await mkShift({ clientId: client.id, assignedAssociateId: other.id });

    const agent = await loginAs(user.email);
    const first = await agent.post(`/scheduling/me/shifts/${mine.id}/acknowledge`);
    expect(first.status).toBe(200);
    expect(first.body.acknowledgedAt).not.toBeNull();

    const again = await agent.post(`/scheduling/me/shifts/${mine.id}/acknowledge`);
    expect(again.status).toBe(200);
    expect(again.body.acknowledgedAt).toBe(first.body.acknowledgedAt);

    const nope = await agent.post(`/scheduling/me/shifts/${foreign.id}/acknowledge`);
    expect(nope.status).toBe(404);
  });
});

describe('shift history paging', () => {
  it('returns pre-30-day shifts newest-first with a cursor', async () => {
    const client = await createClient();
    const { associate: me, user } = await mkPlaced(client.id, 'Maria', 'Lopez');
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    for (const d of [40, 50, 60]) {
      await mkShift({
        clientId: client.id,
        assignedAssociateId: me.id,
        status: 'COMPLETED',
        startsAt: daysAgo(d),
        endsAt: new Date(daysAgo(d).getTime() + 8 * 3_600_000),
      });
    }

    const agent = await loginAs(user.email);
    const page = await agent.get('/scheduling/me/shifts/history');
    expect(page.status).toBe(200);
    expect(page.body.shifts).toHaveLength(3);
    const starts = page.body.shifts.map((s: { startsAt: string }) => s.startsAt);
    expect([...starts].sort().reverse()).toEqual(starts); // newest first
    expect(page.body.nextBefore).toBeNull();
    // Rates stay hidden in history too.
    expect(page.body.shifts[0].hourlyRate).toBeNull();
  });
});

describe('shift trades', () => {
  it('manager approval swaps BOTH assignments atomically', async () => {
    const client = await createClient();
    const { associate: req, user: reqUser } = await mkPlaced(client.id, 'Req', 'A');
    const { associate: cpt, user: cptUser } = await mkPlaced(client.id, 'Cpt', 'B');
    const mine = await mkShift({ clientId: client.id, assignedAssociateId: req.id });
    const theirs = await mkShift({
      clientId: client.id,
      assignedAssociateId: cpt.id,
      startsAt: hoursFromNow(48),
      endsAt: hoursFromNow(56),
    });

    const reqAgent = await loginAs(reqUser.email);
    const create = await reqAgent.post('/scheduling/swap-requests').send({
      shiftId: mine.id,
      counterpartyAssociateId: cpt.id,
      counterpartShiftId: theirs.id,
    });
    expect(create.status).toBe(201);
    expect(create.body.inExchange?.shiftId).toBe(theirs.id);

    const cptAgent = await loginAs(cptUser.email);
    await cptAgent.post(`/scheduling/swap-requests/${create.body.id}/peer-accept`).send({});

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const approve = await hrAgent
      .post(`/scheduling/swap-requests/${create.body.id}/manager-approve`)
      .send({});
    expect(approve.status).toBe(200);

    const mineAfter = await prisma.shift.findUniqueOrThrow({ where: { id: mine.id } });
    const theirsAfter = await prisma.shift.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(mineAfter.assignedAssociateId).toBe(cpt.id);
    expect(theirsAfter.assignedAssociateId).toBe(req.id);
  });

  it('rejects a trade whose exchange shift is not the counterparty’s', async () => {
    const client = await createClient();
    const { associate: req, user: reqUser } = await mkPlaced(client.id, 'Req', 'A');
    const { associate: cpt } = await mkPlaced(client.id, 'Cpt', 'B');
    const stranger = await createAssociate();
    const mine = await mkShift({ clientId: client.id, assignedAssociateId: req.id });
    const strangers = await mkShift({
      clientId: client.id,
      assignedAssociateId: stranger.id,
      startsAt: hoursFromNow(48),
      endsAt: hoursFromNow(56),
    });

    const reqAgent = await loginAs(reqUser.email);
    const res = await reqAgent.post('/scheduling/swap-requests').send({
      shiftId: mine.id,
      counterpartyAssociateId: cpt.id,
      counterpartShiftId: strangers.id,
    });
    expect(res.status).toBe(409);
  });

  it('approve 409s when the main shift was cancelled mid-flight (write-time guard)', async () => {
    const client = await createClient();
    const { associate: req, user: reqUser } = await mkPlaced(client.id, 'Req', 'A');
    const { associate: cpt, user: cptUser } = await mkPlaced(client.id, 'Cpt', 'B');
    const mine = await mkShift({ clientId: client.id, assignedAssociateId: req.id });

    const reqAgent = await loginAs(reqUser.email);
    const create = await reqAgent.post('/scheduling/swap-requests').send({
      shiftId: mine.id,
      counterpartyAssociateId: cpt.id,
    });
    const cptAgent = await loginAs(cptUser.email);
    await cptAgent.post(`/scheduling/swap-requests/${create.body.id}/peer-accept`).send({});

    // Simulate the race: shift gets cancelled between accept and approve.
    await prisma.shift.update({
      where: { id: mine.id },
      data: { status: 'CANCELLED', cancellationReason: 'client cancelled' },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const approve = await hrAgent
      .post(`/scheduling/swap-requests/${create.body.id}/manager-approve`)
      .send({});
    expect(approve.status).toBe(409);
    // The transaction rolled back — swap must NOT read approved.
    const swapAfter = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: create.body.id },
    });
    expect(swapAfter.status).toBe('PEER_ACCEPTED');
  });
});

describe('swap candidates: client scoping + PTO', () => {
  it('only same-client associates; PTO and day-off flagged busy', async () => {
    const client = await createClient();
    const otherClient = await createClient();
    const { associate: me, user } = await mkPlaced(client.id, 'Maria', 'Lopez');
    const { associate: free } = await mkPlaced(client.id, 'Fay', 'Free');
    const { associate: onPto } = await mkPlaced(client.id, 'Pat', 'Pto');
    const { associate: dayOff } = await mkPlaced(client.id, 'Dan', 'Dayoff');
    await mkPlaced(otherClient.id, 'Sam', 'Elsewhere');

    const mine = await mkShift({ clientId: client.id, assignedAssociateId: me.id });
    const day = new Date(mine.startsAt.toISOString().slice(0, 10) + 'T00:00:00Z');
    await prisma.timeOffRequest.create({
      data: {
        associateId: onPto.id,
        category: 'SICK',
        startDate: day,
        endDate: day,
        requestedMinutes: 480,
        status: 'APPROVED',
      },
    });
    await prisma.availabilityException.create({
      data: { associateId: dayOff.id, date: day },
    });

    const agent = await loginAs(user.email);
    const res = await agent.get(`/scheduling/me/shifts/${mine.id}/swap-candidates`);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.candidates.map((c: { name: string; busy: boolean }) => [c.name, c.busy]),
    );
    expect(byName['Fay Free']).toBe(false);
    expect(byName['Pat Pto']).toBe(true);
    expect(byName['Dan Dayoff']).toBe(true);
    expect(byName['Sam Elsewhere']).toBeUndefined();
    expect(byName['Maria Lopez']).toBeUndefined();
  });
});

describe('availability exceptions CRUD', () => {
  it('add, list, delete own days off', async () => {
    const client = await createClient();
    const { user } = await mkPlaced(client.id, 'Maria', 'Lopez');
    const agent = await loginAs(user.email);

    const created = await agent
      .post('/scheduling/me/availability/exceptions')
      .send({ date: '2027-01-15', note: 'Family trip' });
    expect(created.status).toBe(201);
    expect(created.body.date).toBe('2027-01-15');

    // Re-adding the same date upserts instead of erroring.
    const again = await agent
      .post('/scheduling/me/availability/exceptions')
      .send({ date: '2027-01-15' });
    expect(again.status).toBe(201);

    const list = await agent.get('/scheduling/me/availability/exceptions');
    expect(list.body.exceptions).toHaveLength(1);

    const del = await agent.delete(
      `/scheduling/me/availability/exceptions/${created.body.id}`,
    );
    expect(del.status).toBe(204);
    const after = await agent.get('/scheduling/me/availability/exceptions');
    expect(after.body.exceptions).toHaveLength(0);
  });
});

describe('double-booking guards (June audit P0s)', () => {
  it('publish-week skips a draft that would double-book its associate', async () => {
    const client = await createClient();
    const { associate: me } = await mkPlaced(client.id, 'Maria', 'Lopez');
    // Pin both drafts to next week's Tuesday so they can't straddle the
    // server's Monday-snapped week window no matter when the suite runs.
    const nextMonday = new Date();
    nextMonday.setHours(0, 0, 0, 0);
    nextMonday.setDate(nextMonday.getDate() - ((nextMonday.getDay() + 6) % 7) + 7);
    const t = (h: number) => new Date(nextMonday.getTime() + h * 3_600_000);
    const d1 = await mkShift({
      clientId: client.id,
      assignedAssociateId: me.id,
      status: 'DRAFT',
      publishedAt: null,
      startsAt: t(33), // Tue 09:00
      endsAt: t(41),
    });
    const d2 = await mkShift({
      clientId: client.id,
      assignedAssociateId: me.id,
      status: 'DRAFT',
      publishedAt: null,
      startsAt: t(37),
      endsAt: t(45),
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent
      .post('/scheduling/publish-week')
      .send({ weekStart: t(33).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.published).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toBe('double_booking');

    const statuses = await prisma.shift.findMany({
      where: { id: { in: [d1.id, d2.id] } },
      select: { status: true },
    });
    expect(statuses.filter((s) => s.status === 'ASSIGNED')).toHaveLength(1);
    expect(statuses.filter((s) => s.status === 'DRAFT')).toHaveLength(1);
  });

  it('PATCH rejects a time change that overlaps another of the assignee’s shifts', async () => {
    const client = await createClient();
    const { associate: me } = await mkPlaced(client.id, 'Maria', 'Lopez');
    await mkShift({ clientId: client.id, assignedAssociateId: me.id });
    const second = await mkShift({
      clientId: client.id,
      assignedAssociateId: me.id,
      startsAt: hoursFromNow(48),
      endsAt: hoursFromNow(56),
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent.patch(`/scheduling/shifts/${second.id}`).send({
      startsAt: hoursFromNow(25).toISOString(),
      endsAt: hoursFromNow(31).toISOString(),
    });
    expect(res.status).toBe(409);
  });
});

describe('declared unavailability blocks assignment', () => {
  it('/assign 409s on a day off; explicit override assigns and is audited', async () => {
    const client = await createClient();
    const { associate: me } = await mkPlaced(client.id, 'Maria', 'Lopez');
    const open = await mkShift({
      clientId: client.id,
      status: 'OPEN',
      assignedAssociateId: null,
    });
    const day = new Date(open.startsAt.toISOString().slice(0, 10) + 'T00:00:00Z');
    await prisma.availabilityException.create({
      data: { associateId: me.id, date: day, note: 'Family trip' },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    // Conflicts pre-check surfaces the day off to the dialog.
    const check = await hrAgent.get(
      `/scheduling/shifts/${open.id}/conflicts?associateId=${me.id}`,
    );
    expect(check.status).toBe(200);
    expect(check.body.unavailableDays).toHaveLength(1);
    expect(check.body.unavailableDays[0].note).toBe('Family trip');

    // Plain assign is blocked.
    const blocked = await hrAgent
      .post(`/scheduling/shifts/${open.id}/assign`)
      .send({ associateId: me.id });
    expect(blocked.status).toBe(409);

    const stillOpen = await prisma.shift.findUniqueOrThrow({ where: { id: open.id } });
    expect(stillOpen.assignedAssociateId).toBeNull();

    // Explicit override goes through.
    const forced = await hrAgent
      .post(`/scheduling/shifts/${open.id}/assign`)
      .send({ associateId: me.id, overrideUnavailability: true });
    expect(forced.status).toBe(200);
    expect(forced.body.assignedAssociateId).toBe(me.id);
  });

  it('approved time off blocks /assign the same way', async () => {
    const client = await createClient();
    const { associate: me } = await mkPlaced(client.id, 'Maria', 'Lopez');
    const open = await mkShift({
      clientId: client.id,
      status: 'OPEN',
      assignedAssociateId: null,
    });
    const day = new Date(open.startsAt.toISOString().slice(0, 10) + 'T00:00:00Z');
    await prisma.timeOffRequest.create({
      data: {
        associateId: me.id,
        category: 'VACATION',
        startDate: day,
        endDate: day,
        requestedMinutes: 480,
        status: 'APPROVED',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const blocked = await hrAgent
      .post(`/scheduling/shifts/${open.id}/assign`)
      .send({ associateId: me.id });
    expect(blocked.status).toBe(409);
  });

  it('bulk multi-assign skips unavailable associates with day_unavailable', async () => {
    const client = await createClient();
    const { associate: free } = await mkPlaced(client.id, 'Fay', 'Free');
    const { associate: off } = await mkPlaced(client.id, 'Dan', 'Dayoff');
    const startsAt = hoursFromNow(24);
    const day = new Date(startsAt.toISOString().slice(0, 10) + 'T00:00:00Z');
    await prisma.availabilityException.create({
      data: { associateId: off.id, date: day },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent.post('/scheduling/shifts/bulk').send({
      clientId: client.id,
      position: 'Server',
      startsAt: startsAt.toISOString(),
      endsAt: hoursFromNow(32).toISOString(),
      associateIds: [free.id, off.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0]).toMatchObject({
      associateId: off.id,
      reason: 'day_unavailable',
    });

    const created = await prisma.shift.findMany({
      where: { clientId: client.id, position: 'Server' },
      select: { assignedAssociateId: true },
    });
    expect(created.map((s) => s.assignedAssociateId)).toEqual([free.id]);
  });

  it('swap approval 409s when the counterparty declared the day off after accepting', async () => {
    const client = await createClient();
    const { associate: req, user: reqUser } = await mkPlaced(client.id, 'Req', 'A');
    const { associate: cpt, user: cptUser } = await mkPlaced(client.id, 'Cpt', 'B');
    const mine = await mkShift({ clientId: client.id, assignedAssociateId: req.id });

    const reqAgent = await loginAs(reqUser.email);
    const create = await reqAgent.post('/scheduling/swap-requests').send({
      shiftId: mine.id,
      counterpartyAssociateId: cpt.id,
    });
    const cptAgent = await loginAs(cptUser.email);
    await cptAgent.post(`/scheduling/swap-requests/${create.body.id}/peer-accept`).send({});

    // Counterparty declares the day off between accepting and HR approval.
    const day = new Date(mine.startsAt.toISOString().slice(0, 10) + 'T00:00:00Z');
    await prisma.availabilityException.create({
      data: { associateId: cpt.id, date: day },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const approve = await hrAgent
      .post(`/scheduling/swap-requests/${create.body.id}/manager-approve`)
      .send({});
    expect(approve.status).toBe(409);
    const shiftAfter = await prisma.shift.findUniqueOrThrow({ where: { id: mine.id } });
    expect(shiftAfter.assignedAssociateId).toBe(req.id);
  });
});

describe('shift reminder sweep', () => {
  it('reminds each next-24h shift exactly once', async () => {
    const client = await createClient();
    const { associate: me } = await mkPlaced(client.id, 'Maria', 'Lopez');
    const soon = await mkShift({
      clientId: client.id,
      assignedAssociateId: me.id,
      startsAt: hoursFromNow(5),
      endsAt: hoursFromNow(13),
    });
    // Outside the window — untouched.
    const far = await mkShift({
      clientId: client.id,
      assignedAssociateId: me.id,
      startsAt: hoursFromNow(40),
      endsAt: hoursFromNow(48),
    });

    const first = await runShiftReminderSweep(prisma);
    expect(first.reminded).toBe(1);
    expect(first.errors).toHaveLength(0);

    const soonAfter = await prisma.shift.findUniqueOrThrow({ where: { id: soon.id } });
    expect(soonAfter.reminderSentAt).not.toBeNull();
    const farAfter = await prisma.shift.findUniqueOrThrow({ where: { id: far.id } });
    expect(farAfter.reminderSentAt).toBeNull();

    const bell = await prisma.notification.findFirst({
      where: { channel: 'IN_APP', category: 'shift_reminder' },
    });
    expect(bell).not.toBeNull();
    expect(bell!.body).toContain('Server');

    // Second sweep: nothing new.
    const second = await runShiftReminderSweep(prisma);
    expect(second.reminded).toBe(0);
  });
});
