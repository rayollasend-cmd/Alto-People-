import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import type { PerformanceReview } from '@alto-people/shared';
import { acknowledgeReview, listMyReviews } from '@/lib/performanceApi';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, parseYmd } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n, type MessageKey } from '@/lib/i18n';

function ratingStars(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n));
}

export function AssociateReviewsView() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [reviews, setReviews] = useState<PerformanceReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listMyReviews();
      setReviews(res.reviews);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('reviews.loadFailed'));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onAck = async (id: string) => {
    if (
      !(await confirm({
        title: t('reviews.ackTitle'),
        description: t('reviews.ackDesc'),
        confirmLabel: t('reviews.ack'),
      }))
    )
      return;
    setPendingId(id);
    try {
      await acknowledgeReview(id);
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t('reviews.ackFailed'),
      );
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="mx-auto">
      <PageHeader
        title={t('reviews.title')}
        subtitle={t('reviews.subtitle')}
      />

      {error && (
        <ErrorBanner
          className="mb-3"
          action={
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              {t('common.retry')}
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      {!reviews && !error && <SkeletonRows count={2} rowHeight="h-40" />}
      {reviews && reviews.length === 0 && (
        <EmptyState
          icon={ClipboardCheck}
          title={t('reviews.emptyTitle')}
          description={t('reviews.emptyDesc')}
        />
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
                    {fmtDate(parseYmd(r.periodStart))} → {fmtDate(parseYmd(r.periodEnd))}
                  </div>
                  <div className="text-2xl text-gold tabular-nums">
                    {ratingStars(r.overallRating)}
                  </div>
                </div>
                <Badge
                  size="lg"
                  variant={
                    r.status === 'ACKNOWLEDGED'
                      ? 'success'
                      : r.status === 'SUBMITTED'
                        ? 'pending'
                        : 'default'
                  }
                >
                  {t(('reviews.status.' + r.status) as MessageKey)}
                </Badge>
              </div>
              <div className="text-white whitespace-pre-line mb-3">{r.summary}</div>
              {r.strengths && (
                <Section label={t('reviews.strengths')} body={r.strengths} />
              )}
              {r.improvements && (
                <Section label={t('reviews.improvements')} body={r.improvements} />
              )}
              {r.goals && <Section label={t('reviews.goals')} body={r.goals} />}
              {r.status === 'SUBMITTED' && (
                <div className="mt-4 pt-3 border-t border-navy-secondary">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onAck(r.id)}
                    loading={pendingId === r.id}
                    disabled={pendingId === r.id}
                  >
                    {pendingId === r.id ? t('reviews.ackSaving') : t('reviews.ack')}
                  </Button>
                </div>
              )}
              {r.reviewerEmail && (
                <div className="text-2xs uppercase tracking-widest text-silver/70 mt-3">
                  {t('reviews.reviewedBy', { email: r.reviewerEmail })}
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
      <div className="text-2xs uppercase tracking-widest text-silver/70">{label}</div>
      <div className="text-sm text-silver whitespace-pre-line">{body}</div>
    </div>
  );
}
