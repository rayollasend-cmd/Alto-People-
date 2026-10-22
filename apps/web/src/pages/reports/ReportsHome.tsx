import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  CalendarClock,
  Copy,
  Download,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { REPORT_PERIOD_LABELS, REPORT_PERIOD_TOKENS } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { errorText } from '@/lib/errorText';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useConfirm } from '@/lib/confirm';
import { downloadCsv } from '@/lib/csv';
import { usePersistentState } from '@/lib/usePersistentState';
import {
  createReport,
  createSchedule,
  deleteReport,
  deleteSchedule,
  getReport,
  listColumns,
  listReports,
  listSchedules,
  previewReport,
  runReport,
  updateReport,
  type AggregateFn,
  type ReportAggregate,
  type ReportEntity,
  type ReportFull,
  type ReportSchedule,
  type ReportSpec,
  type ReportSummary,
} from '@/lib/reports96Api';
import { AssociatePicker } from '@/components/ui/AssociatePicker';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  Select,
  SkeletonRows,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { Label } from '@/components/ui/Label';
import { ListTemplate } from '@/components/templates';
import { toast } from 'sonner';
import { REPORT_TEMPLATES, templateText, type ReportTemplate } from './reportTemplates';
import { useTenant, useTerm } from '@/lib/auth';
import { SectionTitle } from '@/components/ui/SectionTitle';

const ENTITIES: ReportEntity[] = [
  'ASSOCIATE',
  'TIME_ENTRY',
  'PAYROLL_ITEM',
  'PAYROLL_RUN',
  'APPLICATION',
  'EXPENSE',
  'CANDIDATE',
  'SEPARATION',
  'LEAVE_CASE',
  'HR_CASE',
  'OFFER',
];

/** Human labels for the entity enum — never show ASSOCIATE/TIME_ENTRY raw. */
const ENTITY_LABELS: Record<ReportEntity, string> = {
  ASSOCIATE: 'Associate',
  TIME_ENTRY: 'Time entry',
  PAYROLL_ITEM: 'Payroll item',
  PAYROLL_RUN: 'Payroll run',
  APPLICATION: 'Application',
  EXPENSE: 'Expense',
  CANDIDATE: 'Candidate',
  SEPARATION: 'Separation',
  LEAVE_CASE: 'Leave case',
  HR_CASE: 'HR case',
  OFFER: 'Offer',
};

/**
 * Column-type heuristics. The columns endpoint returns plain names
 * (see reports96Api.listColumns → { columns: string[] }) with no
 * type/options metadata, so the value control is inferred from the
 * whitelisted column names in apps/api/src/routes/reports96.ts:
 *   - *At / period* / clockIn / clockOut → DateTime → date input
 *   - associateId → associate reference → AssociatePicker
 *   - everything else (incl. enum-ish status/stage — no options are
 *     served, so no Select can be built) → free-text input
 */
const isDateColumn = (c: string) =>
  /At$/.test(c) ||
  /Date$/.test(c) ||
  c === 'periodStart' ||
  c === 'periodEnd' ||
  c === 'clockIn' ||
  c === 'clockOut' ||
  c === 'lastDayWorked';

const isAssociateColumn = (c: string) => c === 'associateId';

/** The columns sum/avg/min/max may roll up — mirrors NUMERIC_COLUMNS in apps/api/src/lib/reportRun.ts. */
const NUMERIC_COLUMNS: Partial<Record<ReportEntity, readonly string[]>> = {
  PAYROLL_ITEM: ['grossAmount', 'netAmount'],
  PAYROLL_RUN: ['totalGross', 'totalNet'],
  EXPENSE: ['amount'],
  OFFER: ['hourlyRate', 'salary'],
};

const AGGREGATE_FNS: { value: AggregateFn; label: string }[] = [
  { value: 'count', label: 'Count of rows' },
  { value: 'sum', label: 'Sum of' },
  { value: 'avg', label: 'Average of' },
  { value: 'min', label: 'Lowest' },
  { value: 'max', label: 'Highest' },
];

interface AggregateRow {
  fn: AggregateFn;
  column: string;
  alias: string;
}

/** The output key an aggregate lands under when no alias is given — the server's rule. */
const defaultAlias = (a: AggregateRow) => (a.fn === 'count' ? 'count' : `${a.fn}_${a.column}`);

interface BuilderSeed {
  /** draft: a spec handed over by the assistant (`?draft=`), opened as a new report. */
  mode: 'edit' | 'duplicate' | 'draft';
  report: ReportFull;
}

