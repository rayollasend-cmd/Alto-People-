import { useEffect, useState } from 'react';
import { Plus, Trash2, TrendingUp } from 'lucide-react';
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setLadders(null);
    listLadders()
      .then((r) => setLadders(r.ladders))
      .catch(() => setLadders([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Career ladders"
        subtitle="Progression paths through your job family. See what level you're at, what skills the next rung needs."
        breadcrumbs={[{ label: 'Performance' }, { label: 'Career' }]}
      />

      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New ladder
          </Button>
        </div>
      )}

      {ladders === null ? (
        <Card>
          <CardContent className="p-6">
            <SkeletonRows count={3} />
          </CardContent>
        </Card>
      ) : ladders.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={TrendingUp}
              title="No ladders yet"
              description={
                canManage
                  ? 'Create the first ladder for your job family.'
                  : 'HR has not set up career ladders yet.'
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {ladders.map((l) => (
            <Card key={l.id}>
              <CardContent
                className="p-4 cursor-pointer hover:bg-navy-tertiary transition"
                onClick={() => setOpenId(l.id)}
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
          <textarea
            className="mt-1 w-full h-24 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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
  const [showAddLevel, setShowAddLevel] = useState(false);
  const [skillFor, setSkillFor] = useState<Level | null>(null);

  const refresh = () => {
    setData(null);
    getLadder(ladderId)
      .then(setData)
      .catch(() => setData(null));
  };
  useEffect(() => {
    refresh();
  }, [ladderId]);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{data?.name ?? 'Loading…'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!data ? (
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
                <div className="text-sm text-silver">No levels defined yet.</div>
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
                        <button
                          onClick={async () => {
                            if (!(await confirm({ title: `Delete L${lv.rank} ${lv.title}?`, destructive: true })))
                              return;
                            try {
                              await deleteLevel(lv.id);
                              refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof ApiError
                                  ? err.message
                                  : 'Failed.',
                              );
                            }
                          }}
                          className="text-silver hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
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
                              <button
                                onClick={async () => {
                                  try {
                                    await removeLevelSkill(s.id);
                                    refresh();
                                  } catch (err) {
                                    toast.error(
                                      err instanceof ApiError
                                        ? err.message
                                        : 'Failed.',
                                    );
                                  }
                                }}
                                className="text-silver hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
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
                <Button size="sm" onClick={() => setShowAddLevel(true)}>
                  <Plus className="h-3 w-3 mr-1" /> Add level
                </Button>
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
  const [saving, setSaving] = useState(false);

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
          <Label>Description / expectations</Label>
          <textarea
            className="mt-1 w-full h-32 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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
  const [skillId, setSkillId] = useState('');
  const [minLevel, setMinLevel] = useState<SkillLevel>('INTERMEDIATE');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!skillId.trim()) {
      toast.error('Skill ID required.');
      return;
    }
    setSaving(true);
    try {
      await addLevelSkill(level.id, { skillId: skillId.trim(), minLevel });
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
          <Label>Skill ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={skillId}
            onChange={(e) => setSkillId(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="career-min-level">Minimum level</Label>
          <select
            id="career-min-level"
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as SkillLevel)}
          >
            {(Object.keys(SKILL_LEVEL_LABELS) as SkillLevel[]).map((l) => (
              <option key={l} value={l}>
                {SKILL_LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
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
