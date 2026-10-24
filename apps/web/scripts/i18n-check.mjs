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
 *      in, a higher count fails the commit that added the string;
 *   4. the same, for the screens the floor, the supervisors and the drivers
 *      read (scripts/i18n-floor-files.txt against i18n-floor-baseline.json,
 *      role walk floor 10). Their keys need English and Spanish (rule 2);
 *      the six-language rule stays with the associate app.
 *
 *   node scripts/i18n-check.mjs            # check
 *   node scripts/i18n-check.mjs --write    # lock a smaller baseline in
 *
 * The hard-coded-text heuristic reads JSX text nodes and the attributes a
 * person can see (placeholder, title, aria-label, alt, label) that start
 * with a capital letter and are not produced by t(); the allowlist holds
 * brand names, codes and form numbers that are the same in every language.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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
  if (i < 0) i = source.indexOf('\nexport const ' + name + ' = {');
  if (i < 0) throw new Error(`i18n-check: no dictionary "${name}"`);
  const ends = ['\n} as const;', '\n};'].map((m) => source.indexOf(m, i)).filter((x) => x > 0);
  const body = source.slice(i, Math.min(...ends));
  const keys = new Set();
  for (const m of body.matchAll(/^ {2}'([^']+)':(?: |$)/gm)) keys.add(m[1]);
  return keys;
}

// English: the core pack plus one area pack per key prefix (src/lib/i18n/en).
const EN_DIR = join(root, 'src/lib/i18n/en');
const packName = (file) => 'en' + file[0].toUpperCase() + file.slice(1, -3);
const areaPacks = readdirSync(EN_DIR).filter((f) => f.endsWith('.ts') && !['core.ts', 'keys.ts', 'all.ts'].includes(f));
const enCore = readDictionary(readFileSync(join(EN_DIR, 'core.ts'), 'utf8'), 'enCore');
const enByPack = new Map(areaPacks.map((f) => [f.slice(0, -3), readDictionary(readFileSync(join(EN_DIR, f), 'utf8'), packName(f))]));
const dictionaries = {
  en: new Set([enCore, ...enByPack.values()].flatMap((s) => [...s])),
  es: readDictionary(readFileSync(join(root, 'src/lib/i18n/es.ts'), 'utf8'), 'es'),
  tr: new Set([...readDictionary(readFileSync(join(root, 'src/lib/i18n/trStaff.ts'), 'utf8'), 'tr'), ...readDictionary(readFileSync(join(root, 'src/lib/i18n/tr.ts'), 'utf8'), 'tr')]),
  ht: readDictionary(readFileSync(join(root, 'src/lib/i18n/ht.ts'), 'utf8'), 'ht'),
  pt: readDictionary(readFileSync(join(root, 'src/lib/i18n/pt.ts'), 'utf8'), 'pt'),
  uk: readDictionary(readFileSync(join(root, 'src/lib/i18n/uk.ts'), 'utf8'), 'uk'),
};

