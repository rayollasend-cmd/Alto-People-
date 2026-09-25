import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Award,
  Briefcase,
  CheckCircle2,
  Download,
  FileText,
  Kanban,
  Link2,
  Plus,
  Rows3,
  UserPlus,
  Users,
} from 'lucide-react';
import type { Candidate, CandidateHireResponse, CandidateStage } from '@alto-people/shared';
import { safeHref } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  advanceCandidate,
  createCandidate,
  listCandidates,
} from '@/lib/recruitingApi';
import { listOffers, type OfferRecord } from '@/lib/recruiting90Api';
import { NewApplicationDialog } from '@/pages/onboarding/NewApplicationDialog';
import { listPositions } from '@/lib/positionsApi';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, ymdLocal } from '@/lib/format';
import { useSelection } from '@/lib/useSelection';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { CandidateBoard } from './CandidateBoard';
import { CandidateDetailDrawer } from './CandidateDetailDrawer';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  SkeletonRows,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { ViewToggle } from '@/components/ui/ViewToggle';

const STAGES: CandidateStage[] = [
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'WITHDRAWN',
  'REJECTED',
];

const STAGE_LABEL: Record<CandidateStage, string> = {
  APPLIED: 'Applied',
  SCREENING: 'Screening',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  HIRED: 'Hired',
  WITHDRAWN: 'Withdrawn',
  REJECTED: 'Rejected',
};

const STAGE_VARIANT: Record<
  CandidateStage,
  'default' | 'success' | 'pending' | 'destructive' | 'accent' | 'outline'
> = {
  APPLIED: 'default',
  SCREENING: 'pending',
  INTERVIEW: 'accent',
  OFFER: 'accent',
  HIRED: 'success',
  WITHDRAWN: 'outline',
  REJECTED: 'destructive',
};

const NEXT_STAGE: Partial<Record<CandidateStage, CandidateStage>> = {
  APPLIED: 'SCREENING',
  SCREENING: 'INTERVIEW',
  INTERVIEW: 'OFFER',
};

/** Where candidates come from — the funnels HR actually tracks. */
const CANDIDATE_SOURCES = [
  'referral',
  'careers-page',
  'indeed',
  'linkedin',
  'walk-in',
  'agency',
  'other',
] as const;

/** Human labels for the stored source slugs. */
const SOURCE_LABEL: Record<string, string> = {
  referral: 'Referral',
  'careers-page': 'Careers page',
  indeed: 'Indeed',
  linkedin: 'LinkedIn',
  'walk-in': 'Walk-in',
  agency: 'Agency',
  other: 'Other',
  manual: 'Manual',
};

/** Whole days since an ISO timestamp; the days-in-stage badge reads the
 *  candidate's stageChangedAt. (It used to read createdAt — "days in
 *  stage" was really days since they applied.) */
function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/** Still in the funnel — the only candidates bulk advance/reject applies to. */
function isOpenStage(c: Candidate): boolean {
  return c.stage !== 'HIRED' && c.stage !== 'REJECTED' && c.stage !== 'WITHDRAWN';
}

type DialogState =
  | { kind: 'reject'; candidate: Candidate }
  | { kind: 'withdraw'; candidate: Candidate }
  | { kind: 'hire'; candidate: Candidate }
  | null;

type ViewMode = 'list' | 'board';
const VIEW_STORAGE_KEY = 'alto.recruiting.view';

function readViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'board';
  try {
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return v === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

function writeViewMode(v: ViewMode) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
  } catch {
    /* persistence is best-effort */
  }
}

