import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { nextInQueue } from '@/lib/queueNext';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { ClipboardList, Download, Plus, Star } from '@/components/ui/icons';
import { toast } from 'sonner';
import type {
  PerformanceReview,
  PerformanceReviewStatus,
} from '@alto-people/shared';
import {
  createReview,
  getReviewsSummary,
  listReviews,
  submitReview,
  type ReviewsSummary,
} from '@/lib/performanceApi';
import { useUrlParam } from '@/lib/useUrlState';
import { QueryError } from '@/components/ui/QueryError';
import { DataGrid } from '@/components/ui/DataGrid';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateOnly, fmtDateTime, parseYmd, ymdLocal } from '@/lib/format';
import { associatePhotoUrl } from '@/lib/photoUrl';
import { downloadCsv } from '@/lib/csv';
import { ListTemplate } from '@/components/templates';
import {
  AssociatePicker,
  type PickedAssociate,
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
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
  EmptyState,
  ErrorBanner,
  FilterChip,
  Field,
  Input,
  MetricCard,
  MetricStrip,
  SearchInput,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { useTerm } from '@/lib/auth';
import { ReviewRecordPanel } from './ReviewRecordPanel';
import { pickOne } from '@/lib/validationCopy';

/** Start/end of the most recently COMPLETED calendar quarter, as local
 *  "YYYY-MM-DD" — the natural default period for a new review. */
function lastCompletedQuarter(now = new Date()): { start: string; end: string } {
  const currentQuarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
  const start = new Date(now.getFullYear(), currentQuarterStartMonth - 3, 1);
  // Day 0 of the current quarter's first month = last day of the previous quarter.
  const end = new Date(now.getFullYear(), currentQuarterStartMonth, 0);
  return { start: ymdLocal(start), end: ymdLocal(end) };
}

function fmtPeriod(start: string, end: string): string {
  return `${fmtDate(parseYmd(start))} → ${fmtDate(parseYmd(end))}`;
}

/** The list's filter: a review status, the reviews that need action, or the people due for one. */
type ReviewFilter = 'NEEDS_ACTION' | PerformanceReviewStatus | 'ALL' | 'DUE' | 'OVERDUE';
const FILTER_VALUES: readonly ReviewFilter[] = ['NEEDS_ACTION', 'DRAFT', 'SUBMITTED', 'ACKNOWLEDGED', 'ALL', 'DUE', 'OVERDUE'];

const STATUS_FILTERS: Array<{ value: ReviewFilter; label: string }> = [
  { value: 'NEEDS_ACTION', label: 'Needs action' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { value: 'ALL', label: 'All' },
];

function statusQuery(f: ReviewFilter): PerformanceReviewStatus | PerformanceReviewStatus[] | undefined {
  if (f === 'NEEDS_ACTION') return ['DRAFT', 'SUBMITTED'];
  if (f === 'DRAFT' || f === 'SUBMITTED' || f === 'ACKNOWLEDGED') return f;
  return undefined;
}

function statusVariant(
  s: PerformanceReviewStatus,
): 'default' | 'pending' | 'success' | 'accent' {
  switch (s) {
    case 'DRAFT':
      return 'default';
    case 'SUBMITTED':
      return 'pending';
    case 'ACKNOWLEDGED':
      return 'success';
    default:
      return 'accent';
  }
}

const STATUS_LABELS: Record<PerformanceReviewStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  ACKNOWLEDGED: 'Acknowledged',
};

export function AdminReviewsView({ canManage }: { canManage: boolean }) {
  // The filter lives in the URL (?status=), and opens on what needs action.
  const [filter, setFilter] = useUrlParam<ReviewFilter>('status', 'NEEDS_ACTION', FILTER_VALUES);
  const peopleView = filter === 'DUE' || filter === 'OVERDUE';
  const summaryQ = useQuery({ queryKey: ['AdminReviewsView', 'summary'], queryFn: getReviewsSummary });
  const summary = summaryQ.data;
  const [showCreate, setShowCreate] = useState(false);
  const [errorLocal, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [submitTarget, setSubmitTarget] = useState<PerformanceReview | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<PerformanceReview | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const refreshQuery = useQuery({
    queryKey: ['AdminReviewsView', 'reviews', filter],
    queryFn: () => listReviews({ status: statusQuery(filter) }),
    enabled: !peopleView,
  });
  const reviews: PerformanceReview[] | null = refreshQuery.data?.reviews ?? null;
  const error = errorLocal ?? (refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Could not load reviews.' : null);
  useEffect(() => {
    const res = refreshQuery.data;
    if (res === undefined) return;
    setSelected((prev) => {
      const next = new Set<string>();
      for (const r of res.reviews) {
        if (r.status === 'DRAFT' && prev.has(r.id)) next.add(r.id);
      }
      return next;
    });
  }, [refreshQuery.data]);
  const refresh = async () => {
    await Promise.all([refreshQuery.refetch(), summaryQ.refetch()]);
  };


  const filtered = useMemo(() => {
    if (!reviews) return null;
    const term = search.trim().toLowerCase();
    if (!term) return reviews;
    return reviews.filter((r) => r.associateName.toLowerCase().includes(term));
  }, [reviews, search]);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onConfirmSubmit = async () => {
    if (!submitTarget) return;
    setPendingId(submitTarget.id);
    try {
      await submitReview(submitTarget.id);
      setSubmitTarget(null);
      await refresh();
      // Review season: open the next draft in the list instead of closing
      // and finding it; the drawer closes when no draft is left.
      setDrawerTarget((cur) =>
        cur ? nextInQueue(filtered ?? [], submitTarget.id, (r) => r.status === 'DRAFT' && r.id !== cur.id) : null,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit the review.');
    } finally {
      setPendingId(null);
    }
  };

  const onConfirmBulkSubmit = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBulkBusy(true);
    let ok = 0;
    let failed = 0;
    // The API only exposes single-review submit; loop it sequentially so
    // one failure doesn't abort the rest of the batch.
    for (const id of ids) {
      try {
        await submitReview(id);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBulkBusy(false);
    setBulkConfirm(false);
    setSelected(new Set());
    if (failed > 0) {
      toast.error(`${ok} submitted, ${failed} failed.`);
    } else {
      toast.success(`${ok} review${ok === 1 ? '' : 's'} submitted.`);
    }
    await refresh();
  };

  const onExportCsv = () => {
    if (!filtered || filtered.length === 0) return;
    downloadCsv(`performance-reviews-${ymdLocal()}.csv`, [
      ['Associate', 'Period', 'Rating', 'Status'],
      ...filtered.map((r) => [
        r.associateName,
        `${r.periodStart} – ${r.periodEnd}`,
        r.overallRating,
        STATUS_LABELS[r.status],
      ]),
    ]);
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title="Performance"
      subtitle={canManage ? 'Reviews due, waiting on the person, and done this quarter.' : 'Read-only view of performance reviews.'}
      related={[
        { label: 'Goals, 1:1s & feedback', to: '/performance/extras' },
        ...(canManage ? [{ label: 'Calibration', to: '/performance/calibration' }] : []),
      ]}
      actions={canManage ? [{ label: 'New review', icon: Plus, primary: true, onSelect: () => setShowCreate(true) }] : undefined}
    >
      {summaryQ.isError ? (
        <QueryError what="the review counts" query={summaryQ} />
      ) : (
        <MetricStrip label="Reviews at a glance">
          <MetricCard
            label="Due this month"
            value={summary ? summary.dueThisMonth : '—'}
            hint="A year since their last review"
            onClick={() => setFilter('DUE')}
            selected={filter === 'DUE'}
          />
          <MetricCard
            label="Overdue"
            value={summary ? summary.overdue : '—'}
            hint="More than a year since their last review"
            tone={summary && summary.overdue > 0 ? 'warning' : 'default'}
            onClick={() => setFilter('OVERDUE')}
            selected={filter === 'OVERDUE'}
          />
          <MetricCard
            label="Awaiting acknowledgment"
            value={summary ? summary.awaitingAck : '—'}
            hint="Submitted, not yet read and signed"
            onClick={() => setFilter('SUBMITTED')}
            selected={filter === 'SUBMITTED'}
          />
          <MetricCard
            label="Done this quarter"
            value={summary ? summary.doneThisQuarter : '—'}
            hint={summary ? `Acknowledged since ${fmtDateOnly(summary.quarterStart)}` : undefined}
            onClick={() => setFilter('ACKNOWLEDGED')}
            selected={filter === 'ACKNOWLEDGED'}
          />
        </MetricStrip>
      )}

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <FilterChip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)} count={summary ? chipCount(f.value, summary) : undefined}>
            {f.label}
          </FilterChip>
        ))}
      </div>

      {peopleView ? (
        <DueList
          rows={(summary?.due ?? []).filter((d) => (filter === 'OVERDUE' ? d.overdue : !d.overdue))}
          overdue={filter === 'OVERDUE'}
          canManage={canManage}
          onStart={() => setShowCreate(true)}
        />
      ) : (
      <>
      {reviews && reviews.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64 max-w-full">
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name…"
              aria-label="Search reviews by name"
            />
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onExportCsv} disabled={!filtered || filtered.length === 0}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          {canManage && selected.size > 0 && (
            <Button type="button" size="sm" onClick={() => setBulkConfirm(true)}>
              Submit selected drafts ({selected.size})
            </Button>
          )}
        </div>
      )}

      {errorLocal && <ErrorBanner>{errorLocal}</ErrorBanner>}
      {refreshQuery.isError && <QueryError what="reviews" query={refreshQuery} />}
      {!reviews && !error && <SkeletonRows count={4} rowHeight="h-20" />}
      {filtered && filtered.length === 0 && reviews && reviews.length > 0 && (
        <p className="text-sm text-silver">No reviews match “{search.trim()}”.</p>
      )}
      {reviews && reviews.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title={filter === 'NEEDS_ACTION' ? 'No reviews need action' : filter === 'ALL' ? 'No reviews yet' : `No ${STATUS_FILTERS.find((f) => f.value === filter)?.label.toLowerCase() ?? ''} reviews`}
          description={
            canManage
              ? 'Drafts and reviews waiting on the person show here. Start one for someone who is due.'
              : 'Switch to a different status filter to see more.'
          }
          action={
            canManage ? (
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4" />
                New review
              </Button>
            ) : undefined
          }
        />
      )}
      {filtered && filtered.length > 0 && (
        <ul className="space-y-2">
          {filtered.map((r) => (
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
                <CardContent>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {canManage && r.status === 'DRAFT' && (
                        <input
                          type="checkbox"
                          className="mt-3 h-4 w-4 shrink-0 accent-gold"
                          checked={selected.has(r.id)}
                          onChange={() => toggleSelected(r.id)}
                          aria-label={`Select draft review for ${r.associateName}`}
                        />
                      )}
                      <Avatar src={associatePhotoUrl(r.associateId)} name={r.associateName} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="text-white font-medium">
                          <AssociateLink associateId={r.associateId}>
                            {r.associateName}
                          </AssociateLink>
                          <span className="text-silver text-xs ml-2 font-normal">
                            {fmtPeriod(r.periodStart, r.periodEnd)}
                          </span>
                        </div>
                        <div className="text-sm text-silver line-clamp-1 mt-0.5">
                          {r.summary}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center gap-1 text-base text-gold tabular-nums">
                        <Star className="h-4 w-4" />
                        {r.overallRating}/5
                      </span>
                      <Badge variant={statusVariant(r.status)}>
                        {STATUS_LABELS[r.status]}
                      </Badge>
                      {canManage && r.status === 'DRAFT' && (
                        <div className="can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSubmitTarget(r)}
                            loading={pendingId === r.id}
                            disabled={pendingId === r.id}
                          >
                            Submit
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      </>
      )}

      <CreateReviewDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => {
          setShowCreate(false);
          refresh();
        }}
      />

      <ConfirmDialog
        open={submitTarget !== null}
        onOpenChange={(o) => !o && setSubmitTarget(null)}
        title={
          submitTarget
            ? `Submit review for ${submitTarget.associateName}?`
            : 'Submit review'
        }
        description="The associate will be able to see this review immediately. You can no longer edit the draft after submitting."
        confirmLabel="Submit review"
        busy={pendingId !== null}
        onConfirm={onConfirmSubmit}
      />

      <ConfirmDialog
        open={bulkConfirm}
        onOpenChange={(o) => !o && !bulkBusy && setBulkConfirm(false)}
        title={`Submit ${selected.size} draft review${selected.size === 1 ? '' : 's'}?`}
        description="Each associate will be able to see their review immediately. Drafts can no longer be edited after submitting."
        confirmLabel="Submit selected"
        busy={bulkBusy}
        onConfirm={onConfirmBulkSubmit}
      />

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-xl"
      >
        {drawerTarget && (
          <ReviewDetailPanel
            r={drawerTarget}
            canManage={canManage}
            submitting={pendingId === drawerTarget.id}
            onSubmit={() => {
              setSubmitTarget(drawerTarget);
              setDrawerTarget(null);
            }}
          />
        )}
      </Drawer>
    </ListTemplate>
  );
}

function ReviewDetailPanel({
  r,
  canManage,
  submitting,
  onSubmit,
}: {
  r: PerformanceReview;
  canManage: boolean;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar src={associatePhotoUrl(r.associateId)} name={r.associateName} size="md" />
          <div className="min-w-0">
            <DrawerTitle className="truncate">
              <AssociateLink associateId={r.associateId}>{r.associateName}</AssociateLink>
            </DrawerTitle>
            <DrawerDescription>
              {fmtPeriod(r.periodStart, r.periodEnd)}
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span className="inline-flex items-center gap-1 text-2xl text-gold tabular-nums">
            <Star className="h-5 w-5" />
            {r.overallRating}/5
          </span>
          <Badge variant={statusVariant(r.status)}>{STATUS_LABELS[r.status]}</Badge>
          {r.reviewerEmail && (
            <span className="text-xs text-silver">by {r.reviewerEmail}</span>
          )}
        </div>

        <ReviewSection label="Summary" body={r.summary} />
        <ReviewSection label="Strengths" body={r.strengths} />
        <ReviewSection label="Areas to improve" body={r.improvements} />
        <ReviewSection label="Goals" body={r.goals} />

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-silver">
          <DetailRow label="Created">{fmtDateTime(r.createdAt)}</DetailRow>
          <DetailRow label="Submitted">{fmtDateTime(r.submittedAt)}</DetailRow>
          <DetailRow label="Acknowledged">{fmtDateTime(r.acknowledgedAt)}</DetailRow>
        </dl>
      </DrawerBody>
      {canManage && r.status === 'DRAFT' && (
        <DrawerFooter>
          <Button onClick={onSubmit} loading={submitting} disabled={submitting}>
            Submit review
          </Button>
        </DrawerFooter>
      )}
    </>
  );
}

function ReviewSection({ label, body }: { label: string; body: string | null }) {
  if (!body) return null;
  return (
    <div className="mb-4">
      <div className="text-2xs uppercase tracking-widest text-silver/80 mb-1">
        {label}
      </div>
      <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-3 text-sm text-white whitespace-pre-wrap">
        {body}
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-widest text-silver/80">{label}</dt>
      <dd className="text-white text-sm mt-0.5 tabular-nums">{children}</dd>
    </div>
  );
}

interface CreateReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

function chipCount(f: ReviewFilter, s: ReviewsSummary): number | undefined {
  switch (f) {
    case 'NEEDS_ACTION':
      return s.drafts + s.awaitingAck;
    case 'DRAFT':
      return s.drafts;
    case 'SUBMITTED':
      return s.awaitingAck;
    case 'ACKNOWLEDGED':
      return s.acknowledged;
    case 'ALL':
      return s.drafts + s.awaitingAck + s.acknowledged;
    default:
      return undefined;
  }
}

/** The people behind "Due this month" / "Overdue": who needs a review, and since when. */
function DueList({ rows, overdue, canManage, onStart }: { rows: ReviewsSummary['due']; overdue: boolean; canManage: boolean; onStart: () => void }) {
  return (
    <DataGrid<ReviewsSummary['due'][number]>
      id={overdue ? 'reviews-overdue' : 'reviews-due'}
      caption={overdue ? 'Overdue for a review' : 'Due for a review this month'}
      noun={{ one: 'person', many: 'people' }}
      rows={rows}
      rowKey={(r) => r.associateId}
      urlKey="due"
      empty={{
        icon: ClipboardList,
        title: overdue ? 'No one is overdue for a review' : 'No one else is due this month',
        description: 'A review falls due a year after the last one ended, or a year after the hire date.',
      }}
      columns={[
        {
          key: 'name',
          header: 'Associate',
          accessor: (r) => r.name,
          sortable: true,
          primary: true,
          cell: (r) => <AssociateLink associateId={r.associateId}>{r.name}</AssociateLink>,
        },
        { key: 'last', header: 'Last review ended', accessor: (r) => r.lastPeriodEnd ?? '', sortable: true, cardMeta: true, cell: (r) => (r.lastPeriodEnd ? fmtDateOnly(r.lastPeriodEnd) : 'None yet') },
        { key: 'due', header: 'Due', accessor: (r) => r.dueOn, sortable: true, cardMeta: true, cell: (r) => <span className={r.overdue ? 'text-warning' : undefined}>{fmtDateOnly(r.dueOn)}</span> },
        ...(canManage
          ? [
              {
                key: 'start',
                header: '',
                accessor: () => null,
                searchable: false,
                csv: () => '',
                align: 'right' as const,
                stopRowClick: true,
                cell: () => (
                  <Button size="sm" variant="outline" onClick={onStart}>
                    Start review
                  </Button>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

function CreateReviewDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateReviewDialogProps) {
  const term = useTerm();
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [overallRating, setOverallRating] = useState(3);
  const [summary, setSummary] = useState('');
  const [strengths, setStrengths] = useState('');
  const [improvements, setImprovements] = useState('');
  const [goals, setGoals] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by the "Create & submit" button just before the form submits.
  const submitAfterRef = useRef(false);

  useEffect(() => {
    if (open) {
      const quarter = lastCompletedQuarter();
      setAssociate(null);
      setPeriodStart(quarter.start);
      setPeriodEnd(quarter.end);
      setOverallRating(3);
      setSummary('');
      setStrengths('');
      setImprovements('');
      setGoals('');
      setError(null);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!associate) {
      setError(pickOne(term));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const created = await createReview({
        associateId: associate.id,
        periodStart,
        periodEnd,
        overallRating,
        summary,
        strengths: strengths || undefined,
        improvements: improvements || undefined,
        goals: goals || undefined,
      });
      // "Create & submit": the review the manager just wrote is the one they
      // mean to submit — no second trip through the list, Submit and a confirm.
      if (submitAfterRef.current) await submitReview(created.id);
      submitAfterRef.current = false;
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the review.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>New performance review</DialogTitle>
          <DialogDescription>
            Their record for the period sits beside the form — write from it, then rate. It starts as a draft.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="grid content-start gap-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label={term('worker')} required>
                <AssociatePicker value={associate} onChange={setAssociate} />
              </Field>
              <Field label="Period start" required>
                <Input type="date" required value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              </Field>
              <Field label="Period end" required>
                <Input type="date" required value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </Field>
            </div>
            <Field label="Summary" required>
              <Textarea required rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label="Strengths">
                <Textarea rows={3} value={strengths} onChange={(e) => setStrengths(e.target.value)} />
              </Field>
              <Field label="Areas for improvement">
                <Textarea rows={3} value={improvements} onChange={(e) => setImprovements(e.target.value)} />
              </Field>
              <Field label="Goals">
                <Textarea rows={3} value={goals} onChange={(e) => setGoals(e.target.value)} />
              </Field>
            </div>
            {/* The rating comes last: after the record and the words. */}
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-ink">Overall rating</legend>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Overall rating">
                {RATINGS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    role="radio"
                    aria-checked={overallRating === r.value}
                    onClick={() => setOverallRating(r.value)}
                    className={
                      overallRating === r.value
                        ? 'rounded-md border border-gold bg-gold/15 px-3 py-1.5 text-sm text-ink'
                        : 'rounded-md border border-line px-3 py-1.5 text-sm text-ink-muted hover:text-ink'
                    }
                  >
                    <span className="font-semibold tabular-nums">{r.value}</span> · {r.label}
                  </button>
                ))}
              </div>
            </fieldset>
            {error && <ErrorBanner>{error}</ErrorBanner>}
          </div>
          <div className="lg:border-l lg:border-line lg:pl-5">
            {associate ? (
              <ReviewRecordPanel associateId={associate.id} from={periodStart} to={periodEnd} />
            ) : (
              <p className="text-sm text-ink-muted">Pick who you’re reviewing to see their goals, attendance, 1:1s, kudos and last review for the period.</p>
            )}
          </div>
          <DialogFooter className="lg:col-span-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" variant="secondary" loading={submitting && !submitAfterRef.current} disabled={submitting}>
              Save draft
            </Button>
            <Button
              type="submit"
              loading={submitting && submitAfterRef.current}
              disabled={submitting}
              onClick={() => {
                submitAfterRef.current = true;
              }}
            >
              Create &amp; submit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const RATINGS = [
  { value: 1, label: 'Below expectations' },
  { value: 2, label: 'Partly meets' },
  { value: 3, label: 'Meets' },
  { value: 4, label: 'Exceeds' },
  { value: 5, label: 'Outstanding' },
] as const;
