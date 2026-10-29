/// <reference types="node" />
/**
 * Static tables for the contract suites (deep audit 2026-10-29, crawl
 * upgrade #2): the API's routes with the capabilities each one checks, the
 * web's App.tsx routes with their guards, every apiFetch / '/api/…' path the
 * web calls, every literal in-app link the web renders, and every in-app link
 * the API writes into a notification, email or task.
 *
 * Ported from the auditor's scripts (crawl/api-routes.mjs, contracts.mjs,
 * parse-routes.mjs, static-links.mjs, api-links.mjs). Plain file reads and
 * regexes — no server, no TypeScript program — so the suites run in a
 * second or two. The parsers are approximate on purpose; each suite keeps a
 * short allowlist, with a reason per entry, for what they can't follow.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const WEB_SRC = path.resolve(__dirname, '../..');
export const API_SRC = path.resolve(__dirname, '../../../../api/src');

const cache = new Map<string, string>();
export function read(file: string): string {
  let s = cache.get(file);
  if (s === undefined) {
    s = readFileSync(file, 'utf8');
    cache.set(file, s);
  }
  return s;
}

const lineOf = (src: string, idx: number) => src.slice(0, idx).split('\n').length;

/** Every .ts/.tsx source under `dir`, without tests, mocks or stories. */
export function sourceFiles(dir: string, exts = /\.(ts|tsx)$/): string[] {
  const out: string[] = [];
  (function scan(d: string) {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) {
        if (!/^(__tests__|__mocks__|node_modules)$/.test(f)) scan(p);
      } else if (exts.test(p) && !/\.(test|spec|stories)\.tsx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
    }
  })(dir);
  return out;
}

/* ------------------------------------------------------------------------ */
/* Tokenizing helpers                                                        */
/* ------------------------------------------------------------------------ */

function balancedEnd(src: string, i: number, open: string, close: string): number {
  let d = 0;
  let q: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      q = ch;
      continue;
    }
    if (ch === open) d++;
    else if (ch === close) {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

/** The top-level arguments of the call whose '(' is at `openIdx`, as source text. */
export function callArgs(src: string, openIdx: number): string[] {
  let depth = 0;
  const args: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]!;
    if (q === '`') {
      cur += ch;
      if (ch === '\\') {
        cur += src[++i];
        continue;
      }
      if (ch === '$' && src[i + 1] === '{') {
        const e = balancedEnd(src, i + 1, '{', '}');
        if (e < 0) return args;
        cur += src.slice(i + 1, e + 1);
        i = e;
        continue;
      }
      if (ch === '`') q = null;
      continue;
    }
    if (q) {
      cur += ch;
      if (ch === '\\') {
        cur += src[++i];
        continue;
      }
      if (ch === q) q = null;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      if (depth === 1 && ch === '(') continue;
      cur += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        args.push(cur.trim());
        break;
      }
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 1) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  return args;
}

const stripComments = (a: string) => a.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').trim();
const strLit = (a: string | undefined): string | null => {
  const m = /^(['"`])(.*)\1$/s.exec(stripComments(a ?? ''));
  return m && !(m[1] === '`' && m[2]!.includes('${')) ? m[2]! : null;
};

/* ------------------------------------------------------------------------ */
/* The API's route table                                                      */
/* ------------------------------------------------------------------------ */

/** One requirement: the caller must hold at least one of these capabilities. */
export type CapGroup = string[];

export interface ApiRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  /** Every group must be met (requireCapability(a, b) is two groups; requireAnyCapability(a, b) one). */
  caps: CapGroup[];
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const p = path.resolve(path.dirname(fromFile), spec).replace(/\.js$/, '');
  for (const c of [p + '.ts', p + '/index.ts', p + '.tsx']) if (existsSync(c)) return c;
  return null;
}

function importsOf(file: string): Record<string, { file: string; name: string }> {
  const src = read(file);
  const map: Record<string, { file: string; name: string }> = {};
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const f = resolveImport(file, m[2]!);
    if (!f) continue;
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((s) => s.trim());
      if (orig) map[alias ?? orig] = { file: f, name: orig };
    }
  }
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s*'([^']+)'/g)) {
    const f = resolveImport(file, m[2]!);
    if (f) map[m[1]!] = { file: f, name: 'default' };
  }
  return map;
}

