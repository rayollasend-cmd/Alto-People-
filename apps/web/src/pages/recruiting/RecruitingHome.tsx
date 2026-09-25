import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
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
import type { Candidate, CandidateFilters, CandidateHireResponse, CandidateSort, CandidateStage } from '@alto-people/shared';
import { safeHref } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  advanceCandidate,
  createCandidate,
  getCandidate,
  getCandidateBoard,
  getRecruitingSummary,
  listAllCandidates,
  listCandidates,
  listRemovedCandidates,
  removeCandidate,
  restoreCandidate,
  undoHire,
} from '@/lib/recruitingApi';
import { secondsUntil, undoWindowToast } from '@/lib/undoToast';
import { usePrompt } from '@/lib/confirm';
import { listJobPostings, listOffers, type OfferRecord } from '@/lib/recruiting90Api';
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
import { SavedViewsMenu } from './SavedViewsMenu';
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
/** Rows per page in the list; cards per column on the board. */
const LIST_PAGE = 50;
const BOARD_PAGE = 25;

const SORT_OPTIONS: Array<{ value: CandidateSort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'waiting', label: 'Longest in stage' },
  { value: 'moved', label: 'Recently moved' },
  { value: 'name', label: 'Name' },
];
const SORTS = new Set<string>(SORT_OPTIONS.map((o) => o.value));

