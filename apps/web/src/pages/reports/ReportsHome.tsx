import { useEffect, useState } from 'react';
import { BarChart3, Play, Plus, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
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
  Textarea,
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
    if (!window.confirm('Delete this report?')) return;
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
                        className="opacity-0 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
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
  const [filtersText, setFiltersText] = useState('[]');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listColumns(entity)
      .then((r) => setAllColumns(r.columns))
      .catch(() => setAllColumns([]));
    setColumns([]);
  }, [entity]);

  const toggleColumn = (col: string) => {
    setColumns((cs) =>
      cs.includes(col) ? cs.filter((c) => c !== col) : [...cs, col],
    );
  };

  const parseFilters = () => {
    try {
      return JSON.parse(filtersText);
    } catch {
      throw new Error('Filters must be valid JSON.');
    }
  };

  const buildSpec = () => ({
    columns,
    filters: parseFilters(),
    sort: [],
    limit: 1000,
  });

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
          <Label>Columns</Label>
          <div className="mt-2 flex flex-wrap gap-2">
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
          <Label>Filters (JSON)</Label>
          <Textarea
            className="mt-1 min-h-32 font-mono text-xs"
            value={filtersText}
            onChange={(e) => setFiltersText(e.target.value)}
            placeholder='[{"column":"status","op":"eq","value":"ACTIVE"}]'
          />
          <div className="text-xs text-silver mt-1">
            ops: eq, ne, gt, gte, lt, lte, contains, in
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