function routerFile(file: string, exportName: string, depth = 0): { file: string; name: string } {
  const src = read(file);
  if (depth > 5) return { file, name: exportName };
  if (exportName === 'default') {
    const m = /export default (\w+)/.exec(src);
    if (m) return { file, name: m[1]! };
  }
  if (new RegExp(`(const|let)\\s+${exportName}\\s*[:=]`).test(src)) return { file, name: exportName };
  const im = importsOf(file)[exportName];
  if (im) return routerFile(im.file, im.name, depth + 1);
  const re = new RegExp(`export\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}\\s*from\\s*'([^']+)'`).exec(src);
  if (re) {
    const f = resolveImport(file, re[1]!);
    if (f) return routerFile(f, exportName, depth + 1);
  }
  return { file, name: exportName };
}

/** Whether `name` in `file` is an express Router (not a gate function exported beside one). */
const isRouter = (t: { file: string; name: string }) => new RegExp(`(const|let)\\s+${t.name}\\s*(?::[^=]+)?=\\s*(express\\.)?Router\\(`).test(read(t.file));

const capList = (args: string) => [...args.matchAll(/'([a-z-]+:[a-z0-9-]+)'/g)].map((m) => m[1]!);

/** The capability groups one middleware argument checks (inline call, or a const in its file). */
function capsOfMiddleware(arg: string, file: string, depth = 0): CapGroup[] {
  const a = stripComments(arg);
  let m = /^requireCapability\s*\(([\s\S]*)\)$/.exec(a);
  if (m) return capList(m[1]!).map((c) => [c]);
  m = /^requireAnyCapability\s*\(([\s\S]*)\)$/.exec(a);
  if (m) return [capList(m[1]!)];
  const ident = /^(\w+)$/.exec(a)?.[1];
  if (!ident || depth > 2) return [];
  const src = read(file);
  const def = new RegExp(`(?:const|let)\\s+${ident}\\s*(?::[^=]+)?=\\s*(require(?:Any)?Capability\\s*\\([^)]*\\))`).exec(src);
  if (def) return capsOfMiddleware(def[1]!, file, depth + 1);
  // A gate function (`export function clientsAccessGate(req, res, next)`) whose
  // last word is another gate — `VIEW(req, res, next);` — checks that gate's
  // capabilities, bar the exceptions it opens first (approximate on purpose).
  const fn = new RegExp(`function\\s+${ident}\\s*\\(`).exec(src);
  if (fn) {
    const bodyOpen = src.indexOf('{', fn.index + fn[0].length);
    const bodyClose = balancedEnd(src, bodyOpen, '{', '}');
    const tail = /(\w+)\(\s*req\s*,\s*res\s*,\s*next\s*\)\s*;?\s*$/.exec(src.slice(bodyOpen + 1, bodyClose).trim());
    if (tail && tail[1] !== ident) return capsOfMiddleware(tail[1]!, file, depth + 1);
  }
  // Imported from the router's file (app.ts mounts `clientsAccessGate`).
  const im = importsOf(file)[ident];
  if (im && im.file !== file) return capsOfMiddleware(im.name, im.file, depth + 1);
  return [];
}

/**
 * The path(s) one route call declares. A literal is itself; a path from a
 * loop over a literal list — `for (const [path, status] of [['/pause', …],
 * ['/resume', …]]) router.post(path, …)`, or `/leave/cases/:id/${path}` —
 * is each of the list's first strings. Anything else is dynamic (null).
 */
