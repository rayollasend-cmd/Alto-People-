import { useEffect, useState } from 'react';
import { Briefcase, MapPin, Send, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  applyToInternalJob,
  decideApplication,
  listApplicationsForJob,
  listInternalJobs,
  listMyApplications,
  STATUS_LABELS,
  withdrawApplication,
  type ApplicationDetail,
  type InternalApplicationStatus,
  type JobRow,
  type MyApplicationRow,
} from '@/lib/internalMobility120Api';
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
  PageHeader,
  SkeletonRows,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const STATUS_VARIANT: Record<
  InternalApplicationStatus,
  'pending' | 'accent' | 'success' | 'destructive' | 'outline'
> = {
  SUBMITTED: 'pending',
  UNDER_REVIEW: 'pending',
  INTERVIEWING: 'accent',
  OFFERED: 'accent',
  HIRED: 'success',
  REJECTED: 'destructive',
  WITHDRAWN: 'outline',
};

export function InternalJobsHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:recruiting') : false;
  const [tab, setTab] = useState<'browse' | 'mine'>('browse');
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [mine, setMine] = useState<MyApplicationRow[] | null>(null);
  const [applyJob, setApplyJob] = useState<JobRow | null>(null);
  const [reviewJob, setReviewJob] = useState<JobRow | null>(null);

  const refresh = () => {
    setJobs(null);
    listInternalJobs()
      .then((r) => setJobs(r.jobs))
      .catch(() => setJobs([]));
    if (tab === 'mine') {
      setMine(null);
      listMyApplications()
        .then((r) => setMine(r.applications))
        .catch(() => setMine([]));
    }
  };
  useEffect(() => {
    refresh();
  }, [tab]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Internal jobs"
        subtitle="Open roles across the company. Apply directly — your manager and the hiring manager will see it."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Internal jobs' }]}
      />

      <div className="flex gap-1">
        <Button
          size="sm"
          variant={tab === 'browse' ? 'primary' : 'ghost'}
          onClick={() => setTab('browse')}
        >
          Browse
        </Button>
        <Button
          size="sm"
          variant={tab === 'mine' ? 'primary' : 'ghost'}
          onClick={() => setTab('mine')}
        >
          My applications
        </Button>
      </div>

      {tab === 'browse' ? (
        jobs === null ? (
          <Card>
            <CardContent className="p-6">
              <SkeletonRows count={4} />
            </CardContent>
          </Card>
        ) : jobs.length === 0 ? (
          <Card>
            <CardContent className="p-0">
              <EmptyState
                icon={Briefcase}
                title="No open positions"
                description="Check back — internal openings are posted here as roles open up."
              />
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {jobs.map((j) => (
              <Card key={j.id}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-base font-semibold text-white">
                        {j.title}
                      </div>
                      {j.clientName && (
                        <div className="text-xs text-silver">{j.clientName}</div>
                      )}
                    </div>
                    {j.myApplication ? (
                      <Badge variant={STATUS_VARIANT[j.myApplication.status]}>
                        {STATUS_LABELS[j.myApplication.status]}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{j.applicantCount} applied</Badge>
                    )}
                  </div>
                  <div className="text-sm text-silver flex items-center gap-3 flex-wrap">
                    {j.location && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" /> {j.location}
                      </span>
                    )}
                    {j.minSalary && j.maxSalary && (
                      <span>
                        {j.currency} {j.minSalary}–{j.maxSalary}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-white line-clamp-3">
                    {j.description}
                  </div>
                  <div className="flex gap-2 pt-2">
                    {j.myApplication ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          j.myApplication.status === 'WITHDRAWN' ||
                          j.myApplication.status === 'HIRED' ||
                          j.myApplication.status === 'REJECTED'
                        }
                        onClick={async () => {
                          if (!j.myApplication) return;
                          if (!(await confirm({ title: 'Withdraw your application?', destructive: true }))) return;
                          try {
                            await withdrawApplication(j.myApplication.id);
                            toast.success('Withdrawn.');
                            refresh();
                          } catch (err) {
                            toast.error(
                              err instanceof ApiError ? err.message : 'Failed.',
                            );
                          }
                        }}
                      >
                        Withdraw
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => setApplyJob(j)}>
                        <Send className="mr-1 h-3 w-3" /> Apply
                      </Button>
                    )}
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setReviewJob(j)}
                      >
                        <Users className="mr-1 h-3 w-3" />
                        Review {j.applicantCount}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      ) : mine === null ? (
        <Card>
          <CardContent className="p-6">
            <SkeletonRows count={3} />
          </CardContent>
        </Card>
      ) : mine.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Send}
              title="No applications yet"
              description="Switch to Browse to find a role and apply."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {mine.map((a) => (
            <Card key={a.id}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-sm font-medium text-white">
                    {a.posting.title}
                  </div>
                  <div className="text-xs text-silver">
                    Applied {new Date(a.createdAt).toLocaleDateString()}
                    {a.posting.location && ` · ${a.posting.location}`}
                  </div>
                </div>
                <Badge variant={STATUS_VARIANT[a.status]}>
                  {STATUS_LABELS[a.status]}
                </Badge>
                {a.status !== 'WITHDRAWN' &&
                  a.status !== 'HIRED' &&
                  a.status !== 'REJECTED' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (!(await confirm({ title: 'Withdraw your application?', destructive: true }))) return;
                        try {
                          await withdrawApplication(a.id);
                          toast.success('Withdrawn.');
                          refresh();
                        } catch (err) {
                          toast.error(
                            err instanceof ApiError ? err.message : 'Failed.',
                          );
                        }
                      }}
                    >
                      Withdraw
                    </Button>
                  )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {applyJob && (
        <ApplyDrawer
          job={applyJob}
          onClose={() => setApplyJob(null)}
          onSaved={() => {
            setApplyJob(null);
            refresh();
          }}
        />
      )}
      {reviewJob && (
        <ReviewDrawer
          job={reviewJob}
          onClose={() => setReviewJob(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function ApplyDrawer({
  job,
  onClose,
  onSaved,
}: {
  job: JobRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [coverLetter, setCoverLetter] = useState('');
  const [resumeUrl, setResumeUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await applyToInternalJob(job.id, {
        coverLetter: coverLetter.trim() || null,
        resumeUrl: resumeUrl.trim() || null,
      });
      toast.success('Applied.');
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
        <DrawerTitle>Apply — {job.title}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {job.location && (
          <div className="text-sm text-silver flex items-center gap-1">
            <MapPin className="h-3 w-3" /> {job.location}
          </div>
        )}
        <div className="text-sm text-white whitespace-pre-wrap">
          {job.description}
        </div>
        <div>
          <Label>Cover letter (optional)</Label>
          <textarea
            className="mt-1 w-full h-32 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
            value={coverLetter}
            onChange={(e) => setCoverLetter(e.target.value)}
            placeholder="Why this role, what you bring…"
          />
        </div>
        <div>
          <Label>Resume URL (optional)</Label>
          <input
            type="url"
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
            value={resumeUrl}
            onChange={(e) => setResumeUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Submitting…' : 'Submit application'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function ReviewDrawer({
  job,
  onClose,
  onChanged,
}: {
  job: JobRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [apps, setApps] = useState<ApplicationDetail[] | null>(null);

  const refresh = () => {
    setApps(null);
    listApplicationsForJob(job.id)
      .then((r) => setApps(r.applications))
      .catch(() => setApps([]));
  };
  useEffect(() => {
    refresh();
  }, [job.id]);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Applicants — {job.title}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-3">
        {apps === null ? (
          <SkeletonRows count={3} />
        ) : apps.length === 0 ? (
          <div className="text-sm text-silver">No applicants yet.</div>
        ) : (
          apps.map((a) => (
            <Card key={a.id}>
              <CardContent className="p-3 space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-sm font-medium text-white">
                      {a.associateName}
                    </div>
                    <div className="text-xs text-silver">
                      {a.currentTitle ?? a.associateEmail}
                      {a.currentDepartment && ` · ${a.currentDepartment}`}
                    </div>
                  </div>
                  <select
                    className="text-xs bg-midnight border border-navy-secondary rounded p-1 text-white"
                    value={a.status}
                    onChange={async (e) => {
                      try {
                        await decideApplication(a.id, {
                          status: e.target.value as InternalApplicationStatus,
                        });
                        refresh();
                        onChanged();
                      } catch (err) {
                        toast.error(
                          err instanceof ApiError ? err.message : 'Failed.',
                        );
                      }
                    }}
                  >
                    {(Object.keys(STATUS_LABELS) as InternalApplicationStatus[]).map(
                      (s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </option>
                      ),
                    )}
                  </select>
                </div>
                {a.coverLetter && (
                  <div className="text-xs text-silver italic line-clamp-3">
                    {a.coverLetter}
                  </div>
                )}
                {a.resumeUrl && (
                  <a
                    href={a.resumeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-300 hover:underline"
                  >
                    Resume ↗
                  </a>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
