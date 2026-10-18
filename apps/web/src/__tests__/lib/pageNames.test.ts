import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultTerminologyFor, type TermKey } from '@alto-people/shared';
import { DOORS, MODULES } from '@/lib/modules';

/**
 * One name per page. A page's sidebar label, its breadcrumb and its title
 * must agree, so a person never wonders whether "Reporting chart", "Org ›
 * Chart" and "Org chart" are three places. Read statically from the source:
 *
 *   - the module's path → the component App.tsx mounts there → its file,
 *     or (when the header lives one component down) the first file it
 *     imports from its own folder that draws a breadcrumb;
 *   - the breadcrumb's last crumb must be the sidebar label;
 *   - its first crumb, when there are two or more, must be the door the
 *     module lives under in the sidebar;
 *   - the title must be the sidebar label, or a longer form that contains it.
 *
 * `term('…')` resolves to the default (workforce) words. Pages whose title
 * is computed (a record's name) are skipped; justified exceptions are named
 * in EXCEPTIONS with the reason.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../..');
const APP = readFileSync(join(SRC, 'App.tsx'), 'utf8');
const TERMS = defaultTerminologyFor('WORKFORCE_PROVIDER');
const termText = (k: string) => TERMS[k as TermKey]?.en ?? null;

/** Pages that legitimately differ, with why. Keep this short. */
const EXCEPTIONS: Record<string, string> = {
  // The hub of Settings & trust: its title is the door's own name.
  settings: 'hub page',
  // The client (store manager) portal is frozen by the owner — "leave it as it is for now".
  'portal-ops': 'client portal frozen',
  // Pages being rebuilt by another builder this round; remove each once its
  // header agrees (the stale-exception test below fails when it does).
};

const norm = (s: string) => s.toLowerCase().replace(/&amp;/g, '&').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

