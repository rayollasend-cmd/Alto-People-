import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  getMyTraining,
  listCourses,
  listEnrollments,
  listExpiring,
  publishCourse,
  waiveEnrollment,
  type MyTrainingEnrollment,
  type Course,
  type CourseStatus,
  type Enrollment,
  type EnrollmentStatus,
  type ExpiringEnrollment,
} from '@/lib/lms94Api';
import { useAuth, useTerm } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useConfirm } from '@/lib/confirm';
import { useI18n } from '@/lib/i18n';
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
  SearchInput,
  SegmentedControl,
  Select,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Label } from '@/components/ui/Label';
import { ListTemplate } from '@/components/templates';
import { toast } from 'sonner';

type Tab = 'courses' | 'enrollments' | 'expiring';
type TFn = ReturnType<typeof useI18n>['t'];

function courseStatusLabel(t: TFn, s: CourseStatus): string {
  switch (s) {
    case 'DRAFT': return t('learning.statusDraft');
    case 'PUBLISHED': return t('learning.statusPublished');
    case 'ARCHIVED': return t('learning.statusArchived');
    default: return statusLabel(s);
  }
}

function enrollmentStatusLabel(t: TFn, s: EnrollmentStatus): string {
  switch (s) {
    case 'ASSIGNED': return t('learning.statusAssigned');
    case 'IN_PROGRESS': return t('learning.statusInProgress');
    case 'COMPLETED': return t('lrn.done');
    case 'EXPIRED': return t('learning.statusExpired');
    case 'WAIVED': return t('lrn.waived');
    default: return statusLabel(s);
  }
}

export function LearningHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const canViewAdmin = user ? hasCapability(user.role, 'view:compliance') : false;
  const [tab, setTab] = useState<Tab>('courses');
  const { t } = useI18n();

  // Associates got the compliance-admin console (associate search, CSV
  // export, expiry windows) whose every fetch 403'd for them. They get
  // their OWN training instead.
  if (!canViewAdmin) {
    return <MyTraining />;
  }

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title={t('lrn.crumb')}
        subtitle={t('learning.subtitle')}
        breadcrumbs={[{ label: t('learning.crumbMe') }, { label: t('lrn.crumb') }]}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="courses">
            <BookOpen className="mr-2 h-4 w-4" /> {t('learning.courses')}
          </TabsTrigger>
          <TabsTrigger value="enrollments">
            <GraduationCap className="mr-2 h-4 w-4" /> {t('learning.enrollments')}
          </TabsTrigger>
          <TabsTrigger value="expiring">
            <AlertTriangle className="mr-2 h-4 w-4" /> {t('learning.expiring')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="courses"><CoursesTab canManage={canManage} /></TabsContent>
        <TabsContent value="enrollments"><EnrollmentsTab canManage={canManage} /></TabsContent>
        <TabsContent value="expiring"><ExpiringTab /></TabsContent>
      </Tabs>
    </ListTemplate>
  );
}

/**
 * The associate's own training list — required chips, status, expiry.
 * Completion is recorded by HR/your supervisor (course delivery happens
 * on the floor or in the LMS player phase), so this view is honest about
 * what to do rather than offering a dead button.
 */
