import { ROLE_LABELS, type Role } from '@alto-people/shared';
import type { TermKey } from '@alto-people/shared';
import type { OrgNode } from '@/lib/orgChartApi';

/**
 * The org chart's arithmetic, kept apart from the drawing so it can be
 * tested: the tree's index, search (with the path to every match), the
 * department filter, colours, reporting-line edits that are allowed, and
 * the CSV.
 */

export interface OrgIndex {
  byId: Map<string, OrgNode>;
  children: Map<string | null, OrgNode[]>;
  /** Everyone below a node (people only), for "12 in this team". */
  teamSize: Map<string, number>;
}

const KIND_ORDER: Record<OrgNode['kind'], number> = {
  region: 0,
  client: 1,
  store: 2,
  lead: 3,
  staff: 4,
  person: 5,
  vacancy: 6,
  group: 7,
};

export function indexNodes(nodes: OrgNode[]): OrgIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, OrgNode[]>();
  for (const n of nodes) {
    const parent = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(n);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
  }
  const teamSize = new Map<string, number>();
  const count = (id: string): number => {
    const cached = teamSize.get(id);
    if (cached !== undefined) return cached;
    let total = 0;
    for (const c of children.get(id) ?? []) {
      if (c.kind === 'person' || c.kind === 'staff' || c.kind === 'lead') total += 1;
      total += count(c.id);
    }
    teamSize.set(id, total);
    return total;
  };
  for (const n of nodes) count(n.id);
  return { byId, children, teamSize };
}

/** The chain from the top down to (not including) a node. */
export function ancestorsOf(index: OrgIndex, id: string): OrgNode[] {
  const out: OrgNode[] = [];
  let cursor = index.byId.get(id)?.parentId ?? null;
  const seen = new Set<string>();
  while (cursor && index.byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const n = index.byId.get(cursor)!;
    out.unshift(n);
    cursor = n.parentId;
  }
  return out;
}

