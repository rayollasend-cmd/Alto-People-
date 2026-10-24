import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, BarChart3, Plus, Search, Sparkles, ShieldCheck, Trash2, UserRound } from '@/components/ui/icons';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  claimAssociateSkill,
  createSkill,
  deleteAssociateSkill,
  deleteSkill,
  listAssociateSkills,
  listSkills,
  searchSkills,
  verifyAssociateSkill,
  listPendingSkillClaims,
  getSkillsOverview,
  type SkillsOverview,
  type PendingSkillClaim,
  type AssociateSkillEntry,
  type SkillCatalogEntry,
  type SkillLevel,
  type SkillSearchResult,
} from '@/lib/skills111Api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useClients } from '@/lib/useClients';
import { listSites } from '@/lib/orgApi';
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
  MetricCard,
  MetricStrip,
  Select,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';
import { useUrlParam } from '@/lib/useUrlState';
import { Label } from '@/components/ui/Label';
import { ListTemplate } from '@/components/templates';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';

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

const TABS = ['overview', 'search', 'people', 'catalog', 'claims'] as const;
type SkillsTab = (typeof TABS)[number];

export function SkillsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  // The tab lives in the URL (?tab=claims), so Back returns to it and a link sends it.
  const [tab, setTab] = useUrlParam<SkillsTab>('tab', 'overview', TABS, { history: 'push' });
  // ?q= opens Find people on that skill (the overview's top skills link there).
  const [params] = useSearchParams();
  const initialQuery = params.get('q') ?? '';
  // Skills people added themselves, waiting on a verifier (manage:org).
  const claims = useQuery({ queryKey: ['skills', 'pending-claims'], queryFn: listPendingSkillClaims, enabled: canManage });
  const claimCount = claims.data?.claims.length ?? 0;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title="Skills"
      subtitle="What your people can do, who has checked it, and who to call for a skill."
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as SkillsTab)}>
        <TabsList>
          <TabsTrigger value="overview">
            <BarChart3 className="mr-2 h-4 w-4" /> Overview
          </TabsTrigger>
          <TabsTrigger value="search">
            <Search className="mr-2 h-4 w-4" /> Find people
          </TabsTrigger>
          <TabsTrigger value="people">
            <UserRound className="mr-2 h-4 w-4" /> One person
          </TabsTrigger>
          <TabsTrigger value="catalog">
            <Sparkles className="mr-2 h-4 w-4" /> Catalog
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="claims">
              <BadgeCheck className="mr-2 h-4 w-4" /> To verify
              {claimCount > 0 && (
                <Badge variant="pending" className="ml-1.5">
                  {claimCount}
                </Badge>
              )}
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview"><OverviewTab canManage={canManage} onTab={setTab} /></TabsContent>
        <TabsContent value="search"><SearchTab canManage={canManage} initialQuery={initialQuery} /></TabsContent>
        <TabsContent value="people"><PersonSkillsTab canManage={canManage} /></TabsContent>
        <TabsContent value="catalog"><CatalogTab canManage={canManage} /></TabsContent>
        {canManage && (
          <TabsContent value="claims">
            <ClaimsTab claims={claims.data?.claims ?? null} loading={claims.isLoading} onChanged={() => void claims.refetch()} />
          </TabsContent>
        )}
      </Tabs>
    </ListTemplate>
  );
}

