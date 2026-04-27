import { useEffect, useState } from 'react';
import { Plus, Route as RouteIcon, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  addLearningPathStep,
  createLearningPath,
  deleteLearningPath,
  enrollInLearningPath,
  getLearningPath,
  listLearningPaths,
  removeLearningPathStep,
  reorderLearningPathSteps,
  updateLearningPath,
  type LearningPathDetail,
  type LearningPathSummary,
} from '@/lib/learningPaths114Api';
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
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

export function LearningPathsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const [rows, setRows] = useState<LearningPathSummary[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = () => {
    setRows(null);
    listLearningPaths()
      .then((r) => setRows(r.paths))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Learning paths"
        subtitle="Sequence courses into ordered tracks. Associates work through them in order."
        breadcrumbs={[{ label: 'Learning' }, { label: 'Paths' }]}
      />
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New path
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={RouteIcon}
              title="No learning paths"
              description="Create one to bundle courses into a curriculum."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead>Enrollments</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id} className="group">
                    <TableCell className="font-medium text-white">{p.title}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          p.status === 'PUBLISHED'
                            ? 'success'
                            : p.status === 'DRAFT'
                              ? 'pending'
                              : 'outline'
                        }
                      >
                        {p.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{p.stepCount}</TableCell>
                    <TableCell>{p.enrollmentCount}</TableCell>
                    <TableCell>
                      {p.isRequired ? <Badge variant="accent">Required</Badge> : '—'}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(p.id)}>
                        Edit
                      </Button>
                      {canManage && (
                        <button
                          onClick={async () => {
                            if (!window.confirm('Delete this path? Enrollments are kept but the path is removed.'))
                              return;
                            try {
                              await deleteLearningPath(p.id);
                              refresh();
                            } catch (err) {
                              toast.error(err instanceof ApiError ? err.message : 'Failed.');
                            }
                          }}
                          className="opacity-0 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
                        >
                          Delete
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
        <NewPathDrawer
          onClose={() => setShowNew(false)}
          onSaved={(id) => {
            setShowNew(false);
            setEditing(id);
            refresh();
          }}
        />
      )}
      {editing && (
        <PathDetailDrawer
          pathId={editing}
          canManage={canManage}
          onClose={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewPathDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isRequired, setIsRequired] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!title.trim()) {
      toast.error('Title required.');
      return;
    }
    setSaving(true);
    try {
      const r = await createLearningPath({
        title: title.trim(),
        description: description.trim() || null,
        isRequired,
      });
      toast.success('Path created.');
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
        <DrawerTitle>New learning path</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Title</Label>
          <Input
            className="mt-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Manager onboarding"
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
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isRequired}
            onChange={(e) => setIsRequired(e.target.checked)}
          />
          <Label>Required path (mandatory completion)</Label>
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

function PathDetailDrawer({
  pathId,
  canManage,
  onClose,
}: {
  pathId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<LearningPathDetail | null>(null);
  const [courseId, setCourseId] = useState('');
  const [associateId, setAssociateId] = useState('');

  const refresh = () => {
    setData(null);
    getLearningPath(pathId).then(setData).catch(() => setData(null));
  };
  useEffect(() => {
    refresh();
  }, [pathId]);

  const moveStep = async (idx: number, delta: number) => {
    if (!data) return;
    const next = idx + delta;
    if (next < 0 || next >= data.steps.length) return;
    const ids = data.steps.map((s) => s.id);
    [ids[idx], ids[next]] = [ids[next], ids[idx]];
    try {
      await reorderLearningPathSteps(pathId, ids);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{data?.title ?? 'Loading…'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!data ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  data.status === 'PUBLISHED'
                    ? 'success'
                    : data.status === 'DRAFT'
                      ? 'pending'
                      : 'outline'
                }
              >
                {data.status}
              </Badge>
              {canManage && (
                <select
                  className="text-xs bg-midnight border border-navy-secondary rounded p-1 text-white"
                  value={data.status}
                  onChange={async (e) => {
                    try {
                      await updateLearningPath(pathId, {
                        status: e.target.value as LearningPathDetail['status'],
                      });
                      refresh();
                    } catch (err) {
                      toast.error(err instanceof ApiError ? err.message : 'Failed.');
                    }
                  }}
                >
                  <option value="DRAFT">DRAFT</option>
                  <option value="PUBLISHED">PUBLISHED</option>
                  <option value="ARCHIVED">ARCHIVED</option>
                </select>
              )}
            </div>
            {data.description && <div className="text-sm text-silver">{data.description}</div>}
            <div className="space-y-2 pt-2 border-t border-navy-secondary">
              <div className="text-sm uppercase tracking-wider text-silver">Steps</div>
              {data.steps.length === 0 ? (
                <div className="text-sm text-silver">No steps yet.</div>
              ) : (
                <div className="space-y-1">
                  {data.steps.map((s, i) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-2 p-2 rounded border border-navy-secondary"
                    >
                      <div className="text-xs text-silver w-6">#{s.order + 1}</div>
                      <div className="flex-1 text-sm text-white">{s.courseTitle}</div>
                      {canManage && (
                        <>
                          <button
                            onClick={() => void moveStep(i, -1)}
                            disabled={i === 0}
                            className="text-silver hover:text-white disabled:opacity-30"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => void moveStep(i, 1)}
                            disabled={i === data.steps.length - 1}
                            className="text-silver hover:text-white disabled:opacity-30"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                await removeLearningPathStep(s.id);
                                refresh();
                              } catch (err) {
                                toast.error(err instanceof ApiError ? err.message : 'Failed.');
                              }
                            }}
                            className="text-silver hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {canManage && (
                <div className="flex gap-2 pt-2">
                  <Input
                    placeholder="Course ID"
                    className="font-mono text-xs"
                    value={courseId}
                    onChange={(e) => setCourseId(e.target.value)}
                  />
                  <Button
                    size="sm"
                    onClick={async () => {
                      if (!courseId.trim()) return;
                      try {
                        await addLearningPathStep({
                          pathId,
                          courseId: courseId.trim(),
                        });
                        setCourseId('');
                        refresh();
                      } catch (err) {
                        toast.error(err instanceof ApiError ? err.message : 'Failed.');
                      }
                    }}
                  >
                    Add step
                  </Button>
                </div>
              )}
            </div>
            {canManage && (
              <div className="space-y-2 pt-2 border-t border-navy-secondary">
                <div className="text-sm uppercase tracking-wider text-silver">Enroll</div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Associate ID"
                    className="font-mono text-xs"
                    value={associateId}
                    onChange={(e) => setAssociateId(e.target.value)}
                  />
                  <Button
                    size="sm"
                    onClick={async () => {
                      if (!associateId.trim()) return;
                      try {
                        await enrollInLearningPath({
                          pathId,
                          associateId: associateId.trim(),
                        });
                        toast.success('Enrolled.');
                        setAssociateId('');
                      } catch (err) {
                        toast.error(err instanceof ApiError ? err.message : 'Failed.');
                      }
                    }}
                  >
                    Enroll
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
