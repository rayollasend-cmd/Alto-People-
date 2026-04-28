import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, BarChart3, Play, Plus, Trash2, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import {
  createReport,
  deleteReport,
  getReport,
  listColumns,
  listReports,
  previewReport,
  runReport,
  type ReportEntity,
  type ReportSummary,
} from '@/lib/reports96Api';
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
  Input,
  PageHeader,
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

export function ReportsHome() {
  const confirm = useConfirm();
  const [rows, setRows] = useState<ReportSummary[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [running, setRunning] = useState<{
    name: string;
    columns: string[];
    rows: Array<Record<string, unknown>>;
  } | null>(null);

  const refresh = () => {
    setRows(null);
    listReports()
      .then((r) => setRows(r.reports))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

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

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this report?', destructive: true }))) return;
    try {
      await deleteReport(id);
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
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New report
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No saved reports"
              description="Build a report by picking an entity, columns, and filters. Save and share with the team."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="group">
                    <TableCell className="font-medium text-white">{r.name}</TableCell>
                    <TableCell className="font-mono text-xs">{r.entity}</TableCell>
                    <TableCell>
                      {r.isPublic ? (
                        <Badge variant="success">Shared</Badge>
                      ) : (
                        <Badge variant="default">Private</Badge>
                      )}
                    </TableCell>
                    <TableCell>{new Date(r.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button size="sm" onClick={() => onRun(r)}>
                        <Play className="mr-1 h-3 w-3" /> Run
                      </Button>
                      <button
                        onClick={() => onDelete(r.id)}
                        className="opacity-60 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
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
      {showNew && (
        <ReportBuilder
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
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

function ReportBuilder({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [entity, setEntity] = useState<ReportEntity>('ASSOCIATE');
  const [columns, setColumns] = useState<string[]>([]);
  const [allColumns, setAllColumns] = useState<string[]>([]);
  const [isPublic, setIsPublic] = useState(false);
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [sorts, setSorts] = useState<SortRow[]>([]);
  const [limit, setLimit] = useState('1000');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listColumns(entity)
      .then((r) => setAllColumns(r.columns))
      .catch(() => setAllColumns([]));
    setColumns([]);
    setFilters([]);
    setSorts([]);
  }, [entity]);

  const toggleColumn = (col: string) => {
    setColumns((cs) =>
      cs.includes(col) ? cs.filter((c) => c !== col) : [...cs, col],
    );
  };

  const buildSpec = () => {
    // Convert each filter row to the API shape. `in` splits the comma-list;
    // numeric ops coerce when the value parses cleanly so reports compare
    // numbers as numbers, not strings.
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
      toast.success(`Preview: ${r.rows.length} rows`);
      // eslint-disable-next-line no-console
      console.table(r.rows.slice(0, 20));
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
      toast.success('Report saved.');
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

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-3xl">
      <DrawerHeader>
        <DrawerTitle>Build report</DrawerTitle>
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
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={entity}
            onChange={(e) => setEntity(e.target.value as ReportEntity)}
          >
            {ENTITIES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Columns ({columns.length} selected)</Label>
          <div className="mt-2 max-h-40 overflow-y-auto flex flex-wrap gap-2 p-2 border border-navy-secondary rounded-md bg-navy-secondary/20">
            {allColumns.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => toggleColumn(c)}
                className={`px-2 py-1 rounded text-xs font-mono border transition ${
                  columns.includes(c)
                    ? 'bg-cyan-600/30 border-cyan-500 text-white'
                    : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
                }`}
              >
                {c}
              </button>
            ))}
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
                  <select
                    className="flex-1 h-8 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-xs font-mono text-white"
                    value={f.column}
                    onChange={(e) =>
                      updateFilter(i, { column: e.target.value })
                    }
                  >
                    {allColumns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select
                    className="h-8 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-xs text-white"
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
                  </select>
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
                  <button
                    type="button"
                    onClick={() => removeFilter(i)}
                    className="text-silver hover:text-destructive p-1"
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
                  <select
                    className="flex-1 h-8 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-xs font-mono text-white"
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
                  </select>
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
                    className="text-silver hover:text-destructive p-1"
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
    const header = columns.join(',');
    const body = rows
      .map((r) =>
        columns.map((c) => JSON.stringify(r[c] ?? '')).join(','),
      )
      .join('\n');
    const blob = new Blob([`${header}\n${body}`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

// Stub usage to keep linter happy — getReport is exported for future drill-in.
void getReport;
