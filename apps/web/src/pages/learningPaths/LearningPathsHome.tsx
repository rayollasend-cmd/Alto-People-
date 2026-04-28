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
  listPathEnrollments,
  removeLearningPathStep,
  reorderLearningPathSteps,
  updateLearningPath,
  withdrawLearningPathEnrollment,
  type LearningPathDetail,
  type LearningPathSummary,
  type PathEnrollment,
} from '@/lib/learningPaths114Api';
import { listCourses, type Course } from '@/lib/lms94Api';
import { listOrgAssociates } from '@/lib/orgApi';
import type { AssociateOrgSummary } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

export function LearningPathsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const [rows, setRows] = useState<LearningPathSummary[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LearningPathSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

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
                          onClick={() => setDeleteTarget(p)}
                          className="opacity-60 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
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
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete learning path"
        description={
          deleteTarget
            ? `Delete "${deleteTarget.title}"? Existing course enrollments stay; only the path wrapper is removed.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setDeleting(true);
          try {
            await deleteLearningPath(deleteTarget.id);
            toast.success('Deleted.');
            setDeleteTarget(null);
            refresh();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : 'Failed.');
          } finally {
            setDeleting(false);
          }
        }}
      />
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
  const [enrollments, setEnrollments] = useState<PathEnrollment[] | null>(null);
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [associates, setAssociates] = useState<AssociateOrgSummary[] | null>(null);
  const [courseId, setCourseId] = useState('');
  const [associateId, setAssociateId] = useState('');

  const refresh = () => {
    setData(null);
    setEnrollments(null);
    getLearningPath(pathId).then(setData).catch(() => setData(null));
    listPathEnrollments(pathId)
      .then((r) => setEnrollments(r.enrollments))
      .catch(() => setEnrollments([]));
  };
  useEffect(() => {
    refresh();
    // Lazy-load picker sources only for managers.
    if (canManage && courses === null) {
      listCourses('PUBLISHED')
        .then((r) => setCourses(r.courses))
        .catch(() => setCourses([]));
    }
    if (canManage && associates === null) {
      listOrgAssociates()
        .then((r) => setAssociates(r.associates))
        .catch(() => setAssociates([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Hide courses already in the path so HR can't add a duplicate step.
  const usedCourseIds = new Set(data?.steps.map((s) => s.courseId) ?? []);
  const availableCourses = (courses ?? []).filter(
    (c) => !usedCourseIds.has(c.id),
  );

  // Hide associates already enrolled (not WITHDRAWN) so HR can see who's left.
  const enrolledAssociateIds = new Set(
    (enrollments ?? []).map((e) => e.associateId),
  );
  const availableAssociates = (associates ?? []).filter(
    (a) => !enrolledAssociateIds.has(a.id),
  );

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
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
              <div className="text-sm uppercase tracking-wider text-silver">
                Steps ({data.steps.length})
              </div>
              {data.steps.length === 0 ? (
                <div className="text-sm text-silver italic">No steps yet.</div>
              ) : (
                <div className="space-y-1">
                  {data.steps.map((s, i) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-2 p-2 rounded border border-navy-secondary"
                    >
                      <div className="text-xs text-silver w-6">#{s.order + 1}</div>
                      <div className="flex-1 text-sm text-white">
                        {s.courseTitle}
                        {s.courseIsRequired && (
                          <Badge variant="accent" className="ml-2">required</Badge>
                        )}
                      </div>
                      {canManage && (
                        <>
                          <button
                            onClick={() => void moveStep(i, -1)}
                            disabled={i === 0}
                            className="text-silver hover:text-white disabled:opacity-30"
                            title="Move up"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => void moveStep(i, 1)}
                            disabled={i === data.steps.length - 1}
                            className="text-silver hover:text-white disabled:opacity-30"
                            title="Move down"
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
                            title="Remove step"
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
                  <select
                    className="flex-1 h-9 rounded-md border border-navy-secondary bg-midnight px-2 text-sm text-white"
                    value={courseId}
                    onChange={(e) => setCourseId(e.target.value)}
                    disabled={courses === null}
                  >
                    <option value="">
                      {courses === null
                        ? 'Loading courses…'
                        : availableCourses.length === 0
                          ? 'All published courses already added'
                          : 'Select a course…'}
                    </option>
                    {availableCourses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={!courseId}
                    onClick={async () => {
                      try {
                        await addLearningPathStep({ pathId, courseId });
                        setCourseId('');
                        refresh();
                      } catch (err) {
                        toast.error(err instanceof ApiError ? err.message : 'Failed.');
                      }
                    }}
                  >
                    <Plus className="mr-1 h-3 w-3" /> Add step
                  </Button>
                </div>
              )}
            </div>

            <div className="space-y-2 pt-2 border-t border-navy-secondary">
              <div className="text-sm uppercase tracking-wider text-silver">
                Enrollments ({enrollments?.length ?? '…'})
              </div>
              {enrollments === null ? (
                <SkeletonRows count={2} />
              ) : enrollments.length === 0 ? (
                <div className="text-sm text-silver italic">
                  Nobody enrolled yet.
                </div>
              ) : (
                <div className="max-h-64 overflow-y-auto border border-navy-secondary rounded">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Associate</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Assigned</TableHead>
                        {canManage && <TableHead className="text-right" />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {enrollments.map((e) => (
                        <TableRow key={e.id}>
                          <TableCell>
                            <div className="font-medium text-white">
                              {e.associateName}
                            </div>
                            <div className="text-xs text-silver">
                              {e.associateEmail}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                e.status === 'COMPLETED'
                                  ? 'success'
                                  : e.status === 'IN_PROGRESS'
                                    ? 'accent'
                                    : 'pending'
                              }
                            >
                              {e.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-silver">
                            {new Date(e.assignedAt).toLocaleDateString()}
                          </TableCell>
                          {canManage && (
                            <TableCell className="text-right">
                              <button
                                onClick={async () => {
                                  try {
                                    await withdrawLearningPathEnrollment(e.id);
                                    refresh();
                                  } catch (err) {
                                    toast.error(
                                      err instanceof ApiError
                                        ? err.message
                                        : 'Failed.',
                                    );
                                  }
                                }}
                                className="text-silver hover:text-destructive text-xs"
                                title="Withdraw"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {canManage && (
                <div className="flex gap-2 pt-2">
                  <select
                    className="flex-1 h-9 rounded-md border border-navy-secondary bg-midnight px-2 text-sm text-white"
                    value={associateId}
                    onChange={(e) => setAssociateId(e.target.value)}
                    disabled={associates === null}
                  >
                    <option value="">
                      {associates === null
                        ? 'Loading associates…'
                        : availableAssociates.length === 0
                          ? 'Everyone is already enrolled'
                          : 'Select an associate…'}
                    </option>
                    {availableAssociates.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.firstName} {a.lastName}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={!associateId}
                    onClick={async () => {
                      try {
                        await enrollInLearningPath({ pathId, associateId });
                        toast.success('Enrolled.');
                        setAssociateId('');
                        refresh();
                      } catch (err) {
                        toast.error(err instanceof ApiError ? err.message : 'Failed.');
                      }
                    }}
                  >
                    <Plus className="mr-1 h-3 w-3" /> Enroll
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