/** A JSX string value: '…', "…", `…` (no ${}), or term('…'). */
function readValue(src: string): string | null {
  const s = src.trim();
  const lit = /^(['"`])([^'"`$]*)\1/.exec(s);
  if (lit) return lit[2]!;
  const t = /^term\(\s*['"]([^'"]+)['"]\s*\)/.exec(s);
  if (t) return termText(t[1]!);
  const tl = /^t\(\s*['"]([^'"]+)['"]/.exec(s);
  if (tl) return `i18n:${tl[1]}`;
  return null;
}

/**
 * `breadcrumbs={[{ label: X, to? }, …]}` → the labels of the page's own
 * header. A crumb that links back to the page itself marks a drill-down
 * (a plan, a campaign, a sub-view) — those are skipped.
 */
function readCrumbs(file: string, selfPath: string): { crumbs: Array<string | null>; at: number } | null {
  const re = /breadcrumbs=\{\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file))) {
    const end = file.indexOf(']}', m.index);
    const body = file.slice(m.index, end);
    if (body.includes(`to: '${selfPath}'`) || body.includes(`to: "${selfPath}"`)) continue;
    const crumbs: Array<string | null> = [];
    const lre = /label:\s*/g;
    let x: RegExpExecArray | null;
    while ((x = lre.exec(body))) crumbs.push(readValue(body.slice(x.index + x[0].length)));
    return { crumbs, at: m.index };
  }
  return null;
}

/** The `title=` nearest the breadcrumbs — the same header element. */
function readTitle(file: string, near: number): string | null | undefined {
  const re = /\btitle=(\{)?/g;
  let best: { d: number; v: string | null } | null = null;
  let x: RegExpExecArray | null;
  while ((x = re.exec(file))) {
    const d = Math.abs(x.index - near);
    if (d > 900) continue;
    const v = readValue(file.slice(x.index + x[0].length));
    if (!best || d < best.d) best = { d, v };
  }
  return best ? best.v : undefined;
}

/** The component mounted at a path, and its source file. */
function componentFileFor(path: string): string | null {
  const route = path.replace(/^\//, '');
  const esc = route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const m = new RegExp(`path:\\s*'${esc}',\\s*element:\\s*(?:<RequireCapability[^>]*>\\s*)?<([A-Z][A-Za-z0-9]*)`).exec(APP);
  if (!m) return null;
  const name = m[1]!;
  const imp =
    new RegExp(`const ${name} = lazyNamed\\(\\(\\) => import\\('@/([^']+)'\\)`).exec(APP) ??
    new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '@/([^']+)'`).exec(APP);
  if (!imp) return null;
  const base = join(SRC, imp[1]!);
  for (const ext of ['.tsx', '.ts', '/index.tsx']) if (existsSync(base + ext)) return base + ext;
  return null;
}

/** The file that draws the header: the page, or a sibling it imports. */
function headerFile(file: string): { path: string; src: string } | null {
  const src = readFileSync(file, 'utf8');
  if (/breadcrumbs=\{\[/.test(src)) return { path: file, src };
  const re = /from '\.\/([A-Za-z0-9_]+)'/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(src))) {
    const sib = join(dirname(file), `${x[1]}.tsx`);
    if (!existsSync(sib)) continue;
    const s = readFileSync(sib, 'utf8');
    if (/breadcrumbs=\{\[/.test(s)) return { path: sib, src: s };
  }
  return null;
}

/** The first door (in sidebar order) that holds a module. */
function doorLabelOf(key: string): string | null {
  for (const d of Object.values(DOORS)) {
    if (!(d.children as readonly string[]).includes(key)) continue;
    if (['my-schedule', 'my-pay', 'my-records', 'more'].includes(d.key)) continue;
    return typeof d.label === 'function' ? d.label((k: TermKey) => termText(k) ?? k) : d.label;
  }
  return null;
}

export interface NameProblem {
  key: string;
  path: string;
  file: string;
  problem: string;
}

export function pageNameProblems(opts: { includeExceptions?: boolean } = {}): NameProblem[] {
  const out: NameProblem[] = [];
  for (const m of MODULES) {
    if (EXCEPTIONS[m.key] && !opts.includeExceptions) continue;
    const comp = componentFileFor(m.path);
    if (!comp) continue;
    const header = headerFile(comp);
    if (!header) continue;
    const rel = header.path.replace(`${SRC}/`, '');
    const crumbs = readCrumbs(header.src, m.path);
    if (!crumbs) continue;
    const label = norm(m.label);
    const last = crumbs.crumbs[crumbs.crumbs.length - 1];
    if (last && !last.startsWith('i18n:') && norm(last) !== label) {
      out.push({ key: m.key, path: m.path, file: rel, problem: `last crumb "${last}" ≠ sidebar "${m.label}"` });
    }
    const door = doorLabelOf(m.key);
    const first = crumbs.crumbs[0];
    // A page under another module's path (/payroll/tax under /payroll) may name that page as its parent.
    const parents = MODULES.filter((p) => p.path !== m.path && m.path.startsWith(`${p.path}/`)).map((p) => norm(p.label));
    if (crumbs.crumbs.length >= 2 && door && first && !first.startsWith('i18n:') && norm(first) !== norm(door) && !parents.includes(norm(first))) {
      out.push({ key: m.key, path: m.path, file: rel, problem: `first crumb "${first}" ≠ door "${door}"${parents.length ? ` or parent page` : ''}` });
    }
    const title = readTitle(header.src, crumbs.at);
    if (title && !title.startsWith('i18n:') && !norm(title).includes(label)) {
      out.push({ key: m.key, path: m.path, file: rel, problem: `title "${title}" ≠ sidebar "${m.label}"` });
    }
  }
  return out;
}

describe('one name per page', () => {
  it('sidebar label, breadcrumb and title agree on every module page', () => {
    const problems = pageNameProblems();
    if (process.env.PAGE_NAMES_REPORT) console.log(problems.map((p) => `${p.path}\t${p.file}\t${p.problem}`).join('\n'));
    expect(problems.map((p) => `${p.path}: ${p.problem} (${p.file})`)).toEqual([]);
  });

  it('names no stale exception (an excepted page that now agrees comes off the list)', () => {
    const still = new Set(pageNameProblems({ includeExceptions: true }).map((p) => p.key));
    const stale = Object.keys(EXCEPTIONS).filter((k) => k !== 'settings' && !still.has(k));
    expect(stale).toEqual([]);
  });

  it('reads the pages it claims to (the check is not silently empty)', () => {
    let read = 0;
    for (const m of MODULES) {
      const comp = componentFileFor(m.path);
      if (comp && headerFile(comp)) read += 1;
    }
    expect(read).toBeGreaterThan(60);
  });
});
