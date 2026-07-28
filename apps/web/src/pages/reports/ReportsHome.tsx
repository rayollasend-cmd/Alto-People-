import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  CalendarClock,
  Copy,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useConfirm } from '@/lib/confirm';
import { downloadCsv } from '@/lib/csv';
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
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

const ENTITIES: ReportEntity[] = [
  'ASSOCIATE',
  'TIME_ENTRY',
  'PAYROLL_ITEM',
  'PAYROLL_RUN',
  'APPLICATION',
  'EXPENSE',
  'CANDIDATE',
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
  /At$/.test(c) || c === 'periodStart' || c === 'periodEnd' || c === 'clockIn' || c === 'clockOut';

const isAssociateColumn = (c: string) => c === 'associateId';

interface BuilderSeed {
  mode: 'edit' | 'duplicate';
  report: ReportFull;
}

export function ReportsHome() {
  const confirm = useConfirm();
  const [rows, setRows] = useState<ReportSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [entityFilter, setEntityFilter] = useState<'' | ReportEntity>('');
  const [builder, setBuilder] = useState<{ seed: BuilderSeed | null } | null>(null);
  const [schedulesFor, setSchedulesFor] = useState<ReportSummary | null>(null);
  const [running, setRunning] = useState<{
    name: string;
    columns: string[];
    rows: Array<Record<string, unknown>>;
  } | null>(null);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listReports()
      .then((r) => setRows(r.reports))
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load reports.'),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        subtitle="Build, save, and schedule reports across associates, time, payroll, applications, and candidates."
        breadcrumbs={[{ label: 'Insights' }, { label: 'Reports' }]}
      />
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
        <div className="ml-auto">
          <Button onClick={() => setBuilder({ seed: null })}>
            <Plus className="mr-2 h-4 w-4" /> New report
          </Button>
        </div>
      </div>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Entity</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead className="hidden lg:table-cell">Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow key={r.id} className="group">
                    <TableCell className="font-medium text-white">
                      {r.name}
                      <div className="text-xs2 text-silver/70 md:hidden font-normal">{ENTITY_LABELS[r.entity] ?? r.entity}</div>
                      <div className="text-xs2 text-silver/70 lg:hidden font-normal">{fmtDate(r.createdAt)}</div>
                    </TableCell>
                    <TableCell className="text-xs hidden md:table-cell">{ENTITY_LABELS[r.entity] ?? r.entity}</TableCell>
                    <TableCell>
                      {r.isPublic ? (
                        <Badge variant="success">Shared</Badge>
                      ) : (
                        <Badge variant="default">Private</Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">{fmtDate(r.createdAt)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap space-x-1">
                      <Button size="sm" onClick={() => onRun(r)}>
                        <Play className="mr-1 h-3 w-3" /> Run
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openSeeded(r, 'edit')}
                        title="Edit"
                        aria-label={`Edit "${r.name}"`}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openSeeded(r, 'duplicate')}
                        title="Duplicate"
                        aria-label={`Duplicate "${r.name}"`}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSchedulesFor(r)}
                        title="Schedules"
                        aria-label={`Schedules for "${r.name}"`}
                      >
                        <CalendarClock className="h-3 w-3" />
                      </Button>
                      <button
                        onClick={() => onDelete(r.id)}
                        className="opacity-60 group-hover:opacity-100 text-silver hover:text-alert transition text-xs"
                        title="Delete"
                        aria-label={`Delete "${r.name}"`}
                      >
                        <Trash2 className="inline h-3 w-3" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
    </div>
  );
}

type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';

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
  const [allColumns, setAllColumns] = useState<string[]>([]);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(seed?.report.isPublic ?? false);
  const [filters, setFilters] = useState<FilterRow[]>(
    seed ? specToFilterRows(seed.report.spec) : [],
  );
  const [sorts, setSorts] = useState<SortRow[]>(
    seed ? seed.report.spec.sort.map((s) => ({ column: s.column, dir: s.direction })) : [],
  );
  const [limit, setLimit] = useState(seed ? String(seed.report.spec.limit) : '1000');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{
    columns: string[];
    rows: Array<Record<string, unknown>>;
  } | null>(null);

  const loadColumns = (ent: ReportEntity) => {
    setColumnsError(null);
    listColumns(ent)
      .then((r) => setAllColumns(r.columns))
      .catch((err) => {
        setAllColumns([]);
        setColumnsError(
          err instanceof ApiError ? err.message : 'Failed to load columns.',
        );
      });
  };

  // On the initial render the seed (if any) already provides columns /
  // filters / sorts for its entity — only wipe them when the admin
  // switches to a different entity afterwards.
  const firstRun = useRef(true);
  useEffect(() => {
    loadColumns(entity);
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setColumns([]);
    setFilters([]);
    setSorts([]);
  }, [entity]);

  const toggleColumn = (col: string) => {
    setColumns((cs) =>
      cs.includes(col) ? cs.filter((c) => c !== col) : [...cs, col],
    );
  };

  const buildSpec = (): ReportSpec => {
    // Convert each filter row to the API shape. `in` splits the comma-list;
    // numeric ops coerce when the value parses cleanly so reports compare
    // numbers as numbers, not strings. Date columns are widened to full
    // ISO datetimes (Prisma DateTime filters reject bare dates).
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
    return {
      columns,
      filters: compiledFilters,
      sort: sorts
        .filter((s) => s.column)
        .map((s) => ({ column: s.column, direction: s.dir })),
      limit: Math.max(1, Math.min(10_000, parseInt(limit, 10) || 1000)),
    };
  };

  const onPreview = async () => {
    if (columns.length === 0) {
      toast.error('Pick at least one column.');
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
      toast.error(err instanceof Error ? err.message : 'Failed.');
    }
  };

  const onSubmit = async () => {
    if (!name.trim() || columns.length === 0) {
      toast.error('Name and at least one column required.');
      return;
    }
    setSaving(true);
    try {
      await createReport({
        name: name.trim(),
        entity,
        spec: buildSpec(),
        isPublic,
      });
      if (seed?.mode === 'edit') {
        // The API has no update endpoint — "editing" saves a replacement
        // and retires the original (author-only; a shared report by
        // someone else can only be duplicated, not replaced).
        try {
          await deleteReport(seed.report.id);
          toast.success('Report updated.');
        } catch {
          toast.warning(
            'Saved as a new report — the original could not be replaced (only its author can delete it).',
          );
        }
      } else {
        toast.success('Report saved.');
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed.');
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
            <Button size="sm" variant="outline" onClick={() => loadColumns(entity)}>
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
                      onChange={(e) =>
                        // Column switch changes the value control type —
                        // reset the value so a stale id/date can't leak in.
                        updateFilter(i, {
                          column: e.target.value,
                          value: '',
                          valueLabel: undefined,
                        })
                      }
                    >
                      {allColumns.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  </div>
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
                  {isAssociateColumn(f.column) && f.op !== 'in' ? (
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
                    className="text-silver hover:text-alert p-1"
                    title="Remove filter"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
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
                    className="text-silver hover:text-alert p-1"
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
  const [schedules, setSchedules] = useState<ReportSchedule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cadence, setCadence] = useState<ReportSchedule['cadence']>('WEEKLY');
  const [recipients, setRecipients] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => {
    setSchedules(null);
    setLoadError(null);
    listSchedules(report.id)
      .then((r) => setSchedules(r.schedules))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load schedules.',
        ),
      );
  };
  useEffect(() => {
    load();
  }, [report.id]);

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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
                  className="text-silver hover:text-alert transition p-1"
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
  const exportCsv = () => {
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
  };

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
