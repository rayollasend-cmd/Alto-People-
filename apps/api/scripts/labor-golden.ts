/**
 * Brief 2-2, step 0 — write (or check) the golden file of today's pay.
 *
 *   npx tsx scripts/labor-golden.ts           check: exit 1 and print the diff if today's engine differs
 *   npx tsx scripts/labor-golden.ts --write   freeze today's engine output as the golden file
 *
 * Writing is for the day the golden is first captured, or for a pay change
 * the owner has approved; the CI tests (src/__tests__/laborRules) fail on any
 * difference. Read-only against the database: it touches none (the fixtures
 * answer the engine's reads).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { aggregatePayrollProjection } from '../src/lib/payrollAggregator.js';
import { __setPayrollTaxConfigForTesting } from '../src/lib/payrollTax.js';
import { GOLDEN_FILE, GOLDEN_PERIOD, GOLDEN_TAX_CONFIG, goldenTx, goldenView } from '../test/laborGolden.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, GOLDEN_FILE);
// Taxes are outside the golden; the engine needs a configuration loaded to finish.
__setPayrollTaxConfigForTesting(GOLDEN_TAX_CONFIG);

const result = await aggregatePayrollProjection(goldenTx() as unknown as PrismaClient, GOLDEN_PERIOD);
const text = JSON.stringify(goldenView(result), null, 2) + '\n';

if (process.argv.includes('--write')) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`Wrote ${GOLDEN_FILE} (${result.items.length} items, gross ${result.totals.totalGross}).`);
} else if (!existsSync(path)) {
  console.error(`No golden file at ${GOLDEN_FILE}; run with --write to capture it.`);
  process.exit(1);
} else if (readFileSync(path, 'utf8') === text) {
  console.log(`Today's engine matches ${GOLDEN_FILE}.`);
} else {
  console.error(`Today's engine DIFFERS from ${GOLDEN_FILE}:`);
  console.error(text);
  process.exit(1);
}
