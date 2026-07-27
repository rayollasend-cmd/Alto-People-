import { useEffect, useMemo, useState } from 'react';
import { Briefcase, MapPin, Send, Users } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/cn';
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
  ConfirmDialog,
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
  SearchInput,
  SegmentedControl,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { fmtDate, fmtMoney } from '@/lib/format';

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

/** The my-applications DTO may carry the last status-change stamp
 *  (server sets reviewedAt on every manager decision). */
type MyApplicationWithReview = MyApplicationRow & { reviewedAt?: string | null };

/** Inline load-failure affordance: real error + Retry, never a fake empty. */
function LoadErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="p-6">
      <ErrorBanner>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{message}</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </ErrorBanner>
    </div>
  );
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function InternalJobsHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:recruiting') : false;
  const [tab, setTab] = useState<'browse' | 'mine'>('browse');
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [mine, setMine] = useState<MyApplicationWithReview[] | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [applyJob, setApplyJob] = useState<JobRow | null>(null);
  const [reviewJob, setReviewJob] = useState<JobRow | null>(null);
  const [search, setSearch] = useState('');
  const [locationFilter, setLocationFilter] = useState<string | null>(null);

  const refresh = () => {
    setJobs(null);
    setJobsError(null);
    listInternalJobs()
      .then((r) => setJobs(r.jobs))
      .catch((err) => setJobsError(errMessage(err, 'Failed to load open positions.')));
    if (tab === 'mine') {
      setMine(null);
      setMineError(null);
      listMyApplications()
        .then((r) => setMine(r.applications))
        .catch((err) =>
          setMineError(errMessage(err, 'Failed to load your applications.')),
        );
    }
  };
  useEffect(() => {
    refresh();
  }, [tab]);

  // Distinct locations across open jobs power the filter chips.
  const locations = useMemo(() => {
    if (!jobs) return [];
    return Array.from(
      new Set(jobs.map((j) => j.location).filter((l): l is string => Boolean(l))),
    ).sort((a, b) => a.localeCompare(b));
  }, [jobs]);

  const visibleJobs = useMemo(() => {
    if (!jobs) return null;
    const q = search.trim().toLowerCase();
    return jobs.filter((j) => {
      if (locationFilter && j.location !== locationFilter) return false;
      if (!q) return true;
      return (
        j.title.toLowerCase().includes(q) ||
        (j.location ?? '').toLowerCase().includes(q) ||
        (j.clientName ?? '').toLowerCase().includes(q)
      );
    });
  }, [jobs, search, locationFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Internal jobs"
        subtitle="Open roles across the company. Apply directly — your manager and the hiring manager will see it."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Internal jobs' }]}
      />

      <SegmentedControl<'browse' | 'mine'>
        ariaLabel="Internal jobs view"
        options={[
          { value: 'browse', label: 'Browse' },
          { value: 'mine', label: 'My applications' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'browse' ? (
        <div className="space-y-3">
          <FilterBar>
            <div className="w-full sm:w-72">
              <SearchInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search title, client, or location…"
                aria-label="Search internal jobs"
              />
            </div>
            {locations.length > 0 && (
              <>
                <FilterChip
                  active={locationFilter === null}
                  onClick={() => setLocationFilter(null)}
                >
                  All locations
                </FilterChip>
                {locations.map((l) => (
                  <FilterChip
                    key={l}
                    active={locationFilter === l}
                    onClick={() =>
                      setLocationFilter(locationFilter === l ? null : l)
                    }
                  >
                    {l}
                  </FilterChip>
                ))}
              </>
            )}
          </FilterBar>
          {jobsError ? (
            <Card>
              <CardContent className="p-0">
                <LoadErrorState message={jobsError} onRetry={refresh} />
              </CardContent>
            </Card>
          ) : visibleJobs === null ? (
            <Card>
              <CardContent className="p-6">
                <SkeletonRows count={4} />
              </CardContent>
            </Card>
          ) : visibleJobs.length === 0 ? (
            <Card>
              <CardContent className="p-0">
                <EmptyState
                  icon={Briefcase}
                  title={
                    search.trim() || locationFilter
                      ? 'No positions match your filters'
                      : 'No open positions'
                  }
                  description={
                    search.trim() || locationFilter
                      ? 'Try a different search or clear the location filter.'
                      : 'Check back — internal openings are posted here as roles open up.'
                  }
                  action={
                    search.trim() || locationFilter ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setSearch('');
                          setLocationFilter(null);
                        }}
                      >
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              </CardContent>
            </Card>
          ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visibleJobs.map((j) => (
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
                        {fmtMoney(j.minSalary, { currency: j.currency })}–
                        {fmtMoney(j.maxSalary, { currency: j.currency })}
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
          )}
        </div>
      ) : mineError ? (
        <Card>
          <CardContent className="p-0">
            <LoadErrorState message={mineError} onRetry={refresh} />
          </CardContent>
        </Card>
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
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-white">
                      {a.posting.title}
                    </div>
                    <div className="text-xs text-silver">
                      Applied {fmtDate(a.createdAt)}
                      {a.posting.location && ` · ${a.posting.location}`}
                      {a.reviewedAt && ` · Status updated ${fmtDate(a.reviewedAt)}`}
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
                </div>
                {a.reviewerNotes && (
                  <div
                    className={cn(
                      'mt-3 rounded-md border px-3 py-2 text-xs text-silver',
                      a.status === 'REJECTED'
                        ? 'border-alert/30 bg-alert/10'
                        : 'border-navy-secondary bg-navy-secondary/30',
                    )}
                  >
                    <span className="font-medium text-white">
                      Note from the hiring manager:
                    </span>{' '}
                    {a.reviewerNotes}
                  </div>
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

/** localStorage key for the per-posting cover-letter draft. */
const coverDraftKey = (postingId: string) =>
  `alto:internal-job-cover-draft:${postingId}`;

function ApplyDrawer({
  job,
  onClose,
  onSaved,
}: {
  job: JobRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Draft survives an accidental drawer close / navigation: restored on
  // reopen, kept per posting id, cleared on successful submit.
  const [coverLetter, setCoverLetter] = useState(() => {
    try {
      return localStorage.getItem(coverDraftKey(job.id)) ?? '';
    } catch {
      return '';
    }
  });
  const [resumeUrl, setResumeUrl] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    try {
      if (coverLetter) localStorage.setItem(coverDraftKey(job.id), coverLetter);
      else localStorage.removeItem(coverDraftKey(job.id));
    } catch {
      // Storage unavailable (private mode / quota) — drafts just don't persist.
    }
  }, [coverLetter, job.id]);

  const submit = async () => {
    setSaving(true);
    try {
      await applyToInternalJob(job.id, {
        coverLetter: coverLetter.trim() || null,
        resumeUrl: resumeUrl.trim() || null,
      });
      try {
        localStorage.removeItem(coverDraftKey(job.id));
      } catch {
        // Best-effort cleanup.
      }
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
          <Textarea
            className="mt-1 h-32"
            value={coverLetter}
            onChange={(e) => setCoverLetter(e.target.value)}
            placeholder="Why this role, what you bring…"
          />
        </div>
        <div>
          <Label>Resume URL (optional)</Label>
          <Input
            type="url"
            className="mt-1"
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
  const [error, setError] = useState<string | null>(null);
  // REJECTED is destructive from the applicant's side, so it routes
  // through a confirm with an optional reviewer note; other statuses
  // apply immediately.
  const [rejectTarget, setRejectTarget] = useState<ApplicationDetail | null>(null);
  const [deciding, setDeciding] = useState(false);

  const refresh = () => {
    setApps(null);
    setError(null);
    listApplicationsForJob(job.id)
      .then((r) => setApps(r.applications))
      .catch((err) => setError(errMessage(err, 'Failed to load applicants.')));
  };
  useEffect(() => {
    refresh();
  }, [job.id]);

  const applyStatus = async (
    id: string,
    status: InternalApplicationStatus,
    reviewerNotes?: string | null,
  ) => {
    setDeciding(true);
    try {
      await decideApplication(id, {
        status,
        ...(reviewerNotes !== undefined ? { reviewerNotes } : {}),
      });
      toast.success(`Status updated to ${STATUS_LABELS[status]}.`);
      setRejectTarget(null);
      refresh();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setDeciding(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Applicants — {job.title}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-3">
        {error ? (
          <LoadErrorState message={error} onRetry={refresh} />
        ) : apps === null ? (
          <SkeletonRows count={3} />
        ) : apps.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No applicants yet"
            description="Associates who apply to this posting will show up here."
          />
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
                  <Select
                    size="sm"
                    value={a.status}
                    disabled={deciding}
                    onChange={(e) => {
                      const next = e.target.value as InternalApplicationStatus;
                      if (next === a.status) return;
                      if (next === 'REJECTED') {
                        setRejectTarget(a);
                        return;
                      }
                      void applyStatus(a.id, next);
                    }}
                  >
                    {(Object.keys(STATUS_LABELS) as InternalApplicationStatus[]).map(
                      (s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </option>
                      ),
                    )}
                  </Select>
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
                    className="text-xs text-steel hover:underline"
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
      <ConfirmDialog
        open={rejectTarget !== null}
        onOpenChange={(o) => !o && setRejectTarget(null)}
        title={
          rejectTarget
            ? `Reject ${rejectTarget.associateName}'s application?`
            : 'Reject application'
        }
        description="They'll be notified that their internal application was not selected."
        confirmLabel="Reject application"
        destructive
        requireReason="optional"
        reasonLabel="Reason (optional)"
        reasonPlaceholder="e.g., Another applicant was a closer fit for this role."
        busy={deciding}
        onConfirm={(reason) => {
          if (!rejectTarget) return;
          void applyStatus(rejectTarget.id, 'REJECTED', reason.trim() || null);
        }}
      />
    </Drawer>
  );
}