/** Decode `?draft=` (base64url JSON {name, entity, spec}) into a builder seed, or null. */
function draftSeed(raw: string | null): BuilderSeed | null {
  if (!raw) return null;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(decodeURIComponent(escape(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))))) as { name?: string; entity?: string; spec?: ReportFull['spec'] };
    if (!json.entity || !ENTITIES.includes(json.entity as ReportEntity) || !json.spec?.columns?.length) return null;
    return { mode: 'draft', report: { id: '', name: (json.name ?? 'Report').slice(0, 160), description: null, entity: json.entity as ReportEntity, spec: json.spec, isPublic: false } as unknown as ReportFull };
  } catch {
    return null;
  }
}

/** One CSV mapping for both the row's one-click download and the preview
 *  drawer's export, so the two files are byte-identical. */
function exportRowsAsCsv(
  name: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
) {
  downloadCsv(`${name.replace(/\s+/g, '_')}.csv`, [
    columns,
    ...rows.map((r) =>
      columns.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return '';
        if (typeof v === 'number') return v;
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
      }),
    ),
  ]);
}

export function ReportsHome() {
  const confirm = useConfirm();
  // 2-3 recurring weekly exports live here — losing the search/entity
  // narrowing on every visit costs more clicks than a stale query risks.
  const [search, setSearch] = usePersistentState<string>(
    'alto:list.reports.search.v1',
    '',
    (v): v is string => typeof v === 'string',
  );
  const [entityFilter, setEntityFilter] = usePersistentState<'' | ReportEntity>(
    'alto:list.reports.entity.v1',
    '',
    (v): v is '' | ReportEntity => v === '' || ENTITIES.includes(v as ReportEntity),
  );
  const [params, setParams] = useSearchParams();
  // A report the assistant drafted opens straight in the builder, unsaved.
  const [builder, setBuilder] = useState<{ seed: BuilderSeed | null } | null>(() => {
    const seed = draftSeed(params.get('draft'));
    return seed ? { seed } : null;
  });
  useEffect(() => {
    if (!params.get('draft')) return;
    const next = new URLSearchParams(params);
    next.delete('draft');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [schedulesFor, setSchedulesFor] = useState<ReportSummary | null>(null);
  const [running, setRunning] = useState<{
    name: string;
    columns: string[];
    rows: Array<Record<string, unknown>>;
  } | null>(null);

  const refreshQuery = useQuery({
    queryKey: ['ReportsHome', 'rows'],
    queryFn: () => listReports(),
  });
  const rows: ReportSummary[] | null = refreshQuery.data?.reports ?? null;
  const loadError = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load reports.' : null;
  const refresh = () => void refreshQuery.refetch();

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (entityFilter && r.entity !== entityFilter) return false;
      return true;
    });
  }, [rows, search, entityFilter]);

  const onRun = async (r: ReportSummary) => {
    try {
      const res = await runReport(r.id);
      setRunning({
        name: r.name,
        columns: res.columns,
        rows: res.rows as Array<Record<string, unknown>>,
      });
    } catch (err) {
      toast.error(errorText(err, "Couldn't run the report."));
    }
  };

  // One-click Run → CSV, skipping the preview drawer entirely.
  const onCsv = async (r: ReportSummary) => {
    try {
      const res = await runReport(r.id);
      exportRowsAsCsv(r.name, res.columns, res.rows as Array<Record<string, unknown>>);
      toast.success(`Exported ${res.rows.length} rows.`);
    } catch (err) {
      toast.error(errorText(err, "Couldn't export the report."));
    }
  };

  const openSeeded = async (r: ReportSummary, mode: BuilderSeed['mode']) => {
    try {
      const full = await getReport(r.id);
      setBuilder({ seed: { mode, report: full } });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load report.');
    }
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this report?', destructive: true }))) return;
    try {
      await deleteReport(id);
      toast.success('Report deleted.');
      refresh();
    } catch (err) {
      toast.error(errorText(err, "Couldn't delete the report."));
    }
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Reports"
        subtitle="Build, save, and schedule reports across people, time, payroll, applications, and candidates."
        breadcrumbs={[{ label: 'Insights' }, { label: 'Reports' }]}
    >
      <div className="flex flex-wrap items-center gap-2">
        {rows !== null && rows.length > 0 && (
          <>
            <Input
              className="max-w-xs h-8 text-xs"
              placeholder="Search reports by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search reports"
            />
            <div className="w-44">
              <Select
                size="sm"
                value={entityFilter}
                onChange={(e) => setEntityFilter(e.target.value as '' | ReportEntity)}
                aria-label="Filter reports by entity"
              >
                <option value="">All entities</option>
                {ENTITIES.map((e) => (
                  <option key={e} value={e}>{ENTITY_LABELS[e]}</option>
                ))}
              </Select>
            </div>
          </>
        )}
        <div className="ml-auto flex gap-2">
          {/* The canned people reports: turnover, cohorts, time to fill, absence. */}
          <Button asChild variant="outline">
            <Link to="/reports/people">People analytics</Link>
          </Button>
          <Button onClick={() => setBuilder({ seed: null })}>
            <Plus className="mr-2 h-4 w-4" /> New report
          </Button>
        </div>
      </div>
      {/* The builder no longer starts blank (HR walk 17): the reports HR
          builds every month, ready to run or adjust. Nothing is saved
          until the person saves it. */}
      <TemplateGallery
        onPick={(tpl) =>
          setBuilder({
            seed: {
              mode: 'draft',
              report: {
                id: '',
                name: tpl.name,
                description: tpl.hint,
                entity: tpl.entity,
                spec: tpl.spec,
                isPublic: false,
                createdAt: new Date().toISOString(),
              },
            },
          })
        }
      />
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6 space-y-3">
              <ErrorBanner>{loadError}</ErrorBanner>
              <Button size="sm" variant="outline" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No saved reports"
              description="Build a report by picking an entity, columns, and filters. Save and share with the team."
              action={
                <Button onClick={() => setBuilder({ seed: null })}>
                  <Plus className="mr-2 h-4 w-4" /> New report
                </Button>
              }
            />
          ) : filtered.length === 0 ? (
            <div className="p-6 text-sm text-silver">
              No reports match the current search / filter.
            </div>
          ) : (
            <DataGrid<(typeof filtered)[number]>
              id="saved-reports"
              caption="Saved reports"
              rows={filtered}
              rowKey={(r) => r.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'saved-reports' }}
              onRowClick={(r) => onRun(r)}
              rowActionLabel={(r) => `Run ${r.name}`}
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  accessor: (r) => r.name,
                  sortable: true,
                  primary: true,
                  className: 'font-medium text-white',
                  cell: (r) => (
                    <span className="inline-flex items-center gap-2">
                      {r.name}
                      {r.period && <Badge variant="outline">{REPORT_PERIOD_LABELS[r.period]}</Badge>}
                    </span>
                  ),
                },
                { key: 'entity', header: 'Entity', accessor: (r) => ENTITY_LABELS[r.entity] ?? r.entity, sortable: true, cardMeta: true, className: 'text-xs' },
                {
                  key: 'visibility',
                  header: 'Visibility',
                  accessor: (r) => (r.isPublic ? 'Shared' : 'Private'),
                  sortable: true,
                  cell: (r) => (r.isPublic ? <Badge variant="success">Shared</Badge> : <Badge variant="default">Private</Badge>),
                },
                { key: 'created', header: 'Created', accessor: (r) => r.createdAt, sortable: true, searchable: false, cardMeta: true, cell: (r) => fmtDate(r.createdAt) },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'whitespace-nowrap space-x-1',
                  cell: (r) => (
                    <>
                      <Button size="sm" onClick={() => onRun(r)}>
                        <Play className="mr-1 h-3 w-3" /> Run
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onCsv(r)} title="Run and download CSV" aria-label={`Download CSV for "${r.name}"`}>
                        <Download className="mr-1 h-3 w-3" /> CSV
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openSeeded(r, 'edit')} title="Edit" aria-label={`Edit "${r.name}"`}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openSeeded(r, 'duplicate')} title="Duplicate" aria-label={`Duplicate "${r.name}"`}>
                        <Copy className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSchedulesFor(r)} title="Schedules" aria-label={`Schedules for "${r.name}"`}>
                        <CalendarClock className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-silver hover:text-alert" onClick={() => onDelete(r.id)} title="Delete" aria-label={`Delete "${r.name}"`}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </>
                  ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {builder && (
        <ReportBuilder
          seed={builder.seed}
          onClose={() => setBuilder(null)}
          onSaved={() => {
            setBuilder(null);
            refresh();
          }}
        />
      )}
      {schedulesFor && (
        <SchedulesDrawer
          report={schedulesFor}
          onClose={() => setSchedulesFor(null)}
        />
      )}
      {running && (
        <RunResultDrawer
          name={running.name}
          columns={running.columns}
          rows={running.rows}
          onClose={() => setRunning(null)}
        />
      )}
    </ListTemplate>
  );
}

