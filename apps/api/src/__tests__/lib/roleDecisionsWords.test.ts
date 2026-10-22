import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { computeRoleDecisions, dayWords, ownsContractDuties } from '../../lib/roleDecisions.js';

/**
 * The decision queue speaks plainly (F500 SH-4): days in words, one age per
 * receivable (days past due — the age Finance's receivables show), contract
 * duties only on the compliance desk, and each decision once.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;

describe('dayWords', () => {
  const now = new Date('2026-10-22T15:00:00Z');
  it('a calendar day in words, with the year only when it is not this one', () => {
    expect(dayWords('2026-10-24', now)).toBe('Sat, Oct 24');
    expect(dayWords('2025-12-31', now)).toBe('Wed, Dec 31, 2025');
    // A date-only column is read at UTC midnight: still its own day, never the day before.
    expect(dayWords(new Date('2026-01-31T00:00:00.000Z'), now)).toBe('Sat, Jan 31');
  });
});

describe('who owns contract duties', () => {
  it('the HR desk; never the recruiter, ops, workforce or a manager', () => {
    expect(ownsContractDuties({ role: 'HR_ADMINISTRATOR' })).toBe(true);
    for (const role of ['INTERNAL_RECRUITER', 'OPERATIONS_MANAGER', 'WORKFORCE_MANAGER', 'MANAGER', 'FINANCE_ACCOUNTANT', 'ASSOCIATE'] as const) {
      expect(ownsContractDuties({ role }), role).toBe(false);
    }
  });
});

describe('a receivable has one age', () => {
  it('days past due and the due day, with the amount — not days since it was sent', async () => {
    const client = await createClient('Coastal Resort Holdings');
    const now = new Date();
    const dueAt = new Date(`${new Date(now.getTime() - 44 * DAY).toISOString().slice(0, 10)}T00:00:00.000Z`);
    await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-07-01'),
        periodEnd: new Date('2026-07-07'),
        status: 'FINAL',
        number: 3,
        snapshot: { totals: { amount: 2880 } },
        finalizedAt: new Date(now.getTime() - 73 * DAY),
        dueAt,
      },
    });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const q = await computeRoleDecisions(prisma, { id: user.id, role: 'FINANCE_ACCOUNTANT', clientId: null, associateId: null }, now);
    const item = q.find((d) => d.key.startsWith('receivable:'))!;
    expect(item.label).toBe('Chase Coastal Resort Holdings statement #3');
    expect(item.ageDays).toBe(44);
    expect(item.detail).toBe(`$2,880.00 · 44 days past due (due ${dayWords(dueAt, now)}) — chase the cash or flag it upward.`);
    // Each key once.
    expect(new Set(q.map((d) => d.key)).size).toBe(q.length);
  });
});