/** Everyone below a node, for the "can't report to your own team" rule. */
export function descendantIds(index: OrgIndex, id: string): Set<string> {
  const out = new Set<string>();
  const walk = (at: string) => {
    for (const c of index.children.get(at) ?? []) {
      if (out.has(c.id)) continue;
      out.add(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

export function matchesQuery(n: OrgNode, q: string, roleLabel: (r: Role) => string): boolean {
  if (!q) return false;
  const hay = [n.name, n.subtitle, n.departmentName, n.clientName, n.siteName, n.role ? roleLabel(n.role) : null, ...(n.shiftLabels ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q.toLowerCase());
}

/** Search hits in reading order (depth-first, as the tree is drawn). */
export function searchNodes(index: OrgIndex, q: string, roleLabel: (r: Role) => string): OrgNode[] {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const out: OrgNode[] = [];
  const walk = (parent: string | null) => {
    for (const n of index.children.get(parent) ?? []) {
      if (matchesQuery(n, trimmed, roleLabel)) out.push(n);
      walk(n.id);
    }
  };
  walk(null);
  return out;
}

/**
 * Keep the nodes in a department and the path down to them (so the tree
 * still reads), dropping everything else. Structure (regions, groups)
 * survives only where something below it does.
 */
export function filterByDepartment(nodes: OrgNode[], departmentId: string | null): OrgNode[] {
  if (!departmentId) return nodes;
  const index = indexNodes(nodes);
  const keep = new Set<string>();
  for (const n of nodes) {
    if (n.departmentId !== departmentId) continue;
    keep.add(n.id);
    for (const a of ancestorsOf(index, n.id)) keep.add(a.id);
  }
  return nodes.filter((n) => keep.has(n.id));
}

/** Department choices, from what the chart actually holds. */
export function departmentsOf(nodes: OrgNode[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const n of nodes) if (n.departmentId && n.departmentName) seen.set(n.departmentId, n.departmentName);
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/* ----- Colour -------------------------------------------------------------- */

/** Categorical accents from the design tokens (literal so Tailwind keeps them). */
export const PALETTE = [
  { border: 'border-l-accent', swatch: 'bg-accent' },
  { border: 'border-l-sky', swatch: 'bg-sky' },
  { border: 'border-l-teal', swatch: 'bg-teal' },
  { border: 'border-l-success', swatch: 'bg-success' },
  { border: 'border-l-warning', swatch: 'bg-warning' },
  { border: 'border-l-alert', swatch: 'bg-alert' },
  { border: 'border-l-gold', swatch: 'bg-gold' },
  { border: 'border-l-steel', swatch: 'bg-steel' },
] as const;

export type ColourBy = 'none' | 'department' | 'client';

/** The key a node is coloured by, and the legend in first-seen order. */
export function colourKeys(nodes: OrgNode[], by: ColourBy): { keyOf: (n: OrgNode) => string | null; legend: Array<{ key: string; label: string; slot: number }> } {
  const keyOf = (n: OrgNode): string | null => (by === 'department' ? n.departmentId : by === 'client' ? n.clientId : null);
  const labelOf = (n: OrgNode): string | null => (by === 'department' ? n.departmentName : by === 'client' ? n.clientName : null);
  const legend: Array<{ key: string; label: string; slot: number }> = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const k = keyOf(n);
    const label = labelOf(n);
    if (!k || !label || seen.has(k)) continue;
    seen.add(k);
    legend.push({ key: k, label, slot: legend.length % PALETTE.length });
  }
  return { keyOf, legend };
}

/* ----- Words --------------------------------------------------------------- */

/** A role in the tenant's own words where it has one (a hotel's "Supervisor"). */
export function roleLabelFor(term: (k: TermKey) => string): (r: Role) => string {
  const TERMED: Partial<Record<Role, TermKey>> = {
    ASSOCIATE: 'role.associate',
    SHIFT_SUPERVISOR: 'role.shiftSupervisor',
    FLOOR_SUPERVISOR: 'role.floorSupervisor',
    MANAGER: 'role.manager',
    CLIENT_PORTAL: 'role.clientPortal',
    TRANSPORTATION_DIRECTOR: 'role.transportationDirector',
    DRIVER: 'role.driver',
  };
  return (r: Role) => (TERMED[r] ? term(TERMED[r]!) : ROLE_LABELS[r]);
}

/* ----- Reporting-line edits ---------------------------------------------- */

/**
 * Who `subject` may be put under. A person record's manager must be a
 * person record (Associate.managerId); an account can report to any
 * account. Never yourself or anyone in your own team.
 */
export function managerChoices(index: OrgIndex, subject: OrgNode): OrgNode[] {
  const below = descendantIds(index, subject.id);
  return [...index.byId.values()]
    .filter((n) => (n.kind === 'person' || n.kind === 'staff') && !n.former && n.id !== subject.id && !below.has(n.id))
    .filter((n) => (subject.associateId && n.associateId) || (subject.userId && n.userId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ----- CSV ------------------------------------------------------------------ */

export function chartCsv(index: OrgIndex, roleLabel: (r: Role) => string): string[][] {
  const rows: string[][] = [['Name', 'Kind', 'Title or role', 'Reports to', 'Department', 'Client', 'Store', 'Team size']];
  const walk = (parent: string | null) => {
    for (const n of index.children.get(parent) ?? []) {
      const up = n.parentId ? index.byId.get(n.parentId) : undefined;
      rows.push([
        n.name,
        n.kind,
        n.subtitle ?? (n.role ? roleLabel(n.role) : ''),
        up?.name ?? '',
        n.departmentName ?? '',
        n.clientName ?? '',
        n.siteName ?? '',
        String(index.teamSize.get(n.id) ?? 0),
      ]);
      walk(n.id);
    }
  };
  walk(null);
  return rows;
}
