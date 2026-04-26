import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { accrueSickLeaveForEntry } from '../../lib/timeOffAccrual.js';
import { prisma, truncateAll } from '../../../test/db.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedAssociate(state: string | null) {
  return prisma.associate.create({
    data: {
      firstName: 'Sick',
      lastName: 'Leaver',
      email: `sl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      state,
    },
  });
}

async function seedEntry(opts: {
  associateId: string;
  workedHours: number;
  approved?: boolean;
}) {
  const clockInAt = new Date('2026-04-26T13:00:00.000Z');
  const clockOutAt = new Date(clockInAt.getTime() + opts.workedHours * 60 * 60 * 1000);
  return prisma.timeEntry.create({
    data: {
      associateId: opts.associateId,
      clockInAt,
      clockOutAt,
      status: opts.approved ? 'APPROVED' : 'COMPLETED',
    },
  });
}

describe('accrueSickLeaveForEntry', () => {
  it('CA: 30 worked hours yields 60 minutes (1hr/30hrs floor)', async () => {
    const a = await seedAssociate('CA');
    const e = await seedEntry({ associateId: a.id, workedHours: 30 });
    const r = await accrueSickLeaveForEntry(prisma, e.id);
    expect(r.accrued).toBe(true);
    // 30 worked hours × (1/30) = 1 hour = 60 min.
    expect(r.earnedMinutes).toBe(60);
    expect(r.workedMinutes).toBe(30 * 60);

    const bal = await prisma.timeOffBalance.findUnique({
      where: { associateId_category: { associateId: a.id, category: 'SICK' } },
    });
    expect(bal?.balanceMinutes).toBe(60);
  });

  it('TX: zero rate → no ledger row, no balance row', async () => {
    const a = await seedAssociate('TX');
    const e = await seedEntry({ associateId: a.id, workedHours: 8 });
    const r = await accrueSickLeaveForEntry(prisma, e.id);
    expect(r.accrued).toBe(false);
    expect(r.earnedMinutes).toBe(0);
    expect(r.ratePerHour).toBe(0);

    const ledger = await prisma.timeOffLedgerEntry.count({ where: { associateId: a.id } });
    expect(ledger).toBe(0);
    const bal = await prisma.timeOffBalance.findFirst({ where: { associateId: a.id } });
    expect(bal).toBeNull();
  });

  it('null state (federal default) → no accrual', async () => {
    const a = await seedAssociate(null);
    const e = await seedEntry({ associateId: a.id, workedHours: 8 });
    const r = await accrueSickLeaveForEntry(prisma, e.id);
    expect(r.accrued).toBe(false);
    expect(r.earnedMinutes).toBe(0);
  });

  it('idempotent: second call on the same entry is a no-op', async () => {
    const a = await seedAssociate('NY');
    const e = await seedEntry({ associateId: a.id, workedHours: 30 });
    const first = await accrueSickLeaveForEntry(prisma, e.id);
    const second = await accrueSickLeaveForEntry(prisma, e.id);
    expect(first.accrued).toBe(true);
    expect(second.accrued).toBe(false);

    const ledgerCount = await prisma.timeOffLedgerEntry.count({ where: { associateId: a.id } });
    expect(ledgerCount).toBe(1);
    const bal = await prisma.timeOffBalance.findUnique({
      where: { associateId_category: { associateId: a.id, category: 'SICK' } },
    });
    expect(bal?.balanceMinutes).toBe(60);
  });

  it('still-active entry (no clockOutAt) → no accrual', async () => {
    const a = await seedAssociate('CA');
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: a.id,
        clockInAt: new Date('2026-04-26T13:00:00.000Z'),
        clockOutAt: null,
        status: 'ACTIVE',
      },
    });
    const r = await accrueSickLeaveForEntry(prisma, entry.id);
    expect(r.accrued).toBe(false);
    expect(r.earnedMinutes).toBe(0);
  });

  it('balance grows monotonically across multiple distinct entries', async () => {
    const a = await seedAssociate('WA'); // 1/40 = 0.025/hr
    const e1 = await seedEntry({ associateId: a.id, workedHours: 40 });
    const e2 = await seedEntry({ associateId: a.id, workedHours: 40 });
    await accrueSickLeaveForEntry(prisma, e1.id);
    await accrueSickLeaveForEntry(prisma, e2.id);
    const bal = await prisma.timeOffBalance.findUnique({
      where: { associateId_category: { associateId: a.id, category: 'SICK' } },
    });
    // Each 40h entry yields 60 min; two entries → 120 min.
    expect(bal?.balanceMinutes).toBe(120);
  });

  it('throws if the entry id does not exist', async () => {
    await expect(
      accrueSickLeaveForEntry(prisma, '00000000-0000-4000-8000-000000000000')
    ).rejects.toThrow(/not found/);
  });
});
