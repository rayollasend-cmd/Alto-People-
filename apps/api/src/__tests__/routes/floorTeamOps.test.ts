import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * Repeating 1:1s (the next is booked on completion, open action items
 * carry), the shared agenda, a manager booking with their own report, the
 * review composer's record, the ops board's never-closed shifts, the
 * floor's activity feed, and "open" meaning OPEN and not over yet.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;

describe('repeating 1:1s', () => {
  it('completing one books the next a cadence later and carries the open action items; completing twice books once', async () => {
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), hrUser.email);
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const when = new Date(Date.now() + 2 * DAY);
    const created = await hr.post('/performance/one-on-ones').send({ associateId: ana.id, managerUserId: hrUser.id, scheduledFor: when.toISOString(), cadence: 'WEEKLY' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await hr.post(`/performance/one-on-ones/${id}/action-items`).send({ text: 'Send the new rota' })).status).toBe(201);
    const done = await hr.post(`/performance/one-on-ones/${id}/action-items`).send({ text: 'Book first aid course' });
    expect((await hr.patch(`/performance/one-on-one-action-items/${done.body.item.id}`).send({ done: true })).body.item.doneAt).not.toBeNull();

    const complete = await hr.put(`/performance/one-on-ones/${id}`).send({ status: 'COMPLETED' });
    expect(complete.status).toBe(200);
    expect(complete.body.nextId).toBeTruthy();
    const next = await prisma.oneOnOne.findUniqueOrThrow({ where: { id: complete.body.nextId }, include: { actionItems: true } });
    expect(next).toMatchObject({ seriesId: id, cadence: 'WEEKLY', status: 'SCHEDULED' });
    expect(next.scheduledFor.getTime()).toBe(when.getTime() + 7 * DAY);
    expect(next.actionItems.map((a) => a.text)).toEqual(['Send the new rota']);
    expect(next.actionItems[0]!.carriedFromId).not.toBeNull();

    // Completing it again is not a second completion: no second meeting.
    await hr.put(`/performance/one-on-ones/${id}`).send({ status: 'COMPLETED' });
    expect(await prisma.oneOnOne.count({ where: { seriesId: id } })).toBe(2);

    const list = await hr.get('/performance/one-on-ones').query({ associateId: ana.id });
    expect(list.body.meetings.find((m: { id: string }) => m.id === next.id)).toMatchObject({ cadence: 'WEEKLY', actionItems: [expect.objectContaining({ text: 'Send the new rota', carried: true })] });
  });

  it('the person met with sees their 1:1 and edits the shared agenda — nobody else’s', async () => {
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), hrUser.email);
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const bea = await createAssociate({ firstName: 'Bea', lastName: 'Lopez' });
    const mine = await hr.post('/performance/one-on-ones').send({ associateId: ana.id, managerUserId: hrUser.id, scheduledFor: new Date(Date.now() + DAY).toISOString() });
    const hers = await hr.post('/performance/one-on-ones').send({ associateId: bea.id, managerUserId: hrUser.id, scheduledFor: new Date(Date.now() + DAY).toISOString() });
    const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const a = await loginAs(agent(), anaUser.email);
    const got = await a.get('/performance/one-on-ones/mine');
    expect(got.status).toBe(200);
    expect(got.body.meetings.map((m: { id: string }) => m.id)).toEqual([mine.body.id]);
    expect(got.body.meetings[0]).not.toHaveProperty('managerNotes');
    expect((await a.put(`/performance/one-on-ones/${mine.body.id}/agenda`).send({ agenda: 'My schedule in November' })).status).toBe(200);
    expect((await prisma.oneOnOne.findUniqueOrThrow({ where: { id: mine.body.id } })).agenda).toBe('My schedule in November');
    expect((await a.put(`/performance/one-on-ones/${hers.body.id}/agenda`).send({ agenda: 'x' })).status).toBe(404);
  });
});

describe('a manager’s team', () => {
  it('books a 1:1 with their own report only, and the team list shows the rhythm', async () => {
    const boss = await createAssociate({ firstName: 'Mia', lastName: 'Boss' });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const other = await createAssociate({ firstName: 'Zed', lastName: 'Else' });
    await prisma.associate.update({ where: { id: ana.id }, data: { managerId: boss.id } });
    const { user: mgr } = await createUser({ role: 'MANAGER', associateId: boss.id });
    const m = await loginAs(agent(), mgr.email);
    const when = new Date(Date.now() + 3 * DAY).toISOString();
    const ok = await m.post(`/team/reports/${ana.id}/one-on-ones`).send({ scheduledFor: when, cadence: 'BIWEEKLY' });
    expect(ok.status).toBe(201);
    expect((await m.post(`/team/reports/${other.id}/one-on-ones`).send({ scheduledFor: when })).status).toBe(403);
    await prisma.oneOnOne.create({ data: { associateId: ana.id, managerUserId: mgr.id, scheduledFor: new Date(Date.now() - 12 * DAY), status: 'COMPLETED', completedAt: new Date(Date.now() - 12 * DAY) } });
    const list = await m.get('/team/reports');
    const row = list.body.reports.find((r: { id: string }) => r.id === ana.id);
    expect(row.nextOneOnOne).toMatchObject({ id: ok.body.id, cadence: 'BIWEEKLY' });
    expect(Date.now() - Date.parse(row.lastOneOnOneAt)).toBeGreaterThan(11 * DAY);
  });
});

