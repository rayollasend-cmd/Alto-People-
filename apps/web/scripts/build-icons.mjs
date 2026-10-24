#!/usr/bin/env node
/**
 * Builds the app's icons (docs/design-system.md §6) from Phosphor's raw SVGs
 * (@phosphor-icons/core, MIT), with only the weights each icon is used at.
 *
 * Call sites import Lucide's names from '@/components/ui/icons' and keep them;
 * scripts/icons/lucide-to-phosphor.json says which Phosphor glyph each name
 * draws (matched by meaning, one glyph per concept). This script:
 *
 *   1. parses every TS/TSX file under src/ and .storybook/ (the TypeScript
 *      compiler, not regexes) for the names imported from the icon module;
 *      weights come from the app's own files, not its tests and stories;
 *   2. works out the weights each glyph needs —
 *        bold     always (every interface icon up to 24 px);
 *        fill     used with `icon-active` (the current nav row or tab): an
 *                 icon tag whose className says icon-active, or — where a
 *                 file puts icon-active on an icon it was handed (`<Icon>`)
 *                 — every icon that file, or a module it imports, holds as a
 *                 value (the nav's MODULE_ICONS, the tab bar's tab list);
 *        duotone  sized h-8 (32 px) or larger, an illustration — found the
 *                 same two ways;
 *   3. reads those SVGs, rounds every path number to one decimal (a tenth of
 *      a unit on a 256-unit grid: invisible), and writes one module per glyph
 *      in src/components/ui/icons/glyphs/ plus the barrel
 *      src/components/ui/icons/generated.tsx that exports each glyph under
 *      every Lucide name mapped to it (so names that mean the same thing are
 *      the same component).
 *
 * One module per glyph, not one file: Rollup puts a module in exactly one
 * chunk, so per-glyph modules let an icon travel with the page that uses
 * it, and vite.config.ts groups the shared ones into the `icons` chunk.
 *
 *   node scripts/build-icons.mjs          write the generated files
 *   node scripts/build-icons.mjs --check  fail if they are stale, or an
 *                                         imported name has no mapping
 *   node scripts/build-icons.mjs --json   print the plan (name → glyph, weights)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const ICONS = join(SRC, 'components/ui/icons');
const GLYPHS = join(ICONS, 'glyphs');
const BARREL = join(ICONS, 'generated.tsx');
const MAPPING = join(ROOT, 'scripts/icons/lucide-to-phosphor.json');
const ASSETS = dirname(dirname(createRequire(import.meta.url).resolve('@phosphor-icons/core/assets/bold/x-bold.svg')));
const HEADER = '// generated — do not edit; run npm -w apps/web run icons:build';
/** Names the icon module exports that are not icons. */
const NOT_ICONS = new Set(['Icon', 'IconProps', 'LucideIcon', 'LucideProps', 'Glyph', 'createIcon']);

const CHECK = process.argv.includes('--check');
const JSON_OUT = process.argv.includes('--json');

// ---------------------------------------------------------------- the scan

function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === ICONS) continue;
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The module a specifier names, if it is one of ours. */
function resolveImport(from, spec) {
  let base;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return existsSync(base) && statSync(base).isDirectory() ? base : null;
}
const isIconModule = (from, spec) => {
  const r = resolveImport(from, spec);
  return r === ICONS || r === join(ICONS, 'index.ts');
};