/** The first screen: the catalog in numbers and the skills most people hold. */
function OverviewTab({ canManage, onTab }: { canManage: boolean; onTab: (t: SkillsTab) => void }) {
  const q = useQuery({ queryKey: ['skills', 'overview'], queryFn: getSkillsOverview });
  if (q.error) return <QueryError what="the skills overview" query={q} />;
  const o = q.data;
  if (!o) return <SkeletonRows count={3} />;
  if (o.catalog === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="No skills in the catalog yet"
        description="Add the skills your work needs — forklift, ServSafe, Spanish — then record who has them."
        action={
          canManage ? (
            <Button onClick={() => onTab('catalog')}>
              <Plus className="mr-2 h-4 w-4" /> Add a skill
            </Button>
          ) : undefined
        }
      />
    );
  }
  const n = (v: number) => v.toLocaleString('en-US');
  return (
    <div className="space-y-4">
      <MetricStrip label="Skills at a glance">
        <MetricCard label="Skills in the catalog" value={o.catalog} hint="Browse and add in the catalog" onClick={() => onTab('catalog')} />
        <MetricCard
          label="People with a verified skill"
          value={o.peopleWithVerified}
          hint={`${n(o.peopleWithSkill)} with any skill on record`}
          nothing={o.peopleWithSkill === 0 ? 'No one has a skill on record yet' : undefined}
          onClick={() => onTab('people')}
        />
        {canManage && (
          <MetricCard
            label="To verify"
            value={o.toVerify}
            hint={o.toVerify > 0 ? 'Skills people added themselves' : 'Nothing waiting'}
            tone={o.toVerify > 0 ? 'warning' : 'default'}
            onClick={() => onTab('claims')}
          />
        )}
      </MetricStrip>
      <DataGrid<SkillsOverview['top'][number]>
        id="skills-top"
        caption="Most held skills"
        noun={{ one: 'skill', many: 'skills' }}
        rows={o.top}
        rowKey={(r) => r.id}
        search={false}
        exportCsv={false}
        columnChooser={false}
        urlState={false}
        empty={{ icon: Sparkles, title: 'No one has a skill on record yet', description: 'Record skills on a person under One person, or let people add their own.' }}
        footnote="The five skills most people hold. Open one to see who."
        columns={[
          {
            key: 'name',
            header: 'Skill',
            accessor: (r) => r.name,
            primary: true,
            cell: (r) => (
              <Link to={`/skills?tab=search&q=${encodeURIComponent(r.name)}`} className="font-medium text-ink hover:text-gold">
                {r.name}
                {r.category && <span className="ml-1.5 text-xs text-ink-muted">{r.category}</span>}
              </Link>
            ),
          },
          { key: 'people', header: 'People', accessor: (r) => r.people, align: 'right', className: 'tabular-nums' },
          { key: 'verified', header: 'Verified', accessor: (r) => r.verified, align: 'right', className: 'tabular-nums', cardMeta: true, cell: (r) => `${n(r.verified)} of ${n(r.people)}` },
        ]}
      />
    </div>
  );
}

