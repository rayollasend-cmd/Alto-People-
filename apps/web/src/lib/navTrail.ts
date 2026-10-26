import { createContext, useContext, useMemo, type ContextType } from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';
import type { TenantModule, TermKey } from '@alto-people/shared';
import type { BreadcrumbSegment } from '@/components/ui/Breadcrumb';
import { AuthContext, useTenant, useTerm, type TenantSession } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import {
  allDoors,
  applyTerms,
  DASHBOARD_NAV,
  DOORS,
  MODULES,
  navShapeFor,
  roleNavLabels,
  visibleModules,
  type DoorKey,
  type ModuleNav,
  type NavShape,
} from '@/lib/modules';

/**
 * Where a page lives, in the sidebar's own words — the one source for
 * breadcrumb parents and the top bar's fallback title (F500 fix-up,
 * 2026-10-22). Hand-written trails drifted from the nav ("Workforce ›
 * Performance" where no Workforce exists, "Time & Pay" for a door called
 * "Time & scheduling"); a trail derived from lib/modules can't.
 *
 *   door → parent module(s) → the page
 *
 * - The door is the one the module sits behind in THIS person's sidebar
 *   (an associate's "My pay", an admin's "Pay & finance"); a module their
 *   sidebar doesn't show falls back to its first shared door.
 * - A module under another module's path (Payroll banking at
 *   /payroll/banking) names that module as its parent: "Payroll ›
 *   Payroll banking", which is also where the phone's Back goes.
 * - Two steps that lead to the same place collapse into the more specific
 *   one ("Me › My profile" → "My profile"); so do repeated words.
 * - A trail with no parent is no trail: a one-crumb line that repeats the
 *   title under it is noise (criterion 9).
 */

/** The doors that are a person's own (an associate's) — never a shared fallback. */
const PERSONAL_DOORS: ReadonlySet<DoorKey> = new Set(['my-schedule', 'my-pay', 'my-records', 'more']);

const hit = (pathname: string, path: string) => pathname === path || pathname.startsWith(`${path}/`);

/** The deepest module that owns `pathname` (the same longest-prefix rule as the sidebar). */
export function deepestModule(pathname: string, modules: readonly ModuleNav[]): ModuleNav | null {
  let best: ModuleNav | null = null;
  for (const m of modules) if (hit(pathname, m.path) && (!best || m.path.length > best.path.length)) best = m;
  return best;
}

export interface NavTrailInput {
  pathname: string;
  /** The modules this person sees, with the tenant's words on them. */
  visible: readonly ModuleNav[];
  /** Their sidebar's shape (null for a role with no doors). */
  shape: NavShape | null;
  /** The tenant's word for a term — for doors that build their label from one. */
  term: (key: TermKey) => string;
}

/**
 * The parents of `pathname` in the nav, each a place to go, nearest last.
 * `module` is the module that owns the page (null off the nav), and
 * `atModuleRoot` says whether the page IS that module's page — then its
 * leaf is the module's own label.
 */
export function navParents({ pathname, visible, shape, term }: NavTrailInput): {
  parents: BreadcrumbSegment[];
  module: ModuleNav | null;
  atModuleRoot: boolean;
} {
  const pool = visible.length > 0 ? visible : MODULES;
  const mod = deepestModule(pathname, pool) ?? deepestModule(pathname, applyLabels(MODULES, visible));
  if (!mod) return { parents: [], module: null, atModuleRoot: false };

  // Parent modules by path (/payroll above /payroll/banking), outermost first.
  const chain: ModuleNav[] = [mod];
  for (;;) {
    const head = chain[0]!;
    const parent = deepestModule(head.path, pool.filter((m) => m.path !== head.path && hit(head.path, m.path)));
    if (!parent) break;
    chain.unshift(parent);
  }

  const segs: BreadcrumbSegment[] = [];
  const door = doorFor(chain[0]!, shape, term) ?? doorFor(mod, shape, term);
  if (door) segs.push(door);
  for (const m of chain) segs.push({ label: m.label, to: m.path });

  // Same destination twice in a row: keep the more specific (later) one.
  // Same word twice in a row: keep one.
  const tidy: BreadcrumbSegment[] = [];
  for (const s of segs) {
    const prev = tidy[tidy.length - 1];
    if (prev && (prev.to === s.to || prev.label.toLowerCase() === s.label.toLowerCase())) tidy[tidy.length - 1] = s;
    else tidy.push(s);
  }

  const atModuleRoot = pathname === mod.path || pathname === `${mod.path}/`;
  const parents = atModuleRoot ? tidy.slice(0, -1) : tidy;
  // A parent that is this very page (a door whose target is here) is not a way up.
  return { parents: parents.filter((p) => p.to !== pathname), module: mod, atModuleRoot };
}

/** MODULES, but with the labels the person sees where they see the module. */
function applyLabels(all: readonly ModuleNav[], visible: readonly ModuleNav[]): ModuleNav[] {
  const byKey = new Map(visible.map((m) => [m.key, m]));
  return all.map((m) => byKey.get(m.key) ?? m);
}

