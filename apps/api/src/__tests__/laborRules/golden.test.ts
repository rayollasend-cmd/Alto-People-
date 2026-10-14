import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { GOLDEN_ASSOCIATES, GOLDEN_PERIOD, goldenTx, goldenView } from '../../../test/laborGolden.js';

// The golden sits beside this file (src/__tests__/laborRules/golden/), whatever directory vitest runs from.
const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'florida-biweekly.json');

/**
 * Brief 2-2, step 0 — today's pay, frozen.
 *
 *   Eleven real-shaped weeks run through today's engine and must produce
 *   the golden file byte for byte. A difference here means pay changed:
 *   that is either a bug, or an approved change whose golden is rewritten
 *   on purpose (npx tsx scripts/labor-golden.ts --write) in the same
 *   commit. The labor-rules engine's Florida pack must reproduce this file
 *   to the cent before it ever pays anyone (docs/labor-rules-investigation.md §6).
 *
 *   The fixtures answer the engine's reads here; goldenDb.test.ts seeds the
 *   same weeks into Postgres and must produce the same file.
 */

const golden = readFileSync(GOLDEN_PATH, 'utf8');

describe("today's pay engine, frozen", () => {
  it('reproduces the golden file for every fixture week', async () => {
    const result = await aggregatePayrollProjection(goldenTx() as unknown as PrismaClient, GOLDEN_PERIOD);
    expect(JSON.stringify(goldenView(result), null, 2) + '\n').toBe(golden);
  });

  it('covers every fixture, and each says what it pins', () => {
    const items = (JSON.parse(golden) as { items: Record<string, unknown> }).items;
    for (const a of GOLDEN_ASSOCIATES) {
      expect(items[a.key], a.key).toBeTruthy();
      expect(a.why.length, a.key).toBeGreaterThan(10);
    }
  });

  it('pins the behaviours the Florida pack must keep', () => {
    const items = (JSON.parse(golden) as { items: Record<string, { regularHours: number; overtimeHours: number; hourlyRate: number; grossPay: number; rateSource: string }> }).items;
    // Weekly 40 at 1.5x, the company week in the site's zone.
    expect(items['ot-42-split-shift']).toMatchObject({ regularHours: 40, overtimeHours: 2 });
    expect(items['central-friday-night']).toMatchObject({ regularHours: 40, overtimeHours: 2 });
    expect(items['overnight-friday']).toMatchObject({ regularHours: 64, overtimeHours: 8 });
    // Net of breaks; no daily overtime in Florida.
    expect(items['breaks-docked']).toMatchObject({ regularHours: 49.5, overtimeHours: 0 });
    // Today's engine pays the open compensation record for the whole period.
    expect(items['rate-change-mid-period']).toMatchObject({ hourlyRate: 16.5, grossPay: 264 });
    expect(items['default-rate']).toMatchObject({ rateSource: 'DEFAULT', hourlyRate: 15 });
    expect(items.salaried).toMatchObject({ rateSource: 'SALARY', grossPay: 2000 });
  });
});
