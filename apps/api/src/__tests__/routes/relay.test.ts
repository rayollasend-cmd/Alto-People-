import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { runRelayEscalationSweep } from '../../lib/relayEscalation.js';
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
 * THE RELAY: the shared board (lanes + batons + agenda), the escalation
 * sweep with teeth, and threads on the work with desk @mentions.
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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe('GET /relay/board', () => {
  it('is a staff read — associates never see it', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const res = await (await loginAs(user.email)).get('/relay/board');
    expect(res.status).toBe(403);
  });

  it('runs a first-paycheck lane from approval to a kept promise', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    const a1 = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await prisma.application.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'APPROVED',
        approvedAt: new Date(now.getTime() - 10 * DAY),
      },
    });

    const { user } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const agent = await loginAs(user.email);

    // Fresh approval, nothing else: the lane waits on the WORKFORCE desk
    // at "scheduled" — and 10 days past a 5-day due date it is STALLED.
    const early = await agent.get('/relay/board');
    expect(early.status).toBe(200);
    const lane0 = early.body.lanes.find(
      (l: { associateId: string }) => l.associateId === a1.id,
    );
    expect(lane0).toBeDefined();
    expect(lane0.currentStage).toBe('scheduled');
    expect(lane0.stalled).toBe(true);
    expect(
      lane0.stages.find((s: { key: string }) => s.key === 'scheduled').desk,
    ).toBe('WORKFORCE');

    // Run the whole relay: shift, registration, worked + approved hours,
    // and a disbursed paystub.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: a1.id,
        position: 'Stocker',
        startsAt: new Date(now.getTime() - 8 * DAY),
        endsAt: new Date(now.getTime() - 8 * DAY + 8 * HOUR),
        status: 'COMPLETED',
        publishedAt: now,
      },
    });
    await prisma.fieldglassRegistration.create({
      data: { associateId: a1.id, clientId: client.id },
    });
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 8 * DAY),
        clockOutAt: new Date(now.getTime() - 8 * DAY + 8 * HOUR),
        status: 'APPROVED',
      },
    });
    const run = await prisma.payrollRun.create({
      data: {
        clientId: client.id,
        periodStart: new Date(now.getTime() - 9 * DAY),
        periodEnd: new Date(now.getTime() - 2 * DAY),
        status: 'DISBURSED',
        disbursedAt: new Date(now.getTime() - DAY),
      },
    });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: run.id,
        associateId: a1.id,
        hoursWorked: 8,
        hourlyRate: 15,
        grossPay: 120,
        federalWithholding: 12,
        netPay: 100,
        status: 'DISBURSED',
        disbursedAt: new Date(now.getTime() - DAY),
      },
    });

    const done = await agent.get('/relay/board');
    // The lane left the in-flight list and became a kept promise.
    expect(
      done.body.lanes.filter(
        (l: { associateId: string }) => l.associateId === a1.id,
      ),
    ).toHaveLength(0);
    expect(done.body.promise.completed).toBe(1);
    expect(done.body.promise.keptPct).toBe(100);
    expect(done.body.recentKept[0].name).toBe('Maria Lopez');
  });

  it('marks the timesheet baton overdue for prior-week hours and writes the agenda', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    const a1 = await createAssociate();
    // A completed-but-unapproved entry from ~10 days ago — a closed week.
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 10 * DAY),
        clockOutAt: new Date(now.getTime() - 10 * DAY + 8 * HOUR),
        status: 'COMPLETED',
      },
    });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const res = await (await loginAs(user.email)).get('/relay/board');
    expect(res.status).toBe(200);
    const baton = res.body.batons.find((b: { key: string }) => b.key === 'timesheets');
    expect(baton.count).toBe(1);
    expect(baton.status).toBe('overdue');
    expect(baton.desk).toBe('WORKFORCE');
    expect(
      res.body.agenda.some(
        (a: { severity: string; text: string }) =>
          a.severity === 'red' && a.text.includes('Timesheets'),
      ),
    ).toBe(true);
  });
});

describe('relay escalation sweep', () => {
  it('rings the holding desk for an overdue baton — once per org-day', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    const a1 = await createAssociate();
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 10 * DAY),
        clockOutAt: new Date(now.getTime() - 10 * DAY + 8 * HOUR),
        status: 'COMPLETED',
      },
    });
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });

    const sent = await runRelayEscalationSweep(prisma, now);
    expect(sent).toBeGreaterThanOrEqual(1);
    const rows = await prisma.notification.findMany({
      where: { category: 'relay.escalation', channel: 'IN_APP' },
      select: { recipientUserId: true, subject: true, linkUrl: true },
    });
    // The WORKFORCE desk holds the timesheet baton — Finance is not rung.
    expect(rows.some((r) => r.recipientUserId === wfm.id)).toBe(true);
    expect(rows.every((r) => r.recipientUserId !== fin.id)).toBe(true);
    expect(rows[0]!.subject).toContain('Overdue on your desk');
    expect(rows[0]!.linkUrl).toBe('/relay#timesheets');

    // Second sweep the same day: silent.
    const again = await runRelayEscalationSweep(prisma, now);
    expect(again).toBe(0);
    expect(
      await prisma.notification.count({
        where: { category: 'relay.escalation', channel: 'IN_APP' },
      }),
    ).toBe(rows.length);
  });
});

describe('threads on the work (/work-notes)', () => {
  it('posts to the record and rings the mentioned desk with a deep link', async () => {
    const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: fin2 } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const agent = await loginAs(wfm.email);

    const posted = await agent.post('/work-notes').send({
      subjectType: 'ASSOCIATE',
      subjectKey: associate.id,
      body: 'Her second week shows a missed break Tuesday — can Finance confirm before the close?',
      mentionDesks: ['FINANCE'],
    });
    expect(posted.status).toBe(201);
    await flushPendingNotifications();

    const rows = await prisma.notification.findMany({
      where: { category: 'work-thread', channel: 'IN_APP' },
      select: { recipientUserId: true, subject: true, linkUrl: true },
    });
    const recipients = rows.map((r) => r.recipientUserId).sort();
    expect(recipients).toEqual([fin.id, fin2.id].sort());
    expect(rows[0]!.subject).toContain('Maria Lopez');
    expect(rows[0]!.linkUrl).toBe(`/people?associateId=${associate.id}&tab=thread`);

    // The thread reads back in order, with the author named.
    const read = await agent.get(
      `/work-notes?subjectType=ASSOCIATE&subjectKey=${associate.id}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.notes).toHaveLength(1);
    expect(read.body.notes[0].body).toContain('missed break');
    expect(read.body.notes[0].mentions).toEqual(['FINANCE']);
  });

  it('stays staff-only and refuses threads on nothing', async () => {
    const associate = await createAssociate();
    const { user: assocUser } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const denied = await (await loginAs(assocUser.email)).get(
      `/work-notes?subjectType=ASSOCIATE&subjectKey=${associate.id}`,
    );
    expect(denied.status).toBe(403);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const ghost = await (await loginAs(hr.email)).post('/work-notes').send({
      subjectType: 'ASSOCIATE',
      subjectKey: '00000000-0000-0000-0000-000000000001',
      body: 'Note on nobody.',
      mentionDesks: [],
    });
    expect(ghost.status).toBe(404);
  });
});
