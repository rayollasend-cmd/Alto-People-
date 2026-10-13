/**
 * Brief 2-1 — shrink the cross-tenant baseline from a CI log.
 *
 *   The cross-tenant suite prints the baseline routes that no longer leak
 *   ("[cross-tenant] N baseline routes no longer leak — shrink …" followed
 *   by one "METHOD /path" per line). This reads a downloaded API job log,
 *   removes exactly those routes from crossTenant.baseline.json and prints
 *   what it removed. It never adds a route: the baseline only shrinks.
 *
 *   npx tsx scripts/prune-tenant-baseline.ts <api-job.log> [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [logPath, flag] = process.argv.slice(2);
if (!logPath) {
  console.error('usage: npx tsx scripts/prune-tenant-baseline.ts <api-job.log> [--dry-run]');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, '..', 'src', '__tests__', 'tenancy', 'crossTenant.baseline.json');

// GitHub's job log prefixes every line with a timestamp; vitest adds colour codes.
const lines = readFileSync(logPath, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '').replace(/\x1b\[[0-9;]*m/g, ''));

const start = lines.findIndex((l) => /\[cross-tenant\] \d+ baseline routes no longer leak/.test(l));
if (start === -1) {
  console.log('No "baseline routes no longer leak" line in that log: nothing to prune.');
  process.exit(0);
}
const route = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;
const fixed: string[] = [];
for (const l of lines.slice(start + 1)) {
  const t = l.trim();
  if (!route.test(t)) break;
  fixed.push(t);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as { leaks: string[]; prunedAt?: string; leakCount?: number };
const before = baseline.leaks.length;
const drop = new Set(fixed);
baseline.leaks = baseline.leaks.filter((k) => !drop.has(k));
const removed = before - baseline.leaks.length;
baseline.leaks.sort();
baseline.prunedAt = new Date().toISOString();
baseline.leakCount = baseline.leaks.length;

console.log(`Log reports ${fixed.length} fixed; ${removed} removed from the baseline (${before} → ${baseline.leaks.length}).`);
for (const k of fixed) console.log(`  ${drop.has(k) && !baseline.leaks.includes(k) ? '-' : '?'} ${k}`);
if (flag === '--dry-run') {
  console.log('Dry run: baseline not written.');
} else {
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Wrote ${baselinePath}`);
}
