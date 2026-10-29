import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, Download, MapPinPlus, Network, Plus, Printer, UserCog } from '@/components/ui/icons';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { getOrgChart, getStoreCrew, searchFieldPeople, type OrgChartView, type OrgNode } from '@/lib/orgChartApi';
import { useClients } from '@/lib/useClients';
import { useMediaQuery } from '@/lib/useViewport';
import { downloadCsv } from '@/lib/csv';
import { ymdLocal } from '@/lib/format';
import { METRICS } from '@alto-people/shared';
import { termizeText } from '@/lib/modules';
import { ListTemplate } from '@/components/templates';
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorBanner,
  SearchInput,
  Select,
  SegmentedControl,
  SkeletonRows,
} from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { BulkReportsToDialog, ChartCanvas, ReportsToDialog, TreeList, type Painter, type StructureActions } from './OrgChartParts';
import { AddRegionDialog, AddSiteDialog, MoveToRegionDialog, StructureDrawer, storeRegion, useMoveStore } from './StructureEditor';
import { regionIdOf } from '@/lib/structureApi';
import {
  PALETTE,
  ancestorsOf,
  chartCsv,
  colourKeys,
  departmentsOf,
  filterByDepartment,
  indexNodes,
  roleLabelFor,
  searchNodes,
  type ColourBy,
} from './orgChartModel';

/**
 * The org chart, two ways.
 *
 *   Company — the people who run the company: every office account (with
 *   or without a person record) and every reporting line, with open seats
 *   as dotted cards under the manager hiring for them.
 *
 *   Field — the tree a staffing company runs on: region → client → store
 *   → the leads placed there → the crew, with today's coverage on each
 *   store, and everyone not yet placed in one labelled group.
 *
 * Desktop draws a chart you can move around in (a focused node, its team,
 * and each member's own team beneath); the phone — and anyone who prefers
 * it — gets the same tree as an accessible list. Search jumps to each
 * match and opens the path to it. Everything is inside the caller's reach.
 */