const ACTIVE = /icon-active/;
/** h-8 (32 px) and up — an illustration. */
const big = (text) => [...text.matchAll(/(?:^|[\s'"`:])(?:h|size)-(\d+)(?=$|[\s'"`])/g)].some((m) => Number(m[1]) >= 8);
/** A tag that renders an icon handed in from elsewhere: Icon, tone.Icon, v.icon, StepIcon. */
const HANDED = /(?:^|\.)(?:icon|Icon|[A-Z]\w*Icon)$/;

const files = new Map(); // path → { names: Set, values: Set, imports: [path], handedActive, handedBig }
const used = new Map(); // Lucide name → [where]
const fill = new Set();
const duotone = new Set();

for (const file of [...sourceFiles(SRC), ...sourceFiles(join(ROOT, '.storybook'))]) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const info = { values: new Set(), imports: [], handedActive: false, handedBig: false };
  const local = new Map(); // local binding → Lucide name
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) && !ts.isExportDeclaration(st)) continue;
    if (!st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const target = resolveImport(file, spec);
    if (target && statSync(target).isFile()) info.imports.push(target);
    if (!isIconModule(file, spec)) continue;
    const bindings = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : st.exportClause;
    if (!bindings || !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) continue;
    const typeOnly = ts.isImportDeclaration(st) ? !!st.importClause?.isTypeOnly : st.isTypeOnly;
    for (const el of bindings.elements) {
      const name = (el.propertyName ?? el.name).text;
      if (typeOnly || el.isTypeOnly || NOT_ICONS.has(name)) continue;
      local.set(el.name.text, name);
      used.set(name, [...(used.get(name) ?? []), relative(ROOT, file)]);
      if (ts.isExportDeclaration(st)) info.values.add(name);
    }
  }
  const visit = (node) => {
    const o = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (o) {
      const tag = o.tagName.getText();
      let cls = '';
      let size = 0;
      for (const a of o.attributes.properties) {
        if (!ts.isJsxAttribute(a)) continue;
        if (a.name.getText() === 'className' && a.initializer) cls = a.initializer.getText();
        if (a.name.getText() === 'size' && a.initializer) size = Number(/\d+/.exec(a.initializer.getText())?.[0] ?? 0);
      }
      const isBig = big(cls) || size >= 32;
      if (local.has(tag)) {
        if (ACTIVE.test(cls)) fill.add(local.get(tag));
        if (isBig) duotone.add(local.get(tag));
      } else if (HANDED.test(tag)) {
        if (ACTIVE.test(cls)) info.handedActive = true;
        if (isBig) info.handedBig = true;
      }
    }
    // An icon held as a value: `icon: Inbox`, `const Icon = ok ? Check : X`, `export { Award }`.
    if (ts.isIdentifier(node) && local.has(node.text)) {
      const p = node.parent;
      const asTag = (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === node;
      const inImport = ts.isImportSpecifier(p) || ts.isImportClause(p);
      let inType = false;
      for (let q = p; q && !inType; q = q.parent) inType = ts.isTypeNode(q);
      if (!asTag && !inImport && !inType) info.values.add(local.get(node.text));
    }
    ts.forEachChild(node, visit);
  };
  // Tests, stories and the Storybook shell import names (which must exist)
  // but say nothing about how the app draws them.
  if (!/\/__tests__\/|\.(test|stories)\.tsx?$/.test(file) && !relative(ROOT, file).startsWith('.storybook')) visit(sf);
  files.set(file, info);
}

// A file that draws an icon it was handed at an illustration size: the icons
// it holds may land there (`const Icon = ok ? ShieldCheck : ShieldAlert`).
// One that marks a handed icon active is a nav surface: the icons it holds,
// and the icons the modules it imports hold (lib/moduleIcons' MODULE_ICONS,
// the tab bar's tabs), may land there.
for (const [, info] of files) {
  if (info.handedBig) for (const name of info.values) duotone.add(name);
  if (!info.handedActive) continue;
  const reach = new Set(info.values);
  for (const dep of info.imports) for (const v of files.get(dep)?.values ?? []) reach.add(v);
  for (const name of reach) fill.add(name);
}

// ---------------------------------------------------------------- the mapping

const problems = [];
const mappingText = readFileSync(MAPPING, 'utf8');
const mapping = JSON.parse(mappingText);
const keys = Object.keys(mapping);
const sorted = [...keys].sort();
if (keys.join() !== sorted.join()) problems.push(`${relative(ROOT, MAPPING)} is not sorted by name`);
for (const [name, glyph] of Object.entries(mapping)) {
  if (!existsSync(join(ASSETS, 'bold', `${glyph}-bold.svg`))) problems.push(`${name} → "${glyph}": no such Phosphor glyph`);
}
const unmapped = [...used.keys()].filter((n) => !(n in mapping)).sort();
for (const n of unmapped) {
  problems.push(`${n} is imported (${used.get(n)[0]}) but has no Phosphor glyph — add it to scripts/icons/lucide-to-phosphor.json, matched by meaning`);
}

// ---------------------------------------------------------------- the paths

const ARITY = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };
const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Absolute end point of every segment, to compare a rounded path with its source. */
function endPoints(d) {
  const t = d.match(TOKEN);
  const pts = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  while (i < t.length) {
    if (/[a-z]/i.test(t[i])) cmd = t[i++];
    const C = cmd.toUpperCase(), rel = cmd !== C;
    if (C === 'Z') { x = sx; y = sy; pts.push([x, y]); continue; }
    const v = t.slice(i, i + ARITY[C]).map(Number);
    i += ARITY[C];
    if (C === 'H') x = (rel ? x : 0) + v[0];
    else if (C === 'V') y = (rel ? y : 0) + v[0];
    else { x = (rel ? x : 0) + v.at(-2); y = (rel ? y : 0) + v.at(-1); }
    if (C === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
    pts.push([x, y]);
  }
  return pts;
}

const r1 = (v) => Math.round(v * 10) / 10;
function fmt(v) {
  const s = String(r1(v));
  return s === '-0' ? '0' : s.replace(/^(-?)0\./, '$1.');
}

/**
 * Every number to one decimal. A relative coordinate is rounded against
 * where the rounded path has actually got to, not the exact one, so the
 * error never adds up along a path: every point stays within 0.05 units.
 */
function roundPath(d) {
  const t = d.match(TOKEN);
  if (t.join('').length !== d.replace(/[\s,]/g, '').length) throw new Error(`unparsed path: ${d.slice(0, 60)}…`);
  let out = '', prev = null;
  const num = (s) => {
    if (prev !== null && !(s[0] === '-' || (s[0] === '.' && prev.includes('.')))) out += ',';
    out += s;
    prev = s;
  };
  let i = 0, cmd = '';
  let ex = 0, ey = 0, rx = 0, ry = 0, sx = 0, sy = 0, srx = 0, sry = 0;
  while (i < t.length) {
    if (/[a-z]/i.test(t[i])) { cmd = t[i++]; out += cmd; prev = null; }
    const C = cmd.toUpperCase(), rel = cmd !== C;
    if (C === 'Z') { ex = sx; ey = sy; rx = srx; ry = sry; continue; }
    const v = t.slice(i, i + ARITY[C]).map(Number);
    i += ARITY[C];
    // A point (x, y): exact absolute position, then what to write.
    const pt = (dx, dy) => {
      const ax = rel ? ex + dx : dx, ay = rel ? ey + dy : dy;
      const ox = rel ? r1(ax - rx) : r1(ax), oy = rel ? r1(ay - ry) : r1(ay);
      return { ax, ay, ox, oy, nx: r1(rel ? rx + ox : ox), ny: r1(rel ? ry + oy : oy) };
    };
    let end;
    if (C === 'H') {
      const ax = rel ? ex + v[0] : v[0], o = rel ? r1(ax - rx) : r1(ax);
      num(fmt(o));
      end = { ax, ay: ey, nx: r1(rel ? rx + o : o), ny: ry };
    } else if (C === 'V') {
      const ay = rel ? ey + v[0] : v[0], o = rel ? r1(ay - ry) : r1(ay);
      num(fmt(o));
      end = { ax: ex, ay, nx: rx, ny: r1(rel ? ry + o : o) };
    } else if (C === 'A') {
      num(fmt(v[0])); num(fmt(v[1])); num(fmt(v[2])); num(String(v[3])); num(String(v[4]));
      end = pt(v[5], v[6]);
      num(fmt(end.ox)); num(fmt(end.oy));
    } else {
      for (let k = 0; k < v.length; k += 2) {
        const p = pt(v[k], v[k + 1]);
        num(fmt(p.ox)); num(fmt(p.oy));
        end = p;
      }
    }
    ex = end.ax; ey = end.ay; rx = end.nx; ry = end.ny;
    if (C === 'M') { sx = ex; sy = ey; srx = rx; sry = ry; cmd = rel ? 'l' : 'L'; }
  }
  const a = endPoints(d), b = endPoints(out);
  if (a.length !== b.length || a.some(([x, y], k) => Math.abs(x - b[k][0]) > 0.051 || Math.abs(y - b[k][1]) > 0.051)) {
    throw new Error(`rounding moved a point: ${d.slice(0, 60)}…`);
  }
  return out;
}

function readGlyph(glyph, weight) {
  const svg = readFileSync(join(ASSETS, weight, `${glyph}-${weight}.svg`), 'utf8');
  const paths = [...svg.matchAll(/<path d="([^"]+)"(?: opacity="([^"]+)")?\/>/g)].map((m) => ({ d: roundPath(m[1]), opacity: m[2] }));
  const rest = svg.replace(/<path [^>]*\/>/g, '').replace(/<svg [^>]*>|<\/svg>/g, '').trim();
  if (rest || paths.length === 0) throw new Error(`${glyph}-${weight}.svg: unexpected markup`);
  return paths;
}

// ---------------------------------------------------------------- the output

const pascal = (kebab) => kebab.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const q = (s) => `'${s}'`;
const list = (ps) => (ps.length === 1 ? q(ps[0]) : `[${ps.map(q).join(', ')}]`);

const byGlyph = new Map(); // glyph → { names: [], weights: Set }
for (const name of [...used.keys()].sort()) {
  const glyph = mapping[name];
  if (!glyph) continue;
  const g = byGlyph.get(glyph) ?? { names: [], weights: new Set(['bold']) };
  g.names.push(name);
  if (fill.has(name)) g.weights.add('fill');
  if (duotone.has(name)) g.weights.add('duotone');
  byGlyph.set(glyph, g);
}

const expected = new Map(); // path → content
if (problems.length === 0) {
  for (const [glyph, g] of [...byGlyph].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const parts = [`  b: ${list(readGlyph(glyph, 'bold').map((p) => p.d))},`];
    if (g.weights.has('fill')) parts.push(`  f: ${list(readGlyph(glyph, 'fill').map((p) => p.d))},`);
    if (g.weights.has('duotone')) {
      const ps = readGlyph(glyph, 'duotone');
      const tint = ps.filter((p) => p.opacity);
      if (tint.length > 1) throw new Error(`${glyph}-duotone.svg: more than one tint layer`);
      parts.push(`  d: [${[tint[0]?.d ?? '', ...ps.filter((p) => !p.opacity).map((p) => p.d)].map(q).join(', ')}],`);
    }
    expected.set(
      join(GLYPHS, `${glyph}.ts`),
      [
        HEADER,
        `// Phosphor "${glyph}" (${[...g.weights].join(', ')}), drawn for ${g.names.join(', ')}.`,
        `import { createIcon } from '../createIcon';`,
        '',
        `export const ${pascal(glyph)} = /* @__PURE__ */ createIcon(${q(pascal(glyph))}, {`,
        ...parts,
        '});',
        '',
      ].join('\n'),
    );
  }
  const barrel = [
    HEADER,
    '// Every Lucide name the app imports, as the Phosphor glyph scripts/icons/lucide-to-phosphor.json maps it to.',
    ...[...byGlyph].flatMap(([glyph, g]) => g.names.map((n) => [n, glyph])).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([n, glyph]) => `export { ${pascal(glyph)} as ${n} } from './glyphs/${glyph}';`),
    '',
  ].join('\n');
  expected.set(BARREL, barrel);
}

