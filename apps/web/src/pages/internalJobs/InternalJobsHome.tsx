import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { safeHref } from '@alto-people/shared';
import { Briefcase, MapPin, Plus, Send, Users } from '@/components/ui/icons';
import { Link } from 'react-router-dom';
import { useUrlParam } from '@/lib/useUrlState';
import { toast } from 'sonner';
import { cn } from '@/lib/cn';
import { ApiError } from '@/lib/api';
import {
  applyToInternalJob,
  decideApplication,
  listApplicationsForJob,
  listInternalJobs,
  listMyApplications,
  withdrawApplication,
  type ApplicationDetail,
  type InternalApplicationStatus,
  type JobRow,
  type MyApplicationRow,
} from '@/lib/internalMobility120Api';
import { useAuth, useTenant } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import { statusTone } from '@/lib/status';
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
  FilterBar,
  FilterChip,
  Input,
  SearchInput,
  SegmentedControl,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { ListTemplate } from '@/components/templates';
import { fmtDate, fmtMoney } from '@/lib/format';
import { QueryError } from '@/components/ui/QueryError';
import { useI18n, type MessageKey, type Translate } from '@/lib/i18n';
import '@/lib/i18n/en/ijobs';

/** An application's status in the reader's language (ASSOC-12: the page was English in every language). */
const STATUS_KEY: Record<InternalApplicationStatus, MessageKey> = {
  SUBMITTED: 'ijobs.status.SUBMITTED',
  UNDER_REVIEW: 'ijobs.status.UNDER_REVIEW',
  INTERVIEWING: 'ijobs.status.INTERVIEWING',
  OFFERED: 'ijobs.status.OFFERED',
  HIRED: 'ijobs.status.HIRED',
  REJECTED: 'ijobs.status.REJECTED',
  WITHDRAWN: 'ijobs.status.WITHDRAWN',
};
const statusLabel = (t: Translate, s: InternalApplicationStatus) => t(STATUS_KEY[s]);

// Domain-only codes the shared vocabulary doesn't carry: UNDER_REVIEW is a
// wait state; an OFFERED application is in-flight awaiting the associate's
// decision (gold). The rest come from the shared status vocabulary.
const INTERNAL_APP_STATUS_TONES = {
  UNDER_REVIEW: 'pending',
  OFFERED: 'accent',
} as const;

/** The my-applications DTO may carry the last status-change stamp
 *  (server sets reviewedAt on every manager decision). */
type MyApplicationWithReview = MyApplicationRow & { reviewedAt?: string | null };

/** Inline load-failure affordance: the failure in plain words + Retry, never a fake empty. */
function LoadErrorState({ what, query }: { what: string; query: { error: unknown; refetch: () => unknown; isFetching?: boolean } }) {
  return (
    <div className="p-6">
      <QueryError what={what} query={query} />
    </div>
  );
}

const JOB_TABS = ['browse', 'mine'] as const;