function doorFor(mod: ModuleNav, shape: NavShape | null, term: (key: TermKey) => string): BreadcrumbSegment | null {
  if (shape) {
    for (const d of allDoors(shape)) {
      if (d.target.key === mod.key || d.children.some((c) => c.key === mod.key)) return { label: d.label, to: d.target.path };
    }
  }
  // Not in this person's sidebar (reached by a link or the palette): the
  // first shared door that holds it, pointing at the module itself.
  for (const d of Object.values(DOORS)) {
    if (PERSONAL_DOORS.has(d.key)) continue;
    if (d.hub !== mod.key && !d.children.includes(mod.key)) continue;
    const label = typeof d.label === 'function' ? d.label(term) : d.label;
    const hub = d.hub ? MODULES.find((m) => m.key === d.hub) : undefined;
    return { label, to: hub?.path ?? mod.path };
  }
  return null;
}

/**
 * The whole trail for a page: its nav parents, then the page itself.
 * `leaf` is what the page calls itself (its title); at a module's own page
 * the module's label stands in when the title isn't plain text. Returns
 * null when the page has no parent in the nav — then it shows no trail.
 */
export function navCrumbs(input: NavTrailInput & { leaf?: string | null }): BreadcrumbSegment[] | null {
  const { parents, module, atModuleRoot } = navParents(input);
  if (!module) return null;
  const leaf = input.leaf?.trim() || (atModuleRoot ? module.label : null);
  if (!leaf) return null;
  if (parents.length === 0) {
    // A section's own page (Scheduling under "Time & scheduling", Payroll
    // under "Pay & finance"): its door is where it lives, said once as a
    // plain crumb — the door's target is this page, so it isn't a link.
    // Pages with no door keep no trail (PageHeader holds the row's place).
    const door = doorFor(module, input.shape, input.term);
    // "My pay" over "Pay" says the same thing twice: the page name is enough.
    const plain = (x: string) => x.trim().toLowerCase().replace(/^my\s+/, '');
    if (door && plain(door.label) !== plain(leaf)) return [{ label: door.label }, { label: leaf }];
    return null;
  }
  const last = parents[parents.length - 1]!;
  // "Payroll › Payroll" — the leaf repeats its parent: the parent is enough.
  if (last.label.toLowerCase() === leaf.toLowerCase()) {
    const rest = parents.slice(0, -1);
    return rest.length > 0 ? [...rest, { label: leaf }] : null;
  }
  return [...parents, { label: leaf }];
}

/**
 * A page's breadcrumb as the reader will see it: the one an explicit
 * caller passed (minus a lone crumb that only repeats the title), or none.
 * Shared by PageHeader and RecordTemplate.
 */
export function tidyCrumbs(crumbs: BreadcrumbSegment[] | null | undefined, title: string | null): BreadcrumbSegment[] | null {
  if (!crumbs || crumbs.length === 0) return null;
  if (crumbs.length === 1 && title && crumbs[0]!.label.trim().toLowerCase() === title.trim().toLowerCase()) return null;
  return crumbs;
}

/* ---------------------------------------------------------------------- */
/* Hooks                                                                     */
/* ---------------------------------------------------------------------- */

/**
 * The current pathname, or null outside a router (a component rendered
 * alone in a test). Read from the location context directly so a header
 * never throws for want of a router it doesn't need.
 */
export function usePathnameIfRouted(): string | null {
  const ctx = useContext(UNSAFE_LocationContext) as { location?: { pathname: string } } | null;
  return ctx?.location?.pathname ?? null;
}

/**
 * The session, or null — outside an AuthProvider, and in a test that mocks
 * lib/auth with only the hooks it needs. Shared chrome (every page header)
 * must not be the thing that breaks a page test.
 */
export function useAuthIfMounted(): ContextType<typeof AuthContext> {
  try {
    return useContext(AuthContext);
  } catch {
    return null;
  }
}

const IDENTITY_TERM = (key: TermKey) => key as string;

/** Outside a provider (or with lib/auth mocked down): no tenant module switched off, no id. */
const NO_TENANT = { id: '', modules: undefined, moduleOn: () => true } as unknown as TenantSession & { moduleOn: (m: TenantModule) => boolean };

function useTenantIfMounted(): TenantSession & { moduleOn: (m: TenantModule) => boolean } {
  try {
    return useTenant();
  } catch {
    return NO_TENANT;
  }
}

function useTermIfMounted(): (key: TermKey) => string {
  try {
    return useTerm();
  } catch {
    return IDENTITY_TERM;
  }
}