/** The URL params a saved view keeps. */
const VIEW_PARAMS = ['view', 'stage', 'q', 'source', 'posting', 'stuck', 'sort'] as const;

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
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [errorLocal, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [removedOpen, setRemovedOpen] = useState(false);
  const prompt = usePrompt();

  // Layout, filters, search, sort, the saved view and the open candidate
  // all live in the URL (same source-of-truth pattern as ComplianceHome's
  // ?tab= and the People directory's ?associateId=), so refresh / back /
  // share — and a saved view — keep the pipeline exactly as it was.
  const [searchParams, setSearchParams] = useSearchParams();
  const view: ViewMode = searchParams.get('view') === 'list' ? 'list' : searchParams.get('view') === 'board' ? 'board' : readViewMode();
  const stageParam = searchParams.get('stage');
  const filter: CandidateStage | 'ALL' =
    stageParam === 'ALL' || (STAGES as string[]).includes(stageParam ?? '')
      ? (stageParam as CandidateStage | 'ALL')
      : 'APPLIED';
  const search = searchParams.get('q') ?? '';
  const sourceFilter = searchParams.get('source') ?? '';
  const postingFilter = searchParams.get('posting') ?? '';
  const stuckOnly = searchParams.get('stuck') === '1';
  const sort = (SORTS.has(searchParams.get('sort') ?? '') ? searchParams.get('sort') : 'newest') as CandidateSort;
  const savedViewId = searchParams.get('sv');
  // The candidate whose detail drawer is open. Held by id rather than by
  // value so a refresh after an advance re-renders the drawer with the new
  // stage instead of leaving a stale snapshot on screen.
  const detailId = searchParams.get('candidateId');

  const setParam = useCallback(
    (key: string, value: string | null, opts: { replace?: boolean } = {}) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: opts.replace },
      ),
    [setSearchParams],
  );
  const setFilter = useCallback(
    // The default stage keeps the URL clean.
    (s: CandidateStage | 'ALL') => setParam('stage', s === 'APPLIED' ? null : s),
    [setParam],
  );
  // replace: keystrokes shouldn't each become a Back-button stop.
  const setSearch = useCallback((q: string) => setParam('q', q || null, { replace: true }), [setParam]);
  // push (not replace): Back closes the drawer instead of leaving the page.
  const setDetailId = useCallback((id: string | null) => setParam('candidateId', id), [setParam]);
  const setView = useCallback(
    (v: ViewMode) => {
      writeViewMode(v);
      setParam('view', v, { replace: true });
    },
    [setParam],
  );

  // ?new=1 — "New candidate" from the dashboard — opens the form, once.
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    if (canManage) setShowCreate(true);
    setParam('new', null, { replace: true });
  }, [searchParams, canManage, setParam]);

  const [debouncedSearch, setDebouncedSearch] = useState(search.trim());
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // The filters the server applies — everything but the list's stage chip.
  const filters: CandidateFilters = useMemo(
    () => ({
      ...(debouncedSearch ? { q: debouncedSearch } : {}),
      ...(sourceFilter ? { source: sourceFilter } : {}),
      ...(postingFilter ? { jobPostingId: postingFilter } : {}),
      ...(stuckOnly ? { stuck: '1' as const } : {}),
      sort,
    }),
    [debouncedSearch, sourceFilter, postingFilter, stuckOnly, sort],
  );
  const listFilters: CandidateFilters = useMemo(
    () => ({ ...filters, ...(filter === 'ALL' ? {} : { stage: filter }) }),
    [filters, filter],
  );
  const filtered = Boolean(debouncedSearch || sourceFilter || postingFilter || stuckOnly);

  /* ----- Data: the summary tiles, the board, the list ------------------ */

  // The tiles count the whole pipeline on the server. They were counted
  // from the list the page had loaded — the newest 200 — so past 200 they
  // were quietly wrong.
  const summaryQuery = useQuery({ queryKey: ['RecruitingHome', 'summary'], queryFn: getRecruitingSummary });
  const kpis = summaryQuery.data
    ? {
        inFunnel: Object.values(summaryQuery.data.byStage).reduce((a, b) => a + b, 0),
        interviewing: summaryQuery.data.byStage.INTERVIEW,
        outstandingOffers: summaryQuery.data.byStage.OFFER,
        hiredThisMonth: summaryQuery.data.hiredThisMonth,
      }
    : null;
  const kpiError = summaryQuery.error
    ? summaryQuery.error instanceof ApiError
      ? summaryQuery.error.message
      : 'Failed to load pipeline stats.'
    : null;

  const boardQuery = useQuery({
    queryKey: ['RecruitingHome', 'board', filters],
    queryFn: () => getCandidateBoard(filters, BOARD_PAGE),
    enabled: view === 'board',
    placeholderData: keepPreviousData,
  });
  // A column's further pages, fetched with "Show more"; dropped whenever
  // the filters change or the board reloads.
  const [morePages, setMorePages] = useState<Partial<Record<CandidateStage, Candidate[]>>>({});
  const [loadingMore, setLoadingMore] = useState<CandidateStage | null>(null);
  useEffect(() => setMorePages({}), [boardQuery.data]);
  const boardColumns = useMemo(
    () =>
      boardQuery.data?.columns.map((col) => {
        const extra = morePages[col.stage] ?? [];
        const seen = new Set(col.candidates.map((c) => c.id));
        return { ...col, candidates: [...col.candidates, ...extra.filter((c) => !seen.has(c.id))] };
      }) ?? null,
    [boardQuery.data, morePages],
  );
  const loadMore = async (stage: CandidateStage) => {
    const col = boardColumns?.find((c) => c.stage === stage);
    if (!col || loadingMore) return;
    setLoadingMore(stage);
    try {
      const page = await listCandidates({ ...filters, stage }, { offset: col.candidates.length, limit: BOARD_PAGE });
      setMorePages((prev) => ({ ...prev, [stage]: [...(prev[stage] ?? []), ...page.candidates] }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load more candidates.');
    } finally {
      setLoadingMore(null);
    }
  };

  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [listFilters]);
  const listQuery = useQuery({
    queryKey: ['RecruitingHome', 'list', listFilters, page],
    queryFn: () => listCandidates(listFilters, { limit: LIST_PAGE, offset: page * LIST_PAGE }),
    enabled: view === 'list',
    placeholderData: keepPreviousData,
  });
  const candidates: Candidate[] | null = listQuery.data?.candidates ?? null;
  const listTotal = listQuery.data?.total ?? 0;

  const activeQuery = view === 'board' ? boardQuery : listQuery;
  const error =
    errorLocal ??
    (activeQuery.error ? (activeQuery.error instanceof ApiError ? activeQuery.error.message : 'Failed to load.') : null);

  // Everything on this page reads under one key; a move refreshes it all.
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['RecruitingHome'] });
  }, [queryClient]);

  const postingsQuery = useQuery({ queryKey: ['recruiting', 'postings'], queryFn: () => listJobPostings(), staleTime: 60_000 });
  const postings = postingsQuery.data?.postings ?? [];

  const advance = async (c: Candidate, target: CandidateStage) => {
    if (pendingId) return;
    setPendingId(c.id);
    try {
      await advanceCandidate(c.id, { stage: target });
      toast.success(
        `Moved ${c.firstName} ${c.lastName} to ${STAGE_LABEL[target]}.`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Advance failed.');
    } finally {
      setPendingId(null);
    }
  };

  /** A move from the board: outcomes open their dialogs. */
  const moveTo = (c: Candidate, target: CandidateStage) => {
    if (target === 'REJECTED') setDialog({ kind: 'reject', candidate: c });
    else if (target === 'WITHDRAWN') setDialog({ kind: 'withdraw', candidate: c });
    else if (target === 'HIRED') setDialog({ kind: 'hire', candidate: c });
    else void advance(c, target);
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
      await refresh();
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
      await refresh();
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
    void refresh();
    // No email configured (local/dev): the dialog stays open with the invite
    // link to copy and says so itself — "invite sent" would be untrue.
    if (hired.inviteUrl) return;
    // The invite waits a few seconds: a mistaken hire can be taken back
    // before the person is emailed anything.
    if (hired.emailDueAt) {
      undoWindowToast({
        message: `${hired.firstName} ${hired.lastName} hired — their onboarding invite goes out in ${secondsUntil(hired.emailDueAt)} seconds.`,
        dueAt: hired.emailDueAt,
        description: hired.payRecorded ? 'Starting pay set from their accepted offer.' : undefined,
        onUndo: async () => {
          await undoHire(hired.id, 'Undone right after hiring');
          await refresh();
          return `Undone — ${hired.firstName} is back at Offer, and no invite was sent.`;
        },
      });
      return;
    }
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

  // The open candidate: from what's on screen when it's there, fetched
  // when it isn't — a link from a notification or email opens anyone,
  // not only the people on the current page.
  const onScreen = useMemo(
    () =>
      detailId
        ? (candidates?.find((c) => c.id === detailId) ??
          boardColumns?.flatMap((col) => col.candidates).find((c) => c.id === detailId) ??
          null)
        : null,
    [detailId, candidates, boardColumns],
  );
  const detailQuery = useQuery({
    queryKey: ['RecruitingHome', 'candidate', detailId],
    queryFn: () => getCandidate(detailId!),
    enabled: Boolean(detailId),
  });
  const detailCandidate = detailId ? (detailQuery.data ?? onScreen) : null;

  // Bulk selection (list view only — the board moves one card at a time).
  // Only open-stage candidates are selectable; closed ones have no
  // advance/reject path.
  const selectableIds = useMemo(
    () => (candidates ?? []).filter(isOpenStage).map((c) => c.id),
    [candidates],
  );
  const sel = useSelection(canManage && view === 'list' ? selectableIds : []);
  const { clear: clearSelection } = sel;
  // A filter/search/page change swaps the visible rows out from under the
  // selection — drop it rather than acting on rows no longer on screen.
  useEffect(() => {
    clearSelection();
  }, [listFilters, page, view, clearSelection]);

  const selectedRows = useMemo(
    () => (candidates ?? []).filter((c) => sel.selected.has(c.id)),
    [candidates, sel.selected],
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
    await refresh();
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
    await refresh();
  };

  // Duplicates, tests, spam — off the pipeline together, restorable for 30 days.
  const bulkRemove = async () => {
    if (bulkBusy || selectedRows.length === 0) return;
    const reason = await prompt({
      title: `Remove ${selectedRows.length} candidate${selectedRows.length === 1 ? '' : 's'} from the pipeline?`,
      description: 'They leave the board and every list. You can restore them from Recently removed for 30 days.',
      reasonLabel: 'Why (optional)',
      reasonPlaceholder: 'e.g. Test entries',
      required: false,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (reason === null) return;
    setBulkBusy(true);
    const targets = selectedRows;
    const results = await Promise.allSettled(targets.map((c) => removeCandidate(c.id, reason.trim() || null)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    results.forEach((res, i) => {
      if (res.status === 'rejected') {
        const c = targets[i]!;
        toast.error(`${c.firstName} ${c.lastName}: ${res.reason instanceof ApiError ? res.reason.message : 'could not remove.'}`);
      }
    });
    if (ok > 0) toast.success(`Removed ${ok} candidate${ok === 1 ? '' : 's'} — restore them from Recently removed.`);
    clearSelection();
    setBulkBusy(false);
    await refresh();
  };

  // Everyone matching the filters — not just the page on screen.
  const onExportCsv = async () => {
    setExporting(true);
    try {
      const rows = await listAllCandidates(view === 'list' ? listFilters : filters);
      if (rows.length === 0) {
        toast.info('No candidates match these filters.');
        return;
      }
      downloadCsv(`candidates-${ymdLocal()}.csv`, [
        ['First name', 'Last name', 'Email', 'Phone', 'Position', 'Source', 'Stage', 'Applied', 'Days in stage'],
        ...rows.map((c) => [
          c.firstName,
          c.lastName,
          c.email,
          c.phone ?? '',
          c.position ?? '',
          c.source ?? '',
          c.stage,
          c.createdAt.slice(0, 10),
          String(daysSince(c.stageChangedAt)),
        ]),
      ]);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not export.');
    } finally {
      setExporting(false);
    }
  };

  /* ----- Saved views ---------------------------------------------------- */
  const currentViewQuery = useMemo(() => {
    const q: Record<string, string> = { view };
    for (const k of VIEW_PARAMS) {
      const v = searchParams.get(k);
      if (v && k !== 'view') q[k] = v;
    }
    return q;
  }, [searchParams, view]);
  const applySavedView = (id: string | null, query: Record<string, string>) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams();
      // Keep the open drawer; replace every filter.
      const cand = prev.get('candidateId');
      if (cand) next.set('candidateId', cand);
      for (const k of VIEW_PARAMS) if (query[k]) next.set(k, query[k]!);
      if (id) next.set('sv', id);
      if (query.view === 'list' || query.view === 'board') writeViewMode(query.view);
      return next;
    });
  const clearFilters = () =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of ['q', 'source', 'posting', 'stuck', 'sv']) next.delete(k);
      return next;
    });

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
          <>
            <Button asChild variant="ghost" size="sm">
              <Link to="/recruiting/analytics">Analytics</Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRemovedOpen(true)}>
              Recently removed
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/recruiting/extras">Interviewing &amp; offers</Link>
            </Button>
          </>
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

      {kpiError && !kpis ? (
        <ErrorBanner
          className="mb-6"
          action={
            <Button size="sm" variant="secondary" onClick={() => void summaryQuery.refetch()}>
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
        <CardHeader className="pb-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <CardTitle className="text-base">Candidates</CardTitle>
              <ViewToggle<ViewMode>
                value={view}
                onChange={setView}
                ariaLabel="Switch between board and list view"
                options={[
                  { value: 'board', label: 'Board', icon: Kanban },
                  { value: 'list', label: 'List', icon: Rows3 },
                ]}
              />
              <SavedViewsMenu
                scope="recruiting.candidates"
                current={currentViewQuery}
                activeId={savedViewId}
                onApply={applySavedView}
                allLabel="All candidates"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput
                wrapperClassName="w-full sm:w-60"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email, phone, position…"
                aria-label="Search candidates"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void onExportCsv()}
                loading={exporting}
                disabled={exporting}
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Source"
              className="h-8 w-auto text-xs2"
              value={sourceFilter}
              onChange={(e) => setParam('source', e.target.value || null, { replace: true })}
            >
              <option value="">All sources</option>
              {CANDIDATE_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s] ?? s}
                </option>
              ))}
              <option value="none">No source recorded</option>
            </Select>
            <Select
              aria-label="Job posting"
              className="h-8 w-auto max-w-[16rem] text-xs2"
              value={postingFilter}
              onChange={(e) => setParam('posting', e.target.value || null, { replace: true })}
            >
              <option value="">All job postings</option>
              {postings.map((po) => (
                <option key={po.id} value={po.id}>
                  {po.title}
                  {po.clientName ? ` · ${po.clientName}` : ''}
                  {po.status !== 'OPEN' ? ` (${po.status.toLowerCase()})` : ''}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Sort"
              className="h-8 w-auto text-xs2"
              value={sort}
              onChange={(e) => setParam('sort', e.target.value === 'newest' ? null : e.target.value, { replace: true })}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <FilterChip active={stuckOnly} aria-pressed={stuckOnly} onClick={() => setParam('stuck', stuckOnly ? null : '1', { replace: true })}>
              Stuck 7+ days
            </FilterChip>
            {filtered && (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
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
        </CardHeader>
        <CardContent className="pt-0">
          {error && (
            <ErrorBanner
              className="mb-3"
              action={
                <Button size="sm" variant="secondary" onClick={() => { setError(null); void refresh(); }}>
                  Retry
                </Button>
              }
            >
              {error}
            </ErrorBanner>
          )}
          {view === 'board' && (
            <>
              {!boardColumns && !boardQuery.error && <SkeletonRows count={5} rowHeight="h-24" />}
              {boardColumns && (
                <div className={cn('transition-opacity', boardQuery.isPlaceholderData && 'opacity-60')}>
                  <CandidateBoard
                    columns={boardColumns}
                    pendingId={pendingId}
                    canManage={canManage}
                    onMove={moveTo}
                    onOpen={(c) => setDetailId(c.id)}
                    onLoadMore={(stage) => void loadMore(stage)}
                    loadingMore={loadingMore}
                    onSeeAll={(stage) =>
                      setSearchParams((prev) => {
                        const next = new URLSearchParams(prev);
                        next.set('view', 'list');
                        next.set('stage', stage);
                        return next;
                      })
                    }
                  />
                </div>
              )}
            </>
          )}
          {view === 'list' && !candidates && !listQuery.error && (
            <SkeletonRows count={5} rowHeight="h-12" />
          )}
          {view === 'list' && candidates && candidates.length === 0 && (
            <EmptyState
              icon={UserPlus}
              title={
                filtered
                  ? 'No candidates match these filters'
                  : 'No candidates in this stage'
              }
              description={
                filtered
                  ? 'Try a different search, or clear the filters.'
                  : canManage
                    ? 'Add a candidate or switch to a different stage.'
                    : 'Switch to a different stage to see more candidates.'
              }
              action={
                filtered ? (
                  <Button variant="outline" onClick={clearFilters}>
                    Clear filters
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
          {view === 'list' && candidates && candidates.length > 0 && (
            <div className={cn('transition-opacity', listQuery.isPlaceholderData && 'opacity-60')}>
            {/* The page owns search, filters, sort and paging (all on the
                server); the grid draws the page, the checkboxes (open
                stages only) and phones' cards. */}
            <DataGrid<NonNullable<typeof candidates>[number]>
              id="candidates"
              caption="Candidates"
              rows={candidates}
              rowKey={(c) => c.id}
              search={false}
              urlState={false}
              exportCsv={false}
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
                  primary: true,
                  className: 'font-medium',
                  cell: (c) => <CandidateNameCell c={c} onOpen={(x) => setDetailId(x.id)} />,
                },
                { key: 'email', header: 'Email', accessor: (c) => c.email, cardMeta: true, className: 'text-silver' },
                { key: 'position', header: 'Position', accessor: (c) => c.position, cardMeta: true, className: 'text-silver', cell: (c) => c.position ?? '—' },
                {
                  key: 'source',
                  header: 'Source',
                  accessor: (c) => (c.source ? (SOURCE_LABEL[c.source] ?? c.source) : null),
                  className: 'text-silver',
                  cell: (c) => (c.source ? (SOURCE_LABEL[c.source] ?? c.source) : '—'),
                },
                {
                  key: 'applied',
                  header: 'Applied',
                  accessor: (c) => c.createdAt,
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
                        cell: (c: NonNullable<typeof candidates>[number]) => (
                          <CandidateActions c={c} pendingId={pendingId} onAdvance={advance} onRequest={(kind) => setDialog({ kind, candidate: c })} />
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            <Pager page={page} pageSize={LIST_PAGE} total={listTotal} onPage={setPage} />
            </div>
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
          <Button size="sm" variant="ghost" onClick={() => void bulkRemove()} disabled={bulkBusy}>
            Remove selected
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

      <RemovedDialog open={removedOpen} onOpenChange={setRemovedOpen} onRestored={() => void refresh()} />

      <CreateCandidateDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => {
          setShowCreate(false);
          void refresh();
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
        onChanged={() => void refresh()}
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

/**
 * Removed in the last 30 days — a duplicate, a test, a mistake — with a
 * way back. Opened by state, never mounted open.
 */
function RemovedDialog({
  open,
  onOpenChange,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRestored: () => void;
}) {
  const q = useQuery({ queryKey: ['RecruitingHome', 'removed'], queryFn: () => listRemovedCandidates(), enabled: open });
  const [busy, setBusy] = useState<string | null>(null);
  const restore = async (id: string, name: string) => {
    setBusy(id);
    try {
      await restoreCandidate(id);
      toast.success(`${name} is back in the pipeline.`);
      await q.refetch();
      onRestored();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not restore.');
    } finally {
      setBusy(null);
    }
  };
  const rows = q.data?.removed ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Recently removed</DialogTitle>
          <DialogDescription>Removed in the last 30 days. Restoring puts them back where they were.</DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <SkeletonRows count={3} rowHeight="h-12" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-silver/70">Nobody removed in the last 30 days.</p>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-navy-secondary/60 overflow-y-auto">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0 text-sm">
                  <div className="truncate text-white">
                    {r.name} <span className="text-silver">· {STAGE_LABEL[r.stage]}</span>
                  </div>
                  <div className="truncate text-xs text-silver">
                    Removed {fmtDate(r.removedAt)}
                    {r.removedBy ? ` by ${r.removedBy}` : ''}
                    {r.reason ? ` — ${r.reason}` : ''}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  loading={busy === r.id}
                  disabled={busy !== null}
                  onClick={() => void restore(r.id, r.name)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "1–50 of 205", with previous and next. */
function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (total <= pageSize) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, from + pageSize - 1);
  const last = Math.ceil(total / pageSize) - 1;
  return (
    <nav aria-label="Pages" className="mt-3 flex items-center justify-end gap-2 text-xs2 text-silver">
      <span className="tabular-nums" aria-live="polite">
        {from}–{to} of {total}
      </span>
      <Button size="sm" variant="outline" onClick={() => onPage(page - 1)} disabled={page === 0}>
        Previous
      </Button>
      <Button size="sm" variant="outline" onClick={() => onPage(page + 1)} disabled={page >= last}>
        Next
      </Button>
    </nav>
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