export function RecruitingHome() {
  const { can } = useAuth();
  const canManage = can('manage:recruiting');
  const navigate = useNavigate();
  const [view, setView] = useState<ViewMode>(() => readViewMode());
  const [showCreate, setShowCreate] = useState(false);
  const [errorLocal, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);

  // Stage filter, search, and the open candidate drawer all live in the
  // URL (same source-of-truth pattern as ComplianceHome's ?tab= and the
  // People directory's ?associateId=), so refresh / back / share keep the
  // pipeline context instead of resetting to the default view.
  const [searchParams, setSearchParams] = useSearchParams();
  const stageParam = searchParams.get('stage');
  const filter: CandidateStage | 'ALL' =
    stageParam === 'ALL' || (STAGES as string[]).includes(stageParam ?? '')
      ? (stageParam as CandidateStage | 'ALL')
      : 'APPLIED';
  const search = searchParams.get('q') ?? '';
  // The candidate whose detail drawer is open. Held by id rather than by
  // value so a refresh after an advance re-renders the drawer with the new
  // stage instead of leaving a stale snapshot on screen.
  const detailId = searchParams.get('candidateId');

  const setFilter = useCallback(
    (s: CandidateStage | 'ALL') =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (s === 'APPLIED') next.delete('stage'); // default stage keeps the URL clean
        else next.set('stage', s);
        return next;
      }),
    [setSearchParams],
  );
  // replace: keystrokes shouldn't each become a Back-button stop.
  const setSearch = useCallback(
    (q: string) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (q) next.set('q', q);
          else next.delete('q');
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  // push (not replace): Back closes the drawer instead of leaving the page.
  const setDetailId = useCallback(
    (id: string | null) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('candidateId', id);
        else next.delete('candidateId');
        return next;
      }),
    [setSearchParams],
  );
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const setViewPersisted = useCallback((v: ViewMode) => {
    setView(v);
    writeViewMode(v);
  }, []);

  const refreshQuery = useQuery({
    queryKey: ['RecruitingHome', 'candidates', filter],
    queryFn: () => listCandidates(filter === 'ALL' ? {} : { stage: filter }),
  });
  const candidates: Candidate[] | null = refreshQuery.data?.candidates ?? null;
  const error = errorLocal ?? (refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load.' : null);
  const refresh = async () => {
    await refreshQuery.refetch();
  };

  const refreshKpisQuery = useQuery({
    queryKey: ['RecruitingHome', 'allCandidates'],
    queryFn: () => listCandidates({}),
  });
  const allCandidates: Candidate[] | null = refreshKpisQuery.data?.candidates ?? null;
  const kpiError = refreshKpisQuery.error ? refreshKpisQuery.error instanceof ApiError ? refreshKpisQuery.error.message : 'Failed to load pipeline stats.' : null;
  const refreshKpis = async () => {
    await refreshKpisQuery.refetch();
  };



  const advance = async (c: Candidate, target: CandidateStage) => {
    if (pendingId) return;
    setPendingId(c.id);
    try {
      await advanceCandidate(c.id, { stage: target });
      toast.success(
        `Moved ${c.firstName} ${c.lastName} to ${STAGE_LABEL[target]}.`,
      );
      await Promise.all([refresh(), refreshKpis()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Advance failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onConfirmReject = async (reason: string) => {
    if (!dialog || dialog.kind !== 'reject') return;
    setPendingId(dialog.candidate.id);
    try {
      await advanceCandidate(dialog.candidate.id, {
        stage: 'REJECTED',
        rejectedReason: reason,
      });
      toast.success(
        `${dialog.candidate.firstName} ${dialog.candidate.lastName} rejected.`,
      );
      setDialog(null);
      await Promise.all([refresh(), refreshKpis()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reject failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onConfirmWithdraw = async (reason: string) => {
    if (!dialog || dialog.kind !== 'withdraw') return;
    setPendingId(dialog.candidate.id);
    try {
      await advanceCandidate(dialog.candidate.id, {
        stage: 'WITHDRAWN',
        withdrawnReason: reason,
      });
      toast.success(
        `${dialog.candidate.firstName} ${dialog.candidate.lastName} marked withdrawn.`,
      );
      setDialog(null);
      await Promise.all([refresh(), refreshKpis()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Withdraw failed.');
    } finally {
      setPendingId(null);
    }
  };

  // Hire opens the onboarding invite, filled in from the candidate and
  // their accepted offer. The offer is looked up first so its job, start
  // date and pay arrive with the dialog rather than a beat after it.
  // undefined = still looking; null = no accepted offer.
  const hiringId = dialog?.kind === 'hire' ? dialog.candidate.id : null;
  const hireOffersQuery = useQuery({
    queryKey: ['recruiting', 'offers', hiringId],
    queryFn: () => listOffers(hiringId!),
    enabled: Boolean(hiringId),
  });
  const hireOffer: OfferRecord | null | undefined = !hiringId
    ? undefined
    : hireOffersQuery.isError
      ? // No offer on file is still a hire — just without prefilled pay.
        null
      : hireOffersQuery.data === undefined
        ? undefined
        : (hireOffersQuery.data.offers
            .filter((o) => o.status === 'ACCEPTED')
            .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt))[0] ?? null);

  // Who the invite dialog is hiring. Kept after it closes so the dialog
  // doesn't flip back to "New application" while it animates out.
  const [hireCtx, setHireCtx] = useState<{ candidate: Candidate; offer: OfferRecord | null } | null>(null);
  useEffect(() => {
    if (dialog?.kind === 'hire' && hireOffer !== undefined) {
      setHireCtx({ candidate: dialog.candidate, offer: hireOffer });
    }
  }, [dialog, hireOffer]);

  const onHired = (hired: CandidateHireResponse) => {
    void Promise.all([refresh(), refreshKpis()]);
    // No email configured (local/dev): the dialog stays open with the invite
    // link to copy and says so itself — "invite sent" would be untrue.
    if (hired.inviteUrl) return;
    toast.success(
      `${hired.firstName} ${hired.lastName} hired — onboarding invite sent.`,
      {
        description: hired.payRecorded ? 'Starting pay set from their accepted offer.' : undefined,
        action: {
          label: 'Open onboarding',
          onClick: () => navigate(`/onboarding/applications/${hired.applicationId}`),
        },
      },
    );
  };

  // Resolved from the lists rather than fetched: GET /candidates/:id returns
  // the same shape the list already carries, so a second request would buy
  // nothing. allCandidates is the unfiltered set, which keeps the drawer open
  // when an advance moves someone out of the active stage filter.
  const detailCandidate = useMemo(
    () =>
      detailId
        ? (candidates?.find((c) => c.id === detailId) ??
          allCandidates?.find((c) => c.id === detailId) ??
          null)
        : null,
    [detailId, candidates, allCandidates],
  );

  const kpis = useMemo(() => {
    if (!allCandidates) return null;
    const inFunnel = allCandidates.filter(
      (c) => c.stage !== 'HIRED' && c.stage !== 'REJECTED' && c.stage !== 'WITHDRAWN',
    ).length;
    const interviewing = allCandidates.filter((c) => c.stage === 'INTERVIEW').length;
    const outstandingOffers = allCandidates.filter((c) => c.stage === 'OFFER').length;
    // By the hire date. It used to test createdAt, so a candidate who
    // applied in August and was hired today never counted.
    const hiredThisMonth = allCandidates.filter((c) => {
      if (c.stage !== 'HIRED' || !c.hiredAt) return false;
      const d = new Date(c.hiredAt);
      const now = new Date();
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
    return { inFunnel, interviewing, outstandingOffers, hiredThisMonth };
  }, [allCandidates]);

  // Client-side name/email/position search, applied to both views.
  const candidateMatches = useCallback(
    (c: Candidate) =>
      !debouncedSearch ||
      `${c.firstName} ${c.lastName}`.toLowerCase().includes(debouncedSearch) ||
      c.email.toLowerCase().includes(debouncedSearch) ||
      (c.position ?? '').toLowerCase().includes(debouncedSearch),
    [debouncedSearch],
  );
  const visibleCandidates = useMemo(
    () => (candidates ? candidates.filter(candidateMatches) : null),
    [candidates, candidateMatches],
  );
  const visibleAll = useMemo(
    () => (allCandidates ? allCandidates.filter(candidateMatches) : null),
    [allCandidates, candidateMatches],
  );

  // Bulk selection (list view only — the board keeps drag as its bulk
  // mechanic). Only open-stage candidates are selectable; closed ones have
  // no advance/reject path.
  const selectableIds = useMemo(
    () => (visibleCandidates ?? []).filter(isOpenStage).map((c) => c.id),
    [visibleCandidates],
  );
  const sel = useSelection(canManage && view === 'list' ? selectableIds : []);
  const { clear: clearSelection } = sel;
  // A filter/search change swaps the visible rows out from under the
  // selection — drop it rather than acting on rows no longer on screen.
  useEffect(() => {
    clearSelection();
  }, [filter, debouncedSearch, view, clearSelection]);

  const selectedRows = useMemo(
    () => (visibleCandidates ?? []).filter((c) => sel.selected.has(c.id)),
    [visibleCandidates, sel.selected],
  );
  const advanceableRows = useMemo(
    () => selectedRows.filter((c) => NEXT_STAGE[c.stage] !== undefined),
    [selectedRows],
  );

  const bulkAdvance = async () => {
    if (bulkBusy || advanceableRows.length === 0) return;
    setBulkBusy(true);
    const targets = advanceableRows;
    const results = await Promise.allSettled(
      targets.map((c) => advanceCandidate(c.id, { stage: NEXT_STAGE[c.stage]! })),
    );
    let ok = 0;
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        ok++;
      } else {
        const c = targets[i];
        toast.error(
          `${c.firstName} ${c.lastName}: ${
            res.reason instanceof ApiError ? res.reason.message : 'advance failed.'
          }`,
        );
      }
    });
    if (ok > 0) {
      toast.success(`Advanced ${ok} candidate${ok === 1 ? '' : 's'} to the next stage.`);
    }
    clearSelection();
    setBulkBusy(false);
    await Promise.all([refresh(), refreshKpis()]);
  };

  const bulkReject = async (reason: string) => {
    if (bulkBusy || selectedRows.length === 0) return;
    setBulkBusy(true);
    const targets = selectedRows;
    const results = await Promise.allSettled(
      targets.map((c) =>
        advanceCandidate(c.id, { stage: 'REJECTED', rejectedReason: reason }),
      ),
    );
    let ok = 0;
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        ok++;
      } else {
        const c = targets[i];
        toast.error(
          `${c.firstName} ${c.lastName}: ${
            res.reason instanceof ApiError ? res.reason.message : 'reject failed.'
          }`,
        );
      }
    });
    if (ok > 0) toast.success(`Rejected ${ok} candidate${ok === 1 ? '' : 's'}.`);
    setBulkRejectOpen(false);
    clearSelection();
    setBulkBusy(false);
    await Promise.all([refresh(), refreshKpis()]);
  };

  const onExportCsv = () => {
    const rows = view === 'list' ? visibleCandidates : visibleAll;
    if (!rows || rows.length === 0) return;
    downloadCsv(`candidates-${ymdLocal()}.csv`, [
      ['First name', 'Last name', 'Email', 'Phone', 'Position', 'Source', 'Stage', 'Applied'],
      ...rows.map((c) => [
        c.firstName,
        c.lastName,
        c.email,
        c.phone ?? '',
        c.position ?? '',
        c.source ?? '',
        c.stage,
        c.createdAt.slice(0, 10),
      ]),
    ]);
  };

  return (
    <div className="mx-auto">
      <PageHeader
        title="Recruiting"
        subtitle={
          canManage
            ? 'Manage candidates from application through hire.'
            : 'Read-only view of the candidate pipeline.'
        }
        secondaryActions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/recruiting/extras">Interviewing &amp; offers</Link>
          </Button>
        }
        primaryAction={
          canManage ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              New candidate
            </Button>
          ) : undefined
        }
      />

      {kpiError && !allCandidates ? (
        <ErrorBanner
          className="mb-6"
          action={
            <Button size="sm" variant="secondary" onClick={() => refreshKpis()}>
              Retry
            </Button>
          }
        >
          {kpiError}
        </ErrorBanner>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <KpiCard
            icon={Users}
            label="In funnel"
            value={kpis ? String(kpis.inFunnel) : null}
            tone="default"
          />
          <KpiCard
            icon={Briefcase}
            label="Interviewing"
            value={kpis ? String(kpis.interviewing) : null}
            tone="warning"
          />
          <KpiCard
            icon={Award}
            label="Open offers"
            value={kpis ? String(kpis.outstandingOffers) : null}
            tone="default"
          />
          <KpiCard
            icon={CheckCircle2}
            label="Hired this month"
            value={kpis ? String(kpis.hiredThisMonth) : null}
            tone="success"
          />
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <CardTitle className="text-base">Candidates</CardTitle>
              <ViewToggle<ViewMode>
                value={view}
                onChange={setViewPersisted}
                ariaLabel="Switch between board and list view"
                options={[
                  { value: 'board', label: 'Board', icon: Kanban },
                  { value: 'list', label: 'List', icon: Rows3 },
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput
                wrapperClassName="w-full sm:w-60"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email, position…"
                aria-label="Search candidates"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onExportCsv}
                disabled={
                  view === 'list'
                    ? !visibleCandidates || visibleCandidates.length === 0
                    : !visibleAll || visibleAll.length === 0
                }
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </Button>
            </div>
            {view === 'list' && (
              <div className="flex flex-wrap gap-2">
                {(['ALL', ...STAGES] as Array<CandidateStage | 'ALL'>).map((s) => (
                  <FilterChip
                    key={s}
                    active={filter === s}
                    onClick={() => setFilter(s)}
                  >
                    {s === 'ALL' ? 'All' : STAGE_LABEL[s]}
                  </FilterChip>
                ))}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {error && (
            <ErrorBanner
              className="mb-3"
              action={
                <Button size="sm" variant="secondary" onClick={() => refresh()}>
                  Retry
                </Button>
              }
            >
              {error}
            </ErrorBanner>
          )}
          {view === 'board' && (
            <>
              {!visibleAll && kpiError && (
                <ErrorBanner
                  className="my-4"
                  action={
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => refreshKpis()}
                    >
                      Retry
                    </Button>
                  }
                >
                  {kpiError}
                </ErrorBanner>
              )}
              {!visibleAll && !kpiError && <SkeletonRows count={5} rowHeight="h-24" />}
              {visibleAll && (
                <CandidateBoard
                  candidates={visibleAll}
                  pendingId={pendingId}
                  onAdvance={(c, target) => advance(c, target)}
                  onRequestReject={(c) => setDialog({ kind: 'reject', candidate: c })}
                  onRequestWithdraw={(c) => setDialog({ kind: 'withdraw', candidate: c })}
                  onRequestHire={(c) => setDialog({ kind: 'hire', candidate: c })}
                  onOpen={(c) => setDetailId(c.id)}
                />
              )}
            </>
          )}
          {view === 'list' && !visibleCandidates && (
            <SkeletonRows count={5} rowHeight="h-12" />
          )}
          {view === 'list' && visibleCandidates && visibleCandidates.length === 0 && (
            <EmptyState
              icon={UserPlus}
              title={
                debouncedSearch
                  ? 'No candidates match your search'
                  : 'No candidates match this filter'
              }
              description={
                debouncedSearch
                  ? 'Try a different name, email, or position.'
                  : canManage
                    ? 'Add a candidate or switch to a different stage.'
                    : 'Switch to a different stage to see more candidates.'
              }
              action={
                debouncedSearch ? (
                  <Button variant="outline" onClick={() => setSearch('')}>
                    Clear search
                  </Button>
                ) : canManage ? (
                  <Button onClick={() => setShowCreate(true)}>
                    <Plus className="h-4 w-4" />
                    New candidate
                  </Button>
                ) : undefined
              }
            />
          )}
          {view === 'list' && visibleCandidates && visibleCandidates.length > 0 && (
            // The page owns search, the stage filter and the sticky bulk bar;
            // the grid draws the checkboxes (open stages only) and hands the
            // choice back. Phones get the same list as cards.
            <DataGrid<NonNullable<typeof visibleCandidates>[number]>
              id="candidates"
              caption="Candidates"
              rows={visibleCandidates}
              rowKey={(c) => c.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'candidates' }}
              onRowClick={(c) => setDetailId(c.id)}
              rowActionLabel={(c) => `Open ${c.firstName} ${c.lastName}`}
              selectable={
                canManage
                  ? { disabled: (c) => !isOpenStage(c), selection: { selected: sel.selected, onChange: sel.replace } }
                  : undefined
              }
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  accessor: (c) => `${c.firstName} ${c.lastName}`,
                  sortable: true,
                  primary: true,
                  className: 'font-medium',
                  cell: (c) => <CandidateNameCell c={c} onOpen={(x) => setDetailId(x.id)} />,
                },
                { key: 'email', header: 'Email', accessor: (c) => c.email, sortable: true, cardMeta: true, className: 'text-silver' },
                { key: 'position', header: 'Position', accessor: (c) => c.position, sortable: true, cardMeta: true, className: 'text-silver', cell: (c) => c.position ?? '—' },
                {
                  key: 'source',
                  header: 'Source',
                  accessor: (c) => (c.source ? (SOURCE_LABEL[c.source] ?? c.source) : null),
                  sortable: true,
                  className: 'text-silver',
                  cell: (c) => (c.source ? (SOURCE_LABEL[c.source] ?? c.source) : '—'),
                },
                {
                  key: 'applied',
                  header: 'Applied',
                  accessor: (c) => c.createdAt,
                  csv: (c) => `${fmtDate(c.createdAt)} (${daysSince(c.stageChangedAt)}d in stage)`,
                  sortable: true,
                  searchable: false,
                  className: 'text-silver whitespace-nowrap',
                  cell: (c) => (
                    <>
                      {fmtDate(c.createdAt)}
                      <span title={`Days in ${STAGE_LABEL[c.stage]}`}>
                        <Badge variant="outline" className="ml-2 tabular-nums">
                          {daysSince(c.stageChangedAt)}d
                        </Badge>
                      </span>
                    </>
                  ),
                },
                {
                  key: 'stage',
                  header: 'Stage',
                  accessor: (c) => STAGE_LABEL[c.stage],
                  sortable: true,
                  cardMeta: true,
                  cell: (c) => (
                    <>
                      <Badge variant={STAGE_VARIANT[c.stage]}>{STAGE_LABEL[c.stage]}</Badge>
                      {c.rejectedReason && <div className="text-2xs mt-1 text-alert">{c.rejectedReason}</div>}
                      {c.withdrawnReason && <div className="text-2xs mt-1 text-silver">{c.withdrawnReason}</div>}
                    </>
                  ),
                },
                ...(canManage
                  ? [
                      {
                        key: 'actions',
                        header: 'Actions',
                        accessor: () => null,
                        searchable: false,
                        csv: () => '',
                        align: 'right' as const,
                        stopRowClick: true,
                        className: 'whitespace-nowrap',
                        cell: (c: NonNullable<typeof visibleCandidates>[number]) => (
                          <CandidateActions c={c} pendingId={pendingId} onAdvance={advance} onRequest={(kind) => setDialog({ kind, candidate: c })} />
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </CardContent>
      </Card>

      {/* Sticky bulk bar — appears with the first checked row (list view). */}
      {canManage && view === 'list' && selectedRows.length > 0 && (
        <div className="sticky bottom-4 z-20 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-navy-secondary bg-navy p-3 elev-2">
          <span className="text-sm text-silver tabular-nums">
            {selectedRows.length} selected
          </span>
          <Button
            size="sm"
            onClick={() => void bulkAdvance()}
            loading={bulkBusy}
            disabled={bulkBusy || advanceableRows.length === 0}
            title="Each candidate moves to their own next stage (Applied → Screening → Interview → Offer). Offer-stage candidates are skipped — hiring stays a per-candidate decision."
          >
            <ArrowRight className="h-3.5 w-3.5" />
            Advance selected ({advanceableRows.length})
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-alert hover:text-alert hover:bg-alert/10"
            onClick={() => setBulkRejectOpen(true)}
            disabled={bulkBusy}
          >
            Reject selected ({selectedRows.length})
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection} disabled={bulkBusy}>
            Clear
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={bulkRejectOpen}
        onOpenChange={(o) => !o && setBulkRejectOpen(false)}
        title={`Reject ${selectedRows.length} candidate${selectedRows.length === 1 ? '' : 's'}?`}
        description="One reason is recorded on every selected candidate for the audit trail."
        confirmLabel="Reject candidates"
        destructive
        requireReason
        reasonPlaceholder="e.g., Position filled — no openings remain this season."
        busy={bulkBusy}
        onConfirm={bulkReject}
      />

      <CreateCandidateDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => {
          setShowCreate(false);
          refresh();
          refreshKpis();
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === 'reject'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={
          dialog?.kind === 'reject'
            ? `Reject ${dialog.candidate.firstName} ${dialog.candidate.lastName}?`
            : 'Reject candidate'
        }
        description="The associate's record stays — but they'll be marked as rejected with the reason below for the audit trail."
        confirmLabel="Reject candidate"
        destructive
        requireReason
        reasonPlaceholder="e.g., Not a fit for the role at this time."
        busy={pendingId !== null}
        onConfirm={onConfirmReject}
      />

      <ConfirmDialog
        open={dialog?.kind === 'withdraw'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={
          dialog?.kind === 'withdraw'
            ? `Withdraw ${dialog.candidate.firstName} ${dialog.candidate.lastName}?`
            : 'Withdraw candidate'
        }
        description="Use this when the candidate has dropped out of the process on their own."
        confirmLabel="Mark withdrawn"
        requireReason
        reasonPlaceholder="e.g., Accepted another offer."
        busy={pendingId !== null}
        onConfirm={onConfirmWithdraw}
      />

      {/* Always mounted and opened by state — never mounted already open.
          A dialog mounted open parks its Back-button history entry in the
          same tick as the drawer's, and closing it then walked Back one
          entry too far and shut the candidate drawer behind it. */}
      <NewApplicationDialog
        open={dialog?.kind === 'hire' && hireOffer !== undefined && hireCtx !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        onCreated={() => undefined}
        hire={hireCtx ? { ...hireCtx, onHired } : undefined}
      />

      <CandidateDetailDrawer
        candidate={detailCandidate}
        onOpenChange={(o) => !o && setDetailId(null)}
        onChanged={() => void Promise.all([refresh(), refreshKpis()])}
        actions={
          canManage && detailCandidate ? (
            <CandidateActions
              c={detailCandidate}
              pendingId={pendingId}
              onAdvance={advance}
              onRequest={(kind) =>
                setDialog({ kind, candidate: detailCandidate })
              }
            />
          ) : null
        }
      />
    </div>
  );
}

function CandidateNameCell({
  c,
  onOpen,
}: {
  c: Candidate;
  onOpen: (c: Candidate) => void;
}) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Avatar
        name={`${c.firstName} ${c.lastName}`}
        email={c.email}
        size="sm"
      />
      {/* The name is the affordance here rather than the whole row: these
          rows already carry advance/reject/withdraw buttons, and a row-wide
          click target would swallow them. */}
      <button
        type="button"
        onClick={() => onOpen(c)}
        className="truncate text-left hover:text-gold hover:underline transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-sm"
      >
        {c.firstName} {c.lastName}
      </button>
      {c.resumeUrl && (
        <a
          href={safeHref(c.resumeUrl)}
          target="_blank"
          rel="noopener noreferrer"
          title="Resume"
          aria-label="Open resume in a new tab"
          className="text-silver/70 hover:text-gold transition-colors shrink-0"
        >
          <FileText className="h-3.5 w-3.5" />
        </a>
      )}
      {c.linkedinUrl && (
        <a
          href={safeHref(c.linkedinUrl)}
          target="_blank"
          rel="noopener noreferrer"
          title="LinkedIn"
          aria-label="Open LinkedIn profile in a new tab"
          className="text-silver/70 hover:text-gold transition-colors shrink-0"
        >
          <Link2 className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

function CandidateActions({
  c,
  pendingId,
  onAdvance,
  onRequest,
}: {
  c: Candidate;
  pendingId: string | null;
  onAdvance: (c: Candidate, target: CandidateStage) => void;
  onRequest: (kind: 'reject' | 'withdraw' | 'hire') => void;
}) {
  const next = NEXT_STAGE[c.stage];
  const isClosed =
    c.stage === 'HIRED' || c.stage === 'REJECTED' || c.stage === 'WITHDRAWN';
  const isPending = pendingId === c.id;
  return (
    <div className="inline-flex flex-wrap gap-1.5">
      {next && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onAdvance(c, next)}
          loading={isPending}
          disabled={isPending}
        >
          {STAGE_LABEL[next]}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      )}
      {c.stage === 'OFFER' && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => onRequest('hire')}
          disabled={isPending}
        >
          Hire
        </Button>
      )}
      {!isClosed && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRequest('withdraw')}
            disabled={isPending}
          >
            Withdraw
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-alert hover:text-alert hover:bg-alert/10"
            onClick={() => onRequest('reject')}
            disabled={isPending}
          >
            Reject
          </Button>
        </>
      )}
    </div>
  );
}

interface KpiCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
  tone: 'success' | 'warning' | 'default' | 'silver';
}

const TONE_TEXT: Record<KpiCardProps['tone'], string> = {
  success: 'text-success',
  warning: 'text-warning',
  default: 'text-gold',
  silver: 'text-silver',
};

function KpiCard({ icon: Icon, label, value, tone }: KpiCardProps) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between mb-1">
        <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
          {label}
        </div>
        <Icon className="h-3.5 w-3.5 text-silver/70" />
      </div>
      {value === null ? (
        <Skeleton className="h-9 w-12 mt-1" />
      ) : (
        <div className={cn('text-3xl font-display tabular-nums', TONE_TEXT[tone])}>
          {value}
        </div>
      )}
    </Card>
  );
}

interface CreateCandidateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

function CreateCandidateDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateCandidateDialogProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState('');
  const [source, setSource] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinct position titles for the Select. null = not loaded / failed —
  // in that case we fall back to the free-text input rather than blocking.
  const positionsQuery = useQuery({
    queryKey: ['RecruitingHome', 'positionTitles'],
    queryFn: () => listPositions(),
    select: (r) =>
      Array.from(new Set(r.positions.map((p) => p.title))).sort((a, b) =>
        a.localeCompare(b),
      ),
    enabled: open,
  });
  const positionOptions: string[] | null = positionsQuery.data ?? null;

  // Clear the form whenever the dialog re-opens.
  useEffect(() => {
    if (open) {
      setFirstName('');
      setLastName('');
      setEmail('');
      setPhone('');
      setPosition('');
      setSource('');
      setError(null);
    }
  }, [open]);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await createCandidate({
        firstName,
        lastName,
        email,
        phone: phone || undefined,
        position: position || undefined,
        source: source || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New candidate</DialogTitle>
          <DialogDescription>
            They&apos;ll start in the Applied stage. You can advance them
            through the funnel from the table.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="First name" required>
              <Input
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </Field>
            <Field label="Last name" required>
              <Input
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </Field>
            <Field label="Email" required>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Phone">
              <Input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field label="Position">
              {positionOptions && positionOptions.length > 0 ? (
                <Select
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                >
                  <option value="">Select a position…</option>
                  {positionOptions.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                />
              )}
            </Field>
            <Field label="Source">
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Select a source…</option>
                {CANDIDATE_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABEL[s] ?? s}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {error && (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              Save as Applied
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