/** What this person's sidebar holds — the same recipe as Sidebar and MobileNav. */
export function useNavModel(): { visible: ModuleNav[]; shape: NavShape | null; term: (key: TermKey) => string } {
  const auth = useAuthIfMounted();
  const tenant = useTenantIfMounted();
  const term = useTermIfMounted();
  const { t } = useI18n();
  const role = auth?.user?.role;
  const regionId = auth?.user?.regionId;
  const can = auth?.can;
  return useMemo(() => {
    if (!can || !role) return { visible: [], shape: null, term };
    const visible = roleNavLabels(
      applyTerms(visibleModules(role, can, { regionId, modules: tenant.modules, tenantId: tenant.id }), term, tenant.modules),
      role,
      t,
    );
    return { visible, shape: navShapeFor(visible, role, term), term };
  }, [can, role, regionId, tenant.modules, tenant.id, term, t]);
}

/**
 * The breadcrumb a page gets from the nav when it passes none of its own.
 * `leaf` is the page's title. Null outside a router, off the nav, or when
 * the page has no parent.
 */
export function useNavCrumbs(leaf: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}): BreadcrumbSegment[] | null {
  const pathname = usePathnameIfRouted();
  const model = useNavModel();
  return useMemo(() => (enabled && pathname ? navCrumbs({ pathname, ...model, leaf }) : null), [enabled, pathname, model, leaf]);
}

/* ---------------------------------------------------------------------- */
/* Areas with their own rail (Settings & trust)                              */
/* ---------------------------------------------------------------------- */

/** One page of an area's rail, as the trail needs it. */
export interface AreaRailItem {
  label: string;
  /** May carry a query (`/org/chart?view=field`); only the path is matched. */
  to: string;
  section?: string;
}

export interface AreaTrail {
  /** The area itself ("Settings & trust" → /admin). */
  area: BreadcrumbSegment;
  rail: readonly AreaRailItem[];
}

/**
 * An area shell with its own rail (pages/settings/SettingsArea) names the
 * trail of every page inside it from that rail — "Settings & trust ›
 * Access & trust › Users & access" — instead of each page hand-writing one
 * (they disagreed: "Settings", "Settings & trust › Organization profile",
 * "Platform", none). Headers inside the area read it.
 */
export const AreaTrailContext = createContext<AreaTrail | null>(null);

const pathOf = (to: string) => to.split('?')[0] ?? to;

/** The rail item that owns `pathname` — the deepest whose path it starts with. */
export function areaItemFor(trail: AreaTrail, pathname: string): AreaRailItem | null {
  let best: AreaRailItem | null = null;
  for (const item of trail.rail) {
    const p = pathOf(item.to);
    if (hit(pathname, p) && (!best || p.length > pathOf(best.to).length)) best = item;
  }
  return best;
}

/**
 * The trail inside an area: the area, the rail's section, the rail item —
 * then, on a page deeper than the item (a connection under Integrations),
 * the page's own name. Null for a page the rail doesn't hold (the area's
 * overview), which then keeps its own.
 */
export function areaCrumbs(trail: AreaTrail, pathname: string, leaf: string | null): BreadcrumbSegment[] | null {
  const item = areaItemFor(trail, pathname);
  if (!item) return null;
  const head: BreadcrumbSegment[] = [trail.area, ...(item.section ? [{ label: item.section }] : [])];
  const itemPath = pathOf(item.to);
  if (pathname === itemPath || pathname === `${itemPath}/`) return [...head, { label: item.label }];
  const name = leaf?.trim();
  if (!name || name.toLowerCase() === item.label.toLowerCase()) return [...head, { label: item.label }];
  return [...head, { label: item.label, to: item.to }, { label: name }];
}

/**
 * The breadcrumb a header shows, by precedence: the area's (inside an area
 * with a rail), the page's own (tidied — a lone crumb that repeats the
 * title is dropped), else the nav's. `explicit === undefined` asks for the
 * nav's; `[]` asks for none.
 */
export function useResolvedCrumbs(explicit: BreadcrumbSegment[] | undefined, title: string | null): BreadcrumbSegment[] | null {
  const area = useContext(AreaTrailContext);
  const pathname = usePathnameIfRouted();
  const inArea = !!(area && pathname && areaItemFor(area, pathname));
  const nav = useNavCrumbs(title, { enabled: explicit === undefined && !inArea });
  if (inArea) {
    const leaf = explicit && explicit.length > 0 ? explicit[explicit.length - 1]!.label : title;
    return areaCrumbs(area!, pathname!, leaf);
  }
  if (explicit !== undefined) return tidyCrumbs(explicit, title);
  return nav;
}

/**
 * What the nav calls the current page — the top bar's name for a page that
 * published none, so the chrome never falls back to the wordmark on a page
 * that has a name. "Home" at the root; null off the nav.
 */
export function useNavLabel(): string | null {
  const pathname = usePathnameIfRouted();
  const { visible } = useNavModel();
  return useMemo(() => {
    if (!pathname) return null;
    if (pathname === DASHBOARD_NAV.path) return DASHBOARD_NAV.label;
    // A page outside this person's sidebar (a link, the access page) still
    // has a name: the module's own.
    return (deepestModule(pathname, visible) ?? deepestModule(pathname, MODULES))?.label ?? null;
  }, [pathname, visible]);
}