export function InternalJobsHome() {
  const { t } = useI18n();
  const { user } = useAuth();
  // Brief 2-1b: a tenant with no clients is not offered a client to search by.
  const hasClients = useTenant().moduleOn('clientPortal');
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:recruiting') : false;
  const [tab, setTab] = useUrlParam<'browse' | 'mine'>('tab', 'browse', JOB_TABS, { history: 'push' });
  const [applyJob, setApplyJob] = useState<JobRow | null>(null);
  const [reviewJob, setReviewJob] = useState<JobRow | null>(null);
  const [search, setSearch] = useState('');
  const [locationParam, setLocationParam] = useUrlParam<string>('location', '');
  const locationFilter = locationParam || null;
  const setLocationFilter = (l: string | null) => setLocationParam(l ?? '');
  // One in-flight action at a time — a double-click on Withdraw used to
  // fire the write twice.
  const [actionKey, setActionKey] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<void>) => {
    if (actionKey) return;
    setActionKey(key);
    try {
      await fn();
    } finally {
      setActionKey(null);
    }
  };

  const jobsQuery = useQuery({
    queryKey: ['InternalJobsHome', 'jobs'],
    queryFn: () => listInternalJobs(),
  });
  const mineQuery = useQuery({
    queryKey: ['InternalJobsHome', 'mine'],
    queryFn: () => listMyApplications(),
    enabled: tab === 'mine',
  });
  const jobs: JobRow[] | null = jobsQuery.data?.jobs ?? null;
  const jobsError = jobsQuery.isError;
  const mine: MyApplicationWithReview[] | null = mineQuery.data?.applications ?? null;
  const mineError = mineQuery.isError;
  // Applying or withdrawing changes both the job counts and "mine", so
  // invalidate the pair: the visible reads refresh now, the hidden tab
  // when it next opens.
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['InternalJobsHome'] });

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
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title={t('ijobs.title')}
        subtitle={t('ijobs.subtitle')}
        // Whoever posts the jobs gets the way there; navigation, not a button.
        related={canManage ? [{ label: t('ijobs.manage'), to: '/recruiting/extras?tab=postings' }] : undefined}
    >

      <SegmentedControl<'browse' | 'mine'>
        ariaLabel={t('ijobs.viewAria')}
        options={[
          { value: 'browse', label: t('ijobs.browse') },
          { value: 'mine', label: t('ijobs.mine') },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'browse' ? (
        <div className="space-y-3">
          <FilterBar
            bare
            search={
              <div className="w-full sm:w-72">
                <SearchInput
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={hasClients ? t('ijobs.searchClients') : t('ijobs.search')}
                  aria-label={t('ijobs.searchAria')}
                />
              </div>
            }
          >
            {locations.length > 1 && (
              <>
                <FilterChip
                  active={locationFilter === null}
                  onClick={() => setLocationFilter(null)}
                >
                  {t('ijobs.allLocations')}
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
                <LoadErrorState what={t('ijobs.what')} query={jobsQuery} />
              </CardContent>
            </Card>
          ) : visibleJobs === null ? (
            <Card>
              <CardContent>
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
                      ? t('ijobs.noMatchTitle')
                      : t('ijobs.noneTitle')
                  }
                  description={
                    search.trim() || locationFilter
                      ? t('ijobs.noMatchDesc')
                      : canManage
                        ? t('ijobs.noneDescManage')
                        : t('ijobs.noneDesc')
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
                        {t('ijobs.clearFilters')}
                      </Button>
                    ) : canManage ? (
                      <Button asChild>
                        <Link to="/recruiting/extras?tab=postings&new=1">
                          <Plus className="mr-2 h-4 w-4" /> {t('ijobs.postJob')}
                        </Link>
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
                <CardContent className="space-y-2">
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
                      <Badge variant={statusTone(j.myApplication.status, { overrides: INTERNAL_APP_STATUS_TONES })}>
                        {statusLabel(t, j.myApplication.status)}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{t('ijobs.applied', { count: j.applicantCount })}</Badge>
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
                        loading={actionKey === `withdraw-${j.myApplication.id}`}
                        disabled={
                          actionKey !== null ||
                          j.myApplication.status === 'WITHDRAWN' ||
                          j.myApplication.status === 'HIRED' ||
                          j.myApplication.status === 'REJECTED'
                        }
                        onClick={async () => {
                          if (!j.myApplication) return;
                          const appId = j.myApplication.id;
                          if (!(await confirm({ title: t('ijobs.withdrawConfirm'), destructive: true }))) return;
                          await act(`withdraw-${appId}`, async () => {
                            try {
                              await withdrawApplication(appId);
                              toast.success(t('ijobs.withdrawn'));
                              refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof ApiError ? err.message : t('ijobs.failed'),
                              );
                            }
                          });
                        }}
                      >
                        {t('ijobs.withdraw')}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => setApplyJob(j)}>
                        <Send className="mr-1 h-3 w-3" /> {t('ijobs.apply')}
                      </Button>
                    )}
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setReviewJob(j)}
                      >
                        <Users className="mr-1 h-3 w-3" />
                        {t('ijobs.review', { count: j.applicantCount })}
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
            <LoadErrorState what={t('ijobs.whatMine')} query={mineQuery} />
          </CardContent>
        </Card>
      ) : mine === null ? (
        <Card>
          <CardContent>
            <SkeletonRows count={3} />
          </CardContent>
        </Card>
      ) : mine.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Send}
              title={t('ijobs.noAppsTitle')}
              description={t('ijobs.noAppsDesc')}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {mine.map((a) => (
            <Card key={a.id}>
              <CardContent>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-white">
                      {a.posting.title}
                    </div>
                    <div className="text-xs text-silver">
                      {t('ijobs.appliedOn', { date: fmtDate(a.createdAt) })}
                      {a.posting.location && ` · ${a.posting.location}`}
                      {a.reviewedAt && ` · ${t('ijobs.statusUpdated', { date: fmtDate(a.reviewedAt) })}`}
                    </div>
                  </div>
                  <Badge variant={statusTone(a.status, { overrides: INTERNAL_APP_STATUS_TONES })}>
                    {statusLabel(t, a.status)}
                  </Badge>
                  {a.status !== 'WITHDRAWN' &&
                    a.status !== 'HIRED' &&
                    a.status !== 'REJECTED' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={actionKey === `withdraw-${a.id}`}
                        disabled={actionKey !== null}
                        onClick={async () => {
                          if (!(await confirm({ title: t('ijobs.withdrawConfirm'), destructive: true }))) return;
                          await act(`withdraw-${a.id}`, async () => {
                            try {
                              await withdrawApplication(a.id);
                              toast.success(t('ijobs.withdrawn'));
                              refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof ApiError ? err.message : t('ijobs.failed'),
                              );
                            }
                          });
                        }}
                      >
                        {t('ijobs.withdraw')}
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
                      {t('ijobs.noteFromManager')}
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
    </ListTemplate>
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
  const { t } = useI18n();
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
      // The server wants a full http(s) URL; people paste
      // "linkedin.com/in/me". Prefix the scheme instead of failing the
      // whole application on it.
      const trimmedResume = resumeUrl.trim();
      await applyToInternalJob(job.id, {
        coverLetter: coverLetter.trim() || null,
        resumeUrl: trimmedResume
          ? /^https?:\/\//i.test(trimmedResume)
            ? trimmedResume
            : `https://${trimmedResume}`
          : null,
      });
      try {
        localStorage.removeItem(coverDraftKey(job.id));
      } catch {
        // Best-effort cleanup.
      }
      toast.success(t('ijobs.sent'));
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('ijobs.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{t('ijobs.applyTitle', { title: job.title })}</DrawerTitle>
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
          <Label>{t('ijobs.cover')}</Label>
          <Textarea
            className="mt-1 h-32"
            value={coverLetter}
            onChange={(e) => setCoverLetter(e.target.value)}
            placeholder={t('ijobs.coverPlaceholder')}
          />
        </div>
        <div>
          <Label>{t('ijobs.resume')}</Label>
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
          {t('ijobs.cancel')}
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? t('ijobs.submitting') : t('ijobs.submit')}
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
  // REJECTED is destructive from the applicant's side, so it routes
  // through a confirm with an optional reviewer note; other statuses
  // apply immediately.
  const { t } = useI18n();
  const [rejectTarget, setRejectTarget] = useState<ApplicationDetail | null>(null);
  const [deciding, setDeciding] = useState(false);

  const refreshQuery = useQuery({
    queryKey: ['ReviewDrawer', 'apps', job.id],
    queryFn: () => listApplicationsForJob(job.id),
  });
  const apps: ApplicationDetail[] | null = refreshQuery.data?.applications ?? null;
  const error = refreshQuery.isError;
  const refresh = () => void refreshQuery.refetch();

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
      toast.success(t('ijobs.statusSet', { status: statusLabel(t, status) }));
      setRejectTarget(null);
      refresh();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('ijobs.failed'));
    } finally {
      setDeciding(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{t('ijobs.applicantsTitle', { title: job.title })}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-3">
        {error ? (
          <LoadErrorState what={t('ijobs.whatApplicants')} query={refreshQuery} />
        ) : apps === null ? (
          <SkeletonRows count={3} />
        ) : apps.length === 0 ? (
          <EmptyState
            icon={Users}
            title={t('ijobs.noApplicantsTitle')}
            description={t('ijobs.noApplicantsDesc')}
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
                    {(Object.keys(STATUS_KEY) as InternalApplicationStatus[]).map(
                      (s) => (
                        <option key={s} value={s}>
                          {statusLabel(t, s)}
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
                    href={safeHref(a.resumeUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-gold hover:underline"
                  >
                    {t('ijobs.resumeLink')}
                  </a>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>{t('ijobs.close')}</Button>
      </DrawerFooter>
      <ConfirmDialog
        open={rejectTarget !== null}
        onOpenChange={(o) => !o && setRejectTarget(null)}
        title={rejectTarget ? t('ijobs.rejectTitle', { name: rejectTarget.associateName }) : t('ijobs.reject')}
        description={t('ijobs.rejectDesc')}
        confirmLabel={t('ijobs.reject')}
        destructive
        requireReason="optional"
        reasonLabel={t('ijobs.reason')}
        reasonPlaceholder={t('ijobs.reasonPlaceholder')}
        busy={deciding}
        onConfirm={(reason) => {
          if (!rejectTarget) return;
          void applyStatus(rejectTarget.id, 'REJECTED', reason.trim() || null);
        }}
      />
    </Drawer>
  );
}
