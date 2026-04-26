import { useCallback, useEffect, useState } from 'react';
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

const STATUS_FILTERS: Array<{ value: PerformanceReviewStatus | 'ALL'; label: string }> = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { value: 'ALL', label: 'All' },
];

export function AdminReviewsView({ canManage }: { canManage: boolean }) {
  const [filter, setFilter] = useState<PerformanceReviewStatus | 'ALL'>('DRAFT');
  const [reviews, setReviews] = useState<PerformanceReview[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

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

  const onSubmit = async (id: string) => {
    if (!window.confirm('Submit review to associate? They will be able to see it.')) return;
    setPendingId(id);
    try {
      await submitReview(id);
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
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="px-4 py-2 rounded font-medium bg-gold text-navy hover:bg-gold-bright"
          >
            {showCreate ? 'Close' : '+ New review'}
          </button>
        )}
      </header>

      {showCreate && canManage && (
        <CreateReviewForm
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}

      <div className="flex flex-wrap gap-2 mb-5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              'px-3 py-1.5 rounded text-sm border transition',
              filter === f.value
                ? 'border-gold text-gold bg-gold/10'
                : 'border-navy-secondary text-silver hover:text-white'
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
      {!reviews && <p className="text-silver">Loading…</p>}
      {reviews && reviews.length === 0 && (
        <p className="text-silver">No reviews match this filter.</p>
      )}
      {reviews && reviews.length > 0 && (
        <ul className="space-y-2">
          {reviews.map((r) => (
            <li
              key={r.id}
              className="bg-navy border border-navy-secondary rounded-lg p-4"
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="text-white">
                    {r.associateName}{' '}
                    <span className="text-silver text-xs ml-2">
                      {r.periodStart} → {r.periodEnd}
                    </span>
                  </div>
                  <div className="text-sm text-silver line-clamp-1">{r.summary}</div>
                </div>
                <div className="flex items-center gap-3 text-xs text-silver">
                  <span className="font-display text-base text-gold tabular-nums">
                    {r.overallRating}/5
                  </span>
                  <span className="uppercase tracking-widest">{r.status}</span>
                  {canManage && r.status === 'DRAFT' && (
                    <button
                      type="button"
                      onClick={() => onSubmit(r.id)}
                      disabled={pendingId === r.id}
                      className="px-2 py-1 rounded border border-gold/40 text-gold hover:bg-gold/10 disabled:opacity-50"
                    >
                      Submit
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateReviewForm({ onCreated }: { onCreated: () => void }) {
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

  const inputCls =
    'w-full px-3 py-2 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

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
    <form
      onSubmit={handleSubmit}
      className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5 space-y-3"
    >
      <h2 className="font-display text-2xl text-white">New review</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Associate ID
          </span>
          <input
            type="text"
            required
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Overall rating (1–5)
          </span>
          <input
            type="number"
            min={1}
            max={5}
            step={1}
            required
            value={overallRating}
            onChange={(e) => setOverallRating(Number(e.target.value))}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Period start
          </span>
          <input
            type="date"
            required
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Period end
          </span>
          <input
            type="date"
            required
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      <label className="block">
        <span className="block text-xs uppercase tracking-widest text-silver mb-1">
          Summary
        </span>
        <textarea
          required
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          className={inputCls}
        />
      </label>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Strengths
          </span>
          <textarea
            rows={3}
            value={strengths}
            onChange={(e) => setStrengths(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Areas for improvement
          </span>
          <textarea
            rows={3}
            value={improvements}
            onChange={(e) => setImprovements(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Goals
          </span>
          <textarea
            rows={3}
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className={cn(
          'px-4 py-2 rounded text-sm font-medium transition',
          submitting
            ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
            : 'bg-gold text-navy hover:bg-gold-bright'
        )}
      >
        {submitting ? 'Saving…' : 'Save as DRAFT'}
      </button>
    </form>
  );
}
