import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { signSession } from '../../lib/jwt.js';
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
