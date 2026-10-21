import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * "Approve clean time" from the payroll screen: only the run's cut (its
 * client and period), only the people named, and only entries nobody
 * needs to read first — never one with anomaly flags, a kiosk punch
 * waiting for a supervisor, or a correction the worker submitted. And
 * the app's finalize re-scans a regular run for blockers that appeared
 * after the preview.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

const PERIOD = { periodStart: '2026-04-13', periodEnd: '2026-04-19' };

async function entry(associateId: string, clientId: string, day: string, extra: Record<string, unknown> = {}) {
  return prisma.timeEntry.create({
    data: {
      associateId,
      clientId,
      clockInAt: new Date(`${day}T13:00:00.000Z`),
      clockOutAt: new Date(`${day}T17:00:00.000Z`),
      status: 'COMPLETED',
      ...extra,
    },
  });
}

describe('POST /payroll/runs/approve-clean-time', () => {
  it('approves only the clean, in-scope entries of the people named', async () => {
    const clientA = await createClient('Client A');
    const clientB = await createClient('Client B');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const ben = await createAssociate({ firstName: 'Ben', lastName: 'Ortiz' });

    const clean = await entry(ana.id, clientA.id, '2026-04-14');
    const flagged = await entry(ana.id, clientA.id, '2026-04-15', { anomalies: ['LONG_SHIFT'] });
    const atOtherClient = await entry(ana.id, clientB.id, '2026-04-16');
    const outsidePeriod = await entry(ana.id, clientA.id, '2026-04-21');
    const notNamed = await entry(ben.id, clientA.id, '2026-04-14');
    const rejected = await entry(ana.id, clientA.id, '2026-04-17', { status: 'REJECTED', rejectionReason: 'Not worked' });

    // A kiosk punch with no photo, waiting for a supervisor.
    const awaitingPunch = await entry(ana.id, clientA.id, '2026-04-18');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: clientA.id } });
    const device = await prisma.kioskDevice.create({
      data: { clientId: clientA.id, locationId: site.id, name: 'Front desk', tokenHash: 'h'.repeat(64), tokenPrefix: 'abcd', tokenExpiresAt: new Date(Date.now() + 86_400_000) },
    });
    await prisma.kioskPunch.create({
      data: { kioskDeviceId: device.id, associateId: ana.id, timeEntryId: awaitingPunch.id, action: 'CLOCK_IN', reviewStatus: 'PENDING', anomalyKind: 'NO_PHOTO' },
    });
    // A correction Ana submitted against her Sunday.
    const corrected = await entry(ana.id, clientA.id, '2026-04-19');
    await prisma.timeCorrectionRequest.create({
      data: { associateId: ana.id, timeEntryId: corrected.id, kind: 'WRONG_TIME', status: 'SUBMITTED', reason: 'Left at 3' },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/payroll/runs/approve-clean-time').send({ ...PERIOD, clientId: clientA.id, associateIds: [ana.id] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: 1, failed: 0, flagged: 1, awaitingReview: 1, awaitingCorrection: 1 });

    const status = async (id: string) => (await prisma.timeEntry.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(clean.id)).toBe('APPROVED');
    for (const e of [flagged, atOtherClient, outsidePeriod, notNamed, awaitingPunch, corrected]) {
      expect(await status(e.id)).toBe('COMPLETED');
    }
    expect(await status(rejected.id)).toBe('REJECTED');

    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'payroll.approve_clean_time' } })).toBe(1);

    // Twice is harmless.
    const again = await a.post('/payroll/runs/approve-clean-time').send({ ...PERIOD, clientId: clientA.id, associateIds: [ana.id] });
    expect(again.body.approved).toBe(0);
  });

  it('needs time-approval rights as well as payroll', async () => {
    const client = await createClient();
    const ana = await createAssociate();
    await entry(ana.id, client.id, '2026-04-14');
    const { user: driver } = await createUser({ role: 'DRIVER' });
    const d = await loginAs(driver.email);
    expect((await d.post('/payroll/runs/approve-clean-time').send({ ...PERIOD, associateIds: [ana.id] })).status).toBe(403);
  });
});

describe('finalize — the app re-scans a regular run', () => {
  it('stops on a blocker that appeared after the preview, unless acknowledged', async () => {
    const client = await createClient();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    await prisma.associate.update({ where: { id: ana.id }, data: { state: 'KY', employmentType: 'W2_EMPLOYEE' } });
    await prisma.compensationRecord.create({ data: { associateId: ana.id, effectiveFrom: new Date('2026-01-01'), payType: 'HOURLY', amount: 20, reason: 'HIRE' } });
    await entry(ana.id, client.id, '2026-04-14', { status: 'APPROVED' });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const run = await a.post('/payroll/runs').send(PERIOD);
    expect(run.status).toBe(201);

    // No W-4 on file: the app's finalize refuses and says why.
    const refused = await a.post(`/payroll/runs/${run.body.id}/finalize`).send({ recheckExceptions: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('blocking_exceptions');
    expect(refused.body.error.message).toMatch(/Ana Reyes/);

    const ok = await a.post(`/payroll/runs/${run.body.id}/finalize`).send({ recheckExceptions: true, acknowledgeBlocking: true });
    expect(ok.status).toBe(200);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'payroll.finalized_over_blocking', entityId: run.body.id } })).toBe(1);
  });
});
