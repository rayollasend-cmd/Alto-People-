import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Network, Search, Users } from 'lucide-react';
import type { AssociateOrgSummary } from '@alto-people/shared';
import { listOrgAssociates } from '@/lib/orgApi';
import {
  Card,
  CardContent,
  EmptyState,
  Input,
  PageHeader,
  SkeletonRows,
} from '@/components/ui';

/**
 * Phase 106 — Visual org chart.
 *
 * Renders the Associate hierarchy via managerId. Pure frontend: the
 * /org/associates endpoint already returns the data we need; we shape
 * it into a tree client-side. Roots are anyone whose managerId is
 * null (CEOs, contractors, anyone not yet assigned). A search box
 * filters to a single chain (matching nodes + their full path to root).
 */
type Node = AssociateOrgSummary & { children: Node[] };

function buildTree(rows: AssociateOrgSummary[]): Node[] {
  const byId = new Map<string, Node>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: Node[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    if (r.managerId && byId.has(r.managerId)) {
      byId.get(r.managerId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Stable alpha order at every level.
  const sortRec = (nodes: Node[]) => {
    nodes.sort((a, b) => {
      const al = `${a.lastName} ${a.firstName}`.toLowerCase();
      const bl = `${b.lastName} ${b.firstName}`.toLowerCase();
      return al.localeCompare(bl);
    });
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function filterTree(nodes: Node[], query: string): Node[] {
  if (!query) return nodes;
  const q = query.toLowerCase();
  const matches = (n: Node): Node | null => {
    const childMatches = n.children
      .map(matches)
      .filter((c): c is Node => c !== null);
    const selfMatch =
      `${n.firstName} ${n.lastName}`.toLowerCase().includes(q) ||
      n.email.toLowerCase().includes(q) ||
      (n.jobProfileTitle ?? '').toLowerCase().includes(q) ||
      (n.departmentName ?? '').toLowerCase().includes(q);
    if (selfMatch || childMatches.length > 0) {
      return { ...n, children: childMatches };
    }
    return null;
  };
  return nodes.map(matches).filter((c): c is Node => c !== null);
}

export function OrgChart() {
  const [rows, setRows] = useState<AssociateOrgSummary[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    listOrgAssociates()
      .then((r) => setRows(r.associates))
      .catch(() => setRows([]));
  }, []);

  const tree = useMemo(
    () => (rows ? filterTree(buildTree(rows), query.trim()) : []),
    [rows, query],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Org chart"
        subtitle="Reporting hierarchy across the company. Search to focus on a person or team."
        breadcrumbs={[{ label: 'Org' }, { label: 'Chart' }]}
      />
      <div className="max-w-sm relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-silver pointer-events-none" />
        <Input
          className="pl-8"
          placeholder="Search by name, title, department…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <Card>
        <CardContent className="p-4">
          {rows === null ? (
            <SkeletonRows count={5} />
          ) : tree.length === 0 ? (
            <EmptyState
              icon={Network}
              title={query ? 'No matches' : 'No associates'}
              description={
                query
                  ? 'Try a different search.'
                  : 'Once associates are added, the reporting tree appears here.'
              }
            />
          ) : (
            <div className="space-y-1">
              {tree.map((root) => (
                <TreeNode key={root.id} node={root} depth={0} expanded={query.length > 0} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TreeNode({
  node,
  depth,
  expanded: defaultExpanded,
}: {
  node: Node;
  depth: number;
  expanded: boolean;
}) {
  const [open, setOpen] = useState(defaultExpanded || depth < 2);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-navy-secondary/40 transition group"
        style={{ paddingLeft: 8 + depth * 20 }}
      >
        <button
          onClick={() => hasChildren && setOpen((o) => !o)}
          className={`w-5 h-5 grid place-items-center text-silver/70 ${
            hasChildren ? 'hover:text-white cursor-pointer' : 'opacity-0 cursor-default'
          }`}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {hasChildren && (open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          ))}
        </button>
        <div className="h-7 w-7 rounded-full bg-cyan-600/20 border border-cyan-500/40 grid place-items-center text-xs text-cyan-300">
          {`${node.firstName.charAt(0)}${node.lastName.charAt(0)}`.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white truncate">
            {node.firstName} {node.lastName}
          </div>
          <div className="text-xs text-silver truncate">
            {node.jobProfileTitle ?? 'No title'}
            {node.departmentName ? ` • ${node.departmentName}` : ''}
          </div>
        </div>
        {hasChildren && (
          <div className="text-xs text-silver opacity-0 group-hover:opacity-100 transition flex items-center gap-1">
            <Users className="h-3 w-3" />
            {countTeam(node)}
          </div>
        )}
      </div>
      {hasChildren && open && (
        <div>
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} depth={depth + 1} expanded={defaultExpanded} />
          ))}
        </div>
      )}
    </div>
  );
}

function countTeam(node: Node): number {
  let n = node.children.length;
  for (const c of node.children) n += countTeam(c);
  return n;
}
