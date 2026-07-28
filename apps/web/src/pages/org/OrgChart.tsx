import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Download, Network, Users } from 'lucide-react';
import type { AssociateOrgSummary } from '@alto-people/shared';
import { listOrgAssociates } from '@/lib/orgApi';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { ymdLocal } from '@/lib/format';
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SearchInput,
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
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Bumping seq re-applies the open/closed signal to every node even if
  // the previous click was the same action.
  const [expandSignal, setExpandSignal] = useState<{
    open: boolean;
    seq: number;
  } | null>(null);

  const load = () => {
    setRows(null);
    setError(null);
    listOrgAssociates()
      .then((r) => setRows(r.associates))
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not load the org chart.',
        ),
      );
  };
  useEffect(load, []);

  const tree = useMemo(
    () => (rows ? filterTree(buildTree(rows), query.trim()) : []),
    [rows, query],
  );

  // People whose manager exists but isn't in the fetched set — their
  // subtree silently detaches to the root level, which reads as "no
  // manager" unless we call it out.
  const outOfViewManagerCount = useMemo(() => {
    if (!rows) return 0;
    const ids = new Set(rows.map((r) => r.id));
    return rows.filter((r) => r.managerId && !ids.has(r.managerId)).length;
  }, [rows]);

  const exportCsv = () => {
    if (!rows || rows.length === 0) return;
    downloadCsv(`org-chart-${ymdLocal()}.csv`, [
      ['Name', 'Title', 'Manager', 'Department'],
      ...rows.map((r) => [
        `${r.firstName} ${r.lastName}`,
        r.jobProfileTitle ?? '',
        r.managerName ?? '',
        r.departmentName ?? '',
      ]),
    ]);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Org chart"
        subtitle="Reporting hierarchy across the company. Search to focus on a person or team."
        breadcrumbs={[{ label: 'Org' }, { label: 'Chart' }]}
        secondaryActions={
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={!rows || rows.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        }
      />
      <div className="flex items-end gap-2 flex-wrap">
        <div className="max-w-sm flex-1 min-w-[220px]">
          <SearchInput
            placeholder="Search by name, title, department…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the org chart"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpandSignal((s) => ({ open: true, seq: (s?.seq ?? 0) + 1 }))}
          disabled={!rows || rows.length === 0}
        >
          Expand all
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpandSignal((s) => ({ open: false, seq: (s?.seq ?? 0) + 1 }))}
          disabled={!rows || rows.length === 0}
        >
          Collapse all
        </Button>
      </div>
      {outOfViewManagerCount > 0 && (
        <ErrorBanner severity="warning">
          {outOfViewManagerCount}{' '}
          {outOfViewManagerCount === 1 ? 'person has' : 'people have'} an
          unassigned or out-of-view manager — they appear at the top level.
        </ErrorBanner>
      )}
      {error && (
        <ErrorBanner>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}
      {!error && (
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
                <TreeNode
                  key={root.id}
                  node={root}
                  depth={0}
                  expanded={query.length > 0}
                  signal={expandSignal}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  expanded: defaultExpanded,
  signal,
}: {
  node: Node;
  depth: number;
  expanded: boolean;
  signal: { open: boolean; seq: number } | null;
}) {
  const [open, setOpen] = useState(defaultExpanded || depth < 2);
  const hasChildren = node.children.length > 0;

  // Expand-all / collapse-all broadcast from the toolbar.
  useEffect(() => {
    if (signal) setOpen(signal.open);
  }, [signal]);

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
        <Link
          to={`/people?associateId=${node.id}`}
          className="flex items-center gap-2 flex-1 min-w-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          title={`Open ${node.firstName} ${node.lastName} in the directory`}
        >
          <div className="h-7 w-7 rounded-full bg-gold/15 border border-gold/40 grid place-items-center text-xs text-gold shrink-0">
            {`${node.firstName.charAt(0)}${node.lastName.charAt(0)}`.toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-white truncate group-hover:underline decoration-silver/40 underline-offset-2">
              {node.firstName} {node.lastName}
            </div>
            <div className="text-xs text-silver truncate">
              {node.jobProfileTitle ?? 'No title'}
              {node.departmentName ? ` • ${node.departmentName}` : ''}
            </div>
          </div>
        </Link>
        {hasChildren && (
          <div className="text-xs text-silver opacity-60 group-hover:opacity-100 transition-opacity flex items-center gap-1">
            <Users className="h-3 w-3" />
            {countTeam(node)}
          </div>
        )}
      </div>
      {hasChildren && open && (
        <div>
          {node.children.map((c) => (
            <TreeNode
              key={c.id}
              node={c}
              depth={depth + 1}
              expanded={defaultExpanded}
              signal={signal}
            />
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
