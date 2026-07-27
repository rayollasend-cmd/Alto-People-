import { useEffect, useMemo, useState } from 'react';
import { Plus, Tags } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  createCategory,
  createWorktag,
  deleteWorktag,
  listCategories,
  listWorktags,
  type Worktag,
  type WorktagCategory,
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
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { SearchInput } from '@/components/ui/FilterBar';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

type Tab = 'categories' | 'values';

/** "GL Account" → "gl_account" — the machine-key format the API enforces. */
const slugifyKey = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export function WorktagsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'process:payroll') : false;
  const [tab, setTab] = useState<Tab>('categories');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Worktags"
        subtitle="Multi-dimensional categorical tags for spend tracking and reporting (Department, Project, GL Account, Region)."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Worktags' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="values">Values</TabsTrigger>
        </TabsList>
        <TabsContent value="categories">
          <CategoriesTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="values">
          <ValuesTab canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CategoriesTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<WorktagCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    setError(null);
    listCategories()
      .then((r) => setRows(r.categories))
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not load categories.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

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
              description='Create categories like "Project" or "GL Account" first, then add values under each.'
              action={
                canManage ? (
                  <Button size="sm" onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New category
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="hidden md:table-cell">Key</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead className="text-right">Values</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs hidden md:table-cell">{c.key}</TableCell>
                    <TableCell className="font-medium text-white">
                      {c.label}
                      <div className="md:hidden text-xs2 text-silver/70 truncate font-mono font-normal">
                        {c.key}
                      </div>
                    </TableCell>
                    <TableCell>
                      {c.isRequired ? (
                        <Badge variant="destructive">Required</Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.worktagCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
        <DrawerTitle>New worktag category</DrawerTitle>
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
            placeholder="GL Account"
          />
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
            placeholder="gl_account"
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
  const [worktags, setWorktags] = useState<Worktag[] | null>(null);
  const [worktagsError, setWorktagsError] = useState<string | null>(null);
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

  const refresh = () => {
    if (!categoryId) return;
    setWorktags(null);
    setWorktagsError(null);
    listWorktags(categoryId)
      .then((r) => setWorktags(r.worktags))
      .catch((err) =>
        setWorktagsError(
          err instanceof ApiError ? err.message : 'Could not load values.',
        ),
      );
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);

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
    if (!(await confirm({ title: 'Deactivate this worktag?', destructive: true }))) return;
    try {
      await deleteWorktag(id);
      toast.success('Worktag deactivated.');
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Value</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(filtered ?? []).map((w) => (
                  <TableRow key={w.id} className="group">
                    <TableCell className="font-medium text-white">{w.value}</TableCell>
                    <TableCell className="font-mono text-xs">{w.code ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void onDelete(w.id)}
                          className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert"
                        >
                          Deactivate
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
