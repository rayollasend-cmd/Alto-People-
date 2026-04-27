import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, GraduationCap, Plus } from 'lucide-react';
import { ApiError } from '@/lib/api';
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
  type Enrollment,
  type EnrollmentStatus,
  type ExpiringEnrollment,
} from '@/lib/lms94Api';
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
  Textarea,
} from '@/components/ui';
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

const COURSE_BADGE: Record<Course['status'], 'pending' | 'success' | 'default'> = {
  DRAFT: 'pending',
  PUBLISHED: 'success',
  ARCHIVED: 'default',
};

function CoursesTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Course[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [enrollFor, setEnrollFor] = useState<Course | null>(null);

  const refresh = () => {
    setRows(null);
    listCourses()
      .then((r) => setRows(r.courses))
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
            <Plus className="mr-2 h-4 w-4" /> New course
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No courses"
              description="Build a course catalog with required and optional training."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead>Validity</TableHead>
                  <TableHead>Modules</TableHead>
                  <TableHead>Enrolled</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id} className="group">
                    <TableCell className="font-medium text-white">{c.title}</TableCell>
                    <TableCell>
                      {c.isRequired ? <Badge variant="destructive">Required</Badge> : '—'}
                    </TableCell>
                    <TableCell>
                      {c.validityDays ? `${c.validityDays}d` : 'Never expires'}
                    </TableCell>
                    <TableCell>{c.moduleCount}</TableCell>
                    <TableCell>{c.enrollmentCount}</TableCell>
                    <TableCell>
                      <Badge variant={COURSE_BADGE[c.status]}>{c.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && c.status === 'DRAFT' && (
                        <Button
                          size="sm"
                          onClick={async () => {
                            await publishCourse(c.id);
                            refresh();
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
                              await archiveCourse(c.id);
                              refresh();
                            }}
                          >
                            Archive
                          </Button>
                        </>
                      )}
                      {canManage && (
                        <button
                          onClick={async () => {
                            if (!window.confirm('Delete this course?')) return;
                            try {
                              await deleteCourse(c.id);
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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
            type="checkbox"
            checked={isRequired}
            onChange={(e) => setIsRequired(e.target.checked)}
          />
          <Label>Required for compliance</Label>
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
  const [ids, setIds] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    const associateIds = ids
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (associateIds.length === 0) {
      toast.error('Paste at least one associate ID.');
      return;
    }
    setSaving(true);
    try {
      const r = await enrollAssociates(course.id, associateIds);
      toast.success(`Enrolled ${r.created}, skipped ${r.skipped}.`);
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
        <DrawerTitle>Enroll into "{course.title}"</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate IDs</Label>
          <Textarea
            className="mt-1 min-h-32 font-mono text-xs"
            value={ids}
            onChange={(e) => setIds(e.target.value)}
            placeholder="UUID per line, comma-separated, or whitespace-separated."
          />
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

const ENROLL_BADGE: Record<EnrollmentStatus, 'pending' | 'accent' | 'success' | 'destructive' | 'default'> = {
  ASSIGNED: 'pending',
  IN_PROGRESS: 'accent',
  COMPLETED: 'success',
  EXPIRED: 'destructive',
  WAIVED: 'default',
};

function EnrollmentsTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Enrollment[] | null>(null);

  const refresh = () => {
    setRows(null);
    listEnrollments()
      .then((r) => setRows(r.enrollments))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onComplete = async (id: string) => {
    const score = window.prompt('Score (0-100, optional)?');
    try {
      await completeEnrollment(id, score ? Number(score) : undefined);
      toast.success('Marked complete.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onWaive = async (id: string) => {
    if (!window.confirm('Waive this enrollment?')) return;
    try {
      await waiveEnrollment(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <Card>
      <CardContent className="p-0">
        {rows === null ? (
          <div className="p-6"><SkeletonRows count={3} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={GraduationCap}
            title="No enrollments"
            description="Assign associates to a course from the Courses tab."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead>Associate</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Score</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium text-white">{e.courseTitle}</TableCell>
                  <TableCell>{e.associateName}</TableCell>
                  <TableCell>
                    <Badge variant={ENROLL_BADGE[e.status]}>{e.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {e.completedAt
                      ? new Date(e.completedAt).toLocaleDateString()
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {e.expiresAt ? new Date(e.expiresAt).toLocaleDateString() : '—'}
                  </TableCell>
                  <TableCell>{e.score ?? '—'}</TableCell>
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
    </Card>
  );
}

function ExpiringTab() {
  const [days, setDays] = useState('30');
  const [rows, setRows] = useState<ExpiringEnrollment[] | null>(null);

  const refresh = async () => {
    setRows(null);
    try {
      const r = await listExpiring(Number(days));
      setRows(r.expiring);
    } catch {
      setRows([]);
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div>
          <Label>Window (days)</Label>
          <Input
            type="number"
            className="mt-1 w-28"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </div>
        <Button onClick={refresh}>Refresh</Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
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
                  <TableHead>Required</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Days left</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium text-white">
                      {e.courseTitle}
                    </TableCell>
                    <TableCell>{e.associateName}</TableCell>
                    <TableCell>
                      {e.isRequired ? <Badge variant="destructive">Required</Badge> : '—'}
                    </TableCell>
                    <TableCell>{new Date(e.expiresAt).toLocaleDateString()}</TableCell>
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
