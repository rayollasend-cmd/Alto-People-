import { useEffect, useMemo, useState } from 'react';
import { useUrlParam } from '@/lib/useUrlState';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Plus, Tags, X } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import {
  assignWorktags,
  createCategory,
  createWorktag,
  deleteWorktag,
  getAssignments,
  listCategories,
  listWorktags,
  removeAssignment,
  worktagsReport,
  type Worktag,
  type WorktagCategory,
  type WorktagEntityKind,
} from '@/lib/worktags95Api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
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
  Select,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { Input } from '@/components/ui/Input';
import { SearchInput } from '@/components/ui/FilterBar';
import { Label } from '@/components/ui/Label';
import { ListTemplate } from '@/components/templates';
import { toast } from 'sonner';

type Tab = 'categories' | 'values' | 'assign' | 'report';

const ENTITY_KINDS: Array<{ value: WorktagEntityKind; label: string }> = [
  { value: 'TIME_ENTRY', label: 'Time entry' },
  { value: 'PAYROLL_ITEM', label: 'Payroll item' },
  { value: 'EXPENSE', label: 'Expense' },
  { value: 'PURCHASE_ORDER', label: 'Purchase order' },
];
/** Names that are already Books dimensions (the chart of accounts, client, store, department). */
const LEDGER_DIMENSION = /\b(gl|general ledger|ledger|account|accounts|cost cent(er|re)|department|client|customer|site|store|location)\b/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "GL Account" → "gl_account" — the machine-key format the API enforces. */
const slugifyKey = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const TABS: Tab[] = ['categories', 'values', 'assign', 'report'];

/**
 * Tags for reporting: a company's own labels — a campaign, an event, a
 * program — put on time, pay and expenses, for reports the books don't
 * already cut. Accounts, clients, stores and departments are Books
 * dimensions on every journal line; they don't belong here twice, so the
 * page no longer suggests "GL Account" and warns when a category repeats one.
 */
export function WorktagsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'process:payroll') : false;
  const [tab, setTab] = useUrlParam<Tab>('tab', 'categories', TABS, { history: 'push' });

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Tags for reporting"
        topbarTitle="Tags for reporting"
        subtitle="Your own labels on time, pay and expenses — a campaign, an event, a program — for reports the books don’t already give you."
        related={[{ label: 'Chart of accounts', to: '/books/accounts' }]}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="values">Values</TabsTrigger>
          <TabsTrigger value="assign">Tag a record</TabsTrigger>
          <TabsTrigger value="report">Report</TabsTrigger>
        </TabsList>
        <TabsContent value="categories">
          <CategoriesTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="values">
          <ValuesTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="assign">
          <AssignTab />
        </TabsContent>
        <TabsContent value="report">
          <ReportTab />
        </TabsContent>
      </Tabs>
    </ListTemplate>
  );
}

/**
 * Tag one record — a time entry, a payroll item, an expense, a purchase
 * order — with one value per category. The categories and values existed;
 * nothing was ever tagged, so the report below had nothing to count.
 */
