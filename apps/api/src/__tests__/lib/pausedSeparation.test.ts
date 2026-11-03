import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PAUSED_SEPARATION_NOTES,
  PAUSED_SEPARATION_RULE,
  runPausedSeparationSweep,
} from '../../lib/pausedSeparation.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';
import { dateColumnKey } from '../../lib/timezone.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Paused more than 120 days becomes a separation (owner, 2026-11-03). HR is
 * told once at 110 days; over 120 days, with that notice at least a week
 * old, the separation is completed the way a person would complete it, by
 * no one (the rule), with one HR summary per sweep. Property still out
 * holds a person back (never waived); a rehire in flight takes them out.
 *
 * completeSeparation stamps real time, so the sweep's clock is real time
 * too and the pauses are seeded that many days back.
 */

const DAY = 86_400_000;
let clientId: string;

beforeEach(async () => {
  await truncateAll();
  clientId = (await createClient()).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** The sweep as the job runs it: inside the tenant, under the wall. */
function sweep(now: Date = new Date()) {
  return runWithTenant(ALTO_TENANT_ID, 'job', () => runPausedSeparationSweep(undefined, now));
}

/** Hired a year ago, paused `pausedDays` ago, with a login. `noticeDaysAgo` = HR already told then. */
async function seedPaused(opts: { firstName: string; pausedDays: number; noticeDaysAgo?: number }) {
  const now = Date.now();
  const associate = await prisma.associate.create({
    data: {
      firstName: opts.firstName,
      lastName: 'Paused',
      email: `${opts.firstName.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@paused.example`,
      hireDate: new Date(now - 365 * DAY),
      deactivatedAt: new Date(now - opts.pausedDays * DAY),
      deactivationReason: 'Personal leave',
      pauseSeparationNoticeAt: opts.noticeDaysAgo === undefined ? null : new Date(now - opts.noticeDaysAgo * DAY),
    },
  });
  await prisma.application.create({
    data: { associateId: associate.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date(now - 365 * DAY) },
  });
  const { user } = await createUser({ role: 'ASSOCIATE', email: associate.email, associateId: associate.id });
  await prisma.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
  return { associate, user };
}

async function hrNotices(userId: string) {
  await flushPendingNotifications();
  return prisma.notification.findMany({ where: { recipientUserId: userId, category: 'separation', channel: 'IN_APP' }, orderBy: { createdAt: 'asc' } });
}

describe('paused over 120 days → separated', () => {
  it('separates at 121 days, not at 119', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const over = await seedPaused({ firstName: 'Olive', pausedDays: 121, noticeDaysAgo: 11 });
    const under = await seedPaused({ firstName: 'Uma', pausedDays: 119, noticeDaysAgo: 9 });

    const r = await sweep();
    expect(r.errors).toEqual([]);
    expect(r.separated).toBe(1);

    const sep = await prisma.separation.findFirstOrThrow({ where: { associateId: over.associate.id } });
    expect(sep.status).toBe('COMPLETE');
    expect(sep.reason).toBe('OTHER');
    expect(sep.reasonNotes).toBe(PAUSED_SEPARATION_NOTES);
    expect(sep.initiatedById).toBeNull();
    expect(sep.completedById).toBeNull();
    // No time on file: the last day worked is the day they were paused.
    expect(dateColumnKey(sep.lastDayWorked)).toBe(orgDateKey(over.associate.deactivatedAt!));
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: over.associate.id } })).separatedAt).not.toBeNull();

    expect(await prisma.separation.count({ where: { associateId: under.associate.id } })).toBe(0);
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: under.associate.id } })).separatedAt).toBeNull();

    const notices = await hrNotices(hr.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toMatch(/^Separated automatically: 1 person paused over 120 days/);
    expect(notices[0]!.body).toContain('Olive Paused');
    expect(notices[0]!.body).not.toContain('Uma Paused');
  });

  it('dates the separation to their last time entry, and the audit row names the rule', async () => {
    await createUser({ role: 'HR_ADMINISTRATOR' });
    const { associate } = await seedPaused({ firstName: 'Tess', pausedDays: 130, noticeDaysAgo: 20 });
    const worked = new Date(Date.now() - 140 * DAY);
    await prisma.timeEntry.create({ data: { associateId: associate.id, clientId, clockInAt: worked, clockOutAt: new Date(worked.getTime() + 8 * 3_600_000), status: 'APPROVED' } });

    await sweep();
    await flushPendingAudits();
    const sep = await prisma.separation.findFirstOrThrow({ where: { associateId: associate.id } });
    expect(dateColumnKey(sep.lastDayWorked)).toBe(orgDateKey(worked));

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'separation.completed', entityId: sep.id } });
    expect(audit.actorUserId).toBeNull();
    expect(audit.metadata).toMatchObject({
      associateId: associate.id,
      automatic: true,
      rule: PAUSED_SEPARATION_RULE,
      pausedOn: orgDateKey(associate.deactivatedAt!),
      pausedDays: 130,
      existingSeparation: false,
    });
    // The tenant's second-person switch is on by default: recorded, not asked.
    expect((audit.metadata as { secondPerson: string }).secondPerson).toContain('standing rule');
    expect(await prisma.approvalRequest.count({ where: { kind: 'SEPARATION_COMPLETE' } })).toBe(0);
  });

  it('is a system actor with one HR summary for the sweep, never a notice per person or to the associate', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await seedPaused({ firstName: 'Ana', pausedDays: 125, noticeDaysAgo: 15 });
    const b = await seedPaused({ firstName: 'Ben', pausedDays: 150, noticeDaysAgo: 40 });

    const r = await sweep();
    expect(r.separated).toBe(2);

    const notices = await hrNotices(hr.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toContain('2 people');
    expect(notices[0]!.body).toContain('Ana Paused');
    expect(notices[0]!.body).toContain('Ben Paused');
    expect(notices[0]!.linkUrl).toBe('/separations');
    // completeSeparation's own per-person notice is the rule's summary instead.
    expect(await prisma.notification.count({ where: { subject: { startsWith: 'Separation completed:' } } })).toBe(0);
    expect(await prisma.notification.count({ where: { recipientUserId: { in: [a.user.id, b.user.id] } } })).toBe(0);

    // Everything else a separation does: the logins stay off for good (token bumped).
    const login = await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } });
    expect(login.status).toBe('DISABLED');

    // A second sweep finds nobody left to do.
    const again = await sweep();
    expect(again.separated).toBe(0);
    expect(await hrNotices(hr.id)).toHaveLength(1);
  });

  it('completes the open separation instead of creating a second, and closes the request waiting on it', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { associate } = await seedPaused({ firstName: 'Opal', pausedDays: 122, noticeDaysAgo: 12 });
    const lastDay = new Date(`${orgDateKey(new Date(Date.now() - 125 * DAY))}T00:00:00.000Z`);
    const open = await prisma.separation.create({
      data: { associateId: associate.id, reason: 'VOLUNTARY_PERSONAL', status: 'IN_PROGRESS', lastDayWorked: lastDay, initiatedById: hr.id },
    });
    const pending = await prisma.approvalRequest.create({
      data: { kind: 'SEPARATION_COMPLETE', subjectType: 'Separation', subjectId: open.id, title: 'Complete Opal', proposed: { separationId: open.id }, requesterUserId: hr.id, approverCapability: 'manage:onboarding' },
    });

    const r = await sweep();
    expect(r.errors).toEqual([]);
    expect(r.separated).toBe(1);
    const rows = await prisma.separation.findMany({ where: { associateId: associate.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(open.id);
    expect(rows[0]!.status).toBe('COMPLETE');
    // HR's own record stands: their reason and last day, not the rule's.
    expect(rows[0]!.reason).toBe('VOLUNTARY_PERSONAL');
    expect(dateColumnKey(rows[0]!.lastDayWorked)).toBe(dateColumnKey(lastDay));

    const req = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(req.status).toBe('CANCELLED');
    expect(req.reason).toContain('paused over 120 days');

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'separation.completed', entityId: open.id } });
    expect(audit.metadata).toMatchObject({ existingSeparation: true, automatic: true });
  });

  it('holds someone with company property still out, lists them for HR (once a week), and never waives', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { associate } = await seedPaused({ firstName: 'Kit', pausedDays: 130, noticeDaysAgo: 20 });
    const asset = await prisma.asset.create({ data: { kind: 'LAPTOP', label: 'Laptop 7', status: 'ASSIGNED' } });
    await prisma.assetAssignment.create({ data: { assetId: asset.id, associateId: associate.id } });

    const r = await sweep();
    expect(r.separated).toBe(0);
    expect(r.held).toBe(1);
    expect(await prisma.separation.count({ where: { associateId: associate.id } })).toBe(0);
    const a = await prisma.associate.findUniqueOrThrow({ where: { id: associate.id } });
    expect(a.separatedAt).toBeNull();
    expect(a.pauseSeparationHeldAt).not.toBeNull();

    let notices = await hrNotices(hr.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toBe("Paused over 120 days: 1 person can't be separated automatically");
    expect(notices[0]!.body).toContain('Kit Paused');
    expect(notices[0]!.body).toContain('1 item of company property still out');

    // The next run the same week: still held, not repeated.
    expect((await sweep()).held).toBe(1);
    notices = await hrNotices(hr.id);
    expect(notices).toHaveLength(1);

    // A week on, HR hears again.
    await sweep(new Date(Date.now() + 8 * DAY));
    expect(await hrNotices(hr.id)).toHaveLength(2);

    // HR starts the separation and waives the property with a reason: the rule finishes it.
    const open = await prisma.separation.create({
      data: {
        associateId: associate.id,
        reason: 'OTHER',
        lastDayWorked: new Date(`${orgDateKey(associate.deactivatedAt!)}T00:00:00.000Z`),
        assetsWaivedAt: new Date(),
        assetsWaivedById: hr.id,
        assetsWaiveReason: 'Laptop written off',
      },
    });
    expect((await sweep()).separated).toBe(1);
    expect((await prisma.separation.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('COMPLETE');
  });

  it('skips a rehire in flight, and people already separated, erased or deleted', async () => {
    await createUser({ role: 'HR_ADMINISTRATOR' });
    const rehire = await seedPaused({ firstName: 'Remy', pausedDays: 140, noticeDaysAgo: 30 });
    await prisma.application.create({ data: { associateId: rehire.associate.id, clientId, onboardingTrack: 'STANDARD', status: 'SUBMITTED' } });
    const erased = await seedPaused({ firstName: 'Eve', pausedDays: 140, noticeDaysAgo: 30 });
    await prisma.associate.update({ where: { id: erased.associate.id }, data: { erasedAt: new Date() } });
    const deleted = await seedPaused({ firstName: 'Dee', pausedDays: 140, noticeDaysAgo: 30 });
    await prisma.associate.update({ where: { id: deleted.associate.id }, data: { deletedAt: new Date() } });

    const r = await sweep();
    expect(r.scanned).toBe(0);
    expect(r.separated).toBe(0);
    expect(await prisma.separation.count()).toBe(0);
  });
});

