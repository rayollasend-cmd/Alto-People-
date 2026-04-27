import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, Plus, Star } from 'lucide-react';
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
import { cn } from '@/lib/cn';
import {
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
  EmptyState,
  Input,
  SkeletonRows,
  Textarea,
} from '@/components/ui';

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

export function AdminReviewsView({ canManage }: { canManage: boolean }) {
  const [filter, setFilter] = useState<PerformanceReviewStatus | 'ALL'>('DRAFT');
  const [reviews, setReviews] = useState<PerformanceReview[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [submitTarget, setSubmitTarget] = useState<PerformanceReview | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listReviews(filter === 'ALL' ? {} : { status: filter });
      setReviews(res.reviews);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onConfirmSubmit = async () => {
    if (!submitTarget) return;
    setPendingId(submitTarget.id);
    try {
      await submitReview(submitTarget.id);
      setSubmitTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submit failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Performance
          </h1>
          <p className="text-silver">
            {canManage
              ? 'Compose, submit, and track performance reviews.'
              : 'Read-only view of performance reviews.'}
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            New review
          </Button>
        )}
      </header>

      <div className="flex flex-wrap gap-2 mb-5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              'px-3 py-1.5 rounded text-xs uppercase tracking-wider border transition',
              filter === f.value
                ? 'border-gold text-gold bg-gold/10'
                : 'border-navy-secondary text-silver hover:text-white',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!reviews && <SkeletonRows count={4} rowHeight="h-20" />}
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
      {reviews && reviews.length > 0 && (
        <ul className="space-y-2">
          {reviews.map((r) => (
            <li key={r.id}>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="text-white font-medium">
                        {r.associateName}
                        <span className="text-silver text-xs ml-2 font-normal">
                          {r.periodStart} → {r.periodEnd}
                        </span>
                      </div>
                      <div className="text-sm text-silver line-clamp-1 mt-0.5">
                        {r.summary}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center gap-1 font-display text-base text-gold tabular-nums">
                        <Star className="h-4 w-4" />
                        {r.overallRating}/5
                      </span>
                      <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                      {canManage && r.status === 'DRAFT' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setSubmitTarget(r)}
                          loading={pendingId === r.id}
                          disabled={pendingId === r.id}
                        >
                          Submit
                        </Button>
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
  const [associateId, setAssociateId] = useState('');
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
      setAssociateId('');
      setPeriodStart('');
      setPeriodEnd('');
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
    setError(null);
    setSubmitting(true);
    try {
      await createReview({
        associateId,
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
      setError(err instanceof ApiError ? err.message : 'Create failed.');
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
            The review starts as a DRAFT — you can revise before submitting.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Associate ID" required>
              <Input
                required
                value={associateId}
                onChange={(e) => setAssociateId(e.target.value)}
                placeholder="00000000-0000-4000-8000-…"
              />
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
              Save as DRAFT
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
      <span className="block text-[11px] uppercase tracking-wider text-silver mb-1">
        {label}
        {required && <span className="text-alert"> *</span>}
      </span>
      {children}
    </label>
  );
}