type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'period';

interface FilterRow {
  column: string;
  op: FilterOp;
  value: string;
  /** Display name when `value` is an associate id picked via AssociatePicker. */
  valueLabel?: string;
}

interface SortRow {
  column: string;
  dir: 'asc' | 'desc';
}

// `period` is deliberately absent — it's driven by the preset Select on
// date columns, not the operator dropdown.
const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'ne', label: 'not equals' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'contains', label: 'contains' },
  { value: 'in', label: 'in (comma-separated)' },
];

/** Sentinel for the preset Select's "pick concrete dates" branch —
 *  distinct from every REPORT_PERIOD_TOKENS value. */
const CUSTOM_PERIOD = 'custom';

/** Map a saved spec's filters back into editable rows. */
function specToFilterRows(spec: ReportSpec): FilterRow[] {
  return spec.filters.map((f) => {
    let value: string;
    if (Array.isArray(f.value)) value = f.value.map((v) => String(v)).join(', ');
    else if (f.value === null || f.value === undefined) value = '';
    else value = String(f.value);
    // Date columns are stored as full ISO datetimes; the date input wants
    // just the calendar day.
    if (isDateColumn(f.column) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      value = value.slice(0, 10);
    }
    return { column: f.column, op: f.op, value };
  });
}

const NO_COLUMNS: string[] = [];

