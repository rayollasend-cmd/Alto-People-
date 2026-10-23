import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createStandardTemplate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * F500 G1 — the onboarding desk's numbers (2026-10-22): who owns each
 * application, "Starting in 7 days", the "Email bounced" list behind its
 * tile, a template's "In use", and the analytics median's sample. Each is
 * seeded with known rows and asserted exactly.
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
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

async function appFor(clientId: string, data: { startDate?: string; status?: 'DRAFT' | 'SUBMITTED' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; email?: string } = {}) {
  const associate = await createAssociate({ email: data.email });
  const row = (await createApplicationWithChecklist({ associateId: associate.id, clientId })) as { id: string };
  await prisma.application.update({
    where: { id: row.id },
    data: {
      ...(data.startDate ? { startDate: new Date(`${data.startDate}T00:00:00.000Z`) } : {}),
      ...(data.status ? { status: data.status } : {}),
    },
  });
  return { id: row.id, associateId: associate.id, email: associate.email };
}

const ids = (body: { applications: Array<{ id: string }> }) => body.applications.map((a) => a.id).sort();

describe('onboarding desk — owner', () => {
  it('names the person who sent the invite on the row and the record; an unrecorded one reads null', async () => {
    const client = await createClient();
    const template = await createStandardTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: hr.id }, data: { displayName: 'Ana Recruiter' } });
    const a = await loginAs(hr.email);

    const created = await a.post('/onboarding/applications').send({
      associateEmail: 'owned.hire@example.com',
      associateFirstName: 'Owned',
      associateLastName: 'Hire',
      clientId: client.id,
      templateId: template.id,
    });
    expect(created.status).toBe(201);
    await flushPendingAudits();
    const seeded = await appFor(client.id);

    const list = await a.get('/onboarding/applications?status=ALL');
    expect(list.status).toBe(200);
    const byId = new Map(list.body.applications.map((x: { id: string; ownerName: string | null }) => [x.id, x.ownerName]));
    expect(byId.get(created.body.id)).toBe('Ana Recruiter');
    expect(byId.get(seeded.id)).toBeNull();

    const detail = await a.get(`/onboarding/applications/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.ownerName).toBe('Ana Recruiter');
    // Nothing done yet: the last movement is the invite.
    expect(detail.body.lastActivityAt).toBe(detail.body.invitedAt);
    expect(detail.body.stuck).toBe(false);
  });
});

describe('onboarding desk — starting in 7 days', () => {
  it('counts the seven days from the caller\'s today, not called-off ones, and lists the same rows', async () => {
    const client = await createClient();
    const draftToday = await appFor(client.id, { startDate: '2026-07-01' });
    const approvedDay7 = await appFor(client.id, { startDate: '2026-07-07', status: 'APPROVED' });
    await appFor(client.id, { startDate: '2026-07-08' }); // day 8: out
    await appFor(client.id, { startDate: '2026-06-30' }); // yesterday: out
    await appFor(client.id, { startDate: '2026-07-03', status: 'CANCELLED' }); // called off: out
    await appFor(client.id); // no start date: out
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const stats = await a.get('/onboarding/applications/stats?today=2026-07-01');
    expect(stats.status).toBe(200);
    expect(stats.body.startingSoon).toBe(2);
    // Only the draft still has its checklist to finish.
    expect(stats.body.startingSoonUnfinished).toBe(1);

    const list = await a.get('/onboarding/applications?status=STARTING_SOON&today=2026-07-01');
    expect(list.status).toBe(200);
    expect(ids(list.body)).toEqual([draftToday.id, approvedDay7.id].sort());
    expect(list.body.total).toBe(2);

    // A different caller's day moves the window.
    const later = await a.get('/onboarding/applications/stats?today=2026-07-02');
    expect(later.body.startingSoon).toBe(2); // Jul 7 + Jul 8
  });
});

describe('onboarding desk — the "Email bounced" list', () => {
  it('lists exactly the in-flight applications whose latest invite or nudge failed', async () => {
    const client = await createClient();
    const bounced = await appFor(client.id);
    const delivered = await appFor(client.id);
    const decided = await appFor(client.id, { status: 'APPROVED' });
    for (const [row, status] of [
      [bounced, 'FAILED'],
      [delivered, 'SENT'],
      [decided, 'FAILED'],
    ] as const) {
      const { user } = await createUser({ role: 'ASSOCIATE', email: row.email, associateId: row.associateId });
      await prisma.notification.create({
        data: { channel: 'EMAIL', status, recipientUserId: user.id, body: 'Invite', category: 'onboarding.invite', failureReason: status === 'FAILED' ? 'Mailbox does not exist' : null },
      });
    }
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const stats = await a.get('/onboarding/applications/stats');
    expect(stats.body.bounced).toBe(1);
    const list = await a.get('/onboarding/applications?status=BOUNCED');
    expect(list.status).toBe(200);
    expect(ids(list.body)).toEqual([bounced.id]);
  });
});

describe('onboarding desk — a bounded account cannot widen its reach with ?clientId=', () => {
  it('a shift supervisor at client A asking for client B gets nothing', async () => {
    const clientA = await createClient('Client A');
    const clientB = await createClient('Client B');
    const mine = await appFor(clientA.id);
    await appFor(clientB.id);
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: clientA.id });
    const a = await loginAs(sup.email);

    const own = await a.get('/onboarding/applications?status=ALL');
    expect(own.status).toBe(200);
    expect(ids(own.body)).toEqual([mine.id]);
    const other = await a.get(`/onboarding/applications?status=ALL&clientId=${clientB.id}`);
    expect(other.status).toBe(200);
    expect(other.body.total).toBe(0);
  });
});

describe('onboarding desk — templates "In use"', () => {
  it('counts in-flight applications on the template\'s client and track; a global one counts the rest of the track', async () => {
    const clientA = await createClient('Client A');
    const clientB = await createClient('Client B');
    const global = await createStandardTemplate(null);
    const own = await createStandardTemplate(clientA.id);
    await appFor(clientA.id);
    await appFor(clientA.id, { status: 'SUBMITTED' });
    await appFor(clientA.id, { status: 'APPROVED' }); // decided: not in use
    await appFor(clientB.id);
    await appFor(clientB.id, { status: 'CANCELLED' }); // called off: not in use
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.get('/onboarding/templates');
    expect(res.status).toBe(200);
    const byId = new Map(res.body.templates.map((t: { id: string; inUse: number; updatedAt: string }) => [t.id, t]));
    expect((byId.get(own.id) as { inUse: number }).inUse).toBe(2);
    expect((byId.get(global.id) as { inUse: number }).inUse).toBe(1);
    expect(typeof (byId.get(global.id) as { updatedAt: string }).updatedAt).toBe('string');
  });
});

describe('onboarding analytics — the median\'s sample', () => {
  it('says how many finished per track and per client', async () => {
    const client = await createClient('Sample Co');
    const now = Date.now();
    const finished = await appFor(client.id);
    await prisma.application.update({
      where: { id: finished.id },
      data: { invitedAt: new Date(now - 3 * 86_400_000), submittedAt: new Date(now - 86_400_000), status: 'SUBMITTED' },
    });
    await appFor(client.id); // invited, not finished
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.get('/analytics/onboarding');
    expect(res.status).toBe(200);
    const track = res.body.byTrack.find((t: { track: string }) => t.track === 'STANDARD');
    expect(track).toMatchObject({ count: 2, completed: 1 });
    const row = res.body.byClient.find((c: { clientId: string }) => c.clientId === client.id);
    expect(row).toMatchObject({ count: 2, completed: 1 });
  });
});
