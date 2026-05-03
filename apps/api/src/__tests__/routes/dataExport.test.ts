import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { buildDataExport } from '../../lib/dataExport.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('buildDataExport', () => {
  it('returns the user-only entries when no associate is linked', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const entries = await buildDataExport(user.id);
    const names = entries.map((e) => e.filename);
    expect(names).toEqual([
      'README.txt',
      'profile.json',
      'login-history.json',
      'notification-preferences.json',
    ]);
    const profile = JSON.parse(entries[1].contents);
    expect(profile.user.id).toBe(user.id);
    expect(profile.user.email).toBe(user.email);
    expect(profile.associate).toBeNull();
    // Password hash and tokenVersion must never appear in the export.
    expect(entries[1].contents).not.toMatch(/passwordHash/);
    expect(entries[1].contents).not.toMatch(/tokenVersion/);
  });

  it('includes time entries, paystubs, and documents for an associate', async () => {
    const associate = await createAssociate({
      firstName: 'Pat',
      lastName: 'Tester',
      email: `pat-${Date.now()}@example.com`,
    });
    await prisma.associate.update({
      where: { id: associate.id },
      data: {
        addressLine1: '1 Main St',
        city: 'Boston',
        state: 'MA',
        zip: '02110',
        ssnLast4: '1234',
      },
    });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });

    // Seed one approved time entry, one paystub (via PayrollRun), one doc.
    const run = await prisma.payrollRun.create({
      data: {
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-14'),
        status: 'FINALIZED',
        finalizedAt: new Date('2026-04-15T17:00:00Z'),
      },
    });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: run.id,
        associateId: associate.id,
        hoursWorked: 80,
        hourlyRate: 25,
        grossPay: 2000,
        federalWithholding: 200,
        netPay: 1700,
        status: 'DISBURSED',
      },
    });
    const start = new Date('2026-04-02T13:00:00Z');
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clockInAt: start,
        clockOutAt: new Date(start.getTime() + 8 * 60 * 60 * 1000),
        status: 'APPROVED',
      },
    });
    await prisma.documentRecord.create({
      data: {
        associateId: associate.id,
        kind: 'OTHER',
        filename: 'license.png',
        mimeType: 'image/png',
        size: 12345,
        status: 'UPLOADED',
      },
    });

    const entries = await buildDataExport(user.id);
    const names = entries.map((e) => e.filename);
    expect(names).toEqual([
      'README.txt',
      'profile.json',
      'login-history.json',
      'notification-preferences.json',
      'time-entries.json',
      'paystubs.json',
      'documents.json',
    ]);

    const profile = JSON.parse(entries[1].contents);
    expect(profile.associate.firstName).toBe('Pat');
    expect(profile.associate.ssnLast4).toBe('1234');
    expect(profile.associate.state).toBe('MA');

    const times = JSON.parse(entries[4].contents) as Array<{ status: string }>;
    expect(times).toHaveLength(1);
    expect(times[0].status).toBe('APPROVED');

    const stubs = JSON.parse(entries[5].contents) as Array<{
      grossPay: string;
      netPay: string;
      period: { start: string; end: string };
    }>;
    expect(stubs).toHaveLength(1);
    expect(stubs[0].grossPay).toBe('2000');
    expect(stubs[0].netPay).toBe('1700');
    expect(stubs[0].period.start).toBe('2026-04-01');
    expect(stubs[0].period.end).toBe('2026-04-14');

    const docs = JSON.parse(entries[6].contents) as Array<{ filename: string; size: number }>;
    expect(docs).toHaveLength(1);
    expect(docs[0].filename).toBe('license.png');
    expect(docs[0].size).toBe(12345);
    // Storage paths are infrastructure detail, must not leak.
    expect(entries[6].contents).not.toMatch(/s3Key/);
  });

  it("does not leak another user's records", async () => {
    const a1 = await createAssociate({ email: `mine-${Date.now()}@example.com` });
    const a2 = await createAssociate({ email: `theirs-${Date.now()}@example.com` });
    const { user: u1 } = await createUser({
      role: 'ASSOCIATE',
      email: a1.email,
      associateId: a1.id,
    });
    await createUser({ role: 'ASSOCIATE', email: a2.email, associateId: a2.id });

    const start = new Date('2026-04-02T13:00:00Z');
    await prisma.timeEntry.create({
      data: {
        associateId: a2.id,
        clockInAt: start,
        clockOutAt: new Date(start.getTime() + 8 * 60 * 60 * 1000),
        status: 'APPROVED',
      },
    });

    const entries = await buildDataExport(u1.id);
    const times = JSON.parse(
      entries.find((e) => e.filename === 'time-entries.json')!.contents
    ) as Array<unknown>;
    expect(times).toHaveLength(0);
  });
});

describe('GET /auth/me/data-export', () => {
  it('returns 401 without a session', async () => {
    const a = agent();
    const res = await a.get('/auth/me/data-export');
    expect(res.status).toBe(401);
  });

  it('streams a ZIP archive with the right headers and writes an audit row', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.get('/auth/me/data-export').buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="alto-data-export-\d{4}-\d{2}-\d{2}\.zip"/
    );
    // ZIP magic bytes 'PK\x03\x04' lead every well-formed archive.
    const body: Buffer = res.body instanceof Buffer ? res.body : Buffer.from(res.text ?? '', 'binary');
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toBe(0x50); // P
    expect(body[1]).toBe(0x4b); // K

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.data_exported', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
  });
});
