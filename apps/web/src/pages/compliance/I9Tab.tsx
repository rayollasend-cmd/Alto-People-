import { useEffect, useMemo, useRef, useState } from 'react';
import { useTenant, useTerm } from '@/lib/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Download, ExternalLink, FileCheck, Fingerprint, XCircle } from '@/components/ui/icons';
import { DirectorateHeader, Kpi, KpiStrip } from './DirectorateShell';
import { DeadlineStrip, matchesDeadlineDay } from './DeadlineStrip';
import { WORKFORCE_PARAM, WorkforceFilter, useComplianceWorkforce } from './WorkforceFilter';
import { I9_DESTROY_WORD, type ComplianceWorkforce, type I9DestroyResponse, type I9DocumentList, type I9NotStarted, type I9Verification, type WorkStatus } from '@alto-people/shared';
import { destroyI9, destroyI9s, listI9Reverifications, listI9s, recordI9Reverification, upsertI9 } from '@/lib/complianceApi';
import { PeopleStatusBadge, isWorkStatus, workStatusEnglish } from '@/components/ui/PeopleStatusBadge';
import {
  listI9Documents,
  submitI9Section2,
  type I9DocumentListItem,
} from '@/lib/i9Api';
import {
  autoDetectSection2,
  minDocsForSection2List,
  sanitizeReturnPath,
} from './section2Verification';
import { ApiError } from '@/lib/api';
import { DocumentViewer } from '@/components/DocumentViewer';
import {
  downloadAllDocumentsUrl,
  previewDocumentUrl,
  IDENTITY_DOC_KINDS,
} from '@/lib/documentsApi';
import { cn } from '@/lib/cn';
import { personPhotoUrl } from '@/lib/photoUrl';
import { fmtDate, fmtDateOnly, fmtDateTime, ymdLocal } from '@/lib/format';
import { usePersistentState } from '@/lib/usePersistentState';
import { useStoreScope } from '@/lib/storeScope';
import { toast } from 'sonner';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  ErrorBanner,
  Input,
  Label,
  Select,
  SkeletonRows,
} from '@/components/ui';
import { FilterBar, FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { DataGrid } from '@/components/ui/DataGrid';

/* ---------------- Section 2 deadline helpers ----------------
 * Date-only strings ("YYYY-MM-DD") are parsed at LOCAL midnight —
 * `new Date('YYYY-MM-DD')` would parse UTC and shift the day for
 * anyone west of Greenwich. */

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Advance `days` business days (Mon–Fri) past `start`. */
function addBusinessDays(start: Date, days: number): Date {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

/** Section 2 must be completed within 3 business days of the start date
 *  (an older server's rows; the server sends section2DueBy, holidays skipped). */
function section2DueDate(startDate: string | null | undefined): Date | null {
  if (!startDate) return null;
  return addBusinessDays(parseLocalDate(startDate), 3);
}

/**
 * A row's Section 2 due day, from the one hire-date anchor (owner,
 * 2026-11-03): the employment's first day — the date E-Verify counts from —
 * not the application's planned start.
 */
function rowSection2Due(r: I9Verification): Date | null {
  if (r.section2DueBy) return parseLocalDate(r.section2DueBy);
  return section2DueDate(r.hireDate ?? r.startDate);
}

/** Where the person stands; an older server sent only `placed`, which can't tell onboarding from gone. */
function rowWorkStatus(r: I9Verification): WorkStatus | null {
  if (isWorkStatus(r.workStatus)) return r.workStatus;
  if (r.separatedAt) return 'SEPARATED';
  if (r.placed === false) return 'ONBOARDING';
  return null;
}

/** Past retention: the person left and the retain-until day is behind us (the server's rule, lib/hiringCompliance). */
function pastRetention(r: I9Verification): boolean {
  return !!r.leftOn && !!r.retainUntil && r.retainUntil.slice(0, 10) < ymdLocal();
}

/** The open federal clocks on one I-9: Section 2 while it is pending, and
 *  reverification when the work authorization runs out. */
function i9DueDates(r: I9Verification): string[] {
  const out: string[] = [];
  if (!r.section2CompletedAt) {
    const due = rowSection2Due(r);
    if (due) out.push(ymdLocal(due));
  }
  if (r.reverifyDue && r.reverifyDueAt) out.push(r.reverifyDueAt.slice(0, 10));
  return out;
}

/** Whole days from local-today to `d` (negative = in the past). */
function daysFromToday(d: Date): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

/** Shared urgency tone: past → alert, within 2 days → warning, else muted. */
function toneForDays(days: number): string {
  if (days < 0) return 'text-alert';
  if (days <= 2) return 'text-warning';
  return 'text-silver';
}

const WORK_AUTH_WINDOW_DAYS = 90;

const I9_FILTERS = [
  { value: 'pending', label: 'Pending' },
  // Section 1 signed and the documents sent: HR's turn (the Inbox's
  // "I-9 Section 2 to complete" opens here).
  { value: 'ready', label: 'Ready for Section 2' },
  // Placed people with no I-9 record at all — the scorecard counts them
  // missing, so the list carries them too.
  { value: 'not_started', label: 'No I-9 on file' },
  // The KPI strip counts Section-2-overdue rows; this chip makes that
  // number a reachable view instead of just an alarm.
  { value: 'overdue', label: 'Overdue' },
  { value: 'complete', label: 'Complete' },
  // "All statuses", not "All": the group chips above have their own "All".
  { value: 'all', label: 'All statuses' },
  // Re-verification due by the one rule (owner, 2026-11-03): an alien
  // authorized to work, still employed, authorization ending within 90 days.
  { value: 'work_auth', label: 'Re-verification due' },
  // An end date with no Section 1 citizenship status (owner, 2026-11-03).
  { value: 'needs_review', label: 'Needs review' },
  // People who left whose I-9 is past its retention date (the later of
  // three years from hire or one year from the last day worked): may be destroyed.
  { value: 'retention', label: 'Past retention' },
] as const;

// Start-date window — "the newest hires' I-9s" without scanning the list.
// Deliberately keeps FUTURE start dates in every window: Section 2's
// deadline hangs off the start date, so an imminent hire is exactly who
// this filter is chasing. Rows with no start date only appear under "any".
type StartedFilter = 'any' | 'week' | 'month' | 'quarter';

function matchesStarted(startDate: string | null | undefined, f: StartedFilter): boolean {
  if (f === 'any') return true;
  if (!startDate) return false;
  const days = f === 'week' ? 7 : f === 'month' ? 30 : 90;
  return daysFromToday(parseLocalDate(startDate)) >= -days;
}

/** A row's I-9 state in words — the grid's sort key, search text and CSV. */
function i9StatusWords(r: I9Verification, notStarted: boolean): string {
  if (notStarted) return 'No I-9 on file';
  if (r.section2CompletedAt) return 'Complete';
  if (r.section1CompletedAt) return 'Section 2 pending';
  return 'Section 1 pending';
}

const DOC_LIST_LABELS: Record<I9DocumentList, string> = {
  LIST_A: 'List A',
  LIST_B_AND_C: 'Lists B + C',
};
type I9Filter = (typeof I9_FILTERS)[number]['value'];

/** A placed person with no I-9 record, as a row the list and the drawer
 *  can show: nothing done yet, Section 2 due from the hire date. The
 *  drawer's paper-I-9 form creates the record on save. */
export function notStartedRow(n: I9NotStarted): I9Verification {
  return {
    id: n.associateId,
    associateId: n.associateId,
    associateName: n.associateName,
    associateEmail: n.associateEmail ?? '',
    applicationId: null,
    section1CompletedAt: null,
    section2CompletedAt: null,
    section2VerifierUserId: null,
    section2VerifierEmail: null,
    documentList: null,
    supportingDocIds: [],
    startDate: n.hireDate,
    hireDate: n.hireDate,
    section2DueBy: n.section2DueBy,
    clientId: n.clientId,
    clientName: n.clientName,
    placed: true,
    photoUrl: n.photoUrl,
    workStatus: n.workStatus,
  };
}

export function I9Tab({ canManage }: { canManage: boolean }) {
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  // ?associateId= deep-links one person's I-9 (the onboarding checklist
  // links here) — start on the ALL filter so they're present whatever
  // their state, then auto-open their drawer once rows arrive.
  const [deepLinkParams, setDeepLinkParams] = useSearchParams();
  const deepLinkAssociateId = deepLinkParams.get('associateId');
  const deepLinkOpened = useRef(false);
  const navigate = useNavigate();
  // ?return= is the application drawer the reviewer came from. Captured
  // into state once (survives the URL cleanup below) so the drawer can
  // offer a way back and the verify success path can return automatically.
  const [returnPath] = useState<string | null>(() =>
    sanitizeReturnPath(deepLinkParams.get('return')),
  );
  // Consume the param: tab switches copy the current search params, so a
  // lingering ?return= would follow the user around the Compliance page
  // (and re-arm on refresh). replace: true keeps Back-button history sane.
  // ?status= — the Inbox's link names the view its count came from
  // (reverification due, past retention). One visit, consumed below.
  const [deepLinkStatus] = useState<I9Filter | null>(() => {
    const v = deepLinkParams.get('status');
    return I9_FILTERS.some((f) => f.value === v) ? (v as I9Filter) : null;
  });
  // Who the list is about (owner, 2026-11-03): the current workforce unless
  // a link names a group (?workforce=, this visit) or one person (All). A
  // link to "past retention" alone is about people who left: Former.
  const linkedWorkforce = useComplianceWorkforce({ wide: !!deepLinkAssociateId });
  const [workforceOverride, setWorkforceOverride] = useState<ComplianceWorkforce | null>(() =>
    deepLinkParams.get('status') === 'retention' && !deepLinkParams.has(WORKFORCE_PARAM) && !deepLinkAssociateId ? 'former' : null,
  );
  const workforce = workforceOverride ?? linkedWorkforce.workforce;
  const showLeavers = workforce === 'former' || workforce === 'all';
  const returnConsumed = useRef(false);
  useEffect(() => {
    if (returnConsumed.current || !['return', 'status', WORKFORCE_PARAM].some((k) => deepLinkParams.has(k))) return;
    returnConsumed.current = true;
    const params = new URLSearchParams(deepLinkParams);
    params.delete('return');
    params.delete('status');
    params.delete(WORKFORCE_PARAM);
    setDeepLinkParams(params, { replace: true });
  }, [deepLinkParams, setDeepLinkParams]);
  const [storedFilter, setStoredFilter] = usePersistentState<I9Filter>(
    'alto:list.compliance-i9.status.v1',
    'pending',
    (v): v is I9Filter => I9_FILTERS.some((f) => f.value === v),
  );
  // A deep link lands on ALL for this visit only — a checklist click must
  // not overwrite the chip the user deliberately saved.
  const [filterOverride, setFilterOverride] = useState<I9Filter | null>(
    deepLinkStatus ?? (deepLinkAssociateId ? 'all' : null),
  );
  const pickedFilter = filterOverride ?? storedFilter;
  // Past retention is a Former / All view: a saved pick of it never empties
  // the current workforce's list.
  const filter: I9Filter = pickedFilter === 'retention' && !showLeavers ? 'pending' : pickedFilter;
  const setFilter = (f: I9Filter) => {
    setFilterOverride(null);
    setStoredFilter(f);
  };
  // A day picked on the deadline strip — this visit only.
  const [dueDay, setDueDay] = useState<string | null>(null);
  const [started, setStarted] = useState<StartedFilter>('any');
  // '' = all clients; 'none' = rows with no client attribution.
  const [clientFilter, setClientFilter] = usePersistentState<string>(
    'alto:list.compliance-i9.client.v1',
    '',
    (v): v is string => typeof v === 'string',
  );
  // The global Topbar store scope is this tab's default client filter: adopt
  // it on arrival when one is chosen, follow later Topbar switches, and push
  // page-level changes back so Scheduling/Time/People stay in step. Deep
  // links skip the initial adoption so the scope can't hide the linked row.
  const storeScope = useStoreScope();
  const scopeClientId = storeScope.enabled ? storeScope.clientId : null;
  const scopeSyncedRef = useRef(false);
  useEffect(() => {
    if (scopeClientId === null) return;
    if (!scopeSyncedRef.current) {
      scopeSyncedRef.current = true;
      if (!scopeClientId || deepLinkAssociateId) return;
    }
    setClientFilter((prev) => (prev === scopeClientId ? prev : scopeClientId));
  }, [scopeClientId, deepLinkAssociateId, setClientFilter]);
  const changeClientFilter = (id: string) => {
    setClientFilter(id);
    // 'none' is a page-local synthetic bucket, not a store the scope knows.
    if (id !== 'none') storeScope.setClientId(id);
  };
  const setWorkforce = (w: ComplianceWorkforce) => {
    setWorkforceOverride(null);
    linkedWorkforce.setWorkforce(w);
    // Past retention is a Former / All view.
    if (filter === 'retention' && w !== 'former' && w !== 'all') setFilter('pending');
  };
  const [search, setSearch] = useState('');
  const [drawerTarget, setDrawerTarget] = useState<I9Verification | null>(null);
  // Bulk destroy on the Past retention view: the picked I-9 rows' ids.
  const [destroyPicks, setDestroyPicks] = useState<Set<string>>(() => new Set());
  const [bulkDestroyOpen, setBulkDestroyOpen] = useState(false);
  const rowsQuery = useQuery({
    queryKey: ['I9Tab', 'rows', workforce],
    // The whole group: the status filters are client-side views and the
    // KPI strip counts the group on view, not one slice of it.
    queryFn: () => listI9s('all', { workforce }),
  });
  // The I-9 records plus the placed people who have none: one population
  // with the scorecard (everyone hired and placed), so "I-9 complete" reads
  // the same number on both.
  const notStartedIds = useMemo(
    () => new Set((rowsQuery.data?.notStarted ?? []).map((n) => n.associateId)),
    [rowsQuery.data],
  );
  const rows: I9Verification[] | null = useMemo(
    () =>
      rowsQuery.data
        ? [...rowsQuery.data.i9s, ...(rowsQuery.data.notStarted ?? []).map(notStartedRow)]
        : null,
    [rowsQuery.data],
  );
  const error = rowsQuery.error
    ? rowsQuery.error instanceof ApiError
      ? rowsQuery.error.message
      : 'Failed to load.'
    : null;
  // Keep the open drawer pointed at the fresh row after a reload.
  useEffect(() => {
    const res = rowsQuery.data;
    if (res === undefined) return;
    setDrawerTarget((prev) =>
      prev ? res.i9s.find((r) => r.id === prev.id) ?? null : null,
    );
  }, [rowsQuery.data]);
  const refresh = async () => {
    await rowsQuery.refetch();
  };

  useEffect(() => {
    if (!deepLinkAssociateId || deepLinkOpened.current || !rows) return;
    const match = rows.find((r) => r.associateId === deepLinkAssociateId);
    if (match) {
      deepLinkOpened.current = true;
      setDrawerTarget(match);
    }
  }, [rows, deepLinkAssociateId]);


  const closeAndRefresh = () => {
    setDrawerTarget(null);
    refresh();
  };

  // Successful single verify: if the reviewer came from an application
  // drawer, put them back exactly where they were instead of stranding
  // them on this tab; otherwise close + refresh as before.
  const handleVerified = () => {
    if (returnPath) {
      navigate(returnPath);
      return;
    }
    closeAndRefresh();
  };

  // Hiring-wave assembly line (same pattern as EVerifyTab's "Next pending"):
  // after a successful verify, hop straight to the next Section-2-pending row
  // in the current filtered view instead of dumping HR back to the list.
  const advanceAfterVerify = () => {
    const list = displayRows ?? [];
    const currentId = drawerTarget?.id;
    const idx = currentId ? list.findIndex((r) => r.id === currentId) : -1;
    for (let i = 1; i <= list.length; i++) {
      const r = list[(idx + i) % list.length];
      if (r && r.id !== currentId && !r.section2CompletedAt) {
        setDrawerTarget(r);
        void refresh();
        return;
      }
    }
    toast.success('All caught up — no more pending I-9s in this view.');
    // The chain's final close honors the return path too.
    handleVerified();
  };

  // Client-side view over the fetched rows: work-auth window filter, name
  // search, then deadline-first ordering (pending rows with the earliest
  // Section 2 due date first; pending without a start date next; complete
  // rows last).
  const displayRows = useMemo(() => {
    if (!rows) return null;
    let list = rows;
    if (filter === 'retention') list = list.filter(pastRetention);
    if (dueDay) list = list.filter((r) => i9DueDates(r).some((d) => matchesDeadlineDay(d, dueDay)));
    if (filter === 'pending') list = list.filter((r) => !r.section2CompletedAt);
    if (filter === 'ready') list = list.filter((r) => !!r.documentsSubmittedAt && !r.section2CompletedAt);
    if (filter === 'not_started') list = list.filter((r) => notStartedIds.has(r.id));
    if (filter === 'complete') list = list.filter((r) => !!r.section2CompletedAt);
    if (filter === 'overdue') {
      // Mirrors the KPI: Section 2 not done and its 3-business-day
      // deadline already passed.
      list = list.filter((r) => {
        if (r.section2CompletedAt) return false;
        const due = rowSection2Due(r);
        return due !== null && daysFromToday(due) < 0;
      });
    }
    // The server's rule (an alien authorized to work, still employed).
    if (filter === 'work_auth') list = list.filter((r) => !!r.reverifyDue);
    if (filter === 'needs_review') list = list.filter((r) => !!r.needsReview);
    list = list.filter((r) => matchesStarted(r.hireDate ?? r.startDate, started));
    if (clientFilter) {
      list = list.filter((r) =>
        clientFilter === 'none' ? !r.clientId : r.clientId === clientFilter,
      );
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.associateName.toLowerCase().includes(q) ||
          r.associateEmail.toLowerCase().includes(q),
      );
    }
    const rank = (r: I9Verification): [number, number] => {
      if (r.section2CompletedAt) return [2, 0];
      const due = rowSection2Due(r);
      return due ? [0, due.getTime()] : [1, 0];
    };
    return [...list].sort((a, b) => {
      const [ga, ka] = rank(a);
      const [gb, kb] = rank(b);
      return ga - gb || ka - kb;
    });
  }, [rows, filter, started, clientFilter, search, dueDay, notStartedIds]);

  // Distinct clients present in the list, for the dropdown — derived from
  // the rows themselves so no extra fetch (and no /clients dependency).
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) {
      if (r.clientId && r.clientName) m.set(r.clientId, r.clientName);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const hasUnattributed = (rows ?? []).some((r) => !r.clientId);

  // The tiles count the same people the list shows (F500 audit 2026-10-26):
  // the whole population in the client in scope, before the status chips.
  // "Section 2 pending" read 0 over a Pending list of 33 "Section 2 due"
  // rows, because it skipped the people with no I-9 at all — who have
  // neither section done and whose Section 2 clock runs from their hire
  // date. Every pending count now includes them, as the list does.
  const inScope = (r: I9Verification) =>
    !clientFilter || (clientFilter === 'none' ? !r.clientId : r.clientId === clientFilter);
  // The tiles count the group on view (owner, 2026-11-03), so they never
  // count people the list won't show.
  const kpi = useMemo(() => {
    const all = (rows ?? []).filter(inScope);
    const placed = all.filter((r) => r.placed);
    const pending2 = all.filter((r) => !r.section2CompletedAt);
    return {
      // The scorecard's population and its I-9 line, the same rule.
      placed: placed.length,
      placedComplete: placed.filter((r) => !!r.section1CompletedAt && !!r.section2CompletedAt).length,
      notStarted: all.filter((r) => notStartedIds.has(r.id)).length,
      pendingS1: all.filter((r) => !r.section1CompletedAt).length,
      // Exactly the Pending view's rows.
      pendingS2: pending2.length,
      ready: pending2.filter((r) => !!r.documentsSubmittedAt).length,
      overdue: pending2.filter((r) => {
        const due = rowSection2Due(r);
        return due !== null && daysFromToday(due) < 0;
      }).length,
      complete: all.filter((r) => !!r.section2CompletedAt).length,
      workAuth: all.filter((r) => !!r.reverifyDue).length,
      needsReview: all.filter((r) => !!r.needsReview).length,
      retention: all.filter(pastRetention).length,
    };
    // inScope reads clientFilter, listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, notStartedIds, clientFilter]);
  // Reverification dates are a column only when someone re-verifies.
  const showReverify = (rows ?? []).some((r) => !!r.reverifyDueAt);
  const activeFilterCount =
    (filter !== 'pending' ? 1 : 0) + (clientFilter ? 1 : 0) + (started !== 'any' ? 1 : 0) + (dueDay ? 1 : 0);
  const clearFilters = () => {
    setFilter('pending');
    changeClientFilter('');
    setStarted('any');
    setDueDay(null);
    setSearch('');
  };
  const deadlineDates = useMemo(() => (rows ?? []).flatMap(i9DueDates), [rows]);

  return (
    <section>
      <DirectorateHeader
        icon={Fingerprint}
        title="I-9 verification"
        blurb={`Federal employment-eligibility verification — Section 1 by the ${term('worker').toLowerCase()}, Section 2 by HR within 3 business days of the first day of work`}
      />

      {rowsQuery.data?.truncated && (
        <ErrorBanner className="mb-3">
          This group is larger than the {rowsQuery.data.i9s.length.toLocaleString('en-US')} I-9s the list can show at once, so some are missing. Pick a smaller group.
        </ErrorBanner>
      )}

      {rows && rows.length > 0 && (
        <KpiStrip>
          {/* The numbers that have a view are that view's filter. */}
          {/* "I-9 complete" is the scorecard's I-9 line: placed people
              with both sections done, out of everyone placed. */}
          <Kpi label="I-9 complete" value={kpi.placedComplete} of={kpi.placed} />
          {kpi.notStarted > 0 && (
            <Kpi
              label="No I-9 on file"
              value={kpi.notStarted}
              tone="text-alert"
              onClick={() => setFilter('not_started')}
              active={filter === 'not_started'}
            />
          )}
          <Kpi
            label="Section 1 pending"
            value={kpi.pendingS1}
            tone={kpi.pendingS1 > 0 ? 'text-warning' : undefined}
          />
          {/* The Pending chip's own number: every row in that view. */}
          <Kpi
            label="Section 2 pending"
            value={kpi.pendingS2}
            tone={kpi.pendingS2 > 0 ? 'text-warning' : undefined}
            onClick={() => setFilter('pending')}
            active={filter === 'pending'}
          />
          {/* Documents in, HR's turn — the Inbox's "Section 2 to complete". */}
          <Kpi
            label="Ready for Section 2"
            value={kpi.ready}
            tone={kpi.ready > 0 ? 'text-warning' : undefined}
            onClick={() => setFilter('ready')}
            active={filter === 'ready'}
            hint="Section 1 is signed and the documents are in: HR examines them and completes Section 2."
          />
          <Kpi
            label="Overdue"
            value={kpi.overdue}
            tone={kpi.overdue > 0 ? 'text-alert' : undefined}
            onClick={() => setFilter('overdue')}
            active={filter === 'overdue'}
          />
          <Kpi
            label={`Reverify within ${WORK_AUTH_WINDOW_DAYS} days`}
            value={kpi.workAuth}
            tone={kpi.workAuth > 0 ? 'text-alert' : undefined}
            onClick={() => setFilter('work_auth')}
            active={filter === 'work_auth'}
            hint="Only people whose I-9 says “an alien authorized to work”, still employed, whose authorization ended or ends within 90 days. Citizens, nationals and permanent residents never re-verify."
          />
          {(kpi.needsReview > 0 || filter === 'needs_review') && (
            <Kpi
              label="Needs review"
              value={kpi.needsReview}
              tone={kpi.needsReview > 0 ? 'text-warning' : undefined}
              onClick={() => setFilter('needs_review')}
              active={filter === 'needs_review'}
              hint="Citizenship status missing — check Section 1 and the expiry date. These I-9s have a work-authorization end date but no citizenship status, so nobody can tell whether it must be re-verified."
            />
          )}
          {showLeavers && (
            <Kpi
              label="Past retention"
              value={kpi.retention}
              tone={kpi.retention > 0 ? 'text-warning' : undefined}
              onClick={() => setFilter('retention')}
              active={filter === 'retention'}
              hint="People who left: three years since they were hired and a year since their last day have both passed. Their I-9s may now be destroyed."
            />
          )}
        </KpiStrip>
      )}

      {rows && (
        <DeadlineStrip
          title="I-9 deadlines"
          what="Section 2 and reverification deadlines"
          dueDates={deadlineDates}
          selectedDay={dueDay}
          onSelectDay={setDueDay}
        />
      )}

      <WorkforceFilter className="mb-2 flex flex-wrap gap-2" value={workforce} onChange={setWorkforce} counts={rowsQuery.data?.workforceCounts} />

      <FilterBar
        className="mb-3"
        search={
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name…"
            aria-label="Search by name"
            wrapperClassName="min-w-0 w-full sm:w-64"
          />
        }
        activeFilters={activeFilterCount}
        onClearFilters={clearFilters}
        sheetDescription="Narrow the I-9 list by status, client and start date."
      >
        {I9_FILTERS.filter((f) => (f.value !== 'not_started' || kpi.notStarted > 0) && (f.value !== 'retention' || showLeavers)).map((f) => (
          <FilterChip
            key={f.value}
            active={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </FilterChip>
        ))}
        {hasClients && (
        <Select
          value={clientFilter}
          onChange={(e) => changeClientFilter(e.target.value)}
          size="sm"
          className="w-auto"
          aria-label="Filter by client"
        >
          <option value="">All clients</option>
          {clientOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
          {hasUnattributed && <option value="none">No client on record</option>}
        </Select>
        )}
        <Select
          value={started}
          onChange={(e) => setStarted(e.target.value as StartedFilter)}
          size="sm"
          className="w-auto"
          aria-label="Filter by start date"
        >
          <option value="any">Started any time</option>
          <option value="week">Started in the last 7 days (or upcoming)</option>
          <option value="month">Started in the last 30 days (or upcoming)</option>
          <option value="quarter">Started in the last 90 days (or upcoming)</option>
        </Select>
      </FilterBar>

      {/* The I-9 list (F500 audit 2026-10-26): one DataGrid — sortable,
          exportable, a card per row on a phone — where a hand-built bordered
          card per person used to stack. Filters stay above it, so an empty
          view never hides the chips that would refill it. */}
      <DataGrid<I9Verification>
        id="compliance-i9"
        caption="I-9 records"
        noun={{ one: 'I-9', many: 'I-9s' }}
        rows={displayRows}
        loading={!displayRows && !error}
        error={error}
        onRetry={() => void refresh()}
        rowKey={(r) => r.id}
        search={false}
        urlState={false}
        toolbar="inline"
        // The group is in the file's name (owner, 2026-11-03).
        exportCsv={{ filename: `i9-${workforce}-${ymdLocal()}` }}
        onRowClick={(r) => setDrawerTarget(r)}
        rowActionLabel={(r) => `Open ${r.associateName}’s I-9`}
        // Past retention: pick several and destroy them in one step (owner,
        // 2026-11-03). Each is checked again on the server.
        {...(canManage && filter === 'retention'
          ? {
              selectable: {
                selection: { selected: destroyPicks, onChange: setDestroyPicks },
                selectAllLabel: 'Select every I-9 past retention',
                actions: (selected: string[]) => (
                  <Button size="sm" variant="destructive" onClick={() => setBulkDestroyOpen(true)} disabled={selected.length === 0}>
                    Destroy {selected.length === 1 ? '1 I-9' : `${selected.length} I-9s`}
                  </Button>
                ),
              },
            }
          : {})}
        empty={{
          icon: FileCheck,
          title: 'No I-9 records match this filter',
          description: `Switch to a different filter or group, clear the search, or wait for ${term('workers').toLowerCase()} to complete Section 1.`,
        }}
        columns={[
          {
            key: 'person',
            header: term('worker'),
            accessor: (r) => r.associateName,
            csv: (r) => r.associateName,
            sortable: true,
            primary: true,
            cell: (r) => (
              <span className="flex min-w-0 items-center gap-3">
                <Avatar src={personPhotoUrl(r)} name={r.associateName} email={r.associateEmail} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{r.associateName}</span>
                  {(r.associateEmail || r.clientName) && (
                    <span className="block truncate text-xs text-ink-muted">
                      {[hasClients ? r.clientName : null, r.associateEmail].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
              </span>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            accessor: (r) => i9StatusWords(r, notStartedIds.has(r.id)),
            sortable: true,
            cardMeta: true,
            cell: (r) => (
              <span className="flex flex-wrap items-center gap-1.5">
                {notStartedIds.has(r.id) ? (
                  <Badge variant="destructive">No I-9 on file</Badge>
                ) : (
                  <>
                    <SectionBadge label="Section 1" done={!!r.section1CompletedAt} />
                    <SectionBadge label="Section 2" done={!!r.section2CompletedAt} />
                  </>
                )}
                {r.documentList && <Badge variant="outline">{DOC_LIST_LABELS[r.documentList]}</Badge>}
                {r.needsReview && (
                  <Badge variant="pending" title="Citizenship status missing — check Section 1 and the expiry date.">
                    Needs review
                  </Badge>
                )}
              </span>
            ),
          },
          {
            // Where the person stands (owner, 2026-11-03): someone who left
            // read "Onboarding" here, from a placed flag that only knew
            // "not placed".
            key: 'employment',
            header: 'Employment',
            accessor: (r) => {
              const s = rowWorkStatus(r);
              return s ? workStatusEnglish(s) : null;
            },
            sortable: true,
            cardMeta: true,
            cell: (r) => {
              const s = rowWorkStatus(r);
              return s ? <PeopleStatusBadge status={s} /> : <span className="text-ink-subtle">—</span>;
            },
          },
          {
            key: 'sec2',
            header: 'Section 2 due',
            accessor: (r) => {
              if (r.section2CompletedAt) return null;
              return rowSection2Due(r)?.getTime() ?? null;
            },
            csv: (r) => {
              const due = r.section2CompletedAt ? null : rowSection2Due(r);
              return due ? ymdLocal(due) : '';
            },
            sortable: true,
            searchable: false,
            align: 'right',
            cardMeta: true,
            className: 'tabular-nums whitespace-nowrap',
            cell: (r) => <Section2DueCell row={r} />,
          },
          ...(showReverify
            ? [
                {
                  key: 'reverify',
                  header: 'Reverify by',
                  accessor: (r: I9Verification) => (r.reverifyDueAt ?? r.workAuthExpiresAt ?? '').slice(0, 10) || null,
                  sortable: true,
                  searchable: false,
                  align: 'right' as const,
                  className: 'tabular-nums whitespace-nowrap',
                  cell: (r: I9Verification) => {
                    const v = (r.reverifyDueAt ?? r.workAuthExpiresAt)?.slice(0, 10);
                    if (!v) return <span className="text-ink-subtle">—</span>;
                    return (
                      <span className={cn('text-xs', toneForDays(daysFromToday(parseLocalDate(v))))}>
                        {fmtDateOnly(v, { year: 'auto' })}
                      </span>
                    );
                  },
                },
              ]
            : []),
          ...(showLeavers
            ? [
                {
                  key: 'left',
                  header: 'Left',
                  accessor: (r: I9Verification) => r.leftOn ?? null,
                  sortable: true,
                  searchable: false,
                  align: 'right' as const,
                  className: 'tabular-nums whitespace-nowrap',
                  cell: (r: I9Verification) =>
                    r.leftOn ? (
                      <span className="text-xs text-ink-muted">{fmtDateOnly(r.leftOn, { year: 'auto' })}</span>
                    ) : (
                      <span className="text-ink-subtle">—</span>
                    ),
                },
                {
                  key: 'retain',
                  header: 'Retain until',
                  accessor: (r: I9Verification) => r.retainUntil?.slice(0, 10) ?? null,
                  sortable: true,
                  searchable: false,
                  align: 'right' as const,
                  className: 'tabular-nums whitespace-nowrap',
                  cell: (r: I9Verification) =>
                    r.retainUntil ? (
                      <span className={cn('text-xs', r.retainUntil < ymdLocal() ? 'text-warning' : 'text-ink-muted')}>
                        {fmtDateOnly(r.retainUntil.slice(0, 10), { year: 'auto' })}
                      </span>
                    ) : (
                      <span className="text-ink-subtle">—</span>
                    ),
                },
              ]
            : []),
        ]}
      />

      {bulkDestroyOpen && (
        <DestroyI9Dialog
          count={destroyPicks.size}
          onClose={() => setBulkDestroyOpen(false)}
          onConfirm={async (typed) => {
            const ids = (displayRows ?? []).filter((r) => destroyPicks.has(r.id)).map((r) => r.associateId);
            const res = await destroyI9s(ids, typed);
            setBulkDestroyOpen(false);
            setDestroyPicks(new Set());
            reportDestroyed(res);
            void refresh();
          }}
        />
      )}

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-3xl"
      >
        {drawerTarget && (
          <I9DetailPanel
            // Keyed so "Verify & next" resets the verifier's picks/doc-list
            // state when the drawer hops to another associate.
            key={drawerTarget.id}
            current={drawerTarget}
            canManage={canManage}
            onDone={closeAndRefresh}
            onVerified={handleVerified}
            onVerifiedNext={advanceAfterVerify}
            onRefresh={() => void refresh()}
            returnPath={returnPath}
          />
        )}
      </Drawer>
    </section>
  );
}

/** "Section 2 due" cell: "941 days overdue" in alert, due within 2 days in
 *  warning, otherwise a muted date ("Nov 2"). "Done" when complete; a dash
 *  when there is no start date to count from. */
function Section2DueCell({ row }: { row: I9Verification }) {
  if (row.section2CompletedAt) {
    return <span className="text-xs text-ink-muted">Done</span>;
  }
  const due = rowSection2Due(row);
  if (!due) return <span className="text-xs text-ink-subtle" title="No first day of work on file">—</span>;
  const days = daysFromToday(due);
  if (days < 0) {
    return (
      <span className="text-xs font-medium text-alert" title={`Was due ${fmtDate(due)}`}>
        {-days === 1 ? '1 day overdue' : `${(-days).toLocaleString('en-US')} days overdue`}
      </span>
    );
  }
  return (
    <span className={cn('text-xs tabular-nums', toneForDays(days))}>
      {days === 0 ? 'Today' : fmtDateOnly(ymdLocal(due), { year: 'auto' })}
    </span>
  );
}

function SectionBadge({ label, done }: { label: string; done: boolean }) {
  return (
    <Badge variant={done ? 'success' : 'destructive'}>
      {done ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <XCircle className="h-3 w-3" />
      )}
      <span>{label}</span>
    </Badge>
  );
}

function I9DetailPanel({
  current,
  canManage,
  onDone,
  onVerified,
  onVerifiedNext,
  onRefresh,
  returnPath,
}: {
  current: I9Verification;
  canManage: boolean;
  onDone: () => void;
  /** Successful single verify — honors the ?return= round-trip. */
  onVerified: () => void;
  /** After a successful verify, advance to the next pending row in view. */
  onVerifiedNext: () => void;
  /** Reload the list without closing the drawer (in-place updates). */
  onRefresh: () => void;
  /** Application page the reviewer deep-linked from (null = none). */
  returnPath: string | null;
}) {
  const sec1Done = !!current.section1CompletedAt;
  const sec2Done = !!current.section2CompletedAt;
  const showVerifier = canManage && sec1Done && !sec2Done && !!current.applicationId;
  // Re-verification by the server's rule (owner, 2026-11-03): an alien
  // authorized to work, still employed, authorization ending within 90 days.
  const reverifyDue = canManage && !!current.reverifyDue;
  const reverifies = current.citizenshipStatus === 'ALIEN_AUTHORIZED_TO_WORK';
  const status = rowWorkStatus(current);
  const firstDay = current.hireDate ?? current.startDate ?? null;
  const isRecord = current.id !== current.associateId;
  // A rehire may reuse the original I-9 (Supplement B) when this employment
  // began after it was completed — within 3 years of it (owner, 2026-11-03).
  const rehire = rehireStanding(current);
  const supplementKinds: SupplementKind[] = [
    ...(reverifyDue ? (['REVERIFICATION'] as const) : []),
    ...(canManage && rehire === 'eligible' ? (['REHIRE'] as const) : []),
  ];
  const [destroyOpen, setDestroyOpen] = useState(false);
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar
            src={personPhotoUrl(current)}
            name={current.associateName}
            email={current.associateEmail}
            size="md"
          />
          <div className="min-w-0">
            <DrawerTitle className="truncate">{current.associateName}</DrawerTitle>
            <DrawerDescription className="truncate">
              {current.associateEmail}
            </DrawerDescription>
          </div>
          <div className="ml-auto flex shrink-0 flex-col items-end gap-1.5">
            {returnPath && (
              <Link
                to={returnPath}
                className="inline-flex items-center gap-1 text-xs text-gold hover:underline"
              >
                <ArrowLeft className="h-3 w-3" />
                Back to application
              </Link>
            )}
            <Link
              to={`/people?associateId=${current.associateId}`}
              className="inline-flex items-center gap-1 text-xs text-gold hover:underline"
            >
              View profile
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <SectionBadge label="Section 1" done={sec1Done} />
          <SectionBadge label="Section 2" done={sec2Done} />
          {current.documentList && (
            <Badge variant="outline">{DOC_LIST_LABELS[current.documentList]}</Badge>
          )}
          {status && <PeopleStatusBadge status={status} />}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs mb-5">
          <DetailRow label="Section 1 completed">
            {fmtDateTime(current.section1CompletedAt)}
          </DetailRow>
          <DetailRow label="Section 2 completed">
            {fmtDateTime(current.section2CompletedAt)}
          </DetailRow>
          <DetailRow label="Verifier">
            {current.section2VerifierEmail ?? '—'}
          </DetailRow>
          <DetailRow label="Supporting docs">
            {current.supportingDocIds.length
              ? `${current.supportingDocIds.length} on file`
              : '—'}
          </DetailRow>
          {/* The one hire date (owner, 2026-11-03): Section 2 runs from it. */}
          <DetailRow label="First day of work">
            {firstDay ? fmtDate(parseLocalDate(firstDay)) : '—'}
          </DetailRow>
          <DetailRow label="Documents examined">
            {current.section2ExaminedOn
              ? fmtDate(parseLocalDate(current.section2ExaminedOn))
              : current.section2CompletedAt
                ? fmtDate(current.section2CompletedAt)
                : '—'}
          </DetailRow>
          {current.leftOn && (
            <>
              <DetailRow label="Last day worked">{fmtDate(parseLocalDate(current.leftOn))}</DetailRow>
              <DetailRow label="Keep the I-9 until">
                {current.retainUntil ? (
                  <span className={pastRetention(current) ? 'text-warning' : undefined}>
                    {fmtDate(parseLocalDate(current.retainUntil.slice(0, 10)))}
                  </span>
                ) : (
                  '—'
                )}
              </DetailRow>
            </>
          )}
          <DetailRow label="Work auth expires">
            {current.workAuthExpiresAt ? (
              <span
                className={toneForDays(
                  daysFromToday(parseLocalDate(current.workAuthExpiresAt)),
                )}
              >
                {fmtDate(parseLocalDate(current.workAuthExpiresAt))}
              </span>
            ) : (
              '—'
            )}
          </DetailRow>
        </dl>

        {current.needsReview && (
          <div className="mb-5 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-xs">
            <div className="font-medium text-ink">Citizenship status missing — check Section 1 and the expiry date</div>
            <p className="mt-0.5 text-silver">
              This I-9 has a work-authorization end date
              {current.workAuthExpiresAt ? ` (${fmtDate(parseLocalDate(current.workAuthExpiresAt))})` : ''} but no
              citizenship status, so nobody can tell whether it must be re-verified. Find the paper Section 1 and record the
              status the employee checked.
            </p>
            {canManage && isRecord && <CitizenshipRecorder current={current} onSaved={onRefresh} />}
          </div>
        )}
        {supplementKinds.length > 0 && isRecord && <ReverificationForm current={current} kinds={supplementKinds} onSaved={onRefresh} />}
        {canManage && rehire === 'too_late' && (
          <p className="mb-5 rounded-md border border-navy-secondary p-3 text-xs text-silver">
            Rehired more than 3 years after the original I-9: complete a new I-9.
          </p>
        )}
        {(reverifies || !!current.rehireOn) && isRecord && <ReverificationHistory associateId={current.associateId} />}
        {canManage && isRecord && pastRetention(current) && (
          <div className="mb-5 rounded-md border border-alert/40 bg-alert/[0.06] p-3 text-xs">
            <div className="font-medium text-ink">Past retention</div>
            <p className="mt-0.5 text-silver">
              Kept until {current.retainUntil ? fmtDate(parseLocalDate(current.retainUntil.slice(0, 10))) : '—'}, the later of three
              years from hire and one year from the last day worked. It may now be destroyed.
            </p>
            <Button size="sm" variant="destructive" className="mt-2" onClick={() => setDestroyOpen(true)}>
              Destroy I-9
            </Button>
          </div>
        )}
        {destroyOpen && (
          <DestroyI9Dialog
            count={1}
            name={current.associateName}
            onClose={() => setDestroyOpen(false)}
            onConfirm={async (typed) => {
              const res = await destroyI9(current.associateId, typed);
              setDestroyOpen(false);
              reportDestroyed(res);
              onDone();
            }}
          />
        )}

        {showVerifier && current.applicationId && (
          <Section2Verifier
            applicationId={current.applicationId}
            associateId={current.associateId}
            onDone={onVerified}
            onDoneNext={onVerifiedNext}
          />
        )}
        {canManage && !showVerifier && (
          <I9EditForm current={current} onSaved={onDone} />
        )}
        {!canManage && (
          <p className="text-xs text-silver">
            Read-only view. Section 2 verification is restricted to HR.
          </p>
        )}
      </DrawerBody>
    </>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-widest text-silver/80">{label}</dt>
      <dd className="text-white text-sm mt-0.5">{children}</dd>
    </div>
  );
}

type SupplementKind = 'REVERIFICATION' | 'REHIRE';

/** The last day a rehire may reuse an I-9 completed on `original` (3 years). */
function rehireReuseEnds(original: string): string {
  const d = parseLocalDate(original);
  return ymdLocal(new Date(d.getFullYear() + 3, d.getMonth(), d.getDate()));
}

/**
 * Where a rehire stands on Supplement B (owner, 2026-11-03): a person
 * rehired after the original I-9 was completed may reuse it within 3
 * years ('eligible'); later, a new I-9 ('too_late'). Null for anyone not
 * rehired, and once a rehire is recorded for this employment.
 */
function rehireStanding(r: I9Verification): 'eligible' | 'too_late' | null {
  const hire = r.hireDate;
  const original = r.originalSection2On;
  if (!r.rehired || !hire || !original || hire <= original) return null;
  if (r.rehireOn && r.rehireOn >= hire) return null;
  return hire <= rehireReuseEnds(original) ? 'eligible' : 'too_late';
}

/** Documents Supplement B commonly records: any List A or List C document (never List B). */
const REVERIFY_DOC_SUGGESTIONS = [
  'Employment Authorization Document (Form I-766)',
  'Foreign passport with Form I-94 or I-94A',
  'Form I-94 or I-94A with a refugee or asylee admission stamp',
  'Unrestricted Social Security card',
  'Form I-797C extension notice with the expired EAD',
];

const SUPPLEMENT_KIND_LABEL: Record<SupplementKind, string> = {
  REVERIFICATION: 'Re-verification',
  REHIRE: 'Rehire (reuse this I-9)',
};

/**
 * Supplement B (owner, 2026-11-03).
 *
 * Re-verification: the document HR examined and the new end of the
 * authorization — saving moves the I-9's end date in one step, so the row
 * leaves "re-verification due" and scheduling reads the new date. Offered
 * for an alien authorized to work whose authorization ends within 90 days.
 *
 * Rehire: the person came back within 3 years of the original I-9, which is
 * reused — the rehire date, and the re-verified document when their
 * authorization had ended by then. With an earlier E-Verify case that ended
 * Employment Authorized, no new case is needed. The server checks again.
 */
function ReverificationForm({
  current,
  kinds,
  onSaved,
}: {
  current: I9Verification;
  kinds: SupplementKind[];
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<SupplementKind>(kinds[0]!);
  const [rehiredOn, setRehiredOn] = useState(current.hireDate ?? ymdLocal());
  const [title, setTitle] = useState('');
  const [number, setNumber] = useState('');
  const [authority, setAuthority] = useState('');
  const [expiry, setExpiry] = useState('');
  const [noExpiry, setNoExpiry] = useState(false);
  const [reviewedOn, setReviewedOn] = useState(ymdLocal());
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = ymdLocal();
  // A rehire re-verifies only when the authorization had ended by the rehire day.
  const rehireNeedsDocument =
    kind === 'REHIRE' &&
    current.citizenshipStatus === 'ALIEN_AUTHORIZED_TO_WORK' &&
    !!current.workAuthExpiresAt &&
    current.workAuthExpiresAt < rehiredOn;
  const withDocument = kind === 'REVERIFICATION' || rehireNeedsDocument;
  const documentReady = title.trim().length >= 2 && number.trim().length >= 2 && (noExpiry || !!expiry);
  const ready =
    !!reviewedOn &&
    reviewedOn <= today &&
    (kind !== 'REHIRE' || !!rehiredOn) &&
    (!withDocument || documentReady);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !ready) return;
    setSaving(true);
    setError(null);
    try {
      await recordI9Reverification(current.associateId, {
        kind,
        ...(kind === 'REHIRE' ? { rehiredOn } : {}),
        ...(withDocument
          ? {
              documentTitle: title.trim(),
              documentNumber: number.trim(),
              issuingAuthority: authority.trim() || null,
              newExpiresAt: noExpiry ? null : expiry,
            }
          : {}),
        reviewedOn,
        notes: notes.trim() || null,
      });
      toast.success(kind === 'REHIRE' ? 'Rehire recorded on Supplement B.' : 'Re-verification recorded.');
      await qc.invalidateQueries({ queryKey: ['I9Tab', 'reverifications', current.associateId] });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record it.');
    } finally {
      setSaving(false);
    }
  };

  const id = (k: string) => `reverify-${k}-${current.id}`;
  return (
    <form onSubmit={save} className="mb-5 space-y-3 rounded-md border border-warning/40 bg-warning/[0.07] p-3">
      <div>
        <div className="text-2xs uppercase tracking-widest text-silver/80">Record on Supplement B</div>
        <p className="mt-0.5 text-2xs text-silver/60">
          {kind === 'REHIRE'
            ? `Rehired within 3 years of the original I-9 (completed ${current.originalSection2On ? fmtDate(parseLocalDate(current.originalSection2On)) : '—'}): record the rehire to reuse it.`
            : `${current.workAuthExpiresAt ? `The work authorization ${daysFromToday(parseLocalDate(current.workAuthExpiresAt)) < 0 ? 'ended' : 'ends'} ${fmtDate(parseLocalDate(current.workAuthExpiresAt))}. ` : ''}Examine a List A or List C document they choose, then record it here. The new end date replaces the old one.`}
        </p>
      </div>
      {kinds.length > 1 && (
        <div>
          <Label htmlFor={id('kind')}>What are you recording?</Label>
          <Select id={id('kind')} value={kind} onChange={(e) => setKind(e.target.value as SupplementKind)} className="mt-1">
            {kinds.map((k) => (
              <option key={k} value={k}>
                {SUPPLEMENT_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {kind === 'REHIRE' && (
          <div>
            <Label htmlFor={id('rehired')}>Rehire date</Label>
            <Input id={id('rehired')} type="date" value={rehiredOn} min={current.originalSection2On ?? undefined} onChange={(e) => setRehiredOn(e.target.value)} className="mt-1 h-9 text-sm" />
          </div>
        )}
        {kind === 'REHIRE' && (
          <p className="text-2xs text-silver/70 sm:col-span-2">
            {rehireNeedsDocument
              ? 'Their work authorization ended before the rehire date: examine a List A or List C document and record it below.'
              : 'Their work authorization hasn’t ended: no new document is needed.'}
          </p>
        )}
        {withDocument && (
          <>
            <div className="sm:col-span-2">
              <Label htmlFor={id('title')}>Document</Label>
              <Input id={id('title')} list={id('titles')} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 h-9 text-sm" placeholder="Employment Authorization Document (Form I-766)" />
              <datalist id={id('titles')}>
                {REVERIFY_DOC_SUGGESTIONS.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
            <div>
              <Label htmlFor={id('number')}>Document number</Label>
              <Input id={id('number')} value={number} onChange={(e) => setNumber(e.target.value)} className="mt-1 h-9 text-sm" autoComplete="off" />
            </div>
            <div>
              <Label htmlFor={id('authority')}>Issued by (optional)</Label>
              <Input id={id('authority')} value={authority} onChange={(e) => setAuthority(e.target.value)} className="mt-1 h-9 text-sm" placeholder="USCIS" />
            </div>
            <div>
              <Label htmlFor={id('expiry')}>New expiry date</Label>
              <Input id={id('expiry')} type="date" value={noExpiry ? '' : expiry} disabled={noExpiry} min={today} onChange={(e) => setExpiry(e.target.value)} className="mt-1 h-9 text-sm" />
              <label className="mt-1.5 flex items-center gap-2 text-xs text-silver">
                <input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} />
                This document doesn&apos;t expire
              </label>
            </div>
          </>
        )}
        <div>
          <Label htmlFor={id('reviewed')}>{withDocument ? 'Date examined' : 'Date recorded'}</Label>
          <Input id={id('reviewed')} type="date" value={reviewedOn} max={today} onChange={(e) => setReviewedOn(e.target.value)} className="mt-1 h-9 text-sm" />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor={id('notes')}>Notes (optional)</Label>
          <Input id={id('notes')} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 h-9 text-sm" />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" loading={saving} disabled={saving || !ready}>
        {kind === 'REHIRE' ? 'Record rehire' : 'Record re-verification'}
      </Button>
    </form>
  );
}

/** The person's Supplement B entries, newest first. The document number shows its last four only. */
function ReverificationHistory({ associateId }: { associateId: string }) {
  const q = useQuery({
    queryKey: ['I9Tab', 'reverifications', associateId],
    queryFn: () => listI9Reverifications(associateId),
  });
  const list = q.data?.reverifications ?? [];
  if (q.isLoading) return <SkeletonRows count={1} />;
  return (
    <div className="mb-5">
      <div className="text-2xs uppercase tracking-widest text-silver/80">Supplement B</div>
      {q.isError ? (
        <p className="mt-1 text-xs text-alert">Couldn&apos;t load the Supplement B entries.</p>
      ) : list.length === 0 ? (
        <p className="mt-1 text-xs text-silver/70">None recorded yet.</p>
      ) : (
        <ul className="mt-1 divide-y divide-navy-secondary rounded-md border border-navy-secondary">
          {list.map((r) => (
            <li key={r.id} className="px-3 py-2 text-xs">
              <div className="text-ink">
                {r.kind === 'REHIRE' ? `Rehired ${r.rehiredOn ? fmtDate(parseLocalDate(r.rehiredOn)) : ''} — I-9 reused` : 'Re-verified'}
                {r.documentTitle ? ` · ${r.documentTitle}` : ''}
                {r.documentNumberLast4 ? ` ••••${r.documentNumberLast4}` : ''}
                {r.issuingAuthority ? ` · ${r.issuingAuthority}` : ''}
              </div>
              <div className="text-silver/70">
                {r.documentTitle ? 'Examined' : 'Recorded'} {fmtDate(parseLocalDate(r.reviewedOn))}
                {r.reviewedByEmail ? ` by ${r.reviewedByEmail}` : ''}
                {r.documentTitle
                  ? ` · ${r.newExpiresAt ? `authorized until ${fmtDate(parseLocalDate(r.newExpiresAt))}` : 'no expiry'}${r.previousExpiresAt ? ` (was ${fmtDate(parseLocalDate(r.previousExpiresAt))})` : ''}`
                  : ''}
              </div>
              {r.notes && <div className="text-silver/70">{r.notes}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const CITIZENSHIP_OPTIONS = [
  { value: 'US_CITIZEN', label: 'A citizen of the United States' },
  { value: 'NON_CITIZEN_NATIONAL', label: 'A noncitizen national of the United States' },
  { value: 'LAWFUL_PERMANENT_RESIDENT', label: 'A lawful permanent resident' },
  { value: 'ALIEN_AUTHORIZED_TO_WORK', label: 'An alien authorized to work' },
] as const;
type CitizenshipValue = (typeof CITIZENSHIP_OPTIONS)[number]['value'];

/**
 * Needs review → resolved: HR types the box the employee checked on the
 * paper Section 1. Only offered while none is on file; an alien authorized
 * to work then re-verifies by the expiry date, anyone else never does.
 */
function CitizenshipRecorder({ current, onSaved }: { current: I9Verification; onSaved: () => void }) {
  const [value, setValue] = useState<CitizenshipValue | ''>('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!value || saving) return;
    setSaving(true);
    try {
      await upsertI9(current.associateId, { citizenshipStatus: value });
      toast.success('Citizenship status recorded from Section 1.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1">
        <Label htmlFor={`citizenship-${current.id}`}>Section 1 says the employee is</Label>
        <Select id={`citizenship-${current.id}`} value={value} onChange={(e) => setValue(e.target.value as CitizenshipValue | '')} className="mt-1">
          <option value="">Choose…</option>
          {CITIZENSHIP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <Button size="sm" onClick={() => void save()} loading={saving} disabled={!value || saving}>
        Record status
      </Button>
    </div>
  );
}

/** "2 I-9s destroyed", and why any were kept. */
function reportDestroyed(res: I9DestroyResponse) {
  const n = res.destroyed.length;
  if (n > 0) toast.success(n === 1 ? '1 I-9 destroyed.' : `${n} I-9s destroyed.`);
  if (res.refused.length > 0) {
    const first = res.refused[0]!.message;
    toast.warning(res.refused.length === 1 ? `1 I-9 was kept: ${first}` : `${res.refused.length} I-9s were kept. ${first}`);
  }
}

/**
 * Destroying an I-9 past retention (owner, 2026-11-03) is permanent: the
 * dialog says exactly what goes, and the confirm button waits for the typed
 * word DESTROY (one I-9) or the number of I-9s (several).
 */
function DestroyI9Dialog({
  count,
  name,
  onClose,
  onConfirm,
}: {
  count: number;
  name?: string;
  onClose: () => void;
  onConfirm: (typed: string) => Promise<void>;
}) {
  const word = count === 1 && name ? I9_DESTROY_WORD : String(count);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (typed.trim() !== word || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(typed.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not destroy.');
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{name ? `Destroy ${name}’s I-9?` : `Destroy ${count === 1 ? '1 I-9' : `${count} I-9s`}?`}</DialogTitle>
          <DialogDescription>
            This permanently deletes the I-9 form, its Supplement B entries, and the I-9 document copies (the documents
            Section 2 lists, the I-9 supporting papers and the E-Verify results). The person, their separation, pay and
            everything else stay. It can&apos;t be undone. Each I-9 is checked again: one that must still be kept is not
            destroyed.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="destroy-i9-confirm">Type {word} to confirm</Label>
          <Input id="destroy-i9-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="mt-1 h-9 text-sm" />
        </div>
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void go()} loading={busy} disabled={typed.trim() !== word || busy}>
            {count === 1 ? 'Destroy I-9' : `Destroy ${count} I-9s`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section2Verifier({
  applicationId,
  associateId,
  onDone,
  onDoneNext,
}: {
  applicationId: string;
  associateId: string;
  onDone: () => void;
  /** Success path for "Verify & next" — advance instead of closing. */
  onDoneNext: () => void;
}) {
  const [docs, setDocs] = useState<I9DocumentListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [documentList, setDocumentList] = useState<I9DocumentList>('LIST_A');
  // Which footer button is in flight — the two verify actions share the
  // guard but only the clicked one should show its spinner.
  const [submitting, setSubmitting] = useState<false | 'stay' | 'next'>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Index into `docs` currently open in the full-screen viewer. */
  const [viewerAt, setViewerAt] = useState<number | null>(null);

  const docsQuery = useQuery({
    queryKey: ['Section2Verifier', 'docs', applicationId],
    queryFn: () => listI9Documents(applicationId),
  });
  useEffect(() => {
    const res = docsQuery.data;
    if (res === undefined) return;
    setDocs(res.documents);
    const auto = autoDetectSection2(res.documents);
    if (auto) {
      setDocumentList(auto.documentList);
      setPicked(new Set(auto.preChecked));
    }
  }, [docsQuery.data]);
  useEffect(() => {
    if (!docsQuery.isError) return;
    const err = docsQuery.error;
    setLoadError(
      err instanceof ApiError ? err.message : 'Failed to load documents.',
    );
    setDocs([]);
  }, [docsQuery.isError, docsQuery.error]);

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const minDocs = minDocsForSection2List(documentList);
  const canSubmit = picked.size >= minDocs && !submitting;

  const handleSubmit = async (advance: boolean) => {
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(advance ? 'next' : 'stay');
    try {
      await submitI9Section2(applicationId, {
        documentList,
        supportingDocIds: Array.from(picked),
      });
      if (advance) onDoneNext();
      else onDone();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Verification failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="text-2xs uppercase tracking-widest text-silver/80">
        Section 2 verification
      </div>
      <div className="flex flex-wrap gap-3 items-center">
        <span className="block text-xs2 uppercase tracking-wider text-silver">
          Document list
        </span>
        {(['LIST_A', 'LIST_B_AND_C'] as const).map((opt) => (
          <label key={opt} className="text-sm text-white flex items-center gap-2">
            <input
              type="radio"
              name={`docList-${applicationId}`}
              value={opt}
              checked={documentList === opt}
              onChange={() => setDocumentList(opt)}
            />
            {opt === 'LIST_A'
              ? 'List A (identity + work auth in one doc)'
              : 'Lists B + C (identity + work auth)'}
          </label>
        ))}
      </div>

      {loadError && <ErrorBanner>{loadError}</ErrorBanner>}

      {docs === null && <SkeletonRows count={2} rowHeight="h-24" />}
      {docs !== null && docs.length === 0 && !loadError && (
        <p className="text-silver text-sm">
          No supporting documents uploaded yet — the associate must upload photos
          of their ID before Section 2 can be verified.
        </p>
      )}

      {docs && docs.length > 0 && (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs2 uppercase tracking-wider text-silver">
              Pick the documents you inspected (need at least {minDocs})
            </p>
            {/* Identity documents only — not the associate's whole file.
                Audited server-side like any bulk PII export. */}
            <a
              href={downloadAllDocumentsUrl(associateId, IDENTITY_DOC_KINDS)}
              className="inline-flex items-center gap-1.5 rounded border border-navy-secondary px-2 py-1 text-xs text-silver/80 transition-colors hover:border-gold/60 hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            >
              <Download className="h-3.5 w-3.5" />
              Download all
            </a>
          </div>
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {docs.map((doc) => {
              const isImage = doc.mimeType.startsWith('image/');
              const checked = picked.has(doc.id);
              const missing = !doc.fileAvailable;
              return (
                <li key={doc.id}>
                  <label
                    className={cn(
                      'block p-2 rounded border transition-colors',
                      missing
                        ? 'border-alert/40 bg-alert/5 cursor-not-allowed'
                        : checked
                          ? 'border-gold bg-gold/10 cursor-pointer'
                          : 'border-navy-secondary hover:border-silver/40 cursor-pointer',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked && !missing}
                      onChange={() => !missing && togglePick(doc.id)}
                      disabled={missing}
                      aria-label={`${doc.i9DocTitle ?? doc.kind} ${doc.side ?? ''}`.trim()}
                    />
                    <div className="aspect-[3/2] bg-navy-secondary rounded mb-2 overflow-hidden flex items-center justify-center">
                      {missing ? (
                        <span className="text-2xs text-alert text-center px-2 leading-tight">
                          File missing on server
                        </span>
                      ) : isImage ? (
                        <img
                          src={previewDocumentUrl(doc.id)}
                          alt={`${doc.i9DocTitle ?? doc.kind}${doc.side ? ` ${doc.side}` : ''}`}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="text-xs text-silver">PDF</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div className="text-xs text-white truncate">
                        {doc.i9DocTitle ?? doc.kind}
                      </div>
                      {doc.i9List && (
                        <Badge size="sm" variant="outline">
                          {doc.i9List}
                        </Badge>
                      )}
                    </div>
                    <div className="text-2xs text-silver">
                      {doc.side ?? 'document'}
                      {missing ? (
                        <> · <span className="text-alert">re-upload required</span></>
                      ) : (
                        <>
                          {' '}
                          ·{' '}
                          {/* Opens the in-site viewer rather than downloading.
                              This used to hand the reviewer a copy of the
                              associate's ID on every Section 2 check. */}
                          <button
                            type="button"
                            className="text-gold hover:underline"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setViewerAt(docs.findIndex((x) => x.id === doc.id));
                            }}
                            data-no-row-click
                          >
                            View
                          </button>
                        </>
                      )}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {viewerAt !== null && docs && docs.length > 0 && (
        <DocumentViewer
          documents={docs}
          startIndex={viewerAt}
          onClose={() => setViewerAt(null)}
        />
      )}

      {submitError && <ErrorBanner>{submitError}</ErrorBanner>}
      <DrawerFooter className="-mx-6 -mb-6 mt-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void handleSubmit(false)}
          loading={submitting === 'stay'}
          disabled={!canSubmit}
        >
          {`Verify Section 2 (${picked.size} doc${picked.size === 1 ? '' : 's'})`}
        </Button>
        <Button
          type="button"
          onClick={() => void handleSubmit(true)}
          loading={submitting === 'next'}
          disabled={!canSubmit}
          title="Verify, then open the next pending I-9 in this view."
        >
          Verify &amp; next
        </Button>
      </DrawerFooter>
    </div>
  );
}

function I9EditForm({
  current,
  onSaved,
}: {
  current: I9Verification;
  onSaved: () => void;
}) {
  const [section1Done, setSection1Done] = useState(!!current.section1CompletedAt);
  const [section2Done, setSection2Done] = useState(!!current.section2CompletedAt);
  const [documentList, setDocumentList] = useState<I9DocumentList | ''>(
    current.documentList ?? '',
  );
  // The day the documents were examined (owner, 2026-11-03): a paper or
  // late-entered Section 2 happened before it was typed in. Today by
  // default; never after today, never before the first day of work.
  const today = ymdLocal();
  const firstDay = current.hireDate ?? null;
  const [examinedOn, setExaminedOn] = useState(
    current.section2ExaminedOn ?? (current.section2CompletedAt ? ymdLocal(new Date(current.section2CompletedAt)) : today),
  );
  const [examinedTouched, setExaminedTouched] = useState(false);
  // Unticking a completed Section 2 erases a record of an examination
  // that happened: it needs a reason, kept in the audit trail.
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearing = !!current.section2CompletedAt && !section2Done;
  // Sent when Section 2 is newly ticked, or the date was changed by hand —
  // never invented for a Section 2 recorded before the date existed.
  const sendExamined = section2Done && (!current.section2CompletedAt || examinedTouched);
  const examinedBad = sendExamined && (!examinedOn || examinedOn > today || (!!firstDay && examinedOn < firstDay));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (clearing && reason.trim().length < 3) {
      setError('Say why Section 2 is being unticked.');
      return;
    }
    if (examinedBad) {
      setError(firstDay ? `The date examined must be between ${fmtDate(parseLocalDate(firstDay))} and today.` : 'The date examined can’t be after today.');
      return;
    }
    setError(null);
    setSubmitting(true);
    const now = new Date().toISOString();
    try {
      await upsertI9(current.associateId, {
        section1CompletedAt: section1Done
          ? current.section1CompletedAt ?? now
          : null,
        section2CompletedAt: section2Done
          ? current.section2CompletedAt ?? now
          : null,
        documentList: documentList === '' ? null : documentList,
        ...(sendExamined ? { section2ExaminedOn: examinedOn } : {}),
        ...(clearing ? { reason: reason.trim() } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="text-2xs uppercase tracking-widest text-silver/80">
        Manual edit
      </div>
      <div className="flex flex-wrap gap-4 items-end">
        <label className="text-sm text-white flex items-center gap-2">
          <input
            type="checkbox"
            checked={section1Done}
            onChange={(e) => setSection1Done(e.target.checked)}
          />
          Section 1 complete
        </label>
        <label className="text-sm text-white flex items-center gap-2">
          <input
            type="checkbox"
            checked={section2Done}
            onChange={(e) => setSection2Done(e.target.checked)}
          />
          Section 2 complete (HR verifies)
        </label>
        <label className="block">
          <span className="block text-xs2 uppercase tracking-wider text-silver mb-1">
            Document list
          </span>
          <div className="w-48">
            <Select
              value={documentList}
              onChange={(e) =>
                setDocumentList(e.target.value as I9DocumentList | '')
              }
            >
              <option value="">—</option>
              <option value="LIST_A">List A</option>
              <option value="LIST_B_AND_C">Lists B + C</option>
            </Select>
          </div>
        </label>
        {section2Done && (
          <div>
            <Label htmlFor={`examined-${current.id}`}>Date the documents were examined</Label>
            <Input
              id={`examined-${current.id}`}
              type="date"
              value={examinedOn}
              max={today}
              min={firstDay ?? undefined}
              onChange={(e) => {
                setExaminedOn(e.target.value);
                setExaminedTouched(true);
              }}
              className="mt-1 h-9 w-44 text-sm"
            />
          </div>
        )}
      </div>
      {clearing && (
        <div>
          <Label htmlFor={`untick-reason-${current.id}`}>Why is Section 2 being unticked?</Label>
          <Input
            id={`untick-reason-${current.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="For example: ticked on the wrong person"
            className="mt-1 h-9 text-sm"
          />
          <p className="mt-1 text-2xs text-silver/60">
            The completed Section 2 stays in the audit trail with your reason.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}
      <DrawerFooter className="-mx-6 -mb-6 mt-2">
        <Button type="submit" loading={submitting} disabled={submitting}>
          Save
        </Button>
      </DrawerFooter>
    </form>
  );
}
