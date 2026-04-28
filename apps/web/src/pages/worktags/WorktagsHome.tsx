import { useEffect, useState } from 'react';
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
  Input,
  PageHeader,
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
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

type Tab = 'categories' | 'values';

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
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listCategories()
      .then((r) => setRows(r.categories))
      .catch(() => setRows([]));
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
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Tags}
              title="No categories"
              description='Create categories like "Project" or "GL Account" first, then add values under each.'
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead>Values</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.key}</TableCell>
                    <TableCell className="font-medium text-white">{c.label}</TableCell>
                    <TableCell>
                      {c.isRequired ? (
                        <Badge variant="destructive">Required</Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>{c.worktagCount}</TableCell>
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
          <Label>Key (machine name)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="gl_account"
          />
        </div>
        <div>
          <Label>Label</Label>
          <Input
            className="mt-1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="GL Account"
          />
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
  const [categoryId, setCategoryId] = useState('');
  const [worktags, setWorktags] = useState<Worktag[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    listCategories().then((r) => {
      setCategories(r.categories);
      if (r.categories[0]) setCategoryId(r.categories[0].id);
    });
  }, []);

  const refresh = () => {
    if (!categoryId) return;
    setWorktags(null);
    listWorktags(categoryId)
      .then((r) => setWorktags(r.worktags))
      .catch(() => setWorktags([]));
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Deactivate this worktag?', destructive: true }))) return;
    try {
      await deleteWorktag(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <Label>Category</Label>
          <select
            className="mt-1 flex h-10 w-72 rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        {canManage && categoryId && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New value
          </Button>
        )}
      </div>
      <Card>
        <CardContent className="p-0">
          {worktags === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : worktags.length === 0 ? (
            <EmptyState
              icon={Tags}
              title="No values"
              description="Add values under this category to start tagging transactions."
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
                {worktags.map((w) => (
                  <TableRow key={w.id} className="group">
                    <TableCell className="font-medium text-white">{w.value}</TableCell>
                    <TableCell className="font-mono text-xs">{w.code ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <button
                          onClick={() => onDelete(w.id)}
                          className="opacity-60 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
                        >
                          Deactivate
                        </button>
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
