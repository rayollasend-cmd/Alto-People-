import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { signSession } from '../../lib/jwt.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

async function adminCookie(): Promise<string> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const token = signSession({
    sub: user.id,
    role: user.role,
    ver: user.tokenVersion,
  });
  return `alto.session=${token}`;
}

const HOUR = 60 * 60 * 1000;

/** A COMPLETED 8h shift for a CA associate (CA accrues 1h sick per 30h). */
async function setupCompletedShift() {
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  await prisma.associate.update({
    where: { id: associate.id },
    data: { state: 'CA' },
  });
  const clockInAt = new Date(Date.now() - 9 * HOUR);
  const clockOutAt = new Date(Date.now() - 1 * HOUR);
  const entry = await prisma.timeEntry.create({
    data: {
      associateId: associate.id,
      clientId: client.id,
      clockInAt,
      clockOutAt,
      status: 'COMPLETED',
      anomalies: [],
    },
  });
  return { client, associate, entry };
}

async function sickBalance(associateId: string): Promise<number> {
  const b = await prisma.timeOffBalance.findUnique({
    where: { associateId_category: { associateId, category: 'SICK' } },
  });
  return b?.balanceMinutes ?? 0;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('decision notifications', () => {
  it('rejecting notifies the associate with the reason; approving notifies too', async () => {
    const { associate, entry } = await setupCompletedShift();
    // Give the associate an ACTIVE user so notifyAssociate has an inbox.
    const { user: assocUser } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const cookie = await adminCookie();

    const reject = await request(app())
      .post(`/time/admin/entries/${entry.id}/reject`)
      .set('Cookie', [cookie])
      .send({ reason: 'duplicate punch' });
    expect(reject.status).toBe(200);
    await flushPendingNotifications();

    const rejectNote = await prisma.notification.findFirst({
      where: {
        channel: 'IN_APP',
        category: 'time_entry',
        recipientUserId: assocUser.id,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(rejectNote).not.toBeNull();
    expect(rejectNote?.subject).toBe('Time entry rejected');
    expect(rejectNote?.body).toContain('duplicate punch');
    expect(rejectNote?.linkUrl).toBe('/time-attendance');

    const approve = await request(app())
      .post(`/time/admin/entries/${entry.id}/approve`)
      .set('Cookie', [cookie])
      .send({});
    expect(approve.status).toBe(200);
    await flushPendingNotifications();

    const approveNotes = await prisma.notification.findMany({
      where: {
        channel: 'IN_APP',
        category: 'time_entry',
        recipientUserId: assocUser.id,
        subject: 'Hours approved',
      },
    });
    expect(approveNotes).toHaveLength(1);
    expect(approveNotes[0].body).toContain('8.0h');
  });

  it('bulk approve sends ONE summary per associate', async () => {
    const { associate, entry } = await setupCompletedShift();
    const clockInAt = new Date(Date.now() - 30 * HOUR);
    const second = await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: entry.clientId,
        clockInAt,
        clockOutAt: new Date(clockInAt.getTime() + 4 * HOUR),
        status: 'COMPLETED',
        anomalies: [],
      },
    });
    const { user: assocUser } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const cookie = await adminCookie();

    const res = await request(app())
      .post('/time/admin/bulk-approve')
      .set('Cookie', [cookie])
      .send({ entryIds: [entry.id, second.id] });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(2);
    await flushPendingNotifications();

    const notes = await prisma.notification.findMany({
      where: {
        channel: 'IN_APP',
        category: 'time_entry',
        recipientUserId: assocUser.id,
      },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain('2 time entries approved');
    expect(notes[0].body).toContain('12.0h');
  });
});

describe('time approval ↔ sick-leave accrual lifecycle', () => {
  it('approve credits, reject reverses, re-approve re-credits (cycle-safe)', async () => {
    const { associate, entry } = await setupCompletedShift();
    const cookie = await adminCookie();

    // 480 worked min × (1/30 per hr) = 16 accrued minutes.
    const EXPECTED = 16;

    const approve1 = await request(app())
      .post(`/time/admin/entries/${entry.id}/approve`)
      .set('Cookie', [cookie])
      .send({});
    expect(approve1.status).toBe(200);
    expect(await sickBalance(associate.id)).toBe(EXPECTED);

    // Rejecting the APPROVED entry voids the shift — the accrued minutes
    // must leave the balance with it (this used to leak them).
    const reject = await request(app())
      .post(`/time/admin/entries/${entry.id}/reject`)
      .set('Cookie', [cookie])
      .send({ reason: 'shift disputed' });
    expect(reject.status).toBe(200);
    expect(await sickBalance(associate.id)).toBe(0);
    expect(
      await prisma.timeOffLedgerEntry.findFirst({
        where: { sourceTimeEntryId: entry.id, category: 'SICK' },
      }),
    ).toBeNull();

    // Re-approving after a reversal credits again — the unique accrual
    // key must not leave the cycle stuck at zero.
    const approve2 = await request(app())
      .post(`/time/admin/entries/${entry.id}/approve`)
      .set('Cookie', [cookie])
      .send({});
    expect(approve2.status).toBe(200);
    expect(await sickBalance(associate.id)).toBe(EXPECTED);
  });

  it('bulk reject of an approved entry also reverses the accrual', async () => {
    const { associate, entry } = await setupCompletedShift();
    const cookie = await adminCookie();

    await request(app())
      .post(`/time/admin/entries/${entry.id}/approve`)
      .set('Cookie', [cookie])
      .send({});
    expect(await sickBalance(associate.id)).toBeGreaterThan(0);

    const bulk = await request(app())
      .post('/time/admin/bulk-reject')
      .set('Cookie', [cookie])
      .send({ entryIds: [entry.id], reason: 'voided' });
    expect(bulk.status).toBe(200);
    expect(bulk.body.succeeded).toBe(1);
    expect(await sickBalance(associate.id)).toBe(0);
  });
});

describe('net-of-breaks visibility + provisional summary warning', () => {
  it('serializes netMinutes and the break list (gross 480 − 60 break = 420 net)', async () => {
    const { entry } = await setupCompletedShift();
    const cookie = await adminCookie();
    // One 60-minute meal break inside the 8h shift.
    const breakStart = new Date(entry.clockInAt.getTime() + 3 * HOUR);
    await prisma.breakEntry.create({
      data: {
        timeEntryId: entry.id,
        type: 'MEAL',
        startedAt: breakStart,
        endedAt: new Date(breakStart.getTime() + HOUR),
      },
    });

    const res = await request(app())
      .get('/time/admin/entries')
      .set('Cookie', [cookie]);
    const row = (res.body.entries as Array<{
      id: string;
      minutesElapsed: number;
      netMinutes: number;
      breaks: Array<{ type: string; minutes: number }>;
    }>).find((e) => e.id === entry.id);
    expect(row).toBeDefined();
    expect(row!.minutesElapsed).toBe(480);
    expect(row!.netMinutes).toBe(420);
    expect(row!.breaks).toHaveLength(1);
    expect(row!.breaks[0]).toMatchObject({ type: 'MEAL', minutes: 60 });
  });

  it('summary export warns when entries in range are still pending review', async () => {
    const { associate, entry } = await setupCompletedShift();
    const cookie = await adminCookie();
    // Approve the first shift; leave a second one COMPLETED (pending).
    await request(app())
      .post(`/time/admin/entries/${entry.id}/approve`)
      .set('Cookie', [cookie])
      .send({});
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: entry.clientId,
        clockInAt: new Date(Date.now() - 30 * HOUR),
        clockOutAt: new Date(Date.now() - 25 * HOUR),
        status: 'COMPLETED',
        anomalies: [],
      },
    });

    const res = await request(app())
      .post('/time/admin/export-summary.csv')
      .set('Cookie', [cookie])
      .send({
        from: new Date(Date.now() - 60 * HOUR).toISOString(),
        to: new Date().toISOString(),
      });
    expect(res.status).toBe(200);
    expect(res.headers['x-pending']).toBe('1');
    expect(res.text).toContain('PROVISIONAL');
    expect(res.text).toContain('Current rate');
  });

  it('count endpoint returns the cheap KPI count', async () => {
    const { entry } = await setupCompletedShift();
    const cookie = await adminCookie();
    const res = await request(app())
      .get('/time/admin/entries/count')
      .query({ status: 'COMPLETED' })
      .set('Cookie', [cookie]);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(entry.status).toBe('COMPLETED');
  });
});

describe('GET /time/admin/entries — search', () => {
  it('matches a full "First Last" search (used to return nothing)', async () => {
    const { entry } = await setupCompletedShift();
    const cookie = await adminCookie();

    const res = await request(app())
      .get('/time/admin/entries')
      .query({ search: 'Maria Lopez' })
      .set('Cookie', [cookie]);
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { id: string }) => e.id)).toContain(entry.id);
  });
});
