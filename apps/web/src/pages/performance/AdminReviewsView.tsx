import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Download, Plus, Star } from 'lucide-react';
import { toast } from 'sonner';
import type {
  PerformanceReview,
  PerformanceReviewStatus,
} from '@alto-people/shared';
import {
  createReview,
  listReviews,
  submitReview,
} from '@/lib/performanceApi';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, parseYmd, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
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
  Input,
  PageHeader,
  SearchInput,
  SkeletonRows,
  Textarea,
} from '@/components/ui';

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

const STATUS_FILTERS: Array<{ value: PerformanceReviewStatus | 'ALL'; label: string }> = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { value: 'ALL', label: 'All' },
];

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
  const [filter, setFilter] = useState<PerformanceReviewStatus | 'ALL'>('DRAFT');
  const [reviews, setReviews] = useState<PerformanceReview[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [submitTarget, setSubmitTarget] = useState<PerformanceReview | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<PerformanceReview | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listReviews(filter === 'ALL' ? {} : { status: filter });
      setReviews(res.reviews);
      // Drop selections for rows no longer present (or no longer DRAFT).
      setSelected((prev) => {
        const next = new Set<string>();
        for (const r of res.reviews) {
          if (r.status === 'DRAFT' && prev.has(r.id)) next.add(r.id);
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load reviews.');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
    <div className="mx-auto">
      <PageHeader
        title="Performance"
        subtitle={
          canManage
            ? 'Compose, submit, and track performance reviews.'
            : 'Read-only view of performance reviews.'
        }
        primaryAction={
          canManage ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              New review
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap gap-2 mb-3">
        {STATUS_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            active={filter === f.value}
            onClick={() => setFilter(f.value)}
            className="uppercase tracking-wider"
          >
            {f.label}
          </FilterChip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <div className="w-64 max-w-full">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search associate…"
            aria-label="Search reviews by associate"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onExportCsv}
          disabled={!filtered || filtered.length === 0}
        >
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
        {canManage && selected.size > 0 && (
          <Button type="button" size="sm" onClick={() => setBulkConfirm(true)}>
            Submit selected drafts ({selected.size})
          </Button>
        )}
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
      {!reviews && !error && <SkeletonRows count={4} rowHeight="h-20" />}
      {filtered && filtered.length === 0 && reviews && reviews.length > 0 && (
        <p className="text-sm text-silver">No reviews match “{search.trim()}”.</p>
      )}
      {reviews && reviews.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title="No reviews match this filter"
          description={
            canManage
              ? 'Switch filters or compose a new review.'
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
                <CardContent className="p-4">
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
                      <Avatar name={r.associateName} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="text-white font-medium">
                          {r.associateName}
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
                      <span className="inline-flex items-center gap-1 font-display text-base text-gold tabular-nums">
                        <Star className="h-4 w-4" />
                        {r.overallRating}/5
                      </span>
                      <Badge variant={statusVariant(r.status)}>
                        {STATUS_LABELS[r.status]}
                      </Badge>
                      {canManage && r.status === 'DRAFT' && (
                        <div className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
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
            onSubmit={() => {
              setSubmitTarget(drawerTarget);
              setDrawerTarget(null);
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function ReviewDetailPanel({
  r,
  canManage,
  onSubmit,
}: {
  r: PerformanceReview;
  canManage: boolean;
  onSubmit: () => void;
}) {
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar name={r.associateName} size="md" />
          <div className="min-w-0">
            <DrawerTitle className="truncate">{r.associateName}</DrawerTitle>
            <DrawerDescription>
              {fmtPeriod(r.periodStart, r.periodEnd)}
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span className="inline-flex items-center gap-1 font-display text-2xl text-gold tabular-nums">
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
          <Button onClick={onSubmit}>Submit review</Button>
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

function CreateReviewDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateReviewDialogProps) {
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
      setError('Pick an associate.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await createReview({
        associateId: associate.id,
        periodStart,
        periodEnd,
        overallRating,
        summary,
        strengths: strengths || undefined,
        improvements: improvements || undefined,
        goals: goals || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the review.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New performance review</DialogTitle>
          <DialogDescription>
            The review starts as a draft — you can revise before submitting.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Associate" required>
              <AssociatePicker value={associate} onChange={setAssociate} />
            </Field>
            <Field label="Overall rating (1–5)" required>
              <Input
                type="number"
                min={1}
                max={5}
                step={1}
                required
                value={overallRating}
                onChange={(e) => setOverallRating(Number(e.target.value))}
              />
            </Field>
            <Field label="Period start" required>
              <Input
                type="date"
                required
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </Field>
            <Field label="Period end" required>
              <Input
                type="date"
                required
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Summary" required>
            <Textarea
              required
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Strengths">
              <Textarea
                rows={3}
                value={strengths}
                onChange={(e) => setStrengths(e.target.value)}
              />
            </Field>
            <Field label="Areas for improvement">
              <Textarea
                rows={3}
                value={improvements}
                onChange={(e) => setImprovements(e.target.value)}
              />
            </Field>
            <Field label="Goals">
              <Textarea
                rows={3}
                value={goals}
                onChange={(e) => setGoals(e.target.value)}
              />
            </Field>
          </div>
          {error && <ErrorBanner>{error}</ErrorBanner>}
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
              Save draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs2 uppercase tracking-wider text-silver mb-1">
        {label}
        {required && <span className="text-alert"> *</span>}
      </span>
      {children}
    </label>
  );
}
