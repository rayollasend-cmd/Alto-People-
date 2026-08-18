import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Download, ExternalLink, FileCheck, Fingerprint, XCircle } from 'lucide-react';
import { DirectorateHeader, Kpi, KpiStrip } from './DirectorateShell';
import type { I9DocumentList, I9Verification } from '@alto-people/shared';
import { listI9s, upsertI9 } from '@/lib/complianceApi';
import {
  listI9Documents,
  submitI9Section2,
  type I9DocumentListItem,
} from '@/lib/i9Api';
import { ApiError } from '@/lib/api';
import { DocumentViewer } from '@/components/DocumentViewer';
import {
  downloadAllDocumentsUrl,
  previewDocumentUrl,
  IDENTITY_DOC_KINDS,
} from '@/lib/documentsApi';
import { cn } from '@/lib/cn';
import { fmtDate, fmtDateTime } from '@/lib/format';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Select,
  SkeletonRows,
} from '@/components/ui';
import { FilterChip, SearchInput } from '@/components/ui/FilterBar';

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

/** Section 2 must be completed within 3 business days of the start date. */
function section2DueDate(startDate: string | null | undefined): Date | null {
  if (!startDate) return null;
  return addBusinessDays(parseLocalDate(startDate), 3);
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
  // The KPI strip counts Section-2-overdue rows; this chip makes that
  // number a reachable view instead of just an alarm.
  { value: 'overdue', label: 'Overdue' },
  { value: 'complete', label: 'Complete' },
  { value: 'all', label: 'All' },
  { value: 'work_auth', label: 'Work auth expiring' },
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

const DOC_LIST_LABELS: Record<I9DocumentList, string> = {
  LIST_A: 'List A',
  LIST_B_AND_C: 'Lists B + C',
};
type I9Filter = (typeof I9_FILTERS)[number]['value'];

export function I9Tab({ canManage }: { canManage: boolean }) {
  // ?associateId= deep-links one person's I-9 (the onboarding checklist
  // links here) — start on the ALL filter so they're present whatever
  // their state, then auto-open their drawer once rows arrive.
  const [deepLinkParams] = useSearchParams();
  const deepLinkAssociateId = deepLinkParams.get('associateId');
  const deepLinkOpened = useRef(false);
  const [filter, setFilter] = useState<I9Filter>(deepLinkAssociateId ? 'all' : 'pending');
  const [started, setStarted] = useState<StartedFilter>('any');
  // '' = all clients; 'none' = rows with no client attribution.
  const [clientFilter, setClientFilter] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<I9Verification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<I9Verification | null>(null);

  useEffect(() => {
    if (!deepLinkAssociateId || deepLinkOpened.current || !rows) return;
    const match = rows.find((r) => r.associateId === deepLinkAssociateId);
    if (match) {
      deepLinkOpened.current = true;
      setDrawerTarget(match);
    }
  }, [rows, deepLinkAssociateId]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      // Always fetch the full list: the filters are client-side views and
      // the KPI strip must count the whole population, not one slice.
      const res = await listI9s('all');
      setRows(res.i9s);
      setDrawerTarget((prev) =>
        prev ? res.i9s.find((r) => r.id === prev.id) ?? null : null,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const closeAndRefresh = () => {
    setDrawerTarget(null);
    refresh();
  };

  // Client-side view over the fetched rows: work-auth window filter, name
  // search, then deadline-first ordering (pending rows with the earliest
  // Section 2 due date first; pending without a start date next; complete
  // rows last).
  const displayRows = useMemo(() => {
    if (!rows) return null;
    let list = rows;
    if (filter === 'pending') list = list.filter((r) => !r.section2CompletedAt);
    if (filter === 'complete') list = list.filter((r) => !!r.section2CompletedAt);
    if (filter === 'overdue') {
      // Mirrors the KPI: Section 2 not done and its 3-business-day
      // deadline already passed.
      list = list.filter((r) => {
        if (r.section2CompletedAt) return false;
        const due = section2DueDate(r.startDate);
        return due !== null && due.getTime() < Date.now();
      });
    }
    if (filter === 'work_auth') {
      list = list.filter(
        (r) =>
          r.workAuthExpiresAt &&
          daysFromToday(parseLocalDate(r.workAuthExpiresAt)) <= WORK_AUTH_WINDOW_DAYS,
      );
    }
    list = list.filter((r) => matchesStarted(r.startDate, started));
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
      const due = section2DueDate(r.startDate);
      return due ? [0, due.getTime()] : [1, 0];
    };
    return [...list].sort((a, b) => {
      const [ga, ka] = rank(a);
      const [gb, kb] = rank(b);
      return ga - gb || ka - kb;
    });
  }, [rows, filter, started, clientFilter, search]);

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

  // Whole-population stats (rows is always the full list).
  const kpi = useMemo(() => {
    const all = rows ?? [];
    const pending2 = all.filter((r) => !r.section2CompletedAt);
    return {
      total: all.length,
      pendingS1: all.filter((r) => !r.section1CompletedAt).length,
      pendingS2: pending2.length,
      overdue: pending2.filter((r) => {
        const due = section2DueDate(r.startDate);
        return due !== null && due.getTime() < Date.now();
      }).length,
      complete: all.filter((r) => !!r.section2CompletedAt).length,
      workAuth: all.filter(
        (r) =>
          r.workAuthExpiresAt &&
          daysFromToday(parseLocalDate(r.workAuthExpiresAt)) <= WORK_AUTH_WINDOW_DAYS,
      ).length,
    };
  }, [rows]);

  return (
    <section>
      <DirectorateHeader
        icon={Fingerprint}
        title="I-9 verification"
        blurb="Federal employment-eligibility verification — Section 1 by the associate, Section 2 by HR within 3 business days of the start date"
      />

      {rows && rows.length > 0 && (
        <KpiStrip>
          <Kpi label="Associates" value={kpi.total} />
          <Kpi
            label="Section 1 pending"
            value={kpi.pendingS1}
            tone={kpi.pendingS1 > 0 ? 'text-warning' : undefined}
          />
          <Kpi
            label="Section 2 pending"
            value={kpi.pendingS2}
            tone={kpi.pendingS2 > 0 ? 'text-warning' : undefined}
          />
          <Kpi
            label="Overdue"
            value={kpi.overdue}
            tone={kpi.overdue > 0 ? 'text-alert' : undefined}
          />
          <Kpi label="Complete" value={kpi.complete} tone="text-success" />
          <Kpi
            label={`Work auth ≤ ${WORK_AUTH_WINDOW_DAYS}d`}
            value={kpi.workAuth}
            tone={kpi.workAuth > 0 ? 'text-alert' : undefined}
          />
        </KpiStrip>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {I9_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            active={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </FilterChip>
        ))}
        <Select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
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
        <div className="w-full sm:w-64 sm:ml-auto">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name…"
            aria-label="Search by name"
          />
        </div>
      </div>

      {error && (
        <ErrorBanner
          className="mb-3"
          action={
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      {!displayRows && !error && <SkeletonRows count={4} rowHeight="h-20" />}
      {displayRows && displayRows.length === 0 && (
        <EmptyState
          icon={FileCheck}
          title="No I-9 records match this filter"
          description="Switch to a different filter, clear the search, or wait for associates to complete Section 1."
        />
      )}
      {displayRows && displayRows.length > 0 && (
        <ul className="space-y-2">
          {displayRows.map((r) => {
            const sec1Done = !!r.section1CompletedAt;
            const sec2Done = !!r.section2CompletedAt;
            return (
              <li key={r.id}>
                <Card
                  className="group cursor-pointer transition-colors hover:border-gold/40"
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('button, a, input, [data-no-row-click]')) return;
                    if (window.getSelection()?.toString()) return;
                    setDrawerTarget(r);
                  }}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar name={r.associateName} email={r.associateEmail} size="md" />
                        <div className="min-w-0">
                          <div className="text-white font-medium truncate">
                            {r.associateName}
                          </div>
                          <div className="text-xs text-silver truncate">
                            {r.associateEmail}
                            {r.clientName ? ` · ${r.clientName}` : ''}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          <SectionBadge label="Sec 1" done={sec1Done} />
                          <SectionBadge label="Sec 2" done={sec2Done} />
                          {r.documentList && (
                            <Badge variant="outline">
                              {DOC_LIST_LABELS[r.documentList]}
                            </Badge>
                          )}
                        </div>
                        {r.workAuthExpiresAt && (
                          <div className="text-right">
                            <div className="text-2xs uppercase tracking-widest text-silver/80">
                              Work auth
                            </div>
                            <div
                              className={cn(
                                'text-xs tabular-nums',
                                toneForDays(
                                  daysFromToday(parseLocalDate(r.workAuthExpiresAt)),
                                ),
                              )}
                            >
                              {fmtDate(parseLocalDate(r.workAuthExpiresAt))}
                            </div>
                          </div>
                        )}
                        <div className="text-right min-w-[84px]">
                          <div className="text-2xs uppercase tracking-widest text-silver/80">
                            Sec 2 due
                          </div>
                          <Section2DueCell row={r} />
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-3xl"
      >
        {drawerTarget && (
          <I9DetailPanel
            current={drawerTarget}
            canManage={canManage}
            onDone={closeAndRefresh}
          />
        )}
      </Drawer>
    </section>
  );
}

/** "Section 2 due" cell: overdue Nd in alert, due within 2 days in warning,
 *  otherwise a muted date. Em dash when complete or no start date. */
function Section2DueCell({ row }: { row: I9Verification }) {
  if (row.section2CompletedAt) {
    return <div className="text-xs text-silver/60">—</div>;
  }
  const due = section2DueDate(row.startDate);
  if (!due) return <div className="text-xs text-silver/60">—</div>;
  const days = daysFromToday(due);
  if (days < 0) {
    return (
      <div className="text-xs font-medium text-alert">overdue {-days}d</div>
    );
  }
  return (
    <div className={cn('text-xs tabular-nums', toneForDays(days))}>
      {fmtDate(due)}
    </div>
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
}: {
  current: I9Verification;
  canManage: boolean;
  onDone: () => void;
}) {
  const sec1Done = !!current.section1CompletedAt;
  const sec2Done = !!current.section2CompletedAt;
  const showVerifier = canManage && sec1Done && !sec2Done && !!current.applicationId;
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar
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
          <Link
            to={`/people?associateId=${current.associateId}`}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-gold hover:underline"
          >
            View profile
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <SectionBadge label="Section 1" done={sec1Done} />
          <SectionBadge label="Section 2" done={sec2Done} />
          {current.documentList && (
            <Badge variant="outline">{DOC_LIST_LABELS[current.documentList]}</Badge>
          )}
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
          <DetailRow label="Start date">
            {current.startDate
              ? fmtDate(parseLocalDate(current.startDate))
              : '—'}
          </DetailRow>
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

        {showVerifier && current.applicationId && (
          <Section2Verifier
            applicationId={current.applicationId}
            associateId={current.associateId}
            onDone={onDone}
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

function Section2Verifier({
  applicationId,
  associateId,
  onDone,
}: {
  applicationId: string;
  associateId: string;
  onDone: () => void;
}) {
  const [docs, setDocs] = useState<I9DocumentListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [documentList, setDocumentList] = useState<I9DocumentList>('LIST_A');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Index into `docs` currently open in the full-screen viewer. */
  const [viewerAt, setViewerAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    listI9Documents(applicationId)
      .then((res) => {
        if (cancelled) return;
        setDocs(res.documents);
        // Pre-select the list the associate's classified uploads support —
        // a passport pre-picks List A, license + SSN card pre-pick B+C.
        // Unclassified (pre-catalog) docs suggest nothing; HR still decides.
        const usable = res.documents.filter((d) => d.status !== 'REJECTED');
        if (usable.some((d) => d.i9List === 'A')) {
          setDocumentList('LIST_A');
        } else if (
          usable.some((d) => d.i9List === 'B') &&
          usable.some((d) => d.i9List === 'C')
        ) {
          setDocumentList('LIST_B_AND_C');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError ? err.message : 'Failed to load documents.',
          );
          setDocs([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const minDocs = documentList === 'LIST_A' ? 1 : 2;
  const canSubmit = picked.size >= minDocs && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await submitI9Section2(applicationId, {
        documentList,
        supportingDocIds: Array.from(picked),
      });
      onDone();
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
          onClick={handleSubmit}
          loading={submitting}
          disabled={!canSubmit}
        >
          {`Verify Section 2 (${picked.size} doc${picked.size === 1 ? '' : 's'})`}
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
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
      </div>
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