export function AssignTab() {
  const [entityKind, setEntityKind] = useState<WorktagEntityKind>('TIME_ENTRY');
  const [entityId, setEntityId] = useState('');
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const cats = useQuery({ queryKey: ['worktags', 'categories'], queryFn: () => listCategories() });
  const tags = useQuery({ queryKey: ['worktags', 'values', 'all'], queryFn: () => listWorktags() });
  const current = useQuery({
    queryKey: ['worktags', 'assignments', entityKind, loadedId],
    queryFn: () => getAssignments(entityKind, loadedId!),
    enabled: Boolean(loadedId),
  });
  const active = (cats.data?.categories ?? []).filter((c) => c.isActive);
  const byCategory = useMemo(() => {
    const m = new Map<string, Worktag[]>();
    for (const t of tags.data?.worktags ?? []) m.set(t.categoryId, [...(m.get(t.categoryId) ?? []), t]);
    return m;
  }, [tags.data]);
  // What the record holds now is the starting point of each pick.
  useEffect(() => {
    const assigned = current.data?.assignments ?? [];
    const next: Record<string, string> = {};
    for (const a of assigned) {
      const t = tags.data?.worktags.find((x) => x.id === a.worktagId);
      if (t) next[t.categoryId] = t.id;
    }
    setPicks(next);
  }, [current.data, tags.data]);

  const load = () => {
    const id = entityId.trim();
    if (!UUID_RE.test(id)) {
      toast.error('That is not a record id — paste the id from the record itself.');
      return;
    }
    setLoadedId(id);
  };
  const save = async () => {
    if (!loadedId) return;
    const worktagIds = Object.values(picks).filter(Boolean);
    if (worktagIds.length === 0) {
      toast.error('Pick at least one value.');
      return;
    }
    setSaving(true);
    try {
      const r = await assignWorktags({ entityKind, entityId: loadedId, worktagIds });
      toast.success(`${r.assigned} tag${r.assigned === 1 ? '' : 's'} saved on the record.`);
      await current.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not tag the record.');
    } finally {
      setSaving(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await removeAssignment(id);
      toast.success('Tag removed.');
      await current.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the tag.');
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 py-4 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
          <div>
            <Label htmlFor="wt-kind">Record</Label>
            <Select
              id="wt-kind"
              className="mt-1"
              value={entityKind}
              onChange={(e) => {
                setEntityKind(e.target.value as WorktagEntityKind);
                setLoadedId(null);
              }}
            >
              {ENTITY_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="wt-id">Record id</Label>
            <Input
              id="wt-id"
              className="mt-1 font-mono text-xs"
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
              placeholder="Paste the id from the time entry, payroll item or expense"
            />
          </div>
          <Button variant="outline" onClick={load}>
            Open
          </Button>
        </CardContent>
      </Card>
      {loadedId && (
        <Card>
          <CardContent className="space-y-4 py-4">
            {cats.isError || tags.isError || current.isError ? (
              <ErrorBanner>Could not load the tags for this record.</ErrorBanner>
            ) : active.length === 0 ? (
              <EmptyState icon={Tags} title="No categories" description="Create a category and its values first — then tag records with them here." />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {active.map((c) => (
                    <div key={c.id}>
                      <Label htmlFor={`wt-cat-${c.id}`}>
                        {c.label}
                        {c.isRequired ? ' (required)' : ''}
                      </Label>
                      <Select
                        id={`wt-cat-${c.id}`}
                        className="mt-1"
                        value={picks[c.id] ?? ''}
                        onChange={(e) => setPicks((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      >
                        <option value="">Not tagged</option>
                        {(byCategory.get(c.id) ?? []).map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.value}
                            {t.code ? ` (${t.code})` : ''}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => void save()} loading={saving} disabled={saving}>
                    Save tags
                  </Button>
                </div>
                {(current.data?.assignments.length ?? 0) > 0 && (
                  <div>
                    <div className="mb-1.5 text-xs text-ink-muted">On the record now</div>
                    <ul className="flex flex-wrap gap-1.5" aria-label="Tags on this record">
                      {current.data!.assignments.map((a) => (
                        <li key={a.id}>
                          <Badge variant="outline" className="gap-1 pr-1">
                            {a.categoryLabel}: {a.value}
                            <button
                              type="button"
                              className="rounded p-0.5 text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                              onClick={() => void remove(a.id)}
                              aria-label={`Remove ${a.categoryLabel}: ${a.value}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** How many records carry each value of a category — "payroll items by Project". */
export function ReportTab() {
  const cats = useQuery({ queryKey: ['worktags', 'categories'], queryFn: () => listCategories() });
  const [categoryKey, setCategoryKey] = useState('');
  const [entityKind, setEntityKind] = useState<WorktagEntityKind>('PAYROLL_ITEM');
  const key = categoryKey || cats.data?.categories[0]?.key || '';
  const report = useQuery({
    queryKey: ['worktags', 'report', key, entityKind],
    queryFn: () => worktagsReport(key, entityKind),
    enabled: Boolean(key),
  });
  const rows = report.data?.rows ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Category" className="w-auto" value={key} onChange={(e) => setCategoryKey(e.target.value)}>
          {(cats.data?.categories ?? []).map((c) => (
            <option key={c.id} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Record kind" className="w-auto" value={entityKind} onChange={(e) => setEntityKind(e.target.value as WorktagEntityKind)}>
          {ENTITY_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </div>
      <Card>
        <CardContent className="p-3">
          {cats.isError || report.isError ? (
            <ErrorBanner>Could not load the report.</ErrorBanner>
          ) : !key && cats.data ? (
            <EmptyState icon={BarChart3} title="No categories" description="Create a category to report on it." />
          ) : (
            <DataGrid<{ worktagId: string; value: string; count: number }>
              id="worktags-report"
              caption="Records by tag"
              rows={rows}
              rowKey={(r) => r.worktagId}
              loading={report.isLoading}
              search={false}
              urlState={false}
              exportCsv={{ filename: `worktags-${key}-${entityKind.toLowerCase()}` }}
              empty={{ icon: BarChart3, title: 'Nothing tagged yet', description: "Tag records on the Tag a record tab and they're counted here." }}
              columns={[
                { key: 'value', header: 'Value', accessor: (r) => r.value, sortable: true, primary: true, className: 'text-ink' },
                { key: 'count', header: 'Records', accessor: (r) => r.count, sortable: true, align: 'right', className: 'tabular-nums' },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CategoriesTab({ canManage }: { canManage: boolean }) {
  const [showNew, setShowNew] = useState(false);

  const refreshQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => listCategories(),
  });
  const rows = refreshQuery.data?.categories ?? null;
  const error = refreshQuery.error ? (refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Could not load categories.') : null;
  const refresh = () => void refreshQuery.refetch();

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New category
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {error}
              </ErrorBanner>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Tags}
              title="No categories"
              description='Create a category like "Campaign" or "Event" first, then add its values. Accounts, clients, stores and departments are already on every entry in Books.'
              action={
                canManage ? (
                  <Button size="sm" onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New category
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataGrid<(typeof rows)[number]>
              id="worktag-categories"
              caption="Tag categories"
              rows={rows}
              rowKey={(c) => c.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'worktag-categories' }}
              columns={[
                { key: 'label', header: 'Label', accessor: (c) => c.label, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'key', header: 'Key', accessor: (c) => c.key, sortable: true, cardMeta: true, className: 'font-mono text-xs' },
                {
                  key: 'required',
                  header: 'Required',
                  accessor: (c) => (c.isRequired ? 'Required' : ''),
                  sortable: true,
                  searchable: false,
                  cell: (c) => (c.isRequired ? <Badge variant="destructive">Required</Badge> : '—'),
                },
                { key: 'values', header: 'Values', accessor: (c) => c.worktagCount, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewCategoryDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewCategoryDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState('');
  // Once the admin edits the key by hand, stop auto-deriving it from the
  // label — their explicit choice wins.
  const [keyTouched, setKeyTouched] = useState(false);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [isRequired, setIsRequired] = useState(false);
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!key.trim() || !label.trim()) {
      toast.error('Key and label required.');
      return;
    }
    if (!/^[a-z0-9_]+$/.test(key)) {
      toast.error('Key must be lowercase alphanumeric/underscore.');
      return;
    }
    setSaving(true);
    try {
      await createCategory({
        key: key.trim(),
        label: label.trim(),
        description: description.trim() || null,
        isRequired,
      });
      toast.success('Category created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New tag category</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Label</Label>
          <Input
            className="mt-1"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              if (!keyTouched) setKey(slugifyKey(e.target.value));
            }}
            placeholder="Campaign"
          />
          {LEDGER_DIMENSION.test(label) && (
            <p className="mt-1 text-xs2 text-warning" role="status">
              The books already keep this on every entry — accounts, clients, stores and departments are Books dimensions. A tag here would be a second copy that never reaches the ledger.
            </p>
          )}
        </div>
        <div>
          <Label>Key (machine name)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={key}
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value);
            }}
            placeholder="campaign"
          />
          <p className="text-xs2 text-silver mt-1">
            Auto-derived from the label — edit to override.
          </p>
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={isRequired}
            onChange={(e) => setIsRequired(e.target.checked)}
          />
          <Label>Required on tagged transactions</Label>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Create'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function ValuesTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [categories, setCategories] = useState<WorktagCategory[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState('');

  const loadCategories = () => {
    setCategoriesError(null);
    listCategories()
      .then((r) => {
        setCategories(r.categories);
        if (r.categories[0]) {
          setCategoryId((prev) => prev || r.categories[0].id);
        }
      })
      .catch((err) =>
        setCategoriesError(
          err instanceof ApiError ? err.message : 'Could not load categories.',
        ),
      );
  };
  useEffect(loadCategories, []);

  const refreshQuery = useQuery({
    queryKey: ['ValuesTab', 'worktags', categoryId],
    queryFn: () => listWorktags(categoryId!),
    enabled: Boolean(categoryId),
  });
  const worktags: Worktag[] | null = refreshQuery.data?.worktags ?? null;
  const worktagsError = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Could not load values.' : null;
  const refresh = () => void refreshQuery.refetch();

  const filtered = useMemo(() => {
    if (!worktags) return null;
    const q = search.trim().toLowerCase();
    if (!q) return worktags;
    return worktags.filter(
      (w) =>
        w.value.toLowerCase().includes(q) ||
        (w.code ?? '').toLowerCase().includes(q),
    );
  }, [worktags, search]);

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Deactivate this tag?', destructive: true }))) return;
    try {
      await deleteWorktag(id);
      toast.success('Tag deactivated.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  if (categoriesError) {
    return (
      <div className="py-6">
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={loadCategories}>
              Retry
            </Button>
          }
        >
          {categoriesError}
        </ErrorBanner>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <Label>Category</Label>
            <Select
              className="mt-1 w-72"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Search</Label>
            <div className="mt-1">
              <SearchInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Value or code"
                className="w-56"
                aria-label="Search values"
              />
            </div>
          </div>
          {worktags && filtered && (
            <span className="text-xs text-silver tabular-nums pb-2.5">
              {search.trim()
                ? `${filtered.length} of ${worktags.length}`
                : worktags.length}{' '}
              value{(search.trim() ? filtered.length : worktags.length) === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {canManage && categoryId && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New value
          </Button>
        )}
      </div>
      <Card>
        <CardContent className="p-0">
          {worktagsError ? (
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {worktagsError}
              </ErrorBanner>
            </div>
          ) : worktags === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : worktags.length === 0 ? (
            <EmptyState
              icon={Tags}
              title="No values"
              description="Add values under this category to start tagging transactions."
              action={
                canManage && categoryId ? (
                  <Button size="sm" onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New value
                  </Button>
                ) : undefined
              }
            />
          ) : filtered && filtered.length === 0 ? (
            <EmptyState
              icon={Tags}
              title="No values match"
              description="Try a different value or code."
              action={
                <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <DataGrid<NonNullable<typeof filtered>[number]>
              id="worktag-values"
              caption="Worktag values"
              rows={filtered ?? []}
              rowKey={(w) => w.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'worktag-values' }}
              columns={[
                { key: 'value', header: 'Value', accessor: (w) => w.value, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'code', header: 'Code', accessor: (w) => w.code, sortable: true, cardMeta: true, className: 'font-mono text-xs', cell: (w) => w.code ?? '—' },
                ...(canManage
                  ? [
                      {
                        key: 'actions',
                        header: 'Actions',
                        accessor: () => null,
                        searchable: false,
                        csv: () => '',
                        align: 'right' as const,
                        stopRowClick: true,
                        cell: (w: NonNullable<typeof filtered>[number]) => (
                          <Button variant="ghost" size="sm" onClick={() => void onDelete(w.id)} className="text-silver hover:text-alert">
                            Deactivate
                          </Button>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewWorktagDrawer
          categoryId={categoryId}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewWorktagDrawer({
  categoryId,
  onClose,
  onSaved,
}: {
  categoryId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!value.trim()) {
      toast.error('Value required.');
      return;
    }
    setSaving(true);
    try {
      await createWorktag({
        categoryId,
        value: value.trim(),
        code: code.trim() || null,
      });
      toast.success('Value added.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New worktag value</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Value</Label>
          <Input
            className="mt-1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div>
          <Label>Code (optional)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="GL-4501"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Add'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
