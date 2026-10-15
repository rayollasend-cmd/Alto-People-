#!/usr/bin/env node
/**
 * Design lint (design system step 1, 2026-10-15; docs/design-system.md §7).
 *
 * Counts, per page file, the patterns the system retires, and compares the
 * counts with apps/web/design-baseline.json. A file whose count RISES fails
 * the run: new code cannot add to the debt; old debt is paid down and the
 * baseline shrinks with it (the same rule as the cross-tenant baseline).
 *
 *   node scripts/design-lint.mjs            check against the baseline
 *   node scripts/design-lint.mjs --write    rewrite the baseline from this tree
 *
 * Patterns (each is a job the UI kit already does):
 *   brand-text     `text-white` on page code: ink that depends on the light-mode override rules; use text-ink
 *   hex            an inline #rrggbb in TSX: colour outside the tokens
 *   pill           a hand-rolled `rounded-full px-2 py-0.5` status pill: use <Badge>
 *   empty-text     a bare "No … yet" / "Nothing …" sentence: use <EmptyState>
 *   raw-heading    an <h1> or <h2 className=…> in a page: use <PageHeader> / <SectionTitle>
 *   loading-text   a literal "Loading…" string: use <Skeleton> / <SkeletonRows>
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const BASELINE = join(ROOT, 'design-baseline.json');

const PATTERNS = {
  'brand-text': /\btext-white\b/g,
  hex: /#[0-9a-fA-F]{6}\b/g,
  pill: /rounded-full[^"'`]*px-2[^"'`]*py-0\.5|px-2[^"'`]*py-0\.5[^"'`]*rounded-full/g,
  'empty-text': />\s*(No [a-z][^<{]{2,60} yet|Nothing [^<{]{2,60})\.?\s*</g,
  'raw-heading': /<h[12]\s+className=/g,
  'loading-text': />\s*Loading(…|\.\.\.)\s*</g,
};

/** Page code only: the UI kit and lib are where the patterns are supposed to live. */
function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const counts = {};
for (const f of [...files(join(SRC, 'pages')), ...files(join(SRC, 'components')).filter((p) => !p.includes(`${join('components', 'ui')}`))]) {
  const text = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  const row = {};
  for (const [key, re] of Object.entries(PATTERNS)) {
    const n = (text.match(re) ?? []).length;
    if (n) row[key] = n;
  }
  if (Object.keys(row).length) counts[rel] = row;
}

const totals = {};
for (const row of Object.values(counts)) for (const [k, n] of Object.entries(row)) totals[k] = (totals[k] ?? 0) + n;

if (process.argv.includes('--write')) {
  writeFileSync(BASELINE, JSON.stringify({ _comment: 'Design-lint baseline: per-file counts of the patterns the design system retires. Only ever shrinks; a rising count fails CI. Regenerate with `node scripts/design-lint.mjs --write` after paying debt down.', totals, files: counts }, null, 2) + '\n');
  console.log('design-lint: baseline written', totals);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
} catch {
  console.error('design-lint: no baseline; run with --write first');
  process.exit(2);
}
const failures = [];
for (const [file, row] of Object.entries(counts)) {
  const was = baseline.files[file] ?? {};
  for (const [k, n] of Object.entries(row)) {
    if (n > (was[k] ?? 0)) failures.push(`${file}: ${k} ${was[k] ?? 0} -> ${n}`);
  }
}
const paid = Object.entries(baseline.totals ?? {}).map(([k, was]) => [k, was - (totals[k] ?? 0)]).filter(([, d]) => d > 0);
console.log('design-lint totals:', Object.entries(totals).map(([k, n]) => `${k}=${n} (baseline ${baseline.totals?.[k] ?? 0})`).join(', '));
if (paid.length) console.log('design-lint: debt paid since the baseline:', paid.map(([k, d]) => `${k} -${d}`).join(', '), '— run --write to lock it in');
if (failures.length) {
  console.error(`design-lint: ${failures.length} file(s) added to the design debt:\n  ${failures.join('\n  ')}\n\nUse the UI kit instead (text-ink, <Badge>, <EmptyState>, <PageHeader>/<SectionTitle>, <Skeleton>, the colour tokens). See docs/design-system.md.`);
  process.exit(1);
}
console.log('design-lint: ok');
