import { useEffect, useState } from 'react';
import { Plus, Route as RouteIcon, Trash2, ArrowUp, ArrowDown, X } from 'lucide-react';
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
  type LearningPathStatus,
  type LearningPathSummary,
  type PathEnrollment,
} from '@/lib/learningPaths114Api';
import { listCourses, type Course } from '@/lib/lms94Api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
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
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Input, Textarea } from '@/components/ui/Input';
import { fmtDate } from '@/lib/format';
import { Label } from '@/components/ui/Label';

/** Shared load-failure block: message + Retry. Never fake an empty state. */
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-6 space-y-3">
      <p role="alert" className="text-sm text-alert">
        {message}
      </p>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function LearningPathsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const [rows, setRows] = useState<LearningPathSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<LearningPathStatus | 'ALL'>('ALL');
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LearningPathSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = () => {
    setRows(null);
    setError(null);
    listLearningPaths()
      .then((r) => setRows(r.paths))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Failed to load learning paths.'),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = (rows ?? []).filter(
    (p) =>
      (!q || p.title.toLowerCase().includes(q)) &&
      (statusFilter === 'ALL' || p.status === statusFilter),
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Learning paths"
        subtitle="Sequence courses into ordered tracks. Associates work through them in order."
        breadcrumbs={[{ label: 'Learning' }, { label: 'Paths' }]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-56"
          placeholder="Search paths…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search learning paths by name"
        />
        <Select
          size="sm"
          className="w-40"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as LearningPathStatus | 'ALL')}
          aria-label="Filter learning paths by status"
        >
          <option value="ALL">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="PUBLISHED">Published</option>
          <option value="ARCHIVED">Archived</option>
        </Select>
        <div className="ml-auto">
          {canManage && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New path
            </Button>
          )}
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {error ? (
            <LoadError message={error} onRetry={refresh} />
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={RouteIcon}
              title="No learning paths"
              description="Create one to bundle courses into a curriculum."
              action={
                canManage ? (
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New path
                  </Button>
                ) : undefined
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={RouteIcon}
              title="No matching paths"
              description="Adjust the search or status filter."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Steps</TableHead>
                  <TableHead className="hidden md:table-cell">Enrollments</TableHead>
                  <TableHead className="hidden lg:table-cell">Required</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => (
                  <TableRow key={p.id} className="group">
                    <TableCell className="font-medium text-white">
                      {p.title}
                      <div className="md:hidden text-[11px] text-silver/70 truncate font-normal">
                        {p.stepCount} step{p.stepCount === 1 ? '' : 's'} · {p.enrollmentCount} enrolled
                      </div>
                    </TableCell>
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
                    <TableCell className="hidden md:table-cell">{p.stepCount}</TableCell>
                    <TableCell className="hidden md:table-cell">{p.enrollmentCount}</TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {p.isRequired ? <Badge variant="accent">Required</Badge> : '—'}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(p.id)}>
                        Edit
                      </Button>
                      {canManage && (
                        <button
                          onClick={() => setDeleteTarget(p)}
                          className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition text-xs"
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
          <Textarea
            className="mt-1 h-24"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            id="new-path-required"
            type="checkbox"
            checked={isRequired}
            onChange={(e) => setIsRequired(e.target.checked)}
          />
          <Label htmlFor="new-path-required" className="mb-0">
            Required path (mandatory completion)
          </Label>
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
  const confirm = useConfirm();
  const [data, setData] = useState<LearningPathDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [enrollments, setEnrollments] = useState<PathEnrollment[] | null>(null);
  const [enrollmentsError, setEnrollmentsError] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [coursesError, setCoursesError] = useState<string | null>(null);
  const [courseId, setCourseId] = useState('');
  const [picked, setPicked] = useState<PickedAssociate[]>([]);
  const [enrolling, setEnrolling] = useState(false);

  const refresh = () => {
    setData(null);
    setDetailError(null);
    setEnrollments(null);
    setEnrollmentsError(null);
    getLearningPath(pathId)
      .then(setData)
      .catch((err) =>
        setDetailError(
          err instanceof ApiError ? err.message : 'Failed to load the learning path.',
        ),
      );
    listPathEnrollments(pathId)
      .then((r) => setEnrollments(r.enrollments))
      .catch((err) =>
        setEnrollmentsError(
          err instanceof ApiError ? err.message : 'Failed to load enrollments.',
        ),
      );
  };
  const loadCourses = () => {
    setCourses(null);
    setCoursesError(null);
    listCourses('PUBLISHED')
      .then((r) => setCourses(r.courses))
      .catch((err) =>
        setCoursesError(
          err instanceof ApiError ? err.message : 'Failed to load courses.',
        ),
      );
  };
  useEffect(() => {
    refresh();
    // Lazy-load the step-picker source only for managers.
    if (canManage) loadCourses();
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

  // Associates already enrolled (not WITHDRAWN) — the picker skips these
  // so HR can't double-enroll someone by accident.
  const enrolledAssociateIds = new Set(
    (enrollments ?? []).map((e) => e.associateId),
  );

  const enrollPicked = async () => {
    if (picked.length === 0) return;
    setEnrolling(true);
    try {
      const results = await Promise.allSettled(
        picked.map((p) => enrollInLearningPath({ pathId, associateId: p.id })),
      );
      const failedNames = picked.filter((_, i) => results[i].status === 'rejected');
      const ok = results.length - failedNames.length;
      if (failedNames.length === 0) {
        toast.success(`Enrolled ${ok} associate${ok === 1 ? '' : 's'}.`);
      } else if (ok === 0) {
        toast.error(
          `Enrollment failed for ${failedNames.map((p) => p.name).join(', ')}.`,
        );
      } else {
        toast.error(
          `Enrolled ${ok}; failed for ${failedNames.map((p) => p.name).join(', ')}.`,
        );
      }
      // Keep the failures in the chip list so HR can retry just those.
      setPicked(failedNames);
      refresh();
    } finally {
      setEnrolling(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>{data?.title ?? 'Loading…'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {detailError ? (
          <LoadError message={detailError} onRetry={refresh} />
        ) : !data ? (
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
                <Select
                  size="sm"
                  value={data.status}
                  aria-label="Path status"
                  onChange={async (e) => {
                    const next = e.target.value as LearningPathDetail['status'];
                    const el = e.target;
                    if (
                      next === 'ARCHIVED' &&
                      !(await confirm({
                        title: 'Archive this path?',
                        description:
                          'Archived paths are hidden from new enrollment. Existing enrollments are kept.',
                        confirmLabel: 'Archive',
                        destructive: true,
                      }))
                    ) {
                      el.value = data.status;
                      return;
                    }
                    try {
                      await updateLearningPath(pathId, { status: next });
                      toast.success(`Status set to ${next}.`);
                      refresh();
                    } catch (err) {
                      toast.error(err instanceof ApiError ? err.message : 'Failed.');
                      el.value = data.status;
                    }
                  }}
                >
                  <option value="DRAFT">DRAFT</option>
                  <option value="PUBLISHED">PUBLISHED</option>
                  <option value="ARCHIVED">ARCHIVED</option>
                </Select>
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
                            className="text-silver hover:text-white disabled:opacity-50"
                            title="Move up"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => void moveStep(i, 1)}
                            disabled={i === data.steps.length - 1}
                            className="text-silver hover:text-white disabled:opacity-50"
                            title="Move down"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </button>
                          <button
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: 'Remove this step?',
                                  description: `Remove "${s.courseTitle}" from this path? Existing course enrollments are not affected.`,
                                  confirmLabel: 'Remove',
                                  destructive: true,
                                }))
                              )
                                return;
                              try {
                                await removeLearningPathStep(s.id);
                                toast.success('Step removed.');
                                refresh();
                              } catch (err) {
                                toast.error(err instanceof ApiError ? err.message : 'Failed.');
                              }
                            }}
                            className="text-silver hover:text-alert"
                            title="Remove step"
                            aria-label={`Remove step ${s.courseTitle}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {canManage && coursesError && (
                <div className="flex items-center gap-3 pt-2">
                  <p role="alert" className="text-sm text-alert">
                    {coursesError}
                  </p>
                  <Button size="sm" variant="secondary" onClick={loadCourses}>
                    Retry
                  </Button>
                </div>
              )}
              {canManage && !coursesError && (
                <div className="flex gap-2 pt-2">
                  <div className="flex-1">
                    <Select
                      size="sm"
                      value={courseId}
                      onChange={(e) => setCourseId(e.target.value)}
                      disabled={courses === null}
                      aria-label="Course to add as a step"
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
                    </Select>
                  </div>
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
              {enrollmentsError ? (
                <div className="flex items-center gap-3">
                  <p role="alert" className="text-sm text-alert">
                    {enrollmentsError}
                  </p>
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              ) : enrollments === null ? (
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
                        <TableHead className="hidden md:table-cell">Assigned</TableHead>
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
                            <div className="md:hidden text-[11px] text-silver/70 truncate">
                              Assigned {fmtDate(e.assignedAt)}
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
                          <TableCell className="text-xs text-silver hidden md:table-cell">
                            {fmtDate(e.assignedAt)}
                          </TableCell>
                          {canManage && (
                            <TableCell className="text-right">
                              <button
                                onClick={async () => {
                                  if (
                                    !(await confirm({
                                      title: 'Withdraw enrollment?',
                                      description: `Withdraw ${e.associateName} from this path? Their course enrollments are not affected.`,
                                      confirmLabel: 'Withdraw',
                                      destructive: true,
                                    }))
                                  )
                                    return;
                                  try {
                                    await withdrawLearningPathEnrollment(e.id);
                                    toast.success(`Withdrew ${e.associateName}.`);
                                    refresh();
                                  } catch (err) {
                                    toast.error(
                                      err instanceof ApiError
                                        ? err.message
                                        : 'Failed.',
                                    );
                                  }
                                }}
                                className="text-silver hover:text-alert text-xs"
                                title="Withdraw"
                                aria-label={`Withdraw ${e.associateName}`}
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
                <div className="pt-2 space-y-2">
                  {/* Multi-pick built on the single-value AssociatePicker: the
                      picker's own value stays null so it never collapses into
                      its "selected" chip; each onChange appends to the picked
                      list (deduped, already-enrolled skipped) and selections
                      render as removable chips below. */}
                  <AssociatePicker
                    value={null}
                    onChange={(a) => {
                      if (!a) return;
                      if (enrolledAssociateIds.has(a.id)) {
                        toast.error(`${a.name} is already enrolled.`);
                        return;
                      }
                      setPicked((prev) =>
                        prev.some((p) => p.id === a.id) ? prev : [...prev, a],
                      );
                    }}
                    placeholder="Search to add an associate…"
                  />
                  {picked.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {picked.map((p) => (
                        <span
                          key={p.id}
                          className="inline-flex items-center gap-1 rounded-full border border-navy-secondary bg-navy px-2.5 py-1 text-xs text-white"
                        >
                          {p.name}
                          <button
                            type="button"
                            aria-label={`Remove ${p.name}`}
                            className="text-silver/60 hover:text-white"
                            onClick={() =>
                              setPicked((prev) => prev.filter((x) => x.id !== p.id))
                            }
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <Button
                    size="sm"
                    disabled={picked.length === 0 || enrolling}
                    onClick={() => void enrollPicked()}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    {enrolling
                      ? 'Enrolling…'
                      : `Enroll${picked.length > 0 ? ` ${picked.length}` : ''}`}
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