if (JSON_OUT) {
  const plan = Object.fromEntries([...byGlyph].flatMap(([glyph, g]) => g.names.map((n) => [n, { glyph, weights: [...g.weights] }])));
  console.log(JSON.stringify(plan, null, 2));
  process.exit(problems.length ? 1 : 0);
}

const unusedMappings = keys.filter((k) => !used.has(k));
const summary = () => {
  const w = (k) => [...byGlyph.values()].filter((g) => g.weights.has(k)).length;
  const bytes = [...expected.values()].reduce((s, c) => s + c.length, 0);
  return `icons: ${used.size} names → ${byGlyph.size} glyphs (fill ${w('fill')}, duotone ${w('duotone')}), ${(bytes / 1024).toFixed(1)} KB source` +
    (unusedMappings.length ? `; ${unusedMappings.length} mapped name(s) no file imports: ${unusedMappings.join(', ')}` : '');
};

if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  console.error(`icons: ${problems.length} problem(s)`);
  process.exit(1);
}

const onDisk = new Map();
if (existsSync(GLYPHS)) for (const f of readdirSync(GLYPHS)) onDisk.set(join(GLYPHS, f), readFileSync(join(GLYPHS, f), 'utf8'));
if (existsSync(BARREL)) onDisk.set(BARREL, readFileSync(BARREL, 'utf8'));
const stale = [
  ...[...expected].filter(([p, c]) => onDisk.get(p) !== c).map(([p]) => (onDisk.has(p) ? `changed  ${relative(ROOT, p)}` : `missing  ${relative(ROOT, p)}`)),
  ...[...onDisk.keys()].filter((p) => !expected.has(p)).map((p) => `extra    ${relative(ROOT, p)}`),
];

if (CHECK) {
  if (stale.length) {
    for (const s of stale.slice(0, 20)) console.error(`  ${s}`);
    if (stale.length > 20) console.error(`  … ${stale.length - 20} more`);
    console.error('icons: the generated icons are out of date — run `npm -w apps/web run icons:build` and commit the result.');
    process.exit(1);
  }
  console.log(summary());
  process.exit(0);
}

mkdirSync(GLYPHS, { recursive: true });
for (const p of onDisk.keys()) if (!expected.has(p)) rmSync(p);
for (const [p, c] of expected) if (onDisk.get(p) !== c) writeFileSync(p, c);
console.log(`${summary()}; ${stale.length} file(s) written or removed`);