const listOf = (name) =>
  readFileSync(join(here, name), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
const associateFiles = listOf('i18n-associate-files.txt');
const floorFiles = listOf('i18n-floor-files.txt');
const allow = JSON.parse(readFileSync(join(here, 'i18n-allowlist.json'), 'utf8')).map((p) => new RegExp(p));
const baselinePath = join(here, 'i18n-baseline.json');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
const floorBaselinePath = join(here, 'i18n-floor-baseline.json');
const floorBaseline = existsSync(floorBaselinePath) ? JSON.parse(readFileSync(floorBaselinePath, 'utf8')) : {};

/** User-visible English in a file that t() does not produce — the heuristic in the header. */
function hardCodedIn(source) {
  const found = [];
  source.split('\n').forEach((line, idx) => {
    if (line.includes('t(') || line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
    const candidates = [];
    for (const m of line.matchAll(/>\s*([A-Z][A-Za-z][^<>{}]{2,})\s*</g)) candidates.push(m[1].trim());
    for (const m of line.matchAll(/\b(?:placeholder|title|aria-label|alt|label)="([A-Z][^"{}]{2,})"/g)) candidates.push(m[1].trim());
    for (const text of candidates) {
      if (allow.some((re) => re.test(text))) continue;
      found.push(`${idx + 1}: ${text}`);
    }
  });
  return found;
}

const used = new Set();
const dynamicPrefixes = new Set();
const hardCoded = {};
for (const file of associateFiles) {
  const source = readFileSync(join(root, file), 'utf8');
  for (const m of source.matchAll(/\bt\('([A-Za-z0-9_.-]+)'/g)) used.add(m[1]);
  for (const m of source.matchAll(/\bt\(`([A-Za-z0-9_.-]+)\./g)) dynamicPrefixes.add(m[1]);
  hardCoded[file] = hardCodedIn(source);
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

// 4. The floor's screens: hard-coded text against their own baseline; their
// keys must be defined (and, by rule 2, in Spanish).
let floorDebt = 0;
let floorPaid = 0;
const floorNext = {};
for (const file of floorFiles) {
  const source = readFileSync(join(root, file), 'utf8');
  const unknownKeys = [...source.matchAll(/\bt\('([A-Za-z0-9_.-]+)'/g)].map((m) => m[1]).filter((k) => !dictionaries.en.has(k));
  if (unknownKeys.length) problems.push(`${file}: key(s) used but never defined — ${[...new Set(unknownKeys)].join(', ')}`);
  const found = hardCodedIn(source);
  const allowed = floorBaseline[file] ?? 0;
  floorNext[file] = found.length;
  floorDebt += found.length;
  if (found.length > allowed) {
    problems.push(`${file}: ${found.length} hard-coded string(s), floor baseline ${allowed}:\n    ${found.join('\n    ')}`);
  } else if (found.length < allowed) {
    floorPaid += allowed - found.length;
  }
}

// The English packs. A key lives in exactly one pack, named for its prefix,
// and any module that mentions an area's key imports that area's pack — the
// pack loads with the page, not the main bundle (src/lib/i18n/english.ts).
{
  const seen = new Map();
  for (const [pack, keys] of [['core', enCore], ...enByPack]) {
    for (const k of keys) {
      if (seen.has(k)) problems.push(`'${k}' is in both en/${seen.get(k)}.ts and en/${pack}.ts`);
      seen.set(k, pack);
      if (pack !== 'core' && k.split('.')[0] !== pack) problems.push(`'${k}' belongs in en/${k.split('.')[0]}.ts, not en/${pack}.ts`);
    }
  }
  const areas = new Set(enByPack.keys());
  const mention = /['"`]([a-zA-Z][a-zA-Z0-9]*)\.[a-zA-Z0-9_]/g;
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== '__tests__') walk(full, out);
      } else if (/\.tsx?$/.test(name) && !/\.(test|stories)\.tsx?$|\.d\.ts$/.test(name)) out.push(full);
    }
    return out;
  };
  for (const file of walk(join(root, 'src'))) {
    const rel = file.slice(root.length + 1);
    if (rel.startsWith('src/lib/i18n')) continue;
    const text = readFileSync(file, 'utf8');
    if (/['"]@\/lib\/i18n\/en\/all['"]/.test(text)) problems.push(`${rel} imports en/all — that is for tests and Storybook only`);
    // A whole key that lives in core needs no pack (the shell's labels for other areas).
    const fullKey = /['"]([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+)['"]/g;
    const coreOnly = new Set([...text.matchAll(fullKey)].filter((m) => enCore.has(m[1])).map((m) => m.index));
    const needed = new Set([...text.matchAll(mention)].filter((m) => !coreOnly.has(m.index)).map((m) => m[1]).filter((p) => areas.has(p)));
    for (const p of needed) {
      if (!text.includes(`'@/lib/i18n/en/${p}'`)) problems.push(`${rel} uses '${p}.*' keys but doesn't import '@/lib/i18n/en/${p}'`);
    }
  }
}

console.log(`i18n-check: ${associateKeys.length} associate keys · ${LANGS.map((l) => `${l}=${dictionaries[l].size}`).join(' ')} · hard-coded debt ${debt} · floor debt ${floorDebt}`);
if (write) {
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  writeFileSync(floorBaselinePath, JSON.stringify(floorNext, null, 2) + '\n');
  console.log(`i18n-check: baselines written (${Object.keys(next).length} associate files, ${Object.keys(floorNext).length} floor files).`);
} else if (paid > 0 || floorPaid > 0) {
  console.log(`i18n-check: debt paid since the baseline: ${paid} associate, ${floorPaid} floor — run --write to lock it in`);
}
if (problems.length) {
  console.error('i18n-check: FAIL');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('i18n-check: ok');
