import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Sparkles, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  createSkill,
  deleteSkill,
  listSkills,
  searchSkills,
  type SkillCatalogEntry,
  type SkillLevel,
  type SkillSearchResult,
} from '@/lib/skills111Api';
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
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { Label } from '@/components/ui/Label';
import { ymdLocal } from '@/lib/format';

const LEVELS: SkillLevel[] = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'];

const LEVEL_LABELS: Record<SkillLevel, string> = {
  BEGINNER: 'Beginner',
  INTERMEDIATE: 'Intermediate',
  ADVANCED: 'Advanced',
  EXPERT: 'Expert',
};

function distinctCategories(entries: SkillCatalogEntry[]): string[] {
  return Array.from(
    new Set(entries.map((e) => e.category).filter((c): c is string => !!c)),
  ).sort();
}

export function SkillsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  const [tab, setTab] = useState<'search' | 'catalog'>('search');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Skills"
        subtitle="Find people by what they know — or browse the catalog and add new competencies."
        breadcrumbs={[{ label: 'Skills' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'search' | 'catalog')}>
        <TabsList>
          <TabsTrigger value="search">
            <Search className="mr-2 h-4 w-4" /> Find people
          </TabsTrigger>
          <TabsTrigger value="catalog">
            <Sparkles className="mr-2 h-4 w-4" /> Catalog
          </TabsTrigger>
        </TabsList>
        <TabsContent value="search"><SearchTab canManage={canManage} /></TabsContent>
        <TabsContent value="catalog"><CatalogTab canManage={canManage} /></TabsContent>
      </Tabs>
    </div>
  );
}

