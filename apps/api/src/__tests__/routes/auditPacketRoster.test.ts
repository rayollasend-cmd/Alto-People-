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

/**
 * Client-period roster derivation (reported 2026-08-16: "the packet only
 * had limited information"). The old three-signal roster starved in
 * practice — shifts were never flipped to COMPLETED anywhere, and time
 * entries sit at COMPLETED unless timesheet approval runs — so a client
 * whose workforce was migrated in and paid externally produced a
 * near-empty packet. These tests pin the widened signals: the hiring
 * record, recorded (not just approved) worked time, and past published
 * scheduled shifts.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginHr(): Promise<TestAgent<Test>> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = request.agent(app());
  const r = await a
    .post('/auth/login')
    .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

const PERIOD = { periodStart: '2026-01-01', periodEnd: '2026-06-30' };
const REASON = { reason: 'Client vendor audit response — test run.' };

describe('POST /audit-packets/generate — CLIENT_PERIOD roster signals', () => {
  it('includes a worker whose only tie is the hiring record (approved application)', async () => {
    const client = await createClient('Walmart Destin');
    const assoc = await createAssociate({ firstName: 'Hired', lastName: 'Only' });
    // No assignment, no time entries, no shifts — exactly the migrated-
    // workforce shape that used to come back 404 empty_roster.
    await prisma.application.create({
      data: {
        associateId: assoc.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'APPROVED',
        approvedAt: new Date('2026-01-15T00:00:00Z'),
      },
    });

    const a = await loginHr();
    const res = await a
      .post('/audit-packets/generate')
      .send({ scope: 'CLIENT_PERIOD', clientId: client.id, ...PERIOD, ...REASON })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect((res.body as Buffer).length).toBeGreaterThan(1000);
  });

  it('counts recorded (COMPLETED) punches and past published shifts as engagement', async () => {
    const client = await createClient();
    const loc = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    // Worker A: kiosk punches that never went through timesheet approval.
    const punched = await createAssociate({ firstName: 'Punched', lastName: 'Only' });
    await prisma.timeEntry.create({
      data: {
        associateId: punched.id,
        clientId: client.id,
        locationId: loc.id,
        clockInAt: new Date('2026-02-03T14:00:00Z'),
        clockOutAt: new Date('2026-02-03T22:00:00Z'),
        status: 'COMPLETED',
      },
    });
    // Worker B: a published assigned shift whose date has passed — the
    // schedule's own record of engagement (nothing ever sets COMPLETED).
    const scheduled = await createAssociate({ firstName: 'Sched', lastName: 'Only' });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date('2026-02-10T14:00:00Z'),
        endsAt: new Date('2026-02-10T22:00:00Z'),
        status: 'ASSIGNED',
        publishedAt: new Date('2026-02-01T00:00:00Z'),
        assignedAssociateId: scheduled.id,
      },
    });

    const a = await loginHr();
    const res = await a
      .post('/audit-packets/generate')
      .send({ scope: 'CLIENT_PERIOD', clientId: client.id, ...PERIOD, ...REASON })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
  });

  it('still 404s when nothing ties anyone to the client', async () => {
    const client = await createClient();
    const a = await loginHr();
    const res = await a
      .post('/audit-packets/generate')
      .send({ scope: 'CLIENT_PERIOD', clientId: client.id, ...PERIOD, ...REASON });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('empty_roster');
  });
});
