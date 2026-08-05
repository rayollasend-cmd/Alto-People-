import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, GraduationCap, Plus, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, ymdLocal } from '@/lib/format';
import {
  archiveCourse,
  completeEnrollment,
  createCourse,
  deleteCourse,
  enrollAssociates,
  listCourses,
  listEnrollments,
  listExpiring,
  publishCourse,
  waiveEnrollment,
  type Course,
  type CourseStatus,
  type Enrollment,
  type EnrollmentStatus,
  type ExpiringEnrollment,
} from '@/lib/lms94Api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import { StatusBadge, statusLabel } from '@/lib/status';
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
  ErrorBanner,
  Input,
  PageHeader,
  SearchInput,
  SegmentedControl,
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
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

type Tab = 'courses' | 'enrollments' | 'expiring';

export function LearningHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const [tab, setTab] = useState<Tab>('courses');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Learning"
        subtitle="Courses, certifications, and expiration tracking."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'Learning' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="courses">
            <BookOpen className="mr-2 h-4 w-4" /> Courses
          </TabsTrigger>
          <TabsTrigger value="enrollments">
            <GraduationCap className="mr-2 h-4 w-4" /> Enrollments
          </TabsTrigger>
          <TabsTrigger value="expiring">
            <AlertTriangle className="mr-2 h-4 w-4" /> Expiring
          </TabsTrigger>
        </TabsList>
        <TabsContent value="courses"><CoursesTab canManage={canManage} /></TabsContent>
        <TabsContent value="enrollments"><EnrollmentsTab canManage={canManage} /></TabsContent>
        <TabsContent value="expiring"><ExpiringTab /></TabsContent>
      </Tabs>
    </div>
  );
}

/** Shared load-failure block: message + Retry. Never fake an empty state. */
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-6">
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {message}
      </ErrorBanner>
    </div>
  );
}

function CoursesTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<CourseStatus | 'ALL'>('ALL');
  const [showNew, setShowNew] = useState(false);
  const [enrollFor, setEnrollFor] = useState<Course | null>(null);

  const refresh = () => {
    setRows(null);
    setError(null);
    listCourses()
      .then((r) => setRows(r.courses))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Failed to load courses.'),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = (rows ?? []).filter(
    (c) =>
      (!q || c.title.toLowerCase().includes(q)) &&
      (statusFilter === 'ALL' || c.status === statusFilter),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="h-8 w-64"
          placeholder="Search courses…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search courses by name"
        />
        <Select
          size="sm"
          className="w-40"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as CourseStatus | 'ALL')}
          aria-label="Filter courses by status"
        >
          <option value="ALL">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="PUBLISHED">Published</option>
          <option value="ARCHIVED">Archived</option>
        </Select>
        <div className="ml-auto">
          {canManage && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New course
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
              icon={BookOpen}
              title="No courses"
              description="Build a course catalog with required and optional training."
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No matching courses"
              description="Adjust the search or status filter."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead className="hidden md:table-cell">Required</TableHead>
                  <TableHead className="hidden lg:table-cell">Validity</TableHead>
                  <TableHead className="hidden lg:table-cell text-right">Modules</TableHead>
                  <TableHead className="hidden md:table-cell text-right">Enrolled</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((c) => (
                  <TableRow key={c.id} className="group">
                    <TableCell className="font-medium text-white">
                      {c.title}
                      <div className="md:hidden text-xs2 text-silver/70 truncate font-normal">
                        {c.isRequired ? 'Required · ' : ''}{c.enrollmentCount} enrolled
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {c.isRequired ? <Badge variant="destructive">Required</Badge> : '—'}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {c.validityDays ? `${c.validityDays}d` : 'Never expires'}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-right tabular-nums">
                      {c.moduleCount}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-right tabular-nums">
                      {c.enrollmentCount}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && c.status === 'DRAFT' && (
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              await publishCourse(c.id);
                              toast.success(`Published "${c.title}".`);
                              refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof ApiError ? err.message : 'Failed to publish.',
                              );
                            }
                          }}
                        >
                          Publish
                        </Button>
                      )}
                      {canManage && c.status === 'PUBLISHED' && (
                        <>
                          <Button size="sm" onClick={() => setEnrollFor(c)}>
                            Enroll
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: 'Archive this course?',
                                  description: `"${c.title}" will stop accepting new enrollments. Existing enrollments are kept.`,
                                  confirmLabel: 'Archive',
                                  destructive: true,
                                }))
                              )
                                return;
                              try {
                                await archiveCourse(c.id);
                                toast.success(`Archived "${c.title}".`);
                                refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError ? err.message : 'Failed to archive.',
                                );
                              }
                            }}
                          >
                            Archive
                          </Button>
                        </>
                      )}
                      {canManage && (
                        <button
                          onClick={async () => {
                            if (!(await confirm({ title: 'Delete this course?', destructive: true }))) return;
                            try {
                              await deleteCourse(c.id);
                              refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof ApiError
                                  ? err.message
                                  : 'Could not delete the course.',
                              );
                            }
                          }}
                          className="can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition text-xs"
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
        <NewCourseDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {enrollFor && (
        <EnrollDrawer
          course={enrollFor}
          onClose={() => setEnrollFor(null)}
          onSaved={() => {
            setEnrollFor(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewCourseDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isRequired, setIsRequired] = useState(false);
  const [validityDays, setValidityDays] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!title.trim()) {
      toast.error('Title required.');
      return;
    }
    setSaving(true);
    try {
      await createCourse({
        title: title.trim(),
        description: description.trim() || null,
        isRequired,
        validityDays: validityDays ? Number(validityDays) : null,
      });
      toast.success('Course drafted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the course.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New course</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Title</Label>
          <Input
            className="mt-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
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
            id="new-course-required"
            type="checkbox"
            checked={isRequired}
            onChange={(e) => setIsRequired(e.target.checked)}
          />
          <Label htmlFor="new-course-required" className="mb-0">
            Required for compliance
          </Label>
        </div>
        <div>
          <Label>Validity (days) — leave empty for never expires</Label>
          <Input
            type="number"
            className="mt-1"
            value={validityDays}
            onChange={(e) => setValidityDays(e.target.value)}
            placeholder="365"
          />
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

function EnrollDrawer({
  course,
  onClose,
  onSaved,
}: {
  course: Course;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Multi-pick built on the single-value AssociatePicker: the picker's own
  // value stays null so it never collapses into its "selected" chip; each
  // onChange appends to this list (deduped) and selections render as
  // removable chips below.
  const [picked, setPicked] = useState<PickedAssociate[]>([]);
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    const associateIds = picked.map((p) => p.id);
    if (associateIds.length === 0) {
      toast.error('Pick at least one associate.');
      return;
    }
    setSaving(true);
    try {
      const r = await enrollAssociates(course.id, associateIds);
      // The API may grow a skippedNames list; prefer names over a bare
      // count when they're provided so HR knows exactly who was skipped.
      const skippedNames = (r as { skippedNames?: string[] }).skippedNames;
      if (r.skipped > 0 && skippedNames && skippedNames.length > 0) {
        toast.success(
          `Enrolled ${r.created}. Skipped (already enrolled): ${skippedNames.join(', ')}.`,
        );
      } else if (r.skipped > 0) {
        toast.success(`Enrolled ${r.created}, skipped ${r.skipped}.`);
      } else {
        toast.success(`Enrolled ${r.created}.`);
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not enroll the associates.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Enroll into "{course.title}"</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associates</Label>
          <div className="mt-1">
            <AssociatePicker
              value={null}
              onChange={(a) => {
                if (!a) return;
                setPicked((prev) =>
                  prev.some((p) => p.id === a.id) ? prev : [...prev, a],
                );
              }}
              placeholder="Search to add an associate…"
            />
          </div>
          {picked.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
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
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Enrolling…' : 'Enroll'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// Deliberate departures from the shared vocabulary: a learning ASSIGNED is a
// to-do awaiting the associate (amber) — unlike scheduling, where an assigned
// shift is a healthy covered one — and IN_PROGRESS here is an actively-worked
// state (gold per the Badge contract).
const ENROLL_STATUS_TONES = { ASSIGNED: 'pending', IN_PROGRESS: 'accent' } as const;

function EnrollmentsTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Enrollment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<EnrollmentStatus | 'ALL'>('ALL');
  const [completeId, setCompleteId] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [waiveId, setWaiveId] = useState<string | null>(null);
  const [waiving, setWaiving] = useState(false);

  const refresh = () => {
    setRows(null);
    setError(null);
    listEnrollments()
      .then((r) => setRows(r.enrollments))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Failed to load enrollments.'),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const onComplete = (id: string) => setCompleteId(id);
  const onWaive = (id: string) => setWaiveId(id);

  const q = search.trim().toLowerCase();
  const filtered = (rows ?? []).filter(
    (e) =>
      (!q ||
        e.associateName.toLowerCase().includes(q) ||
        e.courseTitle.toLowerCase().includes(q)) &&
      (statusFilter === 'ALL' || e.status === statusFilter),
  );

  const exportCsv = () => {
    downloadCsv(`enrollments-${ymdLocal()}.csv`, [
      ['Course', 'Associate', 'Status', 'Completed', 'Expires', 'Score', 'Assigned'],
      ...filtered.map((e) => [
        e.courseTitle,
        e.associateName,
        statusLabel(e.status),
        e.completedAt ? fmtDate(e.completedAt) : '',
        e.expiresAt ? fmtDate(e.expiresAt) : '',
        e.score ?? '',
        fmtDate(e.assignedAt),
      ]),
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="h-8 w-64"
          placeholder="Search associate or course…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search enrollments by associate or course"
        />
        <Select
          size="sm"
          className="w-40"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as EnrollmentStatus | 'ALL')}
          aria-label="Filter enrollments by status"
        >
          <option value="ALL">All statuses</option>
          <option value="ASSIGNED">Assigned</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="COMPLETED">Completed</option>
          <option value="EXPIRED">Expired</option>
          <option value="WAIVED">Waived</option>
        </Select>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          onClick={exportCsv}
          disabled={filtered.length === 0}
        >
          Export CSV
        </Button>
      </div>
    <Card>
      <CardContent className="p-0">
        {error ? (
          <LoadError message={error} onRetry={refresh} />
        ) : rows === null ? (
          <div className="p-6"><SkeletonRows count={3} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={GraduationCap}
            title="No enrollments"
            description="Assign associates to a course from the Courses tab."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={GraduationCap}
            title="No matching enrollments"
            description="Adjust the search or status filter."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead>Associate</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Completed</TableHead>
                <TableHead className="hidden md:table-cell">Expires</TableHead>
                <TableHead className="hidden lg:table-cell text-right">Score</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium text-white">
                    {e.courseTitle}
                    <div className="md:hidden text-xs2 text-silver/70 truncate font-normal">
                      Expires {fmtDate(e.expiresAt)}
                    </div>
                  </TableCell>
                  <TableCell>{e.associateName}</TableCell>
                  <TableCell>
                    <StatusBadge status={e.status} overrides={ENROLL_STATUS_TONES} />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{fmtDate(e.completedAt)}</TableCell>
                  <TableCell className="hidden md:table-cell">{fmtDate(e.expiresAt)}</TableCell>
                  <TableCell className="hidden lg:table-cell text-right tabular-nums">
                    {e.score ?? '—'}
                  </TableCell>
                  <TableCell className="text-right space-x-2">
                    {(e.status === 'ASSIGNED' || e.status === 'IN_PROGRESS') && (
                      <Button size="sm" onClick={() => onComplete(e.id)}>
                        Complete
                      </Button>
                    )}
                    {canManage &&
                      (e.status === 'ASSIGNED' || e.status === 'IN_PROGRESS') && (
                        <Button size="sm" variant="ghost" onClick={() => onWaive(e.id)}>
                          Waive
                        </Button>
                      )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ConfirmDialog
        open={completeId !== null}
        onOpenChange={(o) => !o && setCompleteId(null)}
        title="Mark complete"
        description="Record a score if applicable. Leave blank for pass/fail courses."
        confirmLabel="Mark complete"
        numericInput
        numericLabel="Score (0–100, optional)"
        numericMin={0}
        numericMax={100}
        numericStep={0.1}
        busy={completing}
        onConfirm={async (score) => {
          if (!completeId) return;
          setCompleting(true);
          try {
            await completeEnrollment(
              completeId,
              score === null ? undefined : score,
            );
            toast.success('Marked complete.');
            setCompleteId(null);
            refresh();
          } catch (err) {
            toast.error(
              err instanceof ApiError ? err.message : 'Could not mark the enrollment complete.',
            );
          } finally {
            setCompleting(false);
          }
        }}
      />
      <ConfirmDialog
        open={waiveId !== null}
        onOpenChange={(o) => !o && setWaiveId(null)}
        title="Waive enrollment"
        description="The associate will not be required to complete this course. They can still take it voluntarily."
        confirmLabel="Waive"
        destructive
        busy={waiving}
        onConfirm={async () => {
          if (!waiveId) return;
          setWaiving(true);
          try {
            await waiveEnrollment(waiveId);
            toast.success('Waived.');
            setWaiveId(null);
            refresh();
          } catch (err) {
            toast.error(
              err instanceof ApiError ? err.message : 'Could not waive the enrollment.',
            );
          } finally {
            setWaiving(false);
          }
        }}
      />
    </Card>
    </div>
  );
}

const EXPIRING_WINDOWS = [30, 60, 90] as const;

function ExpiringTab() {
  const [days, setDays] = useState<number>(30);
  const [rows, setRows] = useState<ExpiringEnrollment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setRows(null);
    setError(null);
    try {
      const r = await listExpiring(days);
      setRows(r.expiring);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Failed to load expiring enrollments.',
      );
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const exportCsv = () => {
    downloadCsv(`expiring-${days}d-${ymdLocal()}.csv`, [
      ['Course', 'Associate', 'Required', 'Expires', 'Days left'],
      ...(rows ?? []).map((e) => [
        e.courseTitle,
        e.associateName,
        e.isRequired ? 'Yes' : 'No',
        fmtDate(e.expiresAt),
        e.daysLeft,
      ]),
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-silver">Window</span>
        <SegmentedControl<number>
          ariaLabel="Expiration window"
          value={days}
          onChange={setDays}
          options={EXPIRING_WINDOWS.map((w) => ({
            value: w,
            label: `${w} days`,
          }))}
        />
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          onClick={exportCsv}
          disabled={!rows || rows.length === 0}
        >
          Export CSV
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {error ? (
            <LoadError message={error} onRetry={() => void refresh()} />
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={AlertTriangle}
              title="No expirations in this window"
              description="Certs with validity periods auto-expire — they'll show here as their deadlines approach."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Course</TableHead>
                  <TableHead>Associate</TableHead>
                  <TableHead className="hidden md:table-cell">Required</TableHead>
                  <TableHead className="hidden md:table-cell">Expires</TableHead>
                  <TableHead>Days left</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium text-white">
                      {e.courseTitle}
                      <div className="md:hidden text-xs2 text-silver/70 truncate font-normal">
                        Expires {fmtDate(e.expiresAt)}{e.isRequired ? ' · Required' : ''}
                      </div>
                    </TableCell>
                    <TableCell>{e.associateName}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      {e.isRequired ? <Badge variant="destructive">Required</Badge> : '—'}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{fmtDate(e.expiresAt)}</TableCell>
                    <TableCell>
                      <Badge variant={e.daysLeft <= 7 ? 'destructive' : 'pending'}>
                        {e.daysLeft}d
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
