import { useEffect, useState } from 'react';
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
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const LEVELS: SkillLevel[] = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'];

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
        <TabsContent value="search"><SearchTab /></TabsContent>
        <TabsContent value="catalog"><CatalogTab canManage={canManage} /></TabsContent>
      </Tabs>
    </div>
  );
}

function SearchTab() {
  const [q, setQ] = useState('');
  const [minLevel, setMinLevel] = useState<SkillLevel | ''>('');
  const [data, setData] = useState<SkillSearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!q.trim()) {
      toast.error('Type a skill name.');
      return;
    }
    setLoading(true);
    try {
      const r = await searchSkills(q.trim(), minLevel || undefined);
      setData(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <Label>Skill</Label>
              <Input
                className="mt-1"
                placeholder="Python, forklift, Spanish…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </div>
            <div>
              <Label>Min level</Label>
              <select
                className="mt-1 bg-midnight border border-navy-secondary rounded-md p-2 text-white"
                value={minLevel}
                onChange={(e) => setMinLevel(e.target.value as SkillLevel | '')}
              >
                <option value="">Any</option>
                {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <Button onClick={submit} disabled={loading}>
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
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Skill</TableHead>
                    <TableHead>Level</TableHead>
                    <TableHead>Years</TableHead>
                    <TableHead>Verified</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.associates.map((a) => (
                    <TableRow key={`${a.associateId}-${a.skillName}`}>
                      <TableCell className="font-medium text-white">{a.name}</TableCell>
                      <TableCell className="text-silver">{a.email}</TableCell>
                      <TableCell>{a.skillName}</TableCell>
                      <TableCell>
                        <Badge variant={levelVariant(a.level)}>{a.level}</Badge>
                      </TableCell>
                      <TableCell>{a.yearsExperience ?? '—'}</TableCell>
                      <TableCell>
                        {a.verified ? (
                          <ShieldCheck className="h-4 w-4 text-emerald-400" />
                        ) : (
                          <span className="text-silver text-xs">self-attested</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CatalogTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<SkillCatalogEntry[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listSkills()
      .then((r) => setRows(r.skills))
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
            <Plus className="mr-2 h-4 w-4" /> New skill
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="No skills yet"
              description="Build the catalog so associates can be tagged."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Holders</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id} className="group">
                    <TableCell className="font-medium text-white">{s.name}</TableCell>
                    <TableCell className="text-silver">{s.category ?? '—'}</TableCell>
                    <TableCell>{s.associateCount}</TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <button
                          onClick={async () => {
                            if (!window.confirm('Delete this skill? Associate claims will be removed.'))
                              return;
                            try {
                              await deleteSkill(s.id);
                              refresh();
                            } catch (err) {
                              toast.error(err instanceof ApiError ? err.message : 'Failed.');
                            }
                          }}
                          className="opacity-0 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
                        >
                          Delete
                        </button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewSkillDrawer
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

function NewSkillDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
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
          <Input
            className="mt-1"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Technical, Language, Equipment…"
          />
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
