import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { sweepHugoNotes } from '../../lib/hugoNotes.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { pinMidweekNoon } from '../../../test/clock.js';

/**
 * Hugo's notes (lib/hugoNotes): what it noticed in a person's own records,
 * raised on its own, each with one thing it could do. Never acting; at most
 * two on the lock screen a day, none at night; every kind can be turned off;
 * a dismissed note stays dismissed.
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

const sweep = (at: Date = new Date()) => runWithTenant(ALTO_TENANT_ID, 'job', () => sweepHugoNotes(at));

async function store() {
  const client = await createClient('Walmart 1234');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const place = async (firstName: string, lastName: string) => {
    const a = await createAssociate({ firstName, lastName });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date(Date.now() - 30 * D) } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    return { associate: a, user };
  };
  const ana = await place('Ana', 'Lopez');
  const ben = await place('Ben', 'Moss');
  const dana = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
  const { user: supervisor } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: dana.id });
  await prisma.user.update({ where: { id: supervisor.id }, data: { lastSeenAt: new Date() } });
  const shift = (associateId: string | null, startsAt: Date) =>
    prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt, endsAt: new Date(startsAt.getTime() + 8 * H), status: associateId ? 'ASSIGNED' : 'OPEN', assignedAssociateId: associateId, publishedAt: new Date() },
    });
  return { client, site, ana, ben, supervisor, shift };
}

const notesOf = (userId: string) => prisma.hugoNote.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
const hugoBell = (userId: string) => prisma.notification.findMany({ where: { recipientUserId: userId, channel: 'IN_APP', category: 'hugo_note' } });

describe('an open shift that fits', () => {
  it('is raised once, pushed once in daytime hours, kept current, and expires when it is gone', async () => {
    const now = pinMidweekNoon();
    const s = await store();
    const open = await s.shift(null, new Date(now.getTime() + 2 * D));

    // Ana and Ben both fit it: one note and one push each.
    expect(await sweep(now)).toMatchObject({ created: 2, pushed: 2 });
    await flushPendingNotifications();
    const [note] = await notesOf(s.ana.user.id);
    expect(note).toMatchObject({ kind: 'OPEN_SHIFT_MATCH', subjectKey: open.id, status: 'NEW' });
    expect(note!.pushedAt).not.toBeNull();
    const bell = await hugoBell(s.ana.user.id);
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ subject: 'An open shift fits your availability', linkUrl: `/marketplace?shift=${open.id}` });
    expect(bell[0]!.body).toContain('no need to answer');
    expect(bell[0]!.body).toMatch(/AI agent/);

    // The next look changes nothing: one note, one push.
    await sweep(new Date(now.getTime() + H));
    await flushPendingNotifications();
    expect(await notesOf(s.ana.user.id)).toHaveLength(1);
    expect(await hugoBell(s.ana.user.id)).toHaveLength(1);

    // Someone takes it: the note goes.
    await prisma.shift.update({ where: { id: open.id }, data: { status: 'ASSIGNED', assignedAssociateId: s.ben.associate.id } });
    await sweep(new Date(now.getTime() + 2 * H));
    expect((await notesOf(s.ana.user.id))[0]!.status).toBe('EXPIRED');
  });

  it('a dismissed note stays dismissed, and the next shift that fits is a new note', async () => {
    const now = pinMidweekNoon();
    const s = await store();
    const first = await s.shift(null, new Date(now.getTime() + 2 * D));
    await sweep(now);
    const ana = await loginAs(s.ana.user.email);
    const listed = (await ana.get('/hugo/notes')).body.notes;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ kind: 'OPEN_SHIFT_MATCH', action: { kind: 'link', url: `/marketplace?shift=${first.id}` } });
    expect(listed[0].data.shift).toMatchObject({ id: first.id, site: 'Walmart 1234' });
    expect((await ana.post(`/hugo/notes/${listed[0].id}/dismiss`).send({})).body.note.status).toBe('DISMISSED');
    expect((await ana.post(`/hugo/notes/${listed[0].id}/dismiss`).send({})).status).toBe(409);

    const second = await s.shift(null, new Date(now.getTime() + 3 * D));
    await sweep(new Date(now.getTime() + H));
    const notes = await notesOf(s.ana.user.id);
    expect(notes.map((n) => [n.subjectKey, n.status])).toEqual([
      [first.id, 'DISMISSED'],
      [second.id, 'NEW'],
    ]);
  });

  it('never pushes at night, and never more than twice a day', async () => {
    const noon = pinMidweekNoon();
    const s = await store();
    await s.shift(null, new Date(noon.getTime() + 2 * D));
    // 2 AM Eastern: raised, not pushed.
    const night = new Date(noon.getTime() - 10 * H);
    vi.setSystemTime(night);
    expect(await sweep(night)).toMatchObject({ created: 2, pushed: 0 });
    // Ana already had two pushes today; Ben had none.
    await prisma.hugoNote.createMany({
      data: [1, 2].map((i) => ({ userId: s.ana.user.id, kind: 'CREDENTIAL_EXPIRING', subjectKey: `x${i}`, status: 'SEEN', pushedAt: new Date(noon.getTime() - i * H), expiresAt: new Date(noon.getTime() + D) })),
    });
    vi.setSystemTime(noon);
    expect(await sweep(noon)).toMatchObject({ pushed: 1 });
    await flushPendingNotifications();
    expect(await hugoBell(s.ana.user.id)).toHaveLength(0);
    expect(await hugoBell(s.ben.user.id)).toHaveLength(1);
  });

  it('turned off, it clears and stays off', async () => {
    const now = pinMidweekNoon();
    const s = await store();
    await s.shift(null, new Date(now.getTime() + 2 * D));
    await sweep(now);
    const ana = await loginAs(s.ana.user.email);
    const settings = (await ana.get('/hugo/notes/settings')).body;
    expect(settings.kinds.map((k: { kind: string }) => k.kind)).toEqual(['CREDENTIAL_EXPIRING', 'OPEN_SHIFT_MATCH', 'DIRECT_DEPOSIT_MISSING']);
    const off = await ana.put('/hugo/notes/settings').send({ kind: 'OPEN_SHIFT_MATCH', on: false });
    expect(off.body.kinds.find((k: { kind: string }) => k.kind === 'OPEN_SHIFT_MATCH').on).toBe(false);
    expect((await ana.get('/hugo/notes')).body.notes).toEqual([]);
    await s.shift(null, new Date(now.getTime() + 3 * D));
    await sweep(new Date(now.getTime() + H));
    expect((await notesOf(s.ana.user.id)).filter((n) => n.status === 'NEW')).toHaveLength(0);
    // A desk's kind isn't an associate's to set.
    expect((await ana.put('/hugo/notes/settings').send({ kind: 'UNCONFIRMED_TOMORROW', on: false })).status).toBe(400);
  });
});

describe('a desk with unconfirmed shifts tomorrow', () => {
  it('is told after noon; accepting starts the chase — the person\'s tap', async () => {
    const now = pinMidweekNoon();
    const s = await store();
    await s.shift(s.ana.associate.id, new Date(now.getTime() + D));
    await s.shift(s.ben.associate.id, new Date(now.getTime() + D + H));
    await sweep(now);
    const sup = await loginAs(s.supervisor.email);
    const [note] = (await sup.get('/hugo/notes')).body.notes;
    expect(note).toMatchObject({ kind: 'UNCONFIRMED_TOMORROW', data: { unconfirmed: { count: 2, total: 2 } }, action: { kind: 'task', task: { kind: 'CHASE_CONFIRMATIONS' } } });
    // In the panel only: no lock-screen push for a desk's note.
    expect(await hugoBell(s.supervisor.id)).toHaveLength(0);

    const accepted = await sup.post(`/hugo/notes/${note.id}/accept`).send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.note.status).toBe('ACCEPTED');
    expect(accepted.body.task).toMatchObject({ kind: 'CHASE_CONFIRMATIONS', source: 'note', progress: { total: 2 } });
    expect((await prisma.hugoTask.findUniqueOrThrow({ where: { id: accepted.body.task.id } })).noteId).toBe(note.id);

    // Someone else's note is not theirs to accept.
    const ana = await loginAs(s.ana.user.email);
    expect((await ana.post(`/hugo/notes/${note.id}/accept`).send({})).status).toBe(404);
  });
});

describe('a credential running out', () => {
  it('waits in the panel (the compliance agent does the chasing)', async () => {
    const now = pinMidweekNoon();
    const s = await store();
    const doc = await prisma.documentRecord.create({ data: { associateId: s.ana.associate.id, kind: 'ID', filename: 'license.jpg', mimeType: 'image/jpeg', size: 10, status: 'VERIFIED', expiresAt: new Date(now.getTime() + 10 * D) } });
    await sweep(now);
    const note = (await notesOf(s.ana.user.id)).find((n) => n.kind === 'CREDENTIAL_EXPIRING');
    expect(note).toBeDefined();
    expect(note!.pushedAt).toBeNull();
    const ana = await loginAs(s.ana.user.email);
    const listed = (await ana.get('/hugo/notes')).body.notes.find((n: { kind: string }) => n.kind === 'CREDENTIAL_EXPIRING');
    expect(listed.data.credential).toMatchObject({ word: 'ID', days: 10, url: `/documents?renew=${doc.id}` });
    expect(listed.action).toEqual({ kind: 'link', url: `/documents?renew=${doc.id}` });
  });
});

describe('direct deposit before a first payday', () => {
  it('is raised and pushed once when the payday is a week out and no account is on file', async () => {
    const now = pinMidweekNoon();
    const s = await store();
    const weekly = await prisma.payrollSchedule.create({ data: { name: 'Company weekly', frequency: 'WEEKLY', anchorDate: new Date('2026-01-03'), isDefault: true } });
    for (const p of [s.ana, s.ben]) {
      await prisma.payrollScheduleAssignment.create({ data: { associateId: p.associate.id, scheduleId: weekly.id, effectiveFrom: new Date('2026-01-01'), source: 'DEFAULT' } });
    }
    // Ben set his up; Ana didn't.
    await prisma.payoutMethod.create({ data: { associateId: s.ben.associate.id, type: 'BRANCH_CARD', branchCardId: 'card-1', isPrimary: true } });
    await sweep(now);
    await flushPendingNotifications();
    const ana = (await notesOf(s.ana.user.id)).find((n) => n.kind === 'DIRECT_DEPOSIT_MISSING');
    expect(ana).toMatchObject({ subjectKey: 'first-paycheck' });
    expect(ana!.pushedAt).not.toBeNull();
    expect((await notesOf(s.ben.user.id)).filter((n) => n.kind === 'DIRECT_DEPOSIT_MISSING')).toHaveLength(0);
    const bell = (await hugoBell(s.ana.user.id)).find((n) => n.subject === 'Add direct deposit before payday');
    expect(bell?.linkUrl).toBe('/payroll#payout-method');
  });
});

describe('the badge', () => {
  it('counts new notes and stops once they are seen', async () => {
    const now = pinMidweekNoon();
    const s = await store();
    await s.shift(null, new Date(now.getTime() + 2 * D));
    await sweep(now);
    const ana = await loginAs(s.ana.user.email);
    expect((await ana.get('/hugo/summary')).body.newNotes).toBe(1);
    const [note] = (await ana.get('/hugo/notes')).body.notes;
    expect((await ana.post('/hugo/seen').send({ notes: [note.id] })).body.notes).toBe(1);
    expect((await ana.get('/hugo/summary')).body.newNotes).toBe(0);
  });
});