/** Self-claims waiting on a verifier: verify each, or open the person to change it. */
function ClaimsTab({ claims, loading, onChanged }: { claims: PendingSkillClaim[] | null; loading: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const verify = async (c: PendingSkillClaim) => {
    setBusy(c.id);
    try {
      await verifyAssociateSkill(c.id);
      toast.success(`${c.skillName} verified for ${c.name}.`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not verify it.');
    } finally {
      setBusy(null);
    }
  };
  if (loading) return <SkeletonRows count={3} />;
  if (!claims || claims.length === 0) {
    return <EmptyState icon={BadgeCheck} title="Nothing to verify" description="Skills people add to their own profile wait here until someone checks them." />;
  }
  return (
    <Card>
      <CardContent>
        <ul className="divide-y divide-navy-secondary" aria-label="Skills to verify">
          {claims.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="min-w-0 flex-1 text-sm text-ink">
                <span className="font-medium">{c.name}</span>
                {` · ${c.skillName} · ${LEVEL_LABELS[c.level]}${c.yearsExperience !== null ? ` · ${c.yearsExperience} yr` : ''}`}
                <span className="block text-xs text-ink-muted">{`Added ${fmtDate(c.claimedAt)}`}</span>
              </span>
              <Button size="sm" onClick={() => void verify(c)} loading={busy === c.id}>
                Verify
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function SearchTab({ canManage, initialQuery = '' }: { canManage: boolean; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [minLevel, setMinLevel] = useState<SkillLevel | ''>('');
  const [clientId, setClientId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [data, setData] = useState<SkillSearchResult | null>(null);
  const termWord = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  const { clients } = useClients({ enabled: hasClients });
  const sitesQ = useQuery({ queryKey: ['skills', 'sites'], queryFn: listSites });
  const stores = (sitesQ.data?.sites ?? []).filter((x) => x.isActive && (!clientId || x.clientId === clientId));
  const [loading, setLoading] = useState(false);
  // Catalog powering the combobox. null = not loaded (or failed) — the
  // input silently degrades to free text, which still searches fine.
  const [matches, setMatches] = useState<SkillCatalogEntry[]>([]);
  const [dropOpen, setDropOpen] = useState(false);
  const [showAddSkill, setShowAddSkill] = useState(false);

  const loadCatalogQuery = useQuery({
    queryKey: ['SearchTab', 'catalog'],
    queryFn: () => listSkills(),
  });
  const catalog: SkillCatalogEntry[] | null = loadCatalogQuery.isError ? null : (loadCatalogQuery.data?.skills ?? null);
  const loadCatalog = () => void loadCatalogQuery.refetch();

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
      const r = await searchSkills(term.trim(), minLevel || undefined, { clientId: clientId || undefined, locationId: locationId || undefined });
      setData(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  };

  // Arriving with ?q= (a top skill on the overview): run that search once.
  const ranInitial = useRef(false);
  useEffect(() => {
    if (!initialQuery || ranInitial.current) return;
    ranInitial.current = true;
    void runSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

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
                placeholder="Forklift, ServSafe, Spanish…"
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
            {hasClients && clients.length > 0 && (
              <div>
                <Label htmlFor="skills-search-client">{termWord('label.client')}</Label>
                <Select
                  id="skills-search-client"
                  className="mt-1"
                  value={clientId}
                  onChange={(e) => {
                    setClientId(e.target.value);
                    setLocationId('');
                  }}
                >
                  <option value="">Any</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {stores.length > 0 && (
              <div>
                <Label htmlFor="skills-search-store">{termWord('label.store')}</Label>
                <Select id="skills-search-store" className="mt-1" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Any</option>
                  {stores.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
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
                  caption="People with this skill"
                  rows={associates}
                  rowKey={(a) => `${a.associateId}-${a.skillName}`}
                  search={{ placeholder: 'Name, email…' }}
                  urlState={false}
                  exportCsv={{ filename: `skill-search-${ymdLocal()}` }}
                  columns={[
                    { key: 'name', header: 'Name', accessor: (a) => a.name, sortable: true, primary: true, className: 'font-medium text-white' },
                    {
                      key: 'place',
                      header: `Works at`,
                      accessor: (a) => a.place?.siteName ?? '',
                      sortable: true,
                      cardMeta: true,
                      cell: (a) =>
                        a.place ? (
                          <span>
                            {a.place.siteName}
                            {hasClients && a.place.clientName && <span className="text-xs text-silver"> · {a.place.clientName}</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-silver">Not placed</span>
                        ),
                    },
                    {
                      key: 'free',
                      header: 'Next free day',
                      accessor: (a) => a.nextFreeDay ?? '9999',
                      csv: (a) => a.nextFreeDay ?? '',
                      sortable: true,
                      searchable: false,
                      cardMeta: true,
                      cell: (a) => (a.nextFreeDay ? fmtDate(parseYmd(a.nextFreeDay)) : <span className="text-xs text-silver">Booked for two weeks</span>),
                    },
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
                    {
                      key: 'certs',
                      header: 'Certifications',
                      accessor: (a) => (a.certifications ?? []).map((c) => c.name).join(', '),
                      sortable: false,
                      cell: (a) =>
                        a.certifications && a.certifications.length ? (
                          <span className="flex flex-wrap gap-1">
                            {a.certifications.slice(0, 3).map((c) => (
                              <Badge key={c.name} size="sm" variant="outline" title={c.expiresAt ? `Valid to ${c.expiresAt}` : undefined}>
                                {c.name}
                              </Badge>
                            ))}
                            {a.certifications.length > 3 && <span className="text-xs text-silver">+{a.certifications.length - 3}</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-silver">—</span>
                        ),
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

/**
 * One person's skills: record what they can do (a claim, at a level), and
 * verify it once someone has seen them do it. The API had all four calls
 * and no screen — nobody was ever tagged with a skill.
 */
export function PersonSkillsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [person, setPerson] = useState<PickedAssociate | null>(null);
  const [skillId, setSkillId] = useState('');
  const [level, setLevel] = useState<SkillLevel>('INTERMEDIATE');
  const [years, setYears] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const catalog = useQuery({ queryKey: ['skills'], queryFn: () => listSkills() });
  const mine = useQuery({
    queryKey: ['skills', 'associate', person?.id],
    queryFn: () => listAssociateSkills(person!.id),
    enabled: Boolean(person),
  });
  const rows: AssociateSkillEntry[] = mine.data?.skills ?? [];
  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await mine.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That did not save.');
    } finally {
      setBusy(null);
    }
  };
  const claim = () => {
    if (!person || !skillId) {
      toast.error('Pick a skill first.');
      return;
    }
    const y = years.trim() === '' ? null : Number(years);
    if (y !== null && (!Number.isFinite(y) || y < 0 || y > 60)) {
      toast.error('Years must be a number from 0 to 60.');
      return;
    }
    const name = catalog.data?.skills.find((x) => x.id === skillId)?.name ?? 'Skill';
    void run(
      'claim',
      () => claimAssociateSkill({ associateId: person.id, skillId, level, yearsExperience: y }),
      `${name} recorded for ${person.name} — verify it once you've seen it.`,
    ).then(() => {
      setSkillId('');
      setYears('');
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 py-4">
          <Label htmlFor="skills-person">Person</Label>
          <AssociatePicker id="skills-person" value={person} onChange={setPerson} placeholder="Find someone by name…" />
        </CardContent>
      </Card>
      {person && (
        <>
          {canManage && (
            <Card>
              <CardContent className="grid gap-3 py-4 sm:grid-cols-[1fr_10rem_7rem_auto] sm:items-end">
                <div>
                  <Label htmlFor="claim-skill">Skill</Label>
                  <Select id="claim-skill" className="mt-1" value={skillId} onChange={(e) => setSkillId(e.target.value)}>
                    <option value="">{catalog.isLoading ? 'Loading the catalog…' : 'Pick a skill…'}</option>
                    {(catalog.data?.skills ?? [])
                      .filter((x) => !rows.some((r) => r.skillId === x.id))
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                          {x.category ? ` · ${x.category}` : ''}
                        </option>
                      ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="claim-level">Level</Label>
                  <Select id="claim-level" className="mt-1" value={level} onChange={(e) => setLevel(e.target.value as SkillLevel)}>
                    {LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_LABELS[l]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="claim-years">Years</Label>
                  <Input id="claim-years" className="mt-1" type="number" inputMode="numeric" min={0} max={60} value={years} onChange={(e) => setYears(e.target.value)} />
                </div>
                <Button onClick={claim} loading={busy === 'claim'} disabled={busy !== null}>
                  <Plus className="h-4 w-4" />
                  Add skill
                </Button>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardContent className="p-3">
              {mine.isError ? (
                <ErrorBanner>{mine.error instanceof ApiError ? mine.error.message : 'Could not load their skills.'}</ErrorBanner>
              ) : mine.isLoading ? (
                <SkeletonRows count={3} />
              ) : rows.length === 0 ? (
                <EmptyState icon={Sparkles} title="No skills recorded" description={`Add what ${person.name} can do — verified skills count first in Find people.`} />
              ) : (
                <ul className="divide-y divide-line" aria-label={`${person.name}'s skills`}>
                  {rows.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                      <span className="min-w-0 flex-1 text-ink">
                        {r.skillName}
                        <span className="text-ink-muted">
                          {' '}
                          · {LEVEL_LABELS[r.level]}
                          {r.yearsExperience != null ? ` · ${r.yearsExperience} yr` : ''}
                          {r.selfClaimedAt && !r.verifiedAt ? ` · added by them ${fmtDate(r.selfClaimedAt)}` : ''}
                        </span>
                      </span>
                      {r.verifiedAt ? (
                        <Badge variant="success" className="gap-1">
                          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                          Verified{r.verifiedByEmail ? ` by ${r.verifiedByEmail}` : ''} {fmtDate(r.verifiedAt)}
                        </Badge>
                      ) : canManage ? (
                        <Button size="sm" variant="outline" loading={busy === `v:${r.id}`} disabled={busy !== null} onClick={() => void run(`v:${r.id}`, () => verifyAssociateSkill(r.id), `${r.skillName} verified.`)}>
                          Verify
                        </Button>
                      ) : (
                        <Badge variant="pending">Not verified</Badge>
                      )}
                      {canManage && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove ${r.skillName}`}
                          disabled={busy !== null}
                          onClick={async () => {
                            if (!(await confirm({ title: `Remove ${r.skillName} from ${person.name}?`, destructive: true, confirmLabel: 'Remove' }))) return;
                            void run(`d:${r.id}`, () => deleteAssociateSkill(r.id), `${r.skillName} removed.`);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
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
            placeholder="Forklift, ServSafe, Spanish…"
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