describe('the review composer’s record', () => {
  it('reads goals, kudos, 1:1s, unexcused attendance and the last review for the period', async () => {
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), hrUser.email);
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    await prisma.attendanceEvent.createMany({
      data: [
        { associateId: ana.id, kind: 'LATE', points: 0.5, occurredOn: new Date('2026-08-03') },
        { associateId: ana.id, kind: 'NO_CALL_NO_SHOW', points: 3, occurredOn: new Date('2026-08-10') },
        { associateId: ana.id, kind: 'LATE', points: 0.5, occurredOn: new Date('2026-08-12'), excusedAt: new Date() },
        { associateId: ana.id, kind: 'LATE', points: 0.5, occurredOn: new Date('2026-02-01') },
      ],
    });
    await prisma.kudo.create({ data: { fromUserId: hrUser.id, toAssociateId: ana.id, message: 'Covered three shifts', createdAt: new Date('2026-08-05T12:00:00Z') } });
    const res = await hr.get('/performance/review-context').query({ associateId: ana.id, from: '2026-07-01', to: '2026-09-30' });
    expect(res.status).toBe(200);
    expect(res.body.attendance).toEqual({ late: 1, noCallNoShow: 1, callOut: 0, earlyOut: 0 });
    expect(res.body.kudos.map((k: { message: string }) => k.message)).toEqual(['Covered three shifts']);
    expect(res.body.lastReview).toBeNull();
    expect((await hr.get('/performance/review-context').query({ associateId: ana.id, from: 'July' })).status).toBe(400);
  });
});

describe('the ops board', () => {
  it('moves a shift left running past its end out of live and lets oversight close it out', async () => {
    const client = await createClient('Coastal Resort');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), hrUser.email);
    const base = { clientId: client.id, locationId: site.id, department: 'Housekeeping', departments: ['Housekeeping'], period: 'MORNING' as const, position: 'HK Morning', status: 'ACTIVE' as const, openedById: hrUser.id, scheduledHeadcount: 4, actualHeadcount: 4 };
    const stale = await prisma.opsShift.create({ data: { ...base, dateKey: '2026-09-18', openedAt: new Date(Date.now() - 33 * DAY), dueAt: new Date(Date.now() - 33 * DAY + 8 * 3_600_000) } });
    const live = await prisma.opsShift.create({ data: { ...base, period: 'EVENING', dateKey: new Date().toISOString().slice(0, 10), openedAt: new Date(Date.now() - 3_600_000), dueAt: new Date(Date.now() + 4 * 3_600_000) } });

    const board = await hr.get('/ops/board');
    expect(board.status).toBe(200);
    expect(board.body.active.map((s: { id: string }) => s.id)).toEqual([live.id]);
    expect(board.body.neverClosed.map((s: { id: string }) => s.id)).toEqual([stale.id]);

    expect((await hr.post(`/ops/shifts/${live.id}/close-out`).send({})).status).toBe(409);
    const closed = await hr.post(`/ops/shifts/${stale.id}/close-out`).send({ reason: 'Supervisor forgot to submit' });
    expect(closed.status).toBe(200);
    const after = await prisma.opsShift.findUniqueOrThrow({ where: { id: stale.id } });
    expect(after).toMatchObject({ status: 'CLOSED', closedById: hrUser.id });
    expect(after.closingSummary).toMatch(/Never closed — closed out from the board: Supervisor forgot to submit/);
    expect((await hr.post(`/ops/shifts/${stale.id}/close-out`).send({})).status).toBe(409);
  });
});

describe('the floor’s activity feed and the one meaning of "open"', () => {
  it('lists call-outs and publishes in reach, and counts an ended OPEN shift as unfilled, not open', async () => {
    const a = await createClient('Coastal Resort');
    const b = await createClient('Seaside');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const now = Date.now();
    const publishedAt = new Date(now - 3_600_000);
    const shiftAt = (clientId: string, offsetH: number, status: 'OPEN' | 'ASSIGNED') =>
      prisma.shift.create({ data: { clientId, position: 'Housekeeper', startsAt: new Date(now + offsetH * 3_600_000), endsAt: new Date(now + (offsetH + 6) * 3_600_000), status, publishedAt } });
    const past = await shiftAt(a.id, -10, 'OPEN');
    await shiftAt(a.id, 20, 'OPEN');
    const other = await shiftAt(b.id, 20, 'OPEN');
    await prisma.callOut.create({ data: { shiftId: past.id, associateId: ana.id, clientId: a.id, channel: 'SMS', minutesBeforeStart: 60 } });
    await prisma.callOut.create({ data: { shiftId: other.id, associateId: ana.id, clientId: b.id, channel: 'SMS', minutesBeforeStart: 60 } });

    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), hrUser.email);
    const feed = await hr.get('/ops-activity');
    expect(feed.status).toBe(200);
    expect(feed.body.items.filter((i: { kind: string }) => i.kind === 'call_out')).toHaveLength(2);
    // One publish row per store and day, the store named in the title (F500 G5).
    const published = feed.body.items.filter((i: { kind: string }) => i.kind === 'published');
    expect(published.map((i: { title: string }) => i.title).sort()).toEqual(['1 shift published · Seaside', '2 shifts published · Coastal Resort']);

    // A supervisor bound to Coastal sees Coastal's floor only.
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: a.id });
    const s = await loginAs(agent(), sup.email);
    const theirs = await s.get('/ops-activity');
    expect(theirs.status).toBe(200);
    expect(theirs.body.items.filter((i: { kind: string }) => i.kind === 'call_out')).toHaveLength(1);
    expect(JSON.stringify(theirs.body)).not.toMatch(/Seaside/);

    const kpis = await hr.get('/scheduling/kpis').query({ clientId: a.id, from: new Date(now - DAY).toISOString(), to: new Date(now + 2 * DAY).toISOString() });
    expect(kpis.body).toMatchObject({ openShifts: 2, openUpcoming: 1, wentUnfilled: 1 });
  });
});