function MyTraining() {
  const { t } = useI18n();
  const trainingQuery = useQuery({ queryKey: ['learning', 'mine'], queryFn: () => getMyTraining() });
  const rows: MyTrainingEnrollment[] | null = trainingQuery.data?.enrollments ?? null;
  const error = trainingQuery.error
    ? trainingQuery.error instanceof ApiError
      ? trainingQuery.error.message
      : t('lrn.loadFailed')
    : null;
  const load = () => void trainingQuery.refetch();

  const open = (rows ?? []).filter(
    (r) => r.status === 'ASSIGNED' || r.status === 'IN_PROGRESS' || r.status === 'EXPIRED',
  );
  const done = (rows ?? []).filter(
    (r) => r.status === 'COMPLETED' || r.status === 'WAIVED',
  );

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title={t('lrn.myTitle')}
        subtitle={t('lrn.mySubtitle')}
        breadcrumbs={[{ label: t('lrn.crumb') }]}
    >
      {error && (
        <ErrorBanner
          action={
            <Button size="sm" variant="outline" onClick={load}>
              {t('common.retry')}
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      {!rows && !error && <SkeletonRows count={4} rowHeight="h-20" />}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={GraduationCap}
          title={t('lrn.emptyTitle')}
          description={t('lrn.emptyDesc')}
        />
      )}
      {rows && open.length > 0 && (
        <section>
          <h2 className="text-xs2 uppercase tracking-wider text-silver/80 mb-2">
            {t('lrn.toDo', { count: String(open.length) })}
          </h2>
          <ul className="space-y-2">
            {open.map((r) => (
              <li
                key={r.id}
                className={cn(
                  'rounded-lg border p-4',
                  r.status === 'EXPIRED'
                    ? 'border-alert/50 bg-alert/[0.05]'
                    : 'border-gold/40 bg-gold/[0.04]',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-white">{r.courseTitle}</span>
                  {r.isRequired && (
                    <Badge variant="pending">{t('lrn.required')}</Badge>
                  )}
                  {r.status === 'EXPIRED' && (
                    <Badge variant="destructive">{t('lrn.expired')}</Badge>
                  )}
                </div>
                {r.courseDescription && (
                  <p className="text-xs text-silver mt-1">{r.courseDescription}</p>
                )}
                <p className="text-2xs text-silver/70 mt-1.5">
                  {t('lrn.assignedOn', { date: fmtDate(r.assignedAt) })}
                  {' · '}
                  {t('lrn.howToComplete')}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {rows && done.length > 0 && (
        <section>
          <h2 className="text-xs2 uppercase tracking-wider text-silver/80 mb-2">
            {t('lrn.completed', { count: String(done.length) })}
          </h2>
          <ul className="space-y-2">
            {done.map((r) => (
              <li
                key={r.id}
                className="rounded-lg border border-success/30 bg-success/[0.03] p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-white">{r.courseTitle}</span>
                  <Badge variant="success">
                    {r.status === 'WAIVED' ? t('lrn.waived') : t('lrn.done')}
                  </Badge>
                </div>
                <p className="text-2xs text-silver/70 mt-1.5 tabular-nums">
                  {r.completedAt && t('lrn.completedOn', { date: fmtDate(r.completedAt) })}
                  {r.expiresAt && (
                    <> · {t('lrn.validUntil', { date: fmtDate(r.expiresAt) })}</>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </ListTemplate>
  );
}

/** Shared load-failure block: message + Retry. Never fake an empty state. */
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="p-6">
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        }
      >
        {message}
      </ErrorBanner>
    </div>
  );
}

function CoursesTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<CourseStatus | 'ALL'>('ALL');
  const [showNew, setShowNew] = useState(false);
  const [enrollFor, setEnrollFor] = useState<Course | null>(null);
  // One in-flight action at a time — a double-click on Publish/Archive/
  // Delete used to fire the write twice.
  const [actionKey, setActionKey] = useState<string | null>(null);
  const act = async (key: string, fn: () => void | Promise<void>) => {
    if (actionKey) return;
    setActionKey(key);
    try {
      await fn();
    } finally {
      setActionKey(null);
    }
  };

  const coursesQuery = useQuery({ queryKey: ['learning', 'courses'], queryFn: () => listCourses() });
  const rows: Course[] | null = coursesQuery.data?.courses ?? null;
  const error = coursesQuery.error
    ? coursesQuery.error instanceof ApiError
      ? coursesQuery.error.message
      : t('learning.coursesFailed')
    : null;
  const refresh = () => void coursesQuery.refetch();

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
          placeholder={t('learning.searchCourses')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t('learning.searchCoursesAria')}
        />
        <Select
          size="sm"
          className="w-40"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as CourseStatus | 'ALL')}
          aria-label={t('learning.filterCoursesAria')}
        >
          <option value="ALL">{t('learning.allStatuses')}</option>
          <option value="DRAFT">{t('learning.statusDraft')}</option>
          <option value="PUBLISHED">{t('learning.statusPublished')}</option>
          <option value="ARCHIVED">{t('learning.statusArchived')}</option>
        </Select>
        <div className="ml-auto">
          {canManage && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> {t('learning.newCourse')}
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
              title={t('learning.noCourses')}
              description={t('learning.noCoursesDesc')}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title={t('learning.noMatchingCourses')}
              description={t('learning.adjustFilters')}
            />
          ) : (
            <DataGrid<NonNullable<typeof filtered>[number]>
              id="courses"
              caption={t('learning.courses')}
              rows={filtered}
              rowKey={(c) => c.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'courses' }}
              columns={[
                { key: 'title', header: t('learning.fieldTitle'), accessor: (c) => c.title, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'required', header: t('lrn.required'), accessor: (c) => (c.isRequired ? t('lrn.required') : ''), sortable: true, searchable: false, cardMeta: true, cell: (c) => (c.isRequired ? <Badge variant="destructive">{t('lrn.required')}</Badge> : '—') },
                { key: 'validity', header: t('learning.colValidity'), accessor: (c) => c.validityDays, csv: (c) => (c.validityDays ? t('learning.daysShort', { n: c.validityDays }) : t('learning.neverExpires')), sortable: true, searchable: false, cell: (c) => (c.validityDays ? t('learning.daysShort', { n: c.validityDays }) : t('learning.neverExpires')) },
                { key: 'modules', header: t('learning.colModules'), accessor: (c) => c.moduleCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
                { key: 'enrolled', header: t('learning.colEnrolled'), accessor: (c) => c.enrollmentCount, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                { key: 'status', header: t('learning.colStatus'), accessor: (c) => c.status, sortable: true, cell: (c) => <StatusBadge status={c.status} label={courseStatusLabel(t, c.status)} /> },
                {
                  key: 'actions',
                  header: t('learning.colActions'),
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'space-x-2',
                  cell: (c) => (
                    <>
                      {canManage && c.status === 'DRAFT' && (
                        <Button
                          size="sm"
                          loading={actionKey === `pub-${c.id}`}
                          disabled={actionKey !== null}
                          onClick={() =>
                            void act(`pub-${c.id}`, async () => {
                              try {
                                await publishCourse(c.id);
                                toast.success(t('learning.publishedToast', { title: c.title }));
                                refresh();
                              } catch (err) {
                                toast.error(err instanceof ApiError ? err.message : t('learning.publishFailed'));
                              }
                            })
                          }
                        >
                          {t('learning.publish')}
                        </Button>
                      )}
                      {canManage && c.status === 'PUBLISHED' && (
                        <>
                          <Button size="sm" onClick={() => setEnrollFor(c)}>
                            {t('learning.enroll')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={actionKey === `arch-${c.id}`}
                            disabled={actionKey !== null}
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: t('learning.archiveConfirmTitle'),
                                  description: t('learning.archiveConfirmDesc', { title: c.title }),
                                  confirmLabel: t('learning.archive'),
                                  destructive: true,
                                }))
                              )
                                return;
                              await act(`arch-${c.id}`, async () => {
                                try {
                                  await archiveCourse(c.id);
                                  toast.success(t('learning.archivedToast', { title: c.title }));
                                  refresh();
                                } catch (err) {
                                  toast.error(err instanceof ApiError ? err.message : t('learning.archiveFailed'));
                                }
                              });
                            }}
                          >
                            {t('learning.archive')}
                          </Button>
                        </>
                      )}
                      {canManage && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-silver hover:text-alert"
                          disabled={actionKey !== null}
                          onClick={async () => {
                            if (!(await confirm({ title: t('learning.deleteConfirmTitle'), destructive: true }))) return;
                            await act(`del-${c.id}`, async () => {
                              try {
                                await deleteCourse(c.id);
                                toast.success(t('learning.deletedToast', { title: c.title }));
                                refresh();
                              } catch (err) {
                                toast.error(err instanceof ApiError ? err.message : t('learning.deleteFailed'));
                              }
                            });
                          }}
                        >
                          {t('learning.delete')}
                        </Button>
                      )}
                    </>
                  ),
                },
              ]}
            />
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
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isRequired, setIsRequired] = useState(false);
  const [validityDays, setValidityDays] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!title.trim()) {
      toast.error(t('learning.titleRequired'));
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
      toast.success(t('learning.courseDrafted'));
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('learning.createFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{t('learning.newCourse')}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{t('learning.fieldTitle')}</Label>
          <Input
            className="mt-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <Label>{t('learning.description')}</Label>
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
            {t('learning.requiredForCompliance')}
          </Label>
        </div>
        <div>
          <Label>{t('learning.validityLabel')}</Label>
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
          {t('common.cancel')}
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? t('learning.saving') : t('learning.create')}
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
  const { t } = useI18n();
  const term = useTerm();
  // Multi-pick built on the single-value AssociatePicker: the picker's own
  // value stays null so it never collapses into its "selected" chip; each
  // onChange appends to this list (deduped) and selections render as
  // removable chips below.
  const [picked, setPicked] = useState<PickedAssociate[]>([]);
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    const associateIds = picked.map((p) => p.id);
    if (associateIds.length === 0) {
      toast.error(t('learning.pickOne'));
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
          t('learning.enrolledSkippedNames', { created: r.created, names: skippedNames.join(', ') }),
        );
      } else if (r.skipped > 0) {
        toast.success(t('learning.enrolledSkipped', { created: r.created, skipped: r.skipped }));
      } else {
        toast.success(t('learning.enrolledCount', { created: r.created }));
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('learning.enrollFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{t('learning.enrollInto', { title: course.title })}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{term('workers')}</Label>
          <div className="mt-1">
            <AssociatePicker
              value={null}
              onChange={(a) => {
                if (!a) return;
                setPicked((prev) =>
                  prev.some((p) => p.id === a.id) ? prev : [...prev, a],
                );
              }}
              placeholder={t('learning.searchToAdd')}
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
                    aria-label={t('learning.removeName', { name: p.name })}
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
          {t('common.cancel')}
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? t('learning.enrolling') : t('learning.enroll')}
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
  const { t } = useI18n();
  const term = useTerm();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<EnrollmentStatus | 'ALL'>('ALL');
  const [completeId, setCompleteId] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [waiveId, setWaiveId] = useState<string | null>(null);
  const [waiving, setWaiving] = useState(false);

  const enrollmentsQuery = useQuery({ queryKey: ['learning', 'enrollments'], queryFn: () => listEnrollments() });
  const rows: Enrollment[] | null = enrollmentsQuery.data?.enrollments ?? null;
  const error = enrollmentsQuery.error
    ? enrollmentsQuery.error instanceof ApiError
      ? enrollmentsQuery.error.message
      : t('learning.enrollmentsFailed')
    : null;
  const refresh = () => void enrollmentsQuery.refetch();

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
      [t('learning.colCourse'), term('worker'), t('learning.colStatus'), t('learning.colCompleted'), t('learning.colExpires'), t('learning.colScore'), t('learning.colAssigned')],
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
          placeholder={t('learning.searchEnrollments')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t('learning.searchEnrollmentsAria')}
        />
        <Select
          size="sm"
          className="w-40"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as EnrollmentStatus | 'ALL')}
          aria-label={t('learning.filterEnrollmentsAria')}
        >
          <option value="ALL">{t('learning.allStatuses')}</option>
          <option value="ASSIGNED">{t('learning.statusAssigned')}</option>
          <option value="IN_PROGRESS">{t('learning.statusInProgress')}</option>
          <option value="COMPLETED">{t('lrn.done')}</option>
          <option value="EXPIRED">{t('learning.statusExpired')}</option>
          <option value="WAIVED">{t('lrn.waived')}</option>
        </Select>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          onClick={exportCsv}
          disabled={filtered.length === 0}
        >
          {t('learning.exportCsv')}
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
            title={t('learning.noEnrollments')}
            description={t('learning.noEnrollmentsDesc')}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={GraduationCap}
            title={t('learning.noMatchingEnrollments')}
            description={t('learning.adjustFilters')}
          />
        ) : (
          <DataGrid<NonNullable<typeof filtered>[number]>
            id="course-enrollments"
            caption={t('learning.enrollments')}
            rows={filtered}
            rowKey={(e) => e.id}
            search={false}
            urlState={false}
            exportCsv={{ filename: 'enrollments' }}
            columns={[
              { key: 'course', header: t('learning.colCourse'), accessor: (e) => e.courseTitle, sortable: true, primary: true, className: 'font-medium text-white' },
              { key: 'associate', header: term('worker'), accessor: (e) => e.associateName, sortable: true, cardMeta: true },
              { key: 'status', header: t('learning.colStatus'), accessor: (e) => e.status, sortable: true, cardMeta: true, cell: (e) => <StatusBadge status={e.status} overrides={ENROLL_STATUS_TONES} label={enrollmentStatusLabel(t, e.status)} /> },
              { key: 'completed', header: t('learning.colCompleted'), accessor: (e) => e.completedAt, sortable: true, searchable: false, cell: (e) => fmtDate(e.completedAt) },
              { key: 'expires', header: t('learning.colExpires'), accessor: (e) => e.expiresAt, sortable: true, searchable: false, cardMeta: true, cell: (e) => fmtDate(e.expiresAt) },
              { key: 'score', header: t('learning.colScore'), accessor: (e) => e.score, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (e) => e.score ?? '—' },
              {
                  key: 'actions',
                  header: t('learning.colActions'),
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                className: 'space-x-2',
                cell: (e) => (
                  <>
                    {(e.status === 'ASSIGNED' || e.status === 'IN_PROGRESS') && (
                      <Button size="sm" onClick={() => onComplete(e.id)}>
                        {t('learning.complete')}
                      </Button>
                    )}
                    {canManage && (e.status === 'ASSIGNED' || e.status === 'IN_PROGRESS') && (
                      <Button size="sm" variant="ghost" onClick={() => onWaive(e.id)}>
                        {t('learning.waive')}
                      </Button>
                    )}
                  </>
                ),
              },
            ]}
          />
        )}
      </CardContent>
      <ConfirmDialog
        open={completeId !== null}
        onOpenChange={(o) => !o && setCompleteId(null)}
        title={t('learning.markComplete')}
        description={t('learning.markCompleteDesc')}
        confirmLabel={t('learning.markComplete')}
        numericInput
        numericLabel={t('learning.scoreLabel')}
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
            toast.success(t('learning.markedComplete'));
            setCompleteId(null);
            refresh();
          } catch (err) {
            toast.error(
              err instanceof ApiError ? err.message : t('learning.markCompleteFailed'),
            );
          } finally {
            setCompleting(false);
          }
        }}
      />
      <ConfirmDialog
        open={waiveId !== null}
        onOpenChange={(o) => !o && setWaiveId(null)}
        title={t('learning.waiveTitle')}
        description={t('learning.waiveDesc')}
        confirmLabel={t('learning.waive')}
        destructive
        busy={waiving}
        onConfirm={async () => {
          if (!waiveId) return;
          setWaiving(true);
          try {
            await waiveEnrollment(waiveId);
            toast.success(t('learning.waivedToast'));
            setWaiveId(null);
            refresh();
          } catch (err) {
            toast.error(
              err instanceof ApiError ? err.message : t('learning.waiveFailed'),
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
  const { t } = useI18n();
  const term = useTerm();
  const [days, setDays] = useState<number>(30);

  const expiringQuery = useQuery({
    queryKey: ['learning', 'expiring', days],
    queryFn: () => listExpiring(days),
  });
  const rows: ExpiringEnrollment[] | null = expiringQuery.data?.expiring ?? null;
  const error = expiringQuery.error
    ? expiringQuery.error instanceof ApiError
      ? expiringQuery.error.message
      : t('learning.expiringFailed')
    : null;
  const refresh = async () => {
    await expiringQuery.refetch();
  };

  const exportCsv = () => {
    downloadCsv(`expiring-${days}d-${ymdLocal()}.csv`, [
      [t('learning.colCourse'), term('worker'), t('lrn.required'), t('learning.colExpires'), t('learning.colDaysLeft')],
      ...(rows ?? []).map((e) => [
        e.courseTitle,
        e.associateName,
        e.isRequired ? t('me.yes') : t('me.no'),
        fmtDate(e.expiresAt),
        e.daysLeft,
      ]),
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-silver">{t('learning.window')}</span>
        <SegmentedControl<number>
          ariaLabel={t('learning.windowAria')}
          value={days}
          onChange={setDays}
          options={EXPIRING_WINDOWS.map((w) => ({
            value: w,
            label: t('learning.nDays', { n: w }),
          }))}
        />
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          onClick={exportCsv}
          disabled={!rows || rows.length === 0}
        >
          {t('learning.exportCsv')}
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
              title={t('learning.noExpiring')}
              description={t('learning.noExpiringDesc')}
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="course-expirations"
              caption={t('learning.expiringCaption')}
              rows={rows}
              rowKey={(e) => e.id}
              search={{ placeholder: t('learning.expiringSearch') }}
              urlState={false}
              exportCsv={{ filename: 'expiring-certifications' }}
              columns={[
                { key: 'course', header: t('learning.colCourse'), accessor: (e) => e.courseTitle, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'associate', header: term('worker'), accessor: (e) => e.associateName, sortable: true, cardMeta: true },
                { key: 'required', header: t('lrn.required'), accessor: (e) => (e.isRequired ? t('lrn.required') : ''), sortable: true, searchable: false, cell: (e) => (e.isRequired ? <Badge variant="destructive">{t('lrn.required')}</Badge> : '—') },
                { key: 'expires', header: t('learning.colExpires'), accessor: (e) => e.expiresAt, sortable: true, searchable: false, cardMeta: true, cell: (e) => fmtDate(e.expiresAt) },
                { key: 'daysLeft', header: t('learning.colDaysLeft'), accessor: (e) => e.daysLeft, csv: (e) => t('learning.daysShort', { n: e.daysLeft }), sortable: true, searchable: false, cardMeta: true, cell: (e) => <Badge variant={e.daysLeft <= 7 ? 'destructive' : 'pending'}>{t('learning.daysShort', { n: e.daysLeft })}</Badge> },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
