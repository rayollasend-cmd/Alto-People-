import { useCallback, useEffect, useState } from 'react';
import type { PerformanceReview } from '@alto-people/shared';
import { acknowledgeReview, listMyReviews } from '@/lib/performanceApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

function ratingStars(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n));
}

export function AssociateReviewsView() {
  const [reviews, setReviews] = useState<PerformanceReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listMyReviews();
      setReviews(res.reviews);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onAck = async (id: string) => {
    setPendingId(id);
    try {
      await acknowledgeReview(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Acknowledge failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          My reviews
        </h1>
        <p className="text-silver">Performance reviews from your manager.</p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!reviews && <p className="text-silver">Loading…</p>}
      {reviews && reviews.length === 0 && (
        <p className="text-silver">No reviews yet.</p>
      )}
      {reviews && reviews.length > 0 && (
        <ul className="space-y-3">
          {reviews.map((r) => (
            <li
              key={r.id}
              className="bg-navy border border-navy-secondary rounded-lg p-5"
            >
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <div className="text-xs uppercase tracking-widest text-silver">
                    {r.periodStart} → {r.periodEnd}
                  </div>
                  <div className="font-display text-2xl text-gold tabular-nums">
                    {ratingStars(r.overallRating)}
                  </div>
                </div>
                <span
                  className={cn(
                    'text-xs uppercase tracking-widest px-2 py-1 rounded border',
                    r.status === 'ACKNOWLEDGED'
                      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                      : 'border-gold/40 bg-gold/10 text-gold'
                  )}
                >
                  {r.status}
                </span>
              </div>
              <div className="text-white whitespace-pre-line mb-3">{r.summary}</div>
              {r.strengths && (
                <Section label="Strengths" body={r.strengths} />
              )}
              {r.improvements && (
                <Section label="Areas for improvement" body={r.improvements} />
              )}
              {r.goals && <Section label="Goals" body={r.goals} />}
              {r.status === 'SUBMITTED' && (
                <div className="mt-4 pt-3 border-t border-navy-secondary">
                  <button
                    type="button"
                    onClick={() => onAck(r.id)}
                    disabled={pendingId === r.id}
                    className={cn(
                      'px-4 py-2 rounded text-sm font-medium transition',
                      pendingId === r.id
                        ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
                        : 'bg-gold text-navy hover:bg-gold-bright'
                    )}
                  >
                    {pendingId === r.id ? 'Saving…' : 'Acknowledge'}
                  </button>
                </div>
              )}
              {r.reviewerEmail && (
                <div className="text-[10px] uppercase tracking-widest text-silver/60 mt-3">
                  Reviewed by {r.reviewerEmail}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ label, body }: { label: string; body: string }) {
  return (
    <div className="mb-2">
      <div className="text-[10px] uppercase tracking-widest text-silver/60">{label}</div>
      <div className="text-sm text-silver whitespace-pre-line">{body}</div>
    </div>
  );
}
