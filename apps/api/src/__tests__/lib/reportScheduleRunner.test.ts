import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  advanceNextRunAt,
  buildReportCsv,
  runDueReportSchedules,
} from '../../lib/reportScheduleRunner.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const NOW = new Date('2026-08-01T12:00:00.000Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const ROSTER_SPEC = {
  columns: ['firstName', 'lastName', 'email'],
  filters: [],
  sort: [{ column: 'firstName', direction: 'asc' }],
  limit: 1000,
};

async function seedReport(opts: {
  createdById: string | null;
  name?: string;
  spec?: unknown;
}) {
  return prisma.report.create({
    data: {
      name: opts.name ?? 'Roster',
      entity: 'ASSOCIATE',
      spec: (opts.spec ?? ROSTER_SPEC) as Prisma.InputJsonValue,
      createdById: opts.createdById,
    },
  });
}

async function seedAssociate(first: string, last: string) {
  return prisma.associate.create({
    data: {
      firstName: first,
      lastName: last,
      email: `${first}-${Math.random().toString(36).slice(2, 8)}@example.com`.toLowerCase(),
    },
  });
}

describe('advanceNextRunAt', () => {
  it('advances one period from the stored nextRunAt, not from now', () => {
    const current = new Date(NOW.getTime() - 2 * HOUR);
    const next = advanceNextRunAt(current, 'DAILY', NOW);
    // Anchored on `current`: NOW - 2h + 24h = NOW + 22h (no drift to NOW + 24h).
    expect(next.getTime()).toBe(current.getTime() + DAY);
  });

  it('catches up an overdue schedule by whole periods until strictly future', () => {
    const current = new Date(NOW.getTime() - 5 * DAY - HOUR);
    const next = advanceNextRunAt(current, 'DAILY', NOW);
    expect(next.getTime()).toBe(current.getTime() + 6 * DAY); // NOW + 23h
    expect(next.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('a nextRunAt exactly at now advances exactly one period', () => {
    const next = advanceNextRunAt(NOW, 'WEEKLY', NOW);
    expect(next.getTime()).toBe(NOW.getTime() + 7 * DAY);
  });
});

describe('buildReportCsv', () => {
  it('emits BOM + CRLF + RFC-4180 quoting + formula guard, mapping public keys', () => {
    const csv = buildReportCsv('ASSOCIATE', ['firstName', 'lastName', 'email'], [
      { firstName: 'Rob "Bob"', lastName: 'Smith, Jr.', email: 'rob@example.com' },
      { firstName: '=SUM(A1)', lastName: null, email: 'x@example.com' },
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('firstName,lastName,email');
    // Embedded quotes doubled, comma-bearing cell wrapped.
    expect(lines[1]).toBe('"Rob ""Bob""","Smith, Jr.",rob@example.com');
    // Formula-injection guard prefixes a single quote; null renders empty.
    expect(lines[2]).toBe("'=SUM(A1),,x@example.com");
  });

  it('reads values through the public→Prisma column map and serializes Dates', () => {
    const clockIn = new Date('2026-07-31T09:00:00.000Z');
    const csv = buildReportCsv('TIME_ENTRY', ['clockIn', 'status'], [
      { clockInAt: clockIn, status: 'APPROVED' },
    ]);
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('clockIn,status');
    expect(lines[1]).toBe('2026-07-31T09:00:00.000Z,APPROVED');
  });
});

describe('runDueReportSchedules', () => {
  it('runs a due schedule: emails every recipient, stamps status, advances from nextRunAt', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await seedAssociate('Alma', 'Reyes');
    await seedAssociate('Ben', 'Okafor');
    const report = await seedReport({ createdById: user.id });
    const scheduledFor = new Date(NOW.getTime() - 2 * HOUR);
    const schedule = await prisma.reportSchedule.create({
      data: {
        reportId: report.id,
        cadence: 'DAILY',
        // Second address has no User row — plain email must still go out.
        recipients: `${user.email},outside-observer@example.com`,
        nextRunAt: scheduledFor,
      },
    });

    const result = await runDueReportSchedules(prisma, NOW);
    expect(result).toMatchObject({ scanned: 1, delivered: 1, failed: 0 });
    expect(result.errors).toHaveLength(0);

    const after = await prisma.reportSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    expect(after.lastRunAt?.getTime()).toBe(NOW.getTime());
    expect(after.lastStatus).toBe('SUCCESS');
    // Anchored on the schedule's own nextRunAt (NOW - 2h + 24h), not on `now`.
    expect(after.nextRunAt.getTime()).toBe(scheduledFor.getTime() + DAY);

    const sent = await prisma.notification.findMany({
      where: { category: 'reports.schedule_delivered' },
      orderBy: { recipientEmail: 'asc' },
    });
    expect(sent).toHaveLength(2);
    for (const n of sent) {
      expect(n.status).toBe('SENT');
      expect(n.subject).toBe('[Report] Roster — 2026-08-01');
      expect(n.sentAt?.getTime()).toBe(NOW.getTime());
    }
    expect(sent.map((n) => n.recipientEmail)).toContain(
      'outside-observer@example.com',
    );

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'reports.schedule_delivered', entityId: schedule.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.entityType).toBe('ReportSchedule');
    expect(audit!.metadata).toMatchObject({
      reportId: report.id,
      recipientCount: 2,
      deliveredCount: 2,
      rowCount: 2,
      truncated: false,
    });
  });

  it('leaves not-due and inactive schedules untouched', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const report = await seedReport({ createdById: user.id });
    const future = await prisma.reportSchedule.create({
      data: {
        reportId: report.id,
        cadence: 'DAILY',
        recipients: user.email,
        nextRunAt: new Date(NOW.getTime() + HOUR),
      },
    });
    const disabled = await prisma.reportSchedule.create({
      data: {
        reportId: report.id,
        cadence: 'DAILY',
        recipients: user.email,
        isActive: false,
        nextRunAt: new Date(NOW.getTime() - HOUR),
      },
    });

    const result = await runDueReportSchedules(prisma, NOW);
    expect(result).toMatchObject({ scanned: 0, delivered: 0, failed: 0 });

    for (const id of [future.id, disabled.id]) {
      const row = await prisma.reportSchedule.findUniqueOrThrow({ where: { id } });
      expect(row.lastRunAt).toBeNull();
      expect(row.lastStatus).toBeNull();
    }
    expect(
      await prisma.notification.count({
        where: { category: 'reports.schedule_delivered' },
      }),
    ).toBe(0);
  });

  it('a failing schedule records FAILED status and still advances nextRunAt', async () => {
    // No creator → the runner refuses to execute unscoped and fails the run.
    const report = await seedReport({ createdById: null });
    const scheduledFor = new Date(NOW.getTime() - HOUR);
    const schedule = await prisma.reportSchedule.create({
      data: {
        reportId: report.id,
        cadence: 'WEEKLY',
        recipients: 'someone@example.com',
        nextRunAt: scheduledFor,
      },
    });

    const result = await runDueReportSchedules(prisma, NOW);
    expect(result).toMatchObject({ scanned: 1, delivered: 0, failed: 1 });
    expect(result.errors[0].scheduleId).toBe(schedule.id);
    expect(result.errors[0].error).toContain('report_owner_missing');

    const after = await prisma.reportSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    expect(after.lastRunAt?.getTime()).toBe(NOW.getTime());
    expect(after.lastStatus).toMatch(/^FAILED: report_owner_missing/);
    // Advanced one WEEKLY period off its own stamp — no hot-looping.
    expect(after.nextRunAt.getTime()).toBe(scheduledFor.getTime() + 7 * DAY);
    expect(
      await prisma.notification.count({
        where: { category: 'reports.schedule_delivered' },
      }),
    ).toBe(0);

    // One failure doesn't sink the batch: a healthy schedule in the same
    // sweep still delivers.
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await seedAssociate('Cara', 'Lund');
    const goodReport = await seedReport({ createdById: user.id, name: 'Good' });
    await prisma.reportSchedule.create({
      data: {
        reportId: goodReport.id,
        cadence: 'DAILY',
        recipients: user.email,
        nextRunAt: new Date(NOW.getTime() - HOUR),
      },
    });
    const second = await runDueReportSchedules(prisma, NOW);
    // The broken schedule already advanced past NOW, so only the good one is due.
    expect(second).toMatchObject({ scanned: 1, delivered: 1, failed: 0 });
  });

  it('catches up a schedule overdue by multiple periods without re-sending per period', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await seedAssociate('Dee', 'Nguyen');
    const report = await seedReport({ createdById: user.id });
    const scheduledFor = new Date(NOW.getTime() - 5 * DAY - HOUR);
    const schedule = await prisma.reportSchedule.create({
      data: {
        reportId: report.id,
        cadence: 'DAILY',
        recipients: user.email,
        nextRunAt: scheduledFor,
      },
    });

    const result = await runDueReportSchedules(prisma, NOW);
    expect(result).toMatchObject({ scanned: 1, delivered: 1 });

    const after = await prisma.reportSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    // 5+ days overdue → one delivery, nextRunAt vaults to the first future slot.
    expect(after.nextRunAt.getTime()).toBe(scheduledFor.getTime() + 6 * DAY);
    expect(
      await prisma.notification.count({
        where: { category: 'reports.schedule_delivered' },
      }),
    ).toBe(1);
  });

  it('caps CSV rows and calls out the truncation in the email body', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await seedAssociate('Eva', 'One');
    await seedAssociate('Fay', 'Two');
    await seedAssociate('Gus', 'Three');
    const report = await seedReport({ createdById: user.id });
    const schedule = await prisma.reportSchedule.create({
      data: {
        reportId: report.id,
        cadence: 'DAILY',
        recipients: user.email,
        nextRunAt: new Date(NOW.getTime() - HOUR),
      },
    });

    const result = await runDueReportSchedules(prisma, NOW, { rowCap: 2 });
    expect(result).toMatchObject({ scanned: 1, delivered: 1, failed: 0 });

    const note = await prisma.notification.findFirstOrThrow({
      where: { category: 'reports.schedule_delivered' },
    });
    expect(note.body).toContain('first 2 rows');

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'reports.schedule_delivered', entityId: schedule.id },
    });
    expect(audit!.metadata).toMatchObject({ rowCount: 2, truncated: true });
  });
});
