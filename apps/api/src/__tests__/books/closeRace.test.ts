import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, truncateAll } from '../../../test/db.js';
import { ensurePeriod } from '../../lib/books/close/checklist.js';

/** Two people opening a month nobody has opened yet, at the same moment, both get it. */
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('a new month opened twice at once', () => {
  it('makes one month and one checklist, and neither request fails', async () => {
    const [a, b, c] = await Promise.all([ensurePeriod(prisma, '2026-09'), ensurePeriod(prisma, '2026-09'), ensurePeriod(prisma, '2026-09')]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(await prisma.fiscalPeriod.count()).toBe(1);
    const tasks = await prisma.closeTask.count({ where: { periodId: a.id } });
    expect(tasks).toBeGreaterThan(5);
    expect(await prisma.closeTask.count()).toBe(tasks);
  });
});