function routePaths(src: string, callIdx: number, arg: string): Array<string | null> {
  const lit = strLit(arg);
  if (lit != null) return [lit];
  const a = stripComments(arg);
  const ident = /^(\w+)$/.exec(a)?.[1] ?? /^`[^`]*\$\{(\w+)\}[^`]*`$/.exec(a)?.[1];
  if (!ident) return [null];
  const before = src.slice(Math.max(0, callIdx - 2000), callIdx);
  const loops = [...before.matchAll(/for\s*\(\s*const\s+(\[\s*(\w+)[^\]]*\]|(\w+))\s+of\s+\[/g)];
  const loop = loops.reverse().find((l) => (l[2] ?? l[3]) === ident);
  if (!loop) return [null];
  const open = Math.max(0, callIdx - 2000) + loop.index! + loop[0].length - 1;
  const close = balancedEnd(src, open, '[', ']');
  if (close < 0) return [null];
  const list = src.slice(open + 1, close);
  const firsts = loop[2]
    ? [...list.matchAll(/\[\s*(['"`])([^'"`]*)\1/g)].map((x) => x[2]!)
    : [...list.matchAll(/(['"`])([^'"`]*)\1/g)].map((x) => x[2]!);
  if (!firsts.length) return [null];
  return firsts.map((v) => (a.startsWith('`') ? a.slice(1, -1).replace('${' + ident + '}', v) : v));
}

let apiRoutesCache: ApiRoute[] | null = null;

/** Every API route reachable from app.ts, in mount order, with the capability groups it checks. */
export function apiRoutes(): ApiRoute[] {
  if (apiRoutesCache) return apiRoutesCache;
  const routes: ApiRoute[] = [];
  const seen = new Set<string>();
  const rel = (f: string) => path.relative(API_SRC, f);

  function walk(file: string, name: string, prefix: string, inherited: CapGroup[], depth = 0) {
    const key = `${file}#${name}#${prefix}`;
    if (seen.has(key) || depth > 6) return;
    seen.add(key);
    const src = read(file);
    const imports = importsOf(file);
    const routerWide: CapGroup[] = [];
    const re = new RegExp(`\\b${name}\\s*\\.\\s*(get|post|put|patch|delete|all|use|route)\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const verb = m[1]!;
      const args = callArgs(src, m.index + m[0].length - 1);
      const line = lineOf(src, m.index);
      if (verb === 'route') {
        const p = strLit(args[0]);
        const tail = src.slice(m.index, m.index + 3000);
        for (const v of tail.matchAll(/\)\s*\.(get|post|put|patch|delete)\s*\(/g)) {
          routes.push({ method: v[1]!.toUpperCase(), path: prefix + (p ?? '/*'), file: rel(file), line, caps: [...inherited, ...routerWide] });
        }
        continue;
      }
      if (verb === 'use') {
        const sub = strLit(args[0]);
        const rest = args.slice(sub != null ? 1 : 0);
        const mwCaps: CapGroup[] = [];
        let mountedRouter = false;
        for (const a of rest) {
          const ident = /^(\w+)$/.exec(stripComments(a))?.[1];
          let target: { file: string; name: string } | undefined;
          if (ident && imports[ident]) {
            const t = routerFile(imports[ident].file, imports[ident].name);
            if (isRouter(t)) target = t;
          } else if (ident && new RegExp(`(const|let)\\s+${ident}\\s*=\\s*(express\\.)?Router\\(`).test(src)) target = { file, name: ident };
          if (target) {
            mountedRouter = true;
            walk(target.file, target.name, prefix + (sub && sub !== '/' ? sub : ''), [...inherited, ...routerWide, ...mwCaps], depth + 1);
          } else {
            mwCaps.push(...capsOfMiddleware(a, file));
          }
        }
        // router.use(requireCapability(…)) with no path: every route after it in this router.
        if (!mountedRouter && sub == null) routerWide.push(...mwCaps);
        // router.use(async (req, res) => …): a handler that answers everything under it.
        const last = stripComments(rest[rest.length - 1] ?? '');
        const params = /^(?:async\s+)?(?:function\s*\w*\s*)?\(([^)]*)\)/.exec(last)?.[1] ?? '';
        if (!mountedRouter && /^(async\b|function\b|\()/.test(last) && /=>|function/.test(last) && !/\bnext\b/.test(params)) {
          routes.push({ method: 'ALL', path: `${prefix}${sub && sub !== '/' ? sub : ''}/*`, file: rel(file), line, caps: [...inherited, ...routerWide] });
        }
        continue;
      }
      const mw = args.slice(1, -1).flatMap((a) => capsOfMiddleware(a, file));
      const caps = [...inherited, ...routerWide, ...mw];
      for (const p of routePaths(src, m.index, args[0] ?? '')) {
        routes.push({ method: verb.toUpperCase(), path: p == null ? `${prefix}/<dynamic>` : (prefix + (p === '/' ? '' : p)) || '/', file: rel(file), line, caps });
      }
    }
  }

  const app = path.join(API_SRC, 'app.ts');
  const appSrc = read(app);
  const appImports = importsOf(app);
  for (const m of appSrc.matchAll(/\bapp\.use\s*\(/g)) {
    const args = callArgs(appSrc, m.index! + m[0].length - 1);
    const prefix = strLit(args[0]);
    const mwCaps: CapGroup[] = [];
    for (const a of args.slice(prefix != null ? 1 : 0)) {
      const ident = /^(\w+)$/.exec(stripComments(a))?.[1];
      if (ident && appImports[ident]) {
        const t = routerFile(appImports[ident].file, appImports[ident].name);
        if (isRouter(t)) {
          walk(t.file, t.name, prefix && prefix !== '/' ? prefix : '', [...mwCaps]);
          continue;
        }
      }
      mwCaps.push(...capsOfMiddleware(a, app));
    }
  }
  apiRoutesCache = routes;
  return routes;
}

const segs = (p: string) => p.split('/').filter(Boolean);

function segMatch(webSeg: string, apiSeg: string): boolean {
  if (webSeg === ':p' || apiSeg.startsWith(':')) return true;
  if (webSeg.includes(':p')) {
    const re = new RegExp('^' + webSeg.split(':p').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$');
    return re.test(apiSeg);
  }
  return webSeg === apiSeg;
}

/** Whether a web path (with ':p' for each interpolation) can reach an API route's path. */
export function apiPathMatches(webPath: string, apiPath: string): boolean {
  const w = segs(webPath);
  const a = segs(apiPath);
  let i = 0;
  for (; i < a.length; i++) {
    const s = a[i]!;
    if (s === '*' || s.startsWith('*') || s.endsWith('(*)')) return true;
    const opt = s.endsWith('?');
    if (i >= w.length) {
      if (opt) continue;
      return false;
    }
    if (!segMatch(w[i]!, opt ? s.slice(0, -1) : s)) return false;
  }
  return i === w.length;
}

/**
 * The route Express would answer `METHOD /path` with: the first match in
 * mount order. A path written with route params (`/clients/:id`) means "an
 * id", so a route with a param in that place wins over a literal one that a
 * real id could never be (`/clients/options`).
 */
export function apiRouteFor(method: string, webPath: string): ApiRoute | null {
  const w = segs(webPath);
  const methodOk = (r: ApiRoute) => r.method === method || r.method === 'ALL';
  const exact = apiRoutes().find((r) => {
    const a = segs(r.path);
    return methodOk(r) && a.length === w.length && a.every((x, i) => (w[i]!.startsWith(':') ? x.startsWith(':') : x === w[i] || x.startsWith(':')));
  });
  if (exact) return exact;
  const loose = webPath.replace(/\/:[A-Za-z]\w*/g, '/:p');
  return apiRoutes().find((r) => methodOk(r) && apiPathMatches(loose, r.path)) ?? null;
}

/* ------------------------------------------------------------------------ */
/* The web's calls into the API                                               */
/* ------------------------------------------------------------------------ */

export interface WebCall {
  file: string;
  line: number;
  kind: 'apiFetch' | 'raw';
  raw: string;
  /** Normalized path (':p' per interpolation), or null when it isn't a literal. */
  path: string | null;
  /** GET/POST/…; 'ANY' for a raw '/api/…' reference (href, download, EventSource); '?' when computed. */
  method: string;
}

function normPath(arg: string): string | null {
  const a = (arg ?? '').trim();
  let raw: string;
  const m = /^(['"])(.*)\1$/s.exec(a);
  if (m) raw = m[2]!;
  else if (a.startsWith('`') && a.endsWith('`')) {
    raw = '';
    const s = a.slice(1, -1);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '$' && s[i + 1] === '{') {
        const e = balancedEnd(s, i + 1, '{', '}');
        raw += '\uE000';
        if (e < 0) break;
        i = e;
      } else raw += s[i];
    }
  } else return null;
  raw = raw.split('?')[0]!.split('#')[0]!;
  // A hole glued onto the end of a segment is a query-string builder: drop it
  // — unless it follows a dot, where it is a file extension (review.${format}).
  raw = raw.replace(/([^/.\uE000])\uE000+$/, '$1');
  return raw.replace(/\uE000+/g, ':p');
}

let webCallsCache: WebCall[] | null = null;

export function webApiCalls(): WebCall[] {
  if (webCallsCache) return webCallsCache;
  const calls: WebCall[] = [];
  for (const f of sourceFiles(WEB_SRC)) {
    const src = read(f);
    if (!src.includes('apiFetch') && !src.includes('/api/')) continue;
    const rel = path.relative(WEB_SRC, f);
    const consts: Record<string, string> = {};
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(['"`])(\/[^'"`$]*)\2/g)) consts[m[1]!] = m[3]!;
    for (const m of src.matchAll(/\bapiFetch\s*(<)?/g)) {
      let i = m.index! + m[0].length;
      if (m[1]) {
        const e = balancedEnd(src, i - 1, '<', '>');
        if (e < 0) continue;
        i = e + 1;
      }
      while (/\s/.test(src[i] ?? '')) i++;
      if (src[i] !== '(') continue;
      const args = callArgs(src, i);
      const line = lineOf(src, m.index!);
      const method = (/method:\s*['"](\w+)['"]/.exec(args[1] ?? '')?.[1] ?? (args[1] && /method/.test(args[1]) ? '?' : 'GET')).toUpperCase();
      let a0 = (args[0] ?? '').trim();
      if (consts[a0] != null) a0 = `'${consts[a0]}'`;
      // A path helper in the same file — `const scoped = (path) => \`${ROOT}${path}…\`` —
      // called with a literal: the helper's prefix plus the literal.
      const helper = /^(\w+)\(\s*(['`])(\/[^'`$]*)\2/.exec(a0);
      if (helper) {
        const def = new RegExp(`const\\s+${helper[1]}\\s*=\\s*\\((\\w+)[^)]*\\)[^=]*=>[\\s\\S]{0,200}?\`\\$\\{(\\w+)\\}\\$\\{\\1\\}`).exec(src);
        if (def && consts[def[2]!] != null) a0 = `'${consts[def[2]!]}${helper[3]}'`;
      }
      a0 = a0.replace(/\$\{(\w+)\}/g, (m0, n: string) => (consts[n] != null ? consts[n]! : m0));
      const p = normPath(a0);
      if (p == null) {
        // A ternary or a concatenation: check each literal path inside it.
        const lits = [...a0.matchAll(/(['`])(\/[^'`]*)\1/g)].map((x) => normPath(x[1]! + x[2]! + x[1]!)).filter((x): x is string => !!x);
        if (lits.length) {
          for (const l of lits) calls.push({ file: rel, line, kind: 'apiFetch', raw: a0.slice(0, 120), path: l, method });
          continue;
        }
      }
      calls.push({ file: rel, line, kind: 'apiFetch', raw: a0.slice(0, 120), path: p, method });
    }
    // Raw '/api/…' references (hrefs, downloads, fetch, EventSource, window.open).
    for (const m of src.matchAll(/(['"`])\/api(\/[^'"`]*?)\1/g)) {
      // '/api/*' in a comment, or a prefix test (`path.startsWith('/api/documents/')`): not a request.
      if (m[2]!.includes('*') || m[2]!.endsWith('/')) continue;
      calls.push({ file: rel, line: lineOf(src, m.index!), kind: 'raw', raw: m[0].slice(0, 120), path: normPath(m[1]! + m[2]! + m[1]!), method: 'ANY' });
    }
    for (const m of src.matchAll(/`\/api(\/[^`]*)`/g)) {
      if (!m[1]!.includes('${')) continue;
      calls.push({ file: rel, line: lineOf(src, m.index!), kind: 'raw', raw: m[0].slice(0, 120), path: normPath('`' + m[1] + '`'), method: 'ANY' });
    }
  }
  webCallsCache = calls;
  return calls;
}

/* ------------------------------------------------------------------------ */
/* The web's own routes (App.tsx)                                             */
/* ------------------------------------------------------------------------ */

export interface AppRoute {
  path: string;
  /** The RequireCapability guard: cap ∪ anyOf; empty when unguarded. */
  caps: string[];
  notClientBounded: boolean;
  notFound: boolean;
}

let appRoutesCache: AppRoute[] | null = null;

export function appRoutes(): AppRoute[] {
  if (appRoutesCache) return appRoutesCache;
  const src = read(path.join(WEB_SRC, 'App.tsx'));
  const start = src.indexOf('const ONBOARDING_ROUTES');
  const end = src.indexOf('export function warmSignedInStart');
  const body = src.slice(start >= 0 ? start : 0, end >= 0 ? end : src.length);
  const hits: Array<{ idx: number; path: string; index: boolean }> = [];
  for (const m of body.matchAll(/(\{\s*index: true[^}]*\}|path: '([^']+)')/g)) hits.push({ idx: m.index!, path: m[2] ?? '', index: !m[2] });
  const out: AppRoute[] = [];
  for (let i = 0; i < hits.length; i++) {
    const seg = body.slice(hits[i]!.idx, i + 1 < hits.length ? hits[i + 1]!.idx : body.length);
    const head = seg.split('},')[0]!;
    const p = hits[i]!.index ? '/' : hits[i]!.path;
    const full = p.startsWith('/') ? p : '/' + p;
    if (full === '/*') continue;
    const cap = /RequireCapability cap="([^"]+)"/.exec(head)?.[1];
    const anyOf = (/RequireCapability[^>]*anyOf=\{\[([^\]]+)\]\}/.exec(head)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    out.push({
      path: full,
      caps: cap ? [cap, ...anyOf] : [],
      notClientBounded: /RequireCapability[^>]*notClientBounded/.test(head),
      notFound: /element: <NotFound \/>/.test(head),
    });
  }
  appRoutesCache = out;
  return out;
}

/** Whether an in-app target (':p' per interpolation) lands on a real page, not the not-found page. */
export function appRouteKnown(target: string): boolean {
  let p = target.split('?')[0]!.split('#')[0]!;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const s = segs(p);
  const fits = (r: AppRoute, exact: boolean) => {
    const a = segs(r.path);
    if (a.length !== s.length) return false;
    return a.every((x, i) => (exact ? x === s[i] : x.startsWith(':') || s[i] === ':p' || x === s[i] || (s[i]!.includes(':p') && new RegExp('^' + s[i]!.split(':p').map((y) => y.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(x))));
  };
  const routes = appRoutes();
  if (routes.some((r) => !r.notFound && fits(r, true))) return true;
  // A hole in the target (a task kind, an id) can be any of the real pages it fits.
  if (s.some((x) => x.includes(':p')) && routes.some((r) => !r.notFound && fits(r, false))) return true;
  if (routes.some((r) => r.notFound && fits(r, false))) return false;
  return routes.some((r) => !r.notFound && fits(r, false));
}

/* ------------------------------------------------------------------------ */
/* In-app links                                                               */
/* ------------------------------------------------------------------------ */

export interface Link {
  kind: string;
  target: string;
  file: string;
}

/**
 * `{ method: 'POST', path: '/hr-cases' }` — a request descriptor (an offline
 * queue entry, an assistant action, a load-test step, an API doc), naming an
 * API path, not a page: the object holding the field also has a `method:`.
 */
function inRequestDescriptor(src: string, idx: number): boolean {
  // Template holes (`${x}`) carry braces of their own: out of the way first.
  const before = src.slice(Math.max(0, idx - 200), idx).replace(/\$\{[^{}]*\}/g, '');
  const open = before.lastIndexOf('{');
  if (open < 0 || open < before.lastIndexOf('}')) return false;
  return /\bmethod\s*:\s*['"`A-Za-z]/.test(before.slice(open));
}

/** Literal in-app targets the web renders: navigate('…'), to=, href=, nav data, <Navigate>. */
export function webLinks(): Link[] {
  const PATS: Array<[string, RegExp]> = [
    ['navigate', /\bnavigate\(\s*(['"`])(\/[^'"`]*)\1/g],
    ['to', /\bto=\{?\s*(['"`])(\/[^'"`]*)\1/g],
    ['href', /\bhref=\{?\s*(['"`])(\/(?!api\/|\/)[^'"`]*)\1/g],
    ['field', /\b(?:path|link|url|href|to|ctaHref|actionUrl|linkTo|route)\s*:\s*(['"`])(\/(?!api\/|\/)[^'"`\s]*)\1/g],
    ['Navigate', /<Navigate to=(['"`])(\/[^'"`]*)\1/g],
  ];
  const out: Link[] = [];
  for (const f of sourceFiles(WEB_SRC)) {
    const src = read(f);
    const rel = path.relative(WEB_SRC, f);
    for (const [kind, re] of PATS) {
      for (const m of src.matchAll(re)) {
        if (kind === 'field' && inRequestDescriptor(src, m.index!)) continue;
        const p = m[2]!.replace(/\$\{[^}]*\}/g, ':p');
        if (/^\/(api|assets|icons|fonts|images|static)\b/.test(p) || /\.(png|svg|jpg|webp|ico|json|pdf|csv|webmanifest|js|css)$/.test(p) || p.startsWith(':p')) continue;
        out.push({ kind, target: m[2]!, file: `${rel}:${lineOf(src, m.index!)}` });
      }
    }
  }
  return out;
}

/** In-app links the API writes into notifications, emails, tasks and alerts. */
export function apiLinks(): Link[] {
  const RE = /\b(linkUrl|link|href|actionUrl|deepLink|ctaUrl|ctaHref|openUrl|url|path|to|target|route)\s*:\s*(['`])(\/[^'`\s]*)\2/g;
  const RE2 = /\$\{(?:appUrl|APP_URL|webUrl|env\.APP_URL|env\.WEB_URL|env\.PUBLIC_APP_URL|appBase|webBase|APP_BASE_URL|env\.APP_BASE_URL|appOrigin|origin|base|baseUrl)\}(\/[^'`"\s)]*)/g;
  const out: Link[] = [];
  for (const f of sourceFiles(API_SRC, /\.ts$/)) {
    const src = read(f);
    const rel = path.relative(API_SRC, f);
    const hits = [...src.matchAll(RE)].map((m) => ({ field: m[1]!, p: m[3]!, idx: m.index! })).concat([...src.matchAll(RE2)].map((m) => ({ field: 'base+', p: m[1]!, idx: m.index! })));
    for (const h of hits) {
      if (h.field !== 'base+' && inRequestDescriptor(src, h.idx)) continue;
      const p = h.p.replace(/\$\{[^}]*\}/g, ':p').replace(/([^/]):p$/, '$1');
      // API-side paths (its own routes) and files are not pages.
      if (/^\/(api|v1|integrations|agent|scim|mcp|events|webhooks?|health|auth\/(oidc|saml)|calendar|uploads|static|\.well-known)\b/.test(p) || /\.(png|svg|jpg|pdf|csv|xml|json|txt|xlsx|ics|pkpass)$/.test(p)) continue;
      // Generic field names count only where a notification/link is being built.
      if (['path', 'url', 'to', 'target', 'route'].includes(h.field) && !/notif|email|mail|task|nudge|alert|digest|message|inbox|hugo|push|sms|whatsapp|link/i.test(src.slice(Math.max(0, h.idx - 600), h.idx + 200))) continue;
      out.push({ kind: h.field, target: h.p, file: `${rel}:${lineOf(src, h.idx)}` });
    }
  }
  return out;
}

/** Normalize a link target the way the checks read it (':p' per interpolation). */
export const linkPath = (target: string) => target.replace(/\$\{[^}]*\}/g, ':p').replace(/([^/]):p$/, '$1');