function SearchTab({ canManage }: { canManage: boolean }) {
  const [q, setQ] = useState('');
  const [minLevel, setMinLevel] = useState<SkillLevel | ''>('');
  const [data, setData] = useState<SkillSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Catalog powering the combobox. null = not loaded (or failed) — the
  // input silently degrades to free text, which still searches fine.
  const [catalog, setCatalog] = useState<SkillCatalogEntry[] | null>(null);
  const [matches, setMatches] = useState<SkillCatalogEntry[]>([]);
  const [dropOpen, setDropOpen] = useState(false);
  const [showAddSkill, setShowAddSkill] = useState(false);

  const loadCatalog = () =>
    listSkills()
      .then((r) => setCatalog(r.skills))
      .catch(() => setCatalog(null));
  useEffect(() => {
    void loadCatalog();
  }, []);

  // Debounced catalog match for the combobox dropdown.
  useEffect(() => {
    const term = q.trim().toLowerCase();
    if (!term || !catalog) {
      setMatches([]);
      return;
    }
    const t = setTimeout(() => {
      setMatches(
        catalog
          .filter((s) => s.name.toLowerCase().includes(term))
          .slice(0, 8),
      );
    }, 200);
    return () => clearTimeout(t);
  }, [q, catalog]);

  const runSearch = async (term: string) => {
    if (!term.trim()) {
      toast.error('Type a skill name.');
      return;
    }
    setDropOpen(false);
    setLoading(true);
    try {
      const r = await searchSkills(term.trim(), minLevel || undefined);
      setData(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  };

  const associates = useMemo(() => data?.associates ?? [], [data]);
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          {/* Phone: the skill field takes its own row — squeezed beside
              the level picker and button it showed four letters. */}
          <div className="flex flex-wrap gap-3 items-end">
            <div className="relative basis-full sm:basis-0 sm:flex-1">
              <Label htmlFor="skills-search-query">Skill</Label>
              <Input
                id="skills-search-query"
                className="mt-1"
                placeholder="Python, forklift, Spanish…"
                value={q}
                autoComplete="off"
                onChange={(e) => {
                  setQ(e.target.value);
                  setDropOpen(true);
                }}
                onFocus={() => matches.length > 0 && setDropOpen(true)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch(q)}
              />
              {dropOpen && matches.length > 0 && (
                <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-navy-secondary bg-navy elev-2">
                  {matches.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="block w-full px-3 py-2 text-left text-sm text-silver hover:bg-navy-secondary hover:text-white"
                      onClick={() => {
                        setQ(s.name);
                        void runSearch(s.name);
                      }}
                    >
                      {s.name}
                      {s.category && (
                        <span className="text-xs text-silver/60"> · {s.category}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Label htmlFor="skills-search-min-level">Min level</Label>
              <Select
                id="skills-search-min-level"
                className="mt-1"
                value={minLevel}
                onChange={(e) => setMinLevel(e.target.value as SkillLevel | '')}
              >
                <option value="">Any</option>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>{LEVEL_LABELS[l]}</option>
                ))}
              </Select>
            </div>
            <Button onClick={() => runSearch(q)} disabled={loading}>
              {loading ? 'Searching…' : 'Search'}
            </Button>
          </div>
        </CardContent>
      </Card>
      {data && (
        <Card>
          <CardContent className="p-0">
            {data.associates.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No matches"
                description={
                  data.skills.length === 0
                    ? 'No skill in the catalog matched. Add it first, then claim it on associates.'
                    : 'The skill exists, but nobody has claimed it (yet).'
                }
                action={
                  canManage && data.skills.length === 0 && q.trim() ? (
                    <Button onClick={() => setShowAddSkill(true)}>
                      <Plus className="mr-2 h-4 w-4" /> Add “{q.trim()}” to catalog
                    </Button>
                  ) : undefined
                }
              />
            ) : (
                <DataGrid<(typeof associates)[number]>
                  id="skill-search"
                  caption="Associates with this skill"
                  rows={associates}
                  rowKey={(a) => `${a.associateId}-${a.skillName}`}
                  search={{ placeholder: 'Name, email…' }}
                  urlState={false}
                  exportCsv={{ filename: `skill-search-${ymdLocal()}` }}
                  columns={[
                    { key: 'name', header: 'Name', accessor: (a) => a.name, sortable: true, primary: true, className: 'font-medium text-white' },
                    { key: 'email', header: 'Email', accessor: (a) => a.email, sortable: true, cardMeta: true, className: 'text-silver' },
                    { key: 'skill', header: 'Skill', accessor: (a) => a.skillName, sortable: true },
                    {
                      key: 'level',
                      header: 'Level',
                      accessor: (a) => LEVELS.indexOf(a.level),
                      csv: (a) => a.level,
                      sortable: true,
                      searchable: false,
                      cell: (a) => <Badge variant={levelVariant(a.level)}>{LEVEL_LABELS[a.level]}</Badge>,
                    },
                    { key: 'years', header: 'Years', accessor: (a) => a.yearsExperience, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (a) => a.yearsExperience ?? '—' },
                    {
                      key: 'verified',
                      header: 'Verified',
                      accessor: (a) => (a.verified ? 'Verified' : 'Self-attested'),
                      sortable: true,
                      cardMeta: true,
                      cell: (a) => (a.verified ? <ShieldCheck className="h-4 w-4 text-success" aria-label="Verified" /> : <span className="text-silver text-xs">self-attested</span>),
                    },
                  ]}
                />
            )}
          </CardContent>
        </Card>
      )}
      {showAddSkill && (
        <NewSkillDrawer
          initialName={q.trim()}
          categories={catalog ? distinctCategories(catalog) : []}
          onClose={() => setShowAddSkill(false)}
          onSaved={() => {
            setShowAddSkill(false);
            void loadCatalog();
            void runSearch(q);
          }}
        />
      )}
    </div>
  );
}

function CatalogTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  // One in-flight action at a time — a double-click on Delete used to
  // fire the write twice.
  const [actionKey, setActionKey] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<void>) => {
    if (actionKey) return;
    setActionKey(key);
    try {
      await fn();
    } finally {
      setActionKey(null);
    }
  };

  const refreshQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => listSkills(),
  });
  const rows = refreshQuery.data?.skills ?? null;
  const loadError = refreshQuery.error ? (refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load the skill catalog.') : null;
  const refresh = () => void refreshQuery.refetch();

  const categories = useMemo(() => (rows ? distinctCategories(rows) : []), [rows]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    return rows.filter(
      (s) =>
        (!q || s.name.toLowerCase().includes(q)) &&
        (!category ||
          (category === '__uncategorized__' ? !s.category : s.category === category)),
    );
  }, [rows, search, category]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 justify-end">
        <Input
          placeholder="Search skills…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          aria-label="Search skills"
        />
        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by category"
          className="w-auto"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
          <option value="__uncategorized__">Uncategorized</option>
        </Select>
        {canManage && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New skill
          </Button>
        )}
      </div>
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6">
              <ErrorBanner>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{loadError}</span>
                  <Button size="sm" variant="outline" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              </ErrorBanner>
            </div>
          ) : filtered === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={rows && rows.length > 0 ? 'No matches' : 'No skills yet'}
              description={
                rows && rows.length > 0
                  ? 'No skill matches the current search or category filter.'
                  : 'Build the catalog so associates can be tagged.'
              }
            />
          ) : (
            <DataGrid<NonNullable<typeof filtered>[number]>
              id="skills-catalog"
              caption="Skills catalog"
              rows={filtered}
              rowKey={(sk) => sk.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'skills' }}
              columns={[
                { key: 'name', header: 'Name', accessor: (sk) => sk.name, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'category', header: 'Category', accessor: (sk) => sk.category, sortable: true, cardMeta: true, className: 'text-silver', cell: (sk) => sk.category ?? '—' },
                { key: 'holders', header: 'Holders', accessor: (sk) => sk.associateCount, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
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
                        cell: (sk: NonNullable<typeof filtered>[number]) => (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-silver hover:text-alert"
                            disabled={actionKey !== null}
                            onClick={async () => {
                              if (!(await confirm({ title: 'Delete this skill?', description: 'Associate claims will be removed.', destructive: true })))
                                return;
                              await act(`del-${sk.id}`, async () => {
                                try {
                                  await deleteSkill(sk.id);
                                  toast.success('Skill deleted.');
                                  refresh();
                                } catch (err) {
                                  toast.error(err instanceof ApiError ? err.message : 'Failed.');
                                }
                              });
                            }}
                          >
                            Delete
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
        <NewSkillDrawer
          categories={categories}
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

const NEW_CATEGORY = '__new__';

function NewSkillDrawer({
  initialName = '',
  categories,
  onClose,
  onSaved,
}: {
  initialName?: string;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState('');
  const [customCategory, setCustomCategory] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    setSaving(true);
    try {
      await createSkill({
        name: name.trim(),
        category: category.trim() || null,
      });
      toast.success('Skill added.');
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
        <DrawerTitle>New skill</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Python, forklift, Spanish…"
          />
        </div>
        <div>
          <Label>Category (optional)</Label>
          <Select
            className="mt-1"
            value={customCategory ? NEW_CATEGORY : category}
            onChange={(e) => {
              if (e.target.value === NEW_CATEGORY) {
                setCustomCategory(true);
                setCategory('');
              } else {
                setCustomCategory(false);
                setCategory(e.target.value);
              }
            }}
          >
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
            <option value={NEW_CATEGORY}>New category…</option>
          </Select>
          {customCategory && (
            <Input
              className="mt-2"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Technical, Language, Equipment…"
              aria-label="New category name"
            />
          )}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function levelVariant(
  level: SkillLevel,
): 'success' | 'accent' | 'pending' | 'outline' {
  switch (level) {
    case 'EXPERT':
      return 'success';
    case 'ADVANCED':
      return 'accent';
    case 'INTERMEDIATE':
      return 'pending';
    default:
      return 'outline';
  }
}
