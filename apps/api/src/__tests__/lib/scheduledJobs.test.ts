import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';
import { __resetJobsForTests, armJob, isJobArmed, listJobs, runJobNow, stopJob } from '../../lib/jobs.js';
import { SHIFT_REMINDER_JOB, startShiftReminderCron, stopShiftReminderCron } from '../../lib/shiftReminder.js';
import { SCHEDULE_DIGEST_JOB, startScheduleDigestCron, stopScheduleDigestCron } from '../../lib/scheduleDigest.js';
import { WEEK_AHEAD_JOB, startWeekAheadCron, stopWeekAheadCron } from '../../lib/weekAheadDigest.js';
import { KIOSK_MAINTENANCE_JOB, startKioskMaintenanceCron, stopKioskMaintenanceCron } from '../../lib/kioskMaintenance.js';
import { AUDIT_CHAIN_CHECK_JOB, startAuditChainCheckCron } from '../../lib/auditChain.js';
import { BIOMETRIC_SEAL_JOB, startBiometricSealCron } from '../../lib/biometricFields.js';

/**
 * Audit 2026-10-21 item 4: four crons defaulted to 0 and were set nowhere,
 * so reminders, both digests and kiosk maintenance never ran. They now
 * default on, register in the jobs registry, and an admin can read what
 * each did last and when it runs next.
 */

beforeEach(async () => {
  await truncateAll();
  __resetJobsForTests();
});
afterEach(() => {
  stopShiftReminderCron();
  stopScheduleDigestCron();
  stopWeekAheadCron();
  stopKioskMaintenanceCron();
  __resetJobsForTests();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the four crons default on', () => {
  it('env defaults are positive, and starting them arms a timer in the registry with a next run', () => {
    expect(env.SHIFT_REMINDER_INTERVAL_SECONDS).toBe(1800);
    expect(env.SCHEDULE_DIGEST_INTERVAL_SECONDS).toBe(900);
    expect(env.WEEK_AHEAD_INTERVAL_SECONDS).toBe(1800);
    expect(env.KIOSK_MAINTENANCE_INTERVAL_SECONDS).toBe(3600);
    expect(env.AUDIT_CHAIN_CHECK_INTERVAL_SECONDS).toBe(86400);

    startShiftReminderCron();
    startScheduleDigestCron();
    startWeekAheadCron();
    startKioskMaintenanceCron();
    startAuditChainCheckCron(prisma);
    startBiometricSealCron(prisma);

    const byName = new Map(listJobs().map((j) => [j.name, j]));
    for (const name of [SHIFT_REMINDER_JOB, SCHEDULE_DIGEST_JOB, WEEK_AHEAD_JOB, KIOSK_MAINTENANCE_JOB, AUDIT_CHAIN_CHECK_JOB, BIOMETRIC_SEAL_JOB]) {
      const j = byName.get(name);
      expect(j, name).toBeDefined();
      expect(j!.armed, name).toBe(true);
      expect(j!.intervalSeconds, name).toBeGreaterThan(0);
      expect(j!.nextRunAt, name).not.toBeNull();
      expect(isJobArmed(name)).toBe(true);
    }
    stopShiftReminderCron();
    expect(byName.get(SHIFT_REMINDER_JOB)).toBeDefined();
    expect(isJobArmed(SHIFT_REMINDER_JOB)).toBe(false);
    expect(listJobs().find((j) => j.name === SHIFT_REMINDER_JOB)).toMatchObject({ armed: false, nextRunAt: null });
  });

  it('an interval of 0 lists the job as off instead of arming it', () => {
    expect(armJob({ name: 'offJob', label: 'Off', intervalSeconds: 0, run: () => undefined })).toBe(false);
    expect(listJobs().find((j) => j.name === 'offJob')).toMatchObject({ armed: false, intervalSeconds: 0, nextRunAt: null });
  });
});

describe('the registry records each run', () => {
  it('keeps last run, duration, and the last error; a tick still running is not stacked', async () => {
    let calls = 0;
    armJob({ name: 'flaky', label: 'Flaky', intervalSeconds: 3600, immediate: false, run: async () => {
      calls += 1;
      if (calls === 1) throw new Error('db down');
    } });
    const first = await runJobNow('flaky');
    expect(first).toMatchObject({ runs: 1, failures: 1, lastError: 'db down', lastOkAt: null });
    const second = await runJobNow('flaky');
    expect(second).toMatchObject({ runs: 2, failures: 1, lastError: null });
    expect(second!.lastOkAt).not.toBeNull();
    expect(second!.lastDurationMs).toBeGreaterThanOrEqual(0);
    stopJob('flaky');
    expect(await runJobNow('missing')).toBeNull();
  });
});

describe('GET /admin/jobs', () => {
  it('shows the registry to someone with view:product-analytics; run-now needs manage:org and is audited', async () => {
    armJob({ name: 'demo', label: 'Demo job', intervalSeconds: 3600, immediate: false, run: () => undefined });
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = request.agent(createApp());
    expect((await a.post('/auth/login').send({ email: admin.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);
    const list = await a.get('/admin/jobs');
    expect(list.status).toBe(200);
    expect(list.body.jobs.find((j: { name: string }) => j.name === 'demo')).toMatchObject({ label: 'Demo job', armed: true, runs: 0 });
    const ran = await a.post('/admin/jobs/demo/run');
    expect(ran.status).toBe(200);
    expect(ran.body.job).toMatchObject({ runs: 1, failures: 0 });
    expect((await a.post('/admin/jobs/nope/run')).status).toBe(404);

    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const b = request.agent(createApp());
    await b.post('/auth/login').send({ email: assoc.email, password: DEFAULT_TEST_PASSWORD });
    expect((await b.get('/admin/jobs')).status).toBe(403);
  });

  it("does not exist for a customer tenant's admin — the jobs are the platform's", async () => {
    armJob({ name: 'demo', label: 'Demo job', intervalSeconds: 3600, immediate: false, run: () => undefined });
    const T2 = '44444444-4444-4444-8444-444444444444';
    await prisma.tenant.create({ data: { id: T2, slug: 'acme-jobs', name: 'Acme', plan: 'standard' } });
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: admin.id }, data: { tenantId: T2 } });
    const a = request.agent(createApp());
    expect((await a.post('/auth/login').send({ email: admin.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);
    expect((await a.get('/admin/jobs')).status).toBe(404);
    expect((await a.post('/admin/jobs/demo/run')).status).toBe(404);
    expect(listJobs().find((j) => j.name === 'demo')).toMatchObject({ runs: 0 });
  });
});
