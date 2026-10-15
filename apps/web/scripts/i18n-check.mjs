#!/usr/bin/env node
/* global process, console */
/**
 * Brief 3-6 — the translation gate. Fails the build when:
 *   1. a key the associate app uses is missing in any of the six languages
 *      (EN, ES, TR, HT, PT, UK) — the associate app ships complete;
 *   2. any key in `en` is missing in `es` (the two reviewed languages stay
 *      in step for every surface, admin included);
 *   3. an associate-facing file carries more hard-coded user-visible text
 *      than its line in scripts/i18n-baseline.json allows. The baseline is
 *      the day-one debt and it only shrinks: `--write` locks a lower count
 *      in, a higher count fails the commit that added the string.
 *
 *   node scripts/i18n-check.mjs            # check
 *   node scripts/i18n-check.mjs --write    # lock a smaller baseline in
 *
 * The hard-coded-text heuristic reads JSX text nodes and the attributes a
 * person can see (placeholder, title, aria-label, alt, label) that start
 * with a capital letter and are not produced by t(); the allowlist holds
 * brand names, codes and form numbers that are the same in every language.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const write = process.argv.includes('--write');
const LANGS = ['en', 'es', 'tr', 'ht', 'pt', 'uk'];

function readDictionary(source, name) {
  let i = source.indexOf('\nconst ' + name + ' = {');
  if (i < 0) i = source.indexOf('\nconst ' + name + ':');
  if (i < 0) i = source.indexOf('\nexport const ' + name + ':');
  if (i < 0) throw new Error(`i18n-check: no dictionary "${name}"`);
  const ends = ['\n} as const;', '\n};'].map((m) => source.indexOf(m, i)).filter((x) => x > 0);
  const body = source.slice(i, Math.min(...ends));
  const keys = new Set();
  for (const m of body.matchAll(/^ {2}'([^']+)':(?: |$)/gm)) keys.add(m[1]);
  return keys;
}

const i18nSource = readFileSync(join(root, 'src/lib/i18n.tsx'), 'utf8');
const dictionaries = {
  en: readDictionary(i18nSource, 'en'),
  es: readDictionary(i18nSource, 'es'),
  tr: new Set([...readDictionary(i18nSource, 'tr'), ...readDictionary(readFileSync(join(root, 'src/lib/i18n/tr.ts'), 'utf8'), 'tr')]),
  ht: readDictionary(readFileSync(join(root, 'src/lib/i18n/ht.ts'), 'utf8'), 'ht'),
  pt: readDictionary(readFileSync(join(root, 'src/lib/i18n/pt.ts'), 'utf8'), 'pt'),
  uk: readDictionary(readFileSync(join(root, 'src/lib/i18n/uk.ts'), 'utf8'), 'uk'),
};

const associateFiles = readFileSync(join(here, 'i18n-associate-files.txt'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
const allow = JSON.parse(readFileSync(join(here, 'i18n-allowlist.json'), 'utf8')).map((p) => new RegExp(p));
const baselinePath = join(here, 'i18n-baseline.json');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};

const used = new Set();
const dynamicPrefixes = new Set();
const hardCoded = {};
for (const file of associateFiles) {
  const source = readFileSync(join(root, file), 'utf8');
  for (const m of source.matchAll(/\bt\('([A-Za-z0-9_.-]+)'/g)) used.add(m[1]);
  for (const m of source.matchAll(/\bt\(`([A-Za-z0-9_.-]+)\./g)) dynamicPrefixes.add(m[1]);
  const found = [];
  const lines = source.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('t(') || line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
    const candidates = [];
    for (const m of line.matchAll(/>\s*([A-Z][A-Za-z][^<>{}]{2,})\s*</g)) candidates.push(m[1].trim());
    for (const m of line.matchAll(/\b(?:placeholder|title|aria-label|alt|label)="([A-Z][^"{}]{2,})"/g)) candidates.push(m[1].trim());
    for (const text of candidates) {
      if (allow.some((re) => re.test(text))) continue;
      found.push(`${idx + 1}: ${text}`);
    }
  });
  hardCoded[file] = found;
}
for (const key of dictionaries.en) for (const p of dynamicPrefixes) if (key.startsWith(p + '.')) used.add(key);

const problems = [];

// 1. Associate keys in every language.
const associateKeys = [...used].filter((k) => dictionaries.en.has(k)).sort();
for (const lang of LANGS) {
  const missing = associateKeys.filter((k) => !dictionaries[lang].has(k));
  if (missing.length) problems.push(`${lang}: ${missing.length} associate key(s) missing — ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}`);
}
const unknown = [...used].filter((k) => !dictionaries.en.has(k));
if (unknown.length) problems.push(`en: ${unknown.length} key(s) used but never defined — ${unknown.slice(0, 12).join(', ')}${unknown.length > 12 ? ', …' : ''}`);

// 2. EN and ES in step everywhere.
const esMissing = [...dictionaries.en].filter((k) => !dictionaries.es.has(k));
if (esMissing.length) problems.push(`es: ${esMissing.length} key(s) in en without Spanish — ${esMissing.slice(0, 12).join(', ')}${esMissing.length > 12 ? ', …' : ''}`);

// 3. Hard-coded text, against the baseline.
let debt = 0;
let paid = 0;
const next = {};
for (const file of associateFiles) {
  const count = hardCoded[file].length;
  const allowed = baseline[file] ?? 0;
  next[file] = count;
  debt += count;
  if (count > allowed) {
    problems.push(`${file}: ${count} hard-coded string(s), baseline ${allowed}:\n    ${hardCoded[file].join('\n    ')}`);
  } else if (count < allowed) {
    paid += allowed - count;
  }
}

console.log(`i18n-check: ${associateKeys.length} associate keys · ${LANGS.map((l) => `${l}=${dictionaries[l].size}`).join(' ')} · hard-coded debt ${debt}`);
if (write) {
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  console.log(`i18n-check: baseline written (${Object.keys(next).length} files).`);
} else if (paid > 0) {
  console.log(`i18n-check: debt paid since the baseline: ${paid} — run --write to lock it in`);
}
if (problems.length) {
  console.error('i18n-check: FAIL');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('i18n-check: ok');