function TemplateGallery({ onPick }: { onPick: (t: ReportTemplate) => void }) {
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  const words = { client: term('label.client').toLowerCase(), store: term('label.store').toLowerCase() };
  const templates = REPORT_TEMPLATES.filter((t) => hasClients || !t.needsClients).map((t) => ({
    ...t,
    name: templateText(t.name, words),
    hint: templateText(t.hint, words),
  }));
  return (
    <section aria-label="Start from a template" className="space-y-3">
      <SectionTitle title="Start from a template" description="Opens in the builder, ready to run. Change anything before you save." />
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {templates.map((tpl) => (
          <li key={tpl.key}>
            <button
              type="button"
              onClick={() => onPick(tpl)}
              className="flex h-full w-full flex-col rounded-lg border border-line bg-surface p-3 text-left transition-colors hover:border-gold/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="text-sm font-medium text-ink">{tpl.name}</span>
              <span className="mt-0.5 text-2xs uppercase tracking-wider text-ink-muted">{ENTITY_LABELS[tpl.entity]}</span>
              <span className="mt-1 text-xs text-ink-muted">{tpl.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReportBuilder({
  seed,
  onClose,
  onSaved,
}: {
  seed: BuilderSeed | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(
    seed ? (seed.mode === 'duplicate' ? `Copy of ${seed.report.name}` : seed.report.name) : '',
  );
  const [entity, setEntity] = useState<ReportEntity>(seed?.report.entity ?? 'ASSOCIATE');
  const [columns, setColumns] = useState<string[]>(seed?.report.spec.columns ?? []);

  const [isPublic, setIsPublic] = useState(seed?.report.isPublic ?? false);
  const [filters, setFilters] = useState<FilterRow[]>(
    seed ? specToFilterRows(seed.report.spec) : [],
  );
  const [sorts, setSorts] = useState<SortRow[]>(
    seed ? seed.report.spec.sort.map((s) => ({ column: s.column, dir: s.direction })) : [],
  );
  const [limit, setLimit] = useState(seed ? String(seed.report.spec.limit) : '1000');
  // Summarize: one row per distinct combination of the group-by columns,
  // each aggregate beside it. Off, the report lists rows as before.
  const [summarize, setSummarize] = useState((seed?.report.spec.groupBy?.length ?? 0) > 0);
  const [groupBy, setGroupBy] = useState<string[]>(seed?.report.spec.groupBy ?? []);
  const [aggregates, setAggregates] = useState<AggregateRow[]>(
    (seed?.report.spec.aggregates ?? []).map((a) => ({ fn: a.fn, column: a.column ?? '', alias: a.alias ?? '' })),
  );
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{
    columns: string[];
    rows: Array<Record<string, unknown>>;
  } | null>(null);

  const columnsQuery = useQuery({
    queryKey: ['ReportBuilder', 'columns', entity],
    queryFn: () => listColumns(entity),
  });
  const allColumns: string[] = columnsQuery.data?.columns ?? NO_COLUMNS;
  const columnsError = columnsQuery.error
    ? columnsQuery.error instanceof ApiError
      ? columnsQuery.error.message
      : 'Failed to load columns.'
    : null;
  const loadColumns = () => void columnsQuery.refetch();

  // On the initial render the seed (if any) already provides columns /
  // filters / sorts for its entity — only wipe them when the admin
  // switches to a different entity afterwards.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setColumns([]);
    setFilters([]);
    setSorts([]);
    setGroupBy([]);
    setAggregates([]);
  }, [entity]);

  const numericColumns = NUMERIC_COLUMNS[entity] ?? [];
  const toggleGroupBy = (col: string) =>
    setGroupBy((gs) => (gs.includes(col) ? gs.filter((c) => c !== col) : gs.length >= 4 ? gs : [...gs, col]));
  const addAggregate = () =>
    setAggregates((as) => (as.length >= 8 ? as : [...as, { fn: 'count', column: numericColumns[0] ?? '', alias: '' }]));
  const updateAggregate = (idx: number, patch: Partial<AggregateRow>) =>
    setAggregates((as) => as.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  const removeAggregate = (idx: number) => setAggregates((as) => as.filter((_, i) => i !== idx));

  const toggleColumn = (col: string) => {
    setColumns((cs) =>
      cs.includes(col) ? cs.filter((c) => c !== col) : [...cs, col],
    );
  };

  const buildSpec = (): ReportSpec => {
    // Convert each filter row to the API shape. `in` splits the comma-list;
    // numeric ops coerce when the value parses cleanly so reports compare
    // numbers as numbers, not strings. Date columns are widened to full
    // ISO datetimes (Prisma DateTime filters reject bare dates). `period`
    // tokens pass through verbatim — the server resolves them at run time.
    const compiledFilters = filters
      .filter((f) => f.column && f.value.trim())
      .map((f) => {
        let value: unknown = f.value.trim();
        if (f.op === 'in') {
          value = f.value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
        } else if (
          isDateColumn(f.column) &&
          /^\d{4}-\d{2}-\d{2}$/.test(f.value.trim())
        ) {
          value = new Date(f.value.trim()).toISOString();
        } else if (
          ['gt', 'gte', 'lt', 'lte'].includes(f.op) &&
          /^-?\d+(\.\d+)?$/.test(f.value.trim())
        ) {
          value = Number(f.value.trim());
        }
        return { column: f.column, op: f.op, value };
      });
    const base: ReportSpec = {
      columns,
      filters: compiledFilters,
      sort: sorts
        .filter((s) => s.column)
        .map((s) => ({ column: s.column, direction: s.dir })),
      limit: Math.max(1, Math.min(10_000, parseInt(limit, 10) || 1000)),
    };
    if (!summarize || groupBy.length === 0) return base;
    // A summary's output columns are the group keys and the aggregates;
    // the spec still names at least one column (the schema's floor), so
    // the group keys stand in when none were picked.
    const compiledAggregates: ReportAggregate[] = (aggregates.length ? aggregates : [{ fn: 'count' as const, column: '', alias: '' }])
      .filter((a) => a.fn === 'count' || a.column)
      .map((a) => ({ fn: a.fn, column: a.fn === 'count' ? null : a.column, alias: a.alias.trim() || null }));
    return { ...base, columns: columns.length ? columns : groupBy, groupBy, aggregates: compiledAggregates };
  };

  /** Summaries group by at least one column; lists pick at least one. */
  const shapeProblem = (): string | null => {
    if (summarize) return groupBy.length === 0 ? 'Pick at least one column to group by.' : null;
    return columns.length === 0 ? 'Pick at least one column.' : null;
  };

  const onPreview = async () => {
    const problem = shapeProblem();
    if (problem) {
      toast.error(problem);
      return;
    }
    try {
      const r = await previewReport({
        name: name || 'preview',
        entity,
        spec: buildSpec(),
      });
      setPreview({
        columns: r.columns,
        rows: r.rows as Array<Record<string, unknown>>,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't preview the report.");
    }
  };

  const onSubmit = async () => {
    const problem = name.trim() ? shapeProblem() : 'Name the report first.';
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    const input = { name: name.trim(), entity, spec: buildSpec(), isPublic };
    try {
      if (seed?.mode === 'edit') {
        try {
          await updateReport(seed.report.id, input);
          toast.success('Report updated.');
        } catch (err) {
          // Not the author (403) or the original is gone (404) — the edit
          // is still worth keeping, so save it as a new report instead.
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            await createReport(input);
            toast.warning(
              'Saved as a new report — only the author can edit the original.',
            );
          } else {
            throw err;
          }
        }
      } else {
        await createReport(input);
        toast.success('Report saved.');
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the report.");
    } finally {
      setSaving(false);
    }
  };

  const addFilter = () =>
    setFilters((fs) => [
      ...fs,
      { column: allColumns[0] ?? '', op: 'eq', value: '' },
    ]);

  const updateFilter = (idx: number, patch: Partial<FilterRow>) =>
    setFilters((fs) =>
      fs.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    );

  const removeFilter = (idx: number) =>
    setFilters((fs) => fs.filter((_, i) => i !== idx));

  const addSort = () =>
    setSorts((ss) => [
      ...ss,
      { column: columns[0] ?? allColumns[0] ?? '', dir: 'asc' },
    ]);

  const updateSort = (idx: number, patch: Partial<SortRow>) =>
    setSorts((ss) => ss.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  const removeSort = (idx: number) =>
    setSorts((ss) => ss.filter((_, i) => i !== idx));

  const title =
    seed?.mode === 'edit'
      ? 'Edit report'
      : seed?.mode === 'duplicate'
        ? 'Duplicate report'
        : 'Build report';

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-3xl">
      <DrawerHeader>
        <DrawerTitle>{title}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Label>Entity</Label>
          <Select
            className="mt-1"
            value={entity}
            onChange={(e) => setEntity(e.target.value as ReportEntity)}
          >
            {ENTITIES.map((e) => (
              <option key={e} value={e}>
                {ENTITY_LABELS[e]}
              </option>
            ))}
          </Select>
        </div>
        {columnsError && (
          <div className="space-y-2">
            <ErrorBanner>{columnsError}</ErrorBanner>
            <Button size="sm" variant="outline" onClick={() => loadColumns()}>
              Retry
            </Button>
          </div>
        )}
        <div>
          <Label>Columns ({columns.length} selected)</Label>
          <div className="mt-2 max-h-40 overflow-y-auto flex flex-wrap gap-1.5 p-2 border border-navy-secondary rounded-md bg-navy-secondary/20">
            {allColumns.map((c) => {
              const selected = columns.includes(c);
              return (
                <Button
                  key={c}
                  type="button"
                  variant={selected ? 'secondary' : 'outline'}
                  size="xs"
                  onClick={() => toggleColumn(c)}
                  aria-pressed={selected}
                  className="font-mono"
                >
                  {c}
                </Button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <Label>Filters</Label>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={addFilter}
              disabled={allColumns.length === 0}
            >
              <Plus className="mr-1 h-3 w-3" /> Add filter
            </Button>
          </div>
          {filters.length === 0 ? (
            <div className="text-xs text-silver italic mt-1">
              No filters — report returns every row of the entity.
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              {filters.map((f, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <div className="flex-1">
                    <Select
                      size="sm"
                      className="font-mono"
                      value={f.column}
                      onChange={(e) => {
                        // Column switch changes the value control type —
                        // reset the value so a stale id/date can't leak in.
                        // A period token is column-independent, so it
                        // survives a date→date switch; otherwise `period`
                        // has to fall back to a real operator.
                        const column = e.target.value;
                        const keepToken = f.op === 'period' && isDateColumn(column);
                        updateFilter(i, {
                          column,
                          op: f.op === 'period' && !keepToken ? 'eq' : f.op,
                          value: keepToken ? f.value : '',
                          valueLabel: undefined,
                        });
                      }}
                    >
                      {allColumns.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {isDateColumn(f.column) && (
                    <Select
                      size="sm"
                      value={f.op === 'period' ? f.value : CUSTOM_PERIOD}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === CUSTOM_PERIOD) {
                          updateFilter(i, { op: 'gte', value: '' });
                        } else {
                          updateFilter(i, { op: 'period', value: v });
                        }
                      }}
                      aria-label={`Filter ${i + 1} period preset`}
                    >
                      {REPORT_PERIOD_TOKENS.map((t) => (
                        <option key={t} value={t}>
                          {REPORT_PERIOD_LABELS[t]}
                        </option>
                      ))}
                      <option value={CUSTOM_PERIOD}>Custom dates</option>
                    </Select>
                  )}
                  {f.op !== 'period' && (
                    <Select
                      size="sm"
                      value={f.op}
                      onChange={(e) =>
                        updateFilter(i, { op: e.target.value as FilterOp })
                      }
                    >
                      {FILTER_OPS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  )}
                  {f.op === 'period' ? null : isAssociateColumn(f.column) && f.op !== 'in' ? (
                    <div className="flex-1">
                      <AssociatePicker
                        value={
                          f.value
                            ? { id: f.value, name: f.valueLabel ?? f.value }
                            : null
                        }
                        onChange={(v) =>
                          updateFilter(i, {
                            value: v?.id ?? '',
                            valueLabel: v?.name,
                          })
                        }
                      />
                    </div>
                  ) : isDateColumn(f.column) && f.op !== 'in' ? (
                    <Input
                      type="date"
                      className="flex-1 h-8 text-xs"
                      value={f.value}
                      onChange={(e) =>
                        updateFilter(i, { value: e.target.value })
                      }
                      aria-label={`Filter ${i + 1} date value`}
                    />
                  ) : (
                    <Input
                      className="flex-1 h-8 text-xs"
                      value={f.value}
                      onChange={(e) =>
                        updateFilter(i, { value: e.target.value })
                      }
                      placeholder={
                        f.op === 'in' ? 'val1, val2, val3' : 'value'
                      }
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeFilter(i)}
                    className="text-silver hover:text-alert p-1 coarse:p-2.5"
                    title="Remove filter"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-md border border-navy-secondary p-3">
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={summarize}
                onChange={(e) => setSummarize(e.target.checked)}
                aria-label="Summarize"
              />
              <span className="text-xs font-medium uppercase tracking-widest text-silver">Summarize</span>
            </label>
            <span className="text-xs text-silver">
              One row per group, with a count or a total beside it.
            </span>
          </div>
          {summarize && (
            <div className="mt-3 space-y-3">
              <div>
                <Label>Group by ({groupBy.length} of 4)</Label>
                <div
                  className="mt-2 flex flex-wrap gap-1.5 p-2 border border-navy-secondary rounded-md bg-navy-secondary/20"
                  role="group"
                  aria-label="Group by"
                >
                  {allColumns.map((c) => {
                    const selected = groupBy.includes(c);
                    return (
                      <Button
                        key={c}
                        type="button"
                        variant={selected ? 'secondary' : 'outline'}
                        size="xs"
                        onClick={() => toggleGroupBy(c)}
                        aria-pressed={selected}
                        className="font-mono"
                      >
                        {c}
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label>Totals</Label>
                  <Button size="sm" variant="ghost" type="button" onClick={addAggregate} disabled={aggregates.length >= 8}>
                    <Plus className="mr-1 h-3 w-3" /> Add total
                  </Button>
                </div>
                {aggregates.length === 0 ? (
                  <div className="text-xs text-silver italic mt-1">
                    No totals — each group shows its count of rows.
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    {aggregates.map((a, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <Select
                          size="sm"
                          aria-label={`Total ${i + 1} function`}
                          value={a.fn}
                          onChange={(e) => {
                            const fn = e.target.value as AggregateFn;
                            updateAggregate(i, { fn, column: fn === 'count' ? '' : a.column || numericColumns[0] || '' });
                          }}
                        >
                          {AGGREGATE_FNS.map((f) => (
                            <option key={f.value} value={f.value}>
                              {f.label}
                            </option>
                          ))}
                        </Select>
                        {a.fn !== 'count' && (
                          <div className="flex-1">
                            <Select
                              size="sm"
                              className="font-mono"
                              aria-label={`Total ${i + 1} column`}
                              value={a.column}
                              onChange={(e) => updateAggregate(i, { column: e.target.value })}
                            >
                              {numericColumns.length === 0 && <option value="">No number columns on this entity</option>}
                              {numericColumns.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </Select>
                          </div>
                        )}
                        <Input
                          size="sm"
                          className="max-w-[160px] font-mono"
                          aria-label={`Total ${i + 1} name`}
                          placeholder={defaultAlias(a)}
                          value={a.alias}
                          maxLength={40}
                          onChange={(e) => updateAggregate(i, { alias: e.target.value })}
                        />
                        <Button size="icon-sm" variant="ghost" type="button" onClick={() => removeAggregate(i)} aria-label={`Remove total ${i + 1}`}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {numericColumns.length === 0 && aggregates.some((a) => a.fn !== 'count') && (
                  <div className="text-xs text-warning mt-1">
                    Only count works here — this entity has no number columns to total.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between">
            <Label>Sort</Label>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={addSort}
              disabled={allColumns.length === 0}
            >
              <Plus className="mr-1 h-3 w-3" /> Add sort
            </Button>
          </div>
          {sorts.length === 0 ? (
            <div className="text-xs text-silver italic mt-1">
              No sort — order is undefined.
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              {sorts.map((s, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <div className="flex-1">
                    <Select
                      size="sm"
                      className="font-mono"
                      value={s.column}
                      onChange={(e) =>
                        updateSort(i, { column: e.target.value })
                      }
                    >
                      {allColumns.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateSort(i, { dir: s.dir === 'asc' ? 'desc' : 'asc' })
                    }
                    className="h-8 px-3 rounded-md border border-navy-secondary bg-navy-secondary/40 text-xs text-white hover:bg-navy-secondary/60 flex items-center gap-1"
                  >
                    {s.dir === 'asc' ? (
                      <>
                        <ArrowUp className="h-3 w-3" /> asc
                      </>
                    ) : (
                      <>
                        <ArrowDown className="h-3 w-3" /> desc
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSort(i)}
                    className="text-silver hover:text-alert p-1 coarse:p-2.5"
                    title="Remove sort"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <Label>Row limit</Label>
          <Input
            type="number"
            min="1"
            max="10000"
            className="mt-1 max-w-[160px]"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
          <div className="text-xs text-silver mt-1">
            Hard cap is 10,000. Use sort to surface the rows you care about.
          </div>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          <Label>Share with the team (public)</Label>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="ghost" onClick={onPreview}>
          Preview
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
      {preview && (
        <RunResultDrawer
          name={`${name.trim() || 'Untitled'} (preview)`}
          columns={preview.columns}
          rows={preview.rows}
          onClose={() => setPreview(null)}
        />
      )}
    </Drawer>
  );
}

const CADENCES: ReportSchedule['cadence'][] = ['DAILY', 'WEEKLY', 'MONTHLY'];

const CADENCE_LABELS: Record<ReportSchedule['cadence'], string> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
};

/**
 * Scheduling for a saved report. The API shape (reports96Api) is a
 * cadence enum + a recipients string — there is no time-of-day field
 * (the server computes nextRunAt relative to creation), so the form is
 * a frequency Select + recipients input.
 */
function SchedulesDrawer({
  report,
  onClose,
}: {
  report: ReportSummary;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const [cadence, setCadence] = useState<ReportSchedule['cadence']>('WEEKLY');
  const [recipients, setRecipients] = useState('');
  const [saving, setSaving] = useState(false);

  const loadQuery = useQuery({
    queryKey: ['SchedulesDrawer', 'schedules', report.id],
    queryFn: () => listSchedules(report.id),
  });
  const schedules: ReportSchedule[] | null = loadQuery.data?.schedules ?? null;
  const loadError = loadQuery.error ? loadQuery.error instanceof ApiError ? loadQuery.error.message : 'Failed to load schedules.' : null;
  const load = () => void loadQuery.refetch();

  const onCreate = async () => {
    if (!recipients.trim()) {
      toast.error('Recipients required.');
      return;
    }
    setSaving(true);
    try {
      await createSchedule(report.id, { cadence, recipients: recipients.trim() });
      toast.success('Schedule created.');
      setRecipients('');
      load();
    } catch (err) {
      toast.error(errorText(err, "Couldn't create the schedule."));
    } finally {
      setSaving(false);
    }
  };

  const onDeleteSchedule = async (id: string) => {
    if (!(await confirm({ title: 'Delete this schedule?', destructive: true }))) return;
    try {
      await deleteSchedule(id);
      toast.success('Schedule deleted.');
      load();
    } catch (err) {
      toast.error(errorText(err, "Couldn't delete the schedule."));
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      <DrawerHeader>
        <DrawerTitle>Schedules — {report.name}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {loadError ? (
          <div className="space-y-2">
            <ErrorBanner>{loadError}</ErrorBanner>
            <Button size="sm" variant="outline" onClick={load}>
              Retry
            </Button>
          </div>
        ) : schedules === null ? (
          <SkeletonRows count={2} />
        ) : schedules.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="No schedules"
            description="Deliver this report to a recipient list on a recurring cadence."
          />
        ) : (
          <ul className="space-y-2">
            {schedules.map((s) => (
              <li
                key={s.id}
                className="rounded border border-navy-secondary p-3 flex items-start gap-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{CADENCE_LABELS[s.cadence] ?? s.cadence}</Badge>
                    {s.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="default">Inactive</Badge>
                    )}
                  </div>
                  <div className="text-xs text-white truncate">{s.recipients}</div>
                  <div className="text-xs2 text-silver">
                    Next run {fmtDateTime(s.nextRunAt)}
                    {' · '}Last run {fmtDateTime(s.lastRunAt)}
                  </div>
                </div>
                <button
                  onClick={() => onDeleteSchedule(s.id)}
                  className="text-silver hover:text-alert transition p-1 coarse:p-2.5"
                  title="Delete schedule"
                  aria-label="Delete schedule"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="pt-3 border-t border-navy-secondary space-y-3">
          <div className="text-2xs uppercase tracking-widest text-silver/80">
            New schedule
          </div>
          <div>
            <Label>Frequency</Label>
            <Select
              className="mt-1"
              value={cadence}
              onChange={(e) => setCadence(e.target.value as ReportSchedule['cadence'])}
            >
              {CADENCES.map((c) => (
                <option key={c} value={c}>{CADENCE_LABELS[c]}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Recipients</Label>
            <Input
              className="mt-1"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="ops@example.com, hr@example.com"
            />
            <div className="text-xs text-silver mt-1">
              Comma-separated email list. The first delivery lands one
              day/week/month after the schedule is created.
            </div>
          </div>
          <Button onClick={onCreate} disabled={saving}>
            {saving ? 'Creating…' : 'Create schedule'}
          </Button>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function RunResultDrawer({
  name,
  columns,
  rows,
  onClose,
}: {
  name: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  onClose: () => void;
}) {
  const exportCsv = () => exportRowsAsCsv(name, columns, rows);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-5xl">
      <DrawerHeader>
        <DrawerTitle>{name} — {rows.length} rows</DrawerTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex justify-end mb-2">
          <Button size="sm" variant="ghost" onClick={exportCsv}>
            Export CSV
          </Button>
        </div>
        <div className="overflow-x-auto border border-navy-secondary rounded-md">
          <table className="min-w-max text-xs">
            <thead className="bg-navy-secondary/40 text-silver">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="text-left px-3 py-2 font-mono">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-white">
              {rows.slice(0, 500).map((r, i) => (
                <tr key={i} className="border-t border-navy-secondary">
                  {columns.map((c) => (
                    <td key={c} className="px-3 py-2 font-mono">
                      {String(r[c] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 500 && (
          <div className="text-xs text-silver mt-2">
            Showing first 500 of {rows.length}. Export for the full set.
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
