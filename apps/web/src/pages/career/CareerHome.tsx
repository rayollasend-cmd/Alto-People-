import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, TrendingUp, X } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  addLevel,
  addLevelSkill,
  archiveLadder,
  createLadder,
  deleteLevel,
  getLadder,
  listLadders,
  removeLevelSkill,
  SKILL_LEVEL_LABELS,
  type LadderDetail,
  type LadderRow,
  type Level,
  type SkillLevel,
} from '@/lib/career126Api';
import { searchSkills } from '@/lib/skills111Api';
import { listJobProfiles } from '@/lib/orgApi';
import type { JobProfile } from '@alto-people/shared';
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
  FilterBar,
  FilterChip,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const LEVEL_VARIANT: Record<SkillLevel, 'pending' | 'accent' | 'success' | 'destructive'> = {
  BEGINNER: 'pending',
  INTERMEDIATE: 'pending',
  ADVANCED: 'accent',
  EXPERT: 'success',
};

export function CareerHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const [ladders, setLadders] = useState<LadderRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState('');
  const [familyFilter, setFamilyFilter] = useState<string | null>(null);

  const refresh = () => {
    setLadders(null);
    setLoadError(null);
    listLadders()
      .then((r) => setLadders(r.ladders))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load career ladders.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const families = useMemo(
    () =>
      ladders
        ? Array.from(
            new Set(ladders.map((l) => l.family).filter((f): f is string => !!f)),
          ).sort()
        : [],
    [ladders],
  );

  const filtered = useMemo(() => {
    if (!ladders) return null;
    const q = search.trim().toLowerCase();
    return ladders.filter(
      (l) =>
        (!q || l.name.toLowerCase().includes(q)) &&
        (!familyFilter || l.family === familyFilter),
    );
  }, [ladders, search, familyFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Career ladders"
        subtitle="Progression paths through your job family. See what level you're at, what skills the next rung needs."
        breadcrumbs={[{ label: 'Performance' }, { label: 'Career' }]}
        primaryAction={
          canManage ? (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New ladder
            </Button>
          ) : undefined
        }
      />

      <FilterBar>
        {families.map((f) => (
          <FilterChip
            key={f}
            active={familyFilter === f}
            onClick={() => setFamilyFilter((cur) => (cur === f ? null : f))}
          >
            {f}
          </FilterChip>
        ))}
        <Input
          placeholder="Search ladders…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto max-w-xs"
          aria-label="Search ladders by name"
        />
      </FilterBar>

      {loadError ? (
        <ErrorBanner>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{loadError}</span>
            <Button size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      ) : filtered === null ? (
        <Card>
          <CardContent className="p-6">
            <SkeletonRows count={3} />
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={TrendingUp}
              title={ladders && ladders.length > 0 ? 'No matches' : 'No ladders yet'}
              description={
                ladders && ladders.length > 0
                  ? 'No ladder matches the current search or family filter.'
                  : canManage
                    ? 'Create the first ladder for your job family.'
                    : 'HR has not set up career ladders yet.'
              }
              action={
                canManage && (!ladders || ladders.length === 0) ? (
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New ladder
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((l) => (
            <Card key={l.id}>
              <CardContent
                role="button"
                tabIndex={0}
                className="p-4 cursor-pointer hover:bg-navy-tertiary transition rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                onClick={() => setOpenId(l.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenId(l.id);
                  }
                }}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-base font-semibold text-white">
                      {l.name}
                    </div>
                    {l.family && (
                      <div className="text-xs text-silver">{l.family}</div>
                    )}
                  </div>
                  <Badge variant="outline">{l.levelCount} levels</Badge>
                </div>
                {l.description && (
                  <div className="text-sm text-silver mt-2 line-clamp-2">
                    {l.description}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showNew && (
        <NewLadderDrawer
          onClose={() => setShowNew(false)}
          onSaved={(id) => {
            setShowNew(false);
            setOpenId(id);
            refresh();
          }}
        />
      )}
      {openId && (
        <LadderDetailDrawer
          ladderId={openId}
          canManage={canManage}
          onClose={() => {
            setOpenId(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewLadderDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [family, setFamily] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    setSaving(true);
    try {
      const r = await createLadder({
        name: name.trim(),
        family: family.trim() || null,
        description: description.trim() || null,
      });
      toast.success('Ladder created.');
      onSaved(r.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New career ladder</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Software Engineering"
          />
        </div>
        <div>
          <Label>Family (optional)</Label>
          <Input
            className="mt-1"
            value={family}
            onChange={(e) => setFamily(e.target.value)}
            placeholder="Engineering"
          />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            className="mt-1 h-24"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Creating…' : 'Create'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function LadderDetailDrawer({
  ladderId,
  canManage,
  onClose,
}: {
  ladderId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const [data, setData] = useState<LadderDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAddLevel, setShowAddLevel] = useState(false);
  const [skillFor, setSkillFor] = useState<Level | null>(null);
  // Per-row pending key so each delete button gets its own spinner
  // instead of disabling the whole drawer. Format: `level:<id>` or
  // `skill:<id>`.
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const refresh = () => {
    setData(null);
    setLoadError(null);
    getLadder(ladderId)
      .then(setData)
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load this ladder.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, [ladderId]);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{data?.name ?? 'Career ladder'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {loadError ? (
          <ErrorBanner>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{loadError}</span>
              <Button size="sm" variant="outline" onClick={refresh}>
                Retry
              </Button>
            </div>
          </ErrorBanner>
        ) : !data ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            {data.family && (
              <div className="text-sm text-silver">{data.family}</div>
            )}
            {data.description && (
              <div className="text-sm text-white">{data.description}</div>
            )}

            <div className="space-y-2">
              {data.levels.length === 0 ? (
                <EmptyState
                  icon={TrendingUp}
                  title="No levels defined yet"
                  description="Add the first rung (L1) to start building the progression path."
                  action={
                    canManage ? (
                      <Button size="sm" onClick={() => setShowAddLevel(true)}>
                        <Plus className="h-3 w-3 mr-1" /> Add level
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                data.levels.map((lv) => (
                  <div
                    key={lv.id}
                    className="p-3 rounded border border-navy-secondary"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">L{lv.rank}</Badge>
                          <div className="text-sm font-medium text-white">
                            {lv.title}
                          </div>
                        </div>
                        {lv.jobProfileTitle && (
                          <div className="text-xs text-silver mt-0.5">
                            ↔ {lv.jobProfileTitle}{' '}
                            {lv.jobProfileCode && `(${lv.jobProfileCode})`}
                          </div>
                        )}
                        {lv.description && (
                          <div className="text-sm text-silver mt-1 whitespace-pre-wrap">
                            {lv.description}
                          </div>
                        )}
                      </div>
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          loading={pendingKey === `level:${lv.id}`}
                          aria-label={`Delete L${lv.rank} ${lv.title}`}
                          onClick={async () => {
                            if (!(await confirm({ title: `Delete L${lv.rank} ${lv.title}?`, destructive: true })))
                              return;
                            setPendingKey(`level:${lv.id}`);
                            try {
                              await deleteLevel(lv.id);
                              toast.success('Level deleted.');
                              refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof ApiError
                                  ? err.message
                                  : 'Failed.',
                              );
                            } finally {
                              setPendingKey(null);
                            }
                          }}
                          className="text-silver hover:text-alert"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                    {lv.skills.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {lv.skills.map((s) => (
                          <span
                            key={s.id}
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-navy-secondary"
                          >
                            {s.skillName}
                            <Badge variant={LEVEL_VARIANT[s.minLevel]} className="ml-1">
                              {SKILL_LEVEL_LABELS[s.minLevel]}
                            </Badge>
                            {canManage && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                loading={pendingKey === `skill:${s.id}`}
                                aria-label={`Remove ${s.skillName}`}
                                onClick={async () => {
                                  if (
                                    !(await confirm({
                                      title: `Remove required skill "${s.skillName}"?`,
                                      destructive: true,
                                    }))
                                  )
                                    return;
                                  setPendingKey(`skill:${s.id}`);
                                  try {
                                    await removeLevelSkill(s.id);
                                    toast.success('Requirement removed.');
                                    refresh();
                                  } catch (err) {
                                    toast.error(
                                      err instanceof ApiError
                                        ? err.message
                                        : 'Failed.',
                                    );
                                  } finally {
                                    setPendingKey(null);
                                  }
                                }}
                                className="text-silver hover:text-alert"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mt-2"
                        onClick={() => setSkillFor(lv)}
                      >
                        <Plus className="h-3 w-3 mr-1" /> Required skill
                      </Button>
                    )}
                  </div>
                ))
              )}
            </div>

            {canManage && (
              <div className="flex gap-2 pt-2">
                {data.levels.length > 0 && (
                  <Button size="sm" onClick={() => setShowAddLevel(true)}>
                    <Plus className="h-3 w-3 mr-1" /> Add level
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!(await confirm({ title: 'Archive this ladder?', destructive: true }))) return;
                    try {
                      await archiveLadder(data.id);
                      toast.success('Archived.');
                      onClose();
                    } catch (err) {
                      toast.error(
                        err instanceof ApiError ? err.message : 'Failed.',
                      );
                    }
                  }}
                >
                  Archive
                </Button>
              </div>
            )}
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
      {showAddLevel && data && (
        <AddLevelDrawer
          ladderId={data.id}
          existingRanks={data.levels.map((l) => l.rank)}
          onClose={() => setShowAddLevel(false)}
          onSaved={() => {
            setShowAddLevel(false);
            refresh();
          }}
        />
      )}
      {skillFor && (
        <AddSkillDrawer
          level={skillFor}
          onClose={() => setSkillFor(null)}
          onSaved={() => {
            setSkillFor(null);
            refresh();
          }}
        />
      )}
    </Drawer>
  );
}

function AddLevelDrawer({
  ladderId,
  existingRanks,
  onClose,
  onSaved,
}: {
  ladderId: string;
  existingRanks: number[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const nextRank = existingRanks.length === 0 ? 1 : Math.max(...existingRanks) + 1;
  const [rank, setRank] = useState(String(nextRank));
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [jobProfileId, setJobProfileId] = useState('');
  const [jobProfiles, setJobProfiles] = useState<JobProfile[] | null>(null);
  const [jobProfilesError, setJobProfilesError] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadJobProfiles = () => {
    setJobProfilesError(false);
    listJobProfiles()
      .then((r) => setJobProfiles(r.jobProfiles))
      .catch(() => setJobProfilesError(true));
  };
  useEffect(() => {
    loadJobProfiles();
  }, []);

  const submit = async () => {
    if (!title.trim()) {
      toast.error('Title required.');
      return;
    }
    setSaving(true);
    try {
      await addLevel(ladderId, {
        rank: parseInt(rank, 10) || 1,
        title: title.trim(),
        description: description.trim() || null,
        jobProfileId: jobProfileId || null,
      });
      toast.success('Level added.');
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
        <DrawerTitle>Add level</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Rank</Label>
          <Input
            type="number"
            min="1"
            max="20"
            className="mt-1 max-w-[100px]"
            value={rank}
            onChange={(e) => setRank(e.target.value)}
          />
        </div>
        <div>
          <Label>Title</Label>
          <Input
            className="mt-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Senior Engineer"
          />
        </div>
        <div>
          <Label>Job profile (optional)</Label>
          {jobProfilesError ? (
            <ErrorBanner className="mt-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Failed to load job profiles.</span>
                <Button size="sm" variant="outline" onClick={loadJobProfiles}>
                  Retry
                </Button>
              </div>
            </ErrorBanner>
          ) : (
            <Select
              className="mt-1"
              value={jobProfileId}
              onChange={(e) => setJobProfileId(e.target.value)}
              disabled={jobProfiles === null}
            >
              <option value="">
                {jobProfiles === null ? 'Loading…' : 'None'}
              </option>
              {(jobProfiles ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.code})
                </option>
              ))}
            </Select>
          )}
        </div>
        <div>
          <Label>Description / expectations</Label>
          <Textarea
            className="mt-1 h-32"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Adding…' : 'Add'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function AddSkillDrawer({
  level,
  onClose,
  onSaved,
}: {
  level: Level;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [dropOpen, setDropOpen] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [minLevel, setMinLevel] = useState<SkillLevel>('INTERMEDIATE');
  const [saving, setSaving] = useState(false);

  // Debounced typeahead over the skills catalog — replaces the old giant
  // native <select> that loaded every skill up front.
  useEffect(() => {
    if (picked || term.trim().length < 2) {
      setOptions([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      searchSkills(term.trim())
        .then((r) => {
          if (!live) return;
          setSearchError(null);
          setOptions(r.skills.slice(0, 8));
          setDropOpen(true);
        })
        .catch(() => {
          if (live) setSearchError('Skill search failed. Try again.');
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [term, picked]);

  const submit = async () => {
    if (!picked) {
      toast.error('Pick a skill.');
      return;
    }
    setSaving(true);
    try {
      await addLevelSkill(level.id, { skillId: picked.id, minLevel });
      toast.success('Requirement added.');
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
        <DrawerTitle>
          Add required skill — L{level.rank} {level.title}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label htmlFor="career-skill">Skill</Label>
          {picked ? (
            <div className="mt-1 flex items-center justify-between rounded-md border border-navy-secondary bg-navy px-3 py-2 text-sm">
              <span className="text-white">{picked.name}</span>
              <button
                type="button"
                onClick={() => {
                  setPicked(null);
                  setTerm('');
                }}
                className="text-silver/60 hover:text-white"
                aria-label="Clear skill"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="relative mt-1">
              <Input
                id="career-skill"
                placeholder="Type to search skills…"
                value={term}
                autoComplete="off"
                onChange={(e) => setTerm(e.target.value)}
                onFocus={() => options.length > 0 && setDropOpen(true)}
              />
              {dropOpen && options.length > 0 && (
                <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-navy-secondary bg-navy elev-2">
                  {options.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="block w-full px-3 py-2 text-left text-sm text-silver hover:bg-navy-secondary hover:text-white"
                      onClick={() => {
                        setPicked(s);
                        setDropOpen(false);
                      }}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              {searchError && (
                <p role="alert" className="mt-1 text-xs text-alert">
                  {searchError}
                </p>
              )}
            </div>
          )}
        </div>
        <div>
          <Label htmlFor="career-min-level">Minimum level</Label>
          <Select
            id="career-min-level"
            className="mt-1"
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as SkillLevel)}
          >
            {(Object.keys(SKILL_LEVEL_LABELS) as SkillLevel[]).map((l) => (
              <option key={l} value={l}>
                {SKILL_LEVEL_LABELS[l]}
              </option>
            ))}
          </Select>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Adding…' : 'Add'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