describe('the heads-up at 110 days', () => {
  it('tells HR once at 110 days, with the date and a link to People filtered to Paused', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const due = await seedPaused({ firstName: 'Nell', pausedDays: 111 });
    await seedPaused({ firstName: 'Ida', pausedDays: 105 });

    const r = await sweep();
    expect(r.announced).toBe(1);
    expect(r.separated).toBe(0);
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: due.associate.id } })).pauseSeparationNoticeAt).not.toBeNull();

    let notices = await hrNotices(hr.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toBe('1 paused person will be separated in 9 days unless reactivated');
    expect(notices[0]!.body).toContain('Nell Paused');
    expect(notices[0]!.body).not.toContain('Ida Paused');
    expect(notices[0]!.linkUrl).toBe('/people?workStatus=DEACTIVATED');
    expect(await prisma.notification.count({ where: { recipientUserId: due.user.id } })).toBe(0);

    // Announced once: the next sweeps say nothing new about them.
    expect((await sweep()).announced).toBe(0);
    notices = await hrNotices(hr.id);
    expect(notices).toHaveLength(1);
  });

  it('runs the whole course: told at 111 days, separated at 121', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { associate } = await seedPaused({ firstName: 'Cora', pausedDays: 121 });

    // Ten days ago they were at 111 days: the heads-up.
    const first = await sweep(new Date(Date.now() - 10 * DAY));
    expect(first.announced).toBe(1);
    expect(first.separated).toBe(0);
    // Today, 121 days: separated.
    const second = await sweep();
    expect(second.separated).toBe(1);
    const subjects = (await hrNotices(hr.id)).map((n) => n.subject);
    expect(subjects).toEqual(['1 paused person will be separated in 9 days unless reactivated', 'Separated automatically: 1 person paused over 120 days']);
    expect((await prisma.separation.findFirstOrThrow({ where: { associateId: associate.id } })).status).toBe('COMPLETE');
  });

  it('never separates anyone HR was not told about: a pause already past 120 days gets the notice first', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { associate } = await seedPaused({ firstName: 'Lou', pausedDays: 125 });

    const r = await sweep();
    expect(r.announced).toBe(1);
    expect(r.separated).toBe(0);
    const notices = await hrNotices(hr.id);
    expect(notices[0]!.subject).toBe('1 paused person will be separated in 7 days unless reactivated');
    expect(await prisma.separation.count({ where: { associateId: associate.id } })).toBe(0);
  });

  it('a stamp from an earlier pause does not count: a new pause is announced afresh', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    // Told during an earlier pause (200 days ago), reactivated, paused again 112 days ago.
    const { associate } = await seedPaused({ firstName: 'Ray', pausedDays: 112, noticeDaysAgo: 200 });
    const r = await sweep();
    expect(r.announced).toBe(1);
    expect((await hrNotices(hr.id))[0]!.body).toContain('Ray Paused');
    const a = await prisma.associate.findUniqueOrThrow({ where: { id: associate.id } });
    expect(a.pauseSeparationNoticeAt!.getTime()).toBeGreaterThan(a.deactivatedAt!.getTime());
  });
});
