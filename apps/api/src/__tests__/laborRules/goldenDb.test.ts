import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, truncateAll } from '../../../test/db.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import {
  GOLDEN_ASSOCIATES,
  GOLDEN_CLIENTS,
  GOLDEN_PERIOD,
  GOLDEN_PREMIUM_RULES,
  GOLDEN_SITES,
  goldenView,
} from '../../../test/laborGolden.js';

// The golden sits beside this file (src/__tests__/laborRules/golden/), whatever directory vitest runs from.
const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'florida-biweekly.json');

/**
 * Brief 2-2, step 0 — the golden, through the database.
 *
 *   The same fixture weeks seeded into Postgres, run through today's engine
 *   with the real client: the result must be the golden file, byte for
 *   byte. This is what proves the stand-in in golden.test.ts filters the way
 *   the database does (status, period, the open compensation record, the
 *   client's active rules), so the frozen numbers are the numbers pay runs
 *   produce.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedGolden() {
  for (const c of Object.values(GOLDEN_CLIENTS)) {
    await prisma.client.create({ data: { id: c.id, name: c.name, industry: 'hospitality', status: 'ACTIVE', state: c.state } });
  }
  for (const s of Object.values(GOLDEN_SITES)) {
    await prisma.site.create({ data: { id: s.id, clientId: s.clientId, name: s.name, state: s.state, timezone: s.timezone } });
  }
  for (const r of GOLDEN_PREMIUM_RULES) {
    await prisma.premiumPayRule.create({
      data: {
        id: r.id,
        clientId: r.clientId,
        name: r.name,
        kind: r.kind,
        multiplier: r.multiplier,
        addPerHour: r.addPerHour,
        thresholdHours: r.thresholdHours,
        startMinute: r.startMinute,
        endMinute: r.endMinute,
        dowMask: r.dowMask,
        isActive: r.isActive,
      },
    });
  }
  for (const a of GOLDEN_ASSOCIATES) {
    await prisma.associate.create({
      data: { id: a.id, firstName: a.firstName, lastName: a.lastName, email: `${a.key}@golden.example.com`, state: a.state },
    });
    for (const c of a.comps) {
      await prisma.compensationRecord.create({
        data: { associateId: a.id, payType: c.payType, amount: c.amount, currency: 'USD', reason: 'HIRE', effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo },
      });
    }
    for (const e of a.entries) {
      const site = GOLDEN_SITES[e.site];
      await prisma.timeEntry.create({
        data: {
          associateId: a.id,
          clientId: site.clientId,
          locationId: site.id,
          clockInAt: e.clockInAt,
          clockOutAt: e.clockOutAt,
          status: e.status,
          breaks: { create: e.breaks.map((b) => ({ type: b.type, startedAt: b.startedAt, endedAt: b.endedAt })) },
        },
      });
    }
  }
}

describe("today's pay engine, frozen, through the database", () => {
  it('the seeded weeks produce the golden file byte for byte', async () => {
    await seedGolden();
    const result = await aggregatePayrollProjection(prisma, GOLDEN_PERIOD);
    const golden = readFileSync(GOLDEN_PATH, 'utf8');
    expect(JSON.stringify(goldenView(result), null, 2) + '\n').toBe(golden);
  });
});