export function OrgChart() {
  const { can } = useAuth();
  const term = useTerm();
  // A direct employer (a hotel) has no clients: the field tree is place → crew.
  const hasClients = useTenant().moduleOn('clientPortal');
  const [params, setParams] = useSearchParams();
  const view: OrgChartView = params.get('view') === 'field' ? 'field' : 'company';
  const isPhone = useMediaQuery('(max-width: 767px)');
  const layout: 'chart' | 'list' = isPhone ? 'list' : params.get('layout') === 'list' ? 'list' : 'chart';
  const focusId = params.get('focus');
  const clientId = view === 'field' ? params.get('client') : null;
  const [former, setFormer] = useState(false);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const [departmentId, setDepartmentId] = useState('');
  const [colourBy, setColourBy] = useState<ColourBy>('none');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<OrgNode | null>(null);
  const [bulkLines, setBulkLines] = useState(false);
  const canEdit = can('manage:org') && view === 'company';
  // The field view is where the structure is edited: regions, stores, cost centers.
  const canStructure = can('manage:org') && view === 'field';
  const [details, setDetails] = useState<OrgNode | null>(null);
  const [moving, setMoving] = useState<OrgNode | null>(null);
  const [addingRegion, setAddingRegion] = useState(false);
  const [addingSite, setAddingSite] = useState<{ clientId?: string | null; regionId?: string | null } | null>(null);
  const moveStore = useMoveStore();

  /** Change one or more URL params in a single update (two in a row would drop the first). */
  const setParam = (key: string | Record<string, string | null>, value?: string | null) => {
    const changes = typeof key === 'string' ? { [key]: value ?? null } : key;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  };

  const chart = useQuery({
    queryKey: ['org', 'chart', view, clientId ?? '', former],
    queryFn: () => getOrgChart({ view, clientId, former }),
  });
  const { clients } = useClients({ enabled: view === 'field' && hasClients });

  const roleLabel = useMemo(() => roleLabelFor(term), [term]);
  // At enterprise size the field view sends structure and counts; a store's
  // crew loads when it is opened, and search asks the server.
  const crewDeferred = view === 'field' && !!chart.data?.crewDeferred;
  const [crewSites, setCrewSites] = useState<string[]>([]);
  useEffect(() => setCrewSites([]), [view, clientId, former]);
  const crewQueries = useQueries({
    queries: (crewDeferred ? crewSites : []).map((siteId) => ({
      queryKey: ['org', 'chart', 'crew', siteId, former],
      queryFn: () => getStoreCrew(siteId, former),
    })),
  });
  const serverSearch = useQuery({
    queryKey: ['org', 'chart', 'search', query.trim(), clientId ?? ''],
    queryFn: () => searchFieldPeople(query.trim(), clientId),
    enabled: crewDeferred && query.trim().length >= 2,
  });
  const openCrewOf = (nodeId: string | null) => {
    if (!crewDeferred || !nodeId?.startsWith('s:')) return;
    const siteId = nodeId.slice(2);
    setCrewSites((prev) => (prev.includes(siteId) ? prev : [...prev, siteId]));
  };
  const crewData = crewQueries.map((q) => q.data);
  const merged = useMemo(() => {
    const base = chart.data?.nodes ?? [];
    if (!crewDeferred) return base;
    const byId = new Map(base.map((n) => [n.id, n]));
    for (const d of crewData) for (const n of d?.nodes ?? []) byId.set(n.id, n);
    for (const n of serverSearch.data?.nodes ?? []) byId.set(n.id, n);
    return [...byId.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.data, crewDeferred, serverSearch.data, ...crewData]);
  const nodes = useMemo(() => filterByDepartment(merged, view === 'company' ? departmentId || null : null), [merged, departmentId, view]);
  // Opening a store — focusing it in the chart, expanding it in the list —
  // loads its crew when crew is deferred.
  useEffect(() => {
    openCrewOf(focusId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, crewDeferred]);
  useEffect(() => {
    for (const id of expanded) openCrewOf(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, crewDeferred]);
  const index = useMemo(() => indexNodes(nodes), [nodes]);
  const departments = useMemo(() => departmentsOf(chart.data?.nodes ?? []), [chart.data]);
  const structure: StructureActions | undefined = useMemo(() => {
    if (!canStructure) return undefined;
    const regions = nodes.filter((n) => n.kind === 'region');
    return {
      regions,
      onDetails: setDetails,
      onMove: setMoving,
      onDropStore: (siteId, regionNodeId) => {
        const store = index.byId.get(`s:${siteId}`);
        const target = regionNodeId ? index.byId.get(regionNodeId) : null;
        const from = store ? storeRegion(index, store) : null;
        const to = regionNodeId ? regionIdOf(regionNodeId) : null;
        if (!store || from === to) return;
        moveStore.mutate({ siteId, regionId: to, name: store.name, regionName: target?.name ?? null });
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canStructure, nodes, index]);
  const colour = useMemo(() => colourKeys(nodes, colourBy), [nodes, colourBy]);
  const painter: Painter = useMemo(() => {
    const slot = new Map(colour.legend.map((l) => [l.key, l.slot]));
    return {
      roleLabel,
      term,
      slotOf: (n) => {
        if (colourBy === 'none') return null;
        const k = colour.keyOf(n);
        return k ? (slot.get(k) ?? null) : null;
      },
    };
  }, [colour, colourBy, roleLabel, term]);

  // The first two levels start open in the list; a new view starts fresh.
  useEffect(() => {
    const open = new Set<string>();
    for (const n of index.children.get(null) ?? []) {
      open.add(n.id);
      for (const c of index.children.get(n.id) ?? []) if (view === 'field') open.add(c.id);
    }
    setExpanded(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.data, view]);

  // Search: every match in reading order; the current one opens its path
  // (list) or brings its team into view (chart).
  const matches = useMemo(() => searchNodes(index, query, roleLabel), [index, query, roleLabel]);
  const current = matches.length ? matches[Math.min(hit, matches.length - 1)]! : null;
  useEffect(() => setHit(0), [query]);
  useEffect(() => {
    if (!current) return;
    const path = ancestorsOf(index, current.id);
    if (layout === 'list') {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of path) next.add(a.id);
        return next;
      });
    } else {
      setParam('focus', current.parentId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, layout]);

  const step = (d: 1 | -1) => matches.length && setHit((h) => (h + d + matches.length) % matches.length);
  const topLabel = view === 'company' ? 'The company' : 'Every region';
  const stats = useMemo(() => {
    const people = nodes.filter((n) => n.kind === 'person' || n.kind === 'staff' || n.kind === 'lead').length;
    const seats = nodes.filter((n) => n.kind === 'vacancy').length;
    const stores = nodes.filter((n) => n.kind === 'store').length;
    return { people, seats, stores };
  }, [nodes]);

  // The company chart with no reporting line at all: offer to set them.
  const noLines = canEdit && view === 'company' && !!chart.data && nodes.length > 0 && !nodes.some((n) => n.parentId && (n.kind === 'person' || n.kind === 'staff'));

  const exportCsv = () => downloadCsv(`org-chart-${view}-${ymdLocal()}.csv`, chartCsv(index, roleLabel));

  return (
    <ListTemplate
      title="Org chart"
      subtitle={
        view === 'company'
          ? 'Who runs the company and who reports to whom — with the seats still to fill.'
          : hasClients
            ? `Every ${term('label.client').toLowerCase()}, ${term('label.store').toLowerCase()} and crew, with who leads them and today’s coverage.`
            : `Every ${term('label.store').toLowerCase()} and its crew, with who leads them and today’s coverage.`
      }
      // Its own trail: the nav trail would put it under Departments & job
      // profiles (/org is a path prefix), but the sidebar lists them side by side.
      breadcrumbs={[{ label: term('nav.people'), to: '/people' }, { label: 'Org chart' }]}
      actions={[
        // The company chart is edited by its reporting lines; the field tree by its regions and stores.
        // (While nobody has a manager the banner below offers it, so once.)
        { key: 'lines', label: 'Set reporting lines', icon: UserCog, onSelect: () => setBulkLines(true), hidden: !canEdit || noLines },
        { key: 'store', label: `Add ${term('label.store').toLowerCase()}`, icon: MapPinPlus, onSelect: () => setAddingSite({}), hidden: !canStructure },
        { key: 'region', label: 'Add region', icon: Plus, onSelect: () => setAddingRegion(true), hidden: !canStructure },
        { key: 'csv', label: 'Export CSV', icon: Download, onSelect: exportCsv, disabled: !nodes.length },
        { key: 'print', label: 'Print or save as PDF', icon: Printer, onSelect: () => window.print(), disabled: !nodes.length, hidden: isPhone },
      ]}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 print:hidden">
          <SegmentedControl
            ariaLabel="Which chart"
            value={view}
            onChange={(v) => {
              const next = new URLSearchParams(params);
              next.set('view', v);
              next.delete('focus');
              next.delete('client');
              setParams(next, { replace: true });
              setDepartmentId('');
              setColourBy('none');
            }}
            options={[
              { value: 'company', label: 'Company' },
              { value: 'field', label: 'Field' },
            ]}
          />
          {!isPhone && (
            <SegmentedControl
              className="ml-auto"
              ariaLabel="How to show it"
              value={layout}
              onChange={(v) => setParam('layout', v === 'chart' ? null : v)}
              options={[
                { value: 'chart', label: 'Chart' },
                { value: 'list', label: 'List' },
              ]}
            />
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2 print:hidden">
          <div className="min-w-0 flex-1 basis-64 sm:max-w-sm">
            <SearchInput
              placeholder="Find a person, title or place"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  step(e.shiftKey ? -1 : 1);
                }
              }}
              aria-label="Search the org chart"
            />
          </div>
          {query.trim() && (
            <div className="flex items-center gap-1 text-xs text-ink-muted" aria-live="polite">
              <span className="tabular-nums">{matches.length ? `${Math.min(hit, matches.length - 1) + 1} of ${matches.length}` : 'No matches'}</span>
              <Button size="icon-sm" variant="ghost" aria-label="Previous match" onClick={() => step(-1)} disabled={matches.length < 2}>
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Next match" onClick={() => step(1)} disabled={matches.length < 2}>
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          )}
          {view === 'company' && departments.length > 0 && (
            <>
              <label htmlFor="org-dept" className="sr-only">
                Department
              </label>
              <Select id="org-dept" size="sm" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">Every department</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </>
          )}
          {view === 'field' && hasClients && clients.length > 1 && (
            <>
              <label htmlFor="org-client" className="sr-only">
                {term('label.client')}
              </label>
              <Select id="org-client" size="sm" value={clientId ?? ''} onChange={(e) => setParam({ client: e.target.value || null, focus: null })}>
                <option value="">Every {term('label.client').toLowerCase()}</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </>
          )}
          <label htmlFor="org-colour" className="sr-only">
            Color by
          </label>
          <Select id="org-colour" size="sm" value={colourBy} onChange={(e) => setColourBy(e.target.value as ColourBy)}>
            <option value="none">No color</option>
            <option value="department">Color by department</option>
            {view === 'field' && hasClients && <option value="client">Color by {term('label.client').toLowerCase()}</option>}
          </Select>
          <label className="flex items-center gap-2 text-sm text-ink coarse:min-h-11">
            <input type="checkbox" className="h-4 w-4 coarse:h-6 coarse:w-6" checked={former} onChange={(e) => setFormer(e.target.checked)} />
            Include former
          </label>
          {layout === 'list' && nodes.length > 0 && (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setExpanded(new Set(nodes.filter((n) => (index.children.get(n.id) ?? []).length).map((n) => n.id)))}>
                Open all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setExpanded(new Set())}>
                Close all
              </Button>
            </div>
          )}
        </div>

        {colourBy !== 'none' && colour.legend.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted" aria-label="Color key">
            {colour.legend.map((l) => (
              <li key={l.key} className="flex items-center gap-1.5">
                <span className={`h-2.5 w-2.5 rounded-full ${PALETTE[l.slot]!.swatch}`} aria-hidden="true" />
                {l.label}
              </li>
            ))}
          </ul>
        )}

        {chart.data?.truncated && (
          <ErrorBanner severity="warning">
            Showing the first {chart.data.limit.toLocaleString()} people. {hasClients ? `Pick a ${term('label.client').toLowerCase()} or a department` : 'Pick a department'} to see the rest.
          </ErrorBanner>
        )}

        {chart.isError ? (
          <QueryError what="the org chart" query={chart} />
        ) : chart.isLoading || !chart.data ? (
          <Card>
            <CardContent>
              <SkeletonRows count={6} />
            </CardContent>
          </Card>
        ) : nodes.length === 0 ? (
          <Card>
            <CardContent className="p-0">
              <EmptyState
                icon={Network}
                title={departmentId ? 'Nobody in this department' : view === 'company' ? 'No one on the company chart yet' : `No ${term('label.stores').toLowerCase()} in reach`}
                description={
                  view === 'company'
                    ? `Office accounts and anyone with a manager appear here. ${term('workers')} placed only at a ${term('label.store').toLowerCase()} are in the Field chart.`
                    : `Once ${term('label.stores').toLowerCase()} have ${term('workers').toLowerCase()} placed, the field tree appears here.`
                }
              />
            </CardContent>
          </Card>
        ) : (
          <>
            <p className="text-xs text-ink-muted">
              {/* Say who is counted (PEOPLE-23): the company chart is staff and
                  everyone in a reporting line; the field chart is the people
                  placed at its stores (metrics.ts → placed) — neither is
                  "Working" or "On the books". */}
              {view === 'field' ? (
                <span title={termizeText(METRICS.placed.definition, term)}>
                  {stats.people.toLocaleString()} {METRICS.placed.label.toLowerCase()}
                </span>
              ) : (
                <span title="Office accounts, and anyone with a manager — the people this chart draws.">
                  {stats.people.toLocaleString()} {stats.people === 1 ? 'person' : 'people'} on the company chart
                </span>
              )}
              {view === 'field' && ` · ${stats.stores} ${stats.stores === 1 ? term('label.store').toLowerCase() : term('label.stores').toLowerCase()}`}
              {stats.seats > 0 && ` · ${stats.seats} open ${stats.seats === 1 ? 'seat' : 'seats'}`}
              {view === 'company' && chart.data.fieldOnly > 0 && (
                <>
                  {' · '}
                  <button type="button" className="text-accent hover:underline print:hidden" onClick={() => setParam('view', 'field')}>
                    {chart.data.fieldOnly.toLocaleString()} more in the Field chart
                  </button>
                </>
              )}
            </p>
            {canStructure && (
              <p className="text-xs text-ink-muted print:hidden">
                {layout === 'chart'
                  ? `Drag a ${term('label.store').toLowerCase()} onto a region to move it — a bar of every region appears while you drag. The gear opens details; the arrow moves it from the keyboard.`
                  : `The arrow moves a ${term('label.store').toLowerCase()} to a region; the gear opens details. From the keyboard: M to move, I for details.`}
              </p>
            )}
            {noLines && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 print:hidden">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">Nobody has a manager on this chart yet</p>
                  <p className="text-sm text-ink-muted">Everyone sits at the top. Pick a manager and the people who report to them, for many people at once.</p>
                </div>
                <Button size="sm" onClick={() => setBulkLines(true)}>
                  <UserCog className="h-4 w-4" aria-hidden="true" />
                  Set reporting lines
                </Button>
              </div>
            )}
            {layout === 'chart' ? (
              <ChartCanvas
                index={index}
                focusId={focusId && index.byId.has(focusId) ? focusId : null}
                setFocus={(id) => setParam('focus', id)}
                highlightId={current?.id ?? null}
                painter={painter}
                topLabel={topLabel}
                onEdit={canEdit ? setEditing : undefined}
                structure={structure}
              />
            ) : (
              <Card>
                <CardContent className="p-2 sm:p-3">
                  <TreeList
                    index={index}
                    expanded={expanded}
                    setExpanded={setExpanded}
                    highlightId={current?.id ?? null}
                    painter={painter}
                    onEdit={canEdit ? setEditing : undefined}
                    structure={structure}
                    label={view === 'company' ? 'Company org chart' : 'Field org chart'}
                  />
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
      <ReportsToDialog subject={editing} index={index} onClose={() => setEditing(null)} />
      {canEdit && <BulkReportsToDialog open={bulkLines} index={index} roleLabel={roleLabel} onClose={() => setBulkLines(false)} />}
      {canStructure && (
        <>
          <StructureDrawer node={details} index={index} onClose={() => setDetails(null)} onAddSite={(d) => setAddingSite(d)} />
          <MoveToRegionDialog store={moving} currentRegionId={storeRegion(index, moving)} onClose={() => setMoving(null)} />
          <AddRegionDialog open={addingRegion} onClose={() => setAddingRegion(false)} />
          <AddSiteDialog open={!!addingSite} defaults={addingSite ?? {}} onClose={() => setAddingSite(null)} />
        </>
      )}
    </ListTemplate>
  );
}
