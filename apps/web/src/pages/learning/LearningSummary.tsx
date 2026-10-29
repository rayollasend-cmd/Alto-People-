import { useQuery } from '@tanstack/react-query';
import { getLmsSummary } from '@/lib/lms94Api';
import { MetricCard, MetricStrip } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';

/**
 * The Learning desk's numbers (F500 2026-10-22: the admin page had none).
 * Admin-only — associates get My training — so it lives apart from the
 * associate-facing LearningHome strings. Each tile opens the list behind it.
 * Enrollments carry no due date, so "overdue" is training whose renewal has
 * lapsed, and "due" is training expiring soon (GET /lms/summary).
 */
export function LearningSummary() {
  const q = useQuery({ queryKey: ['learning', 'summary'], queryFn: getLmsSummary });
  if (q.error) return <QueryError what="the training numbers" query={q} />;
  const s = q.data;
  const n = (v: number) => v.toLocaleString('en-US');
  // Nothing open, lapsing or assigned lately: one quiet line, not four zeros.
  const quiet = s !== undefined && s.lapsed + s.expiring30 + s.open + s.assigned30 === 0;
  return (
    <MetricStrip label="Training at a glance" empty={quiet ? 'No training is open, lapsed or expiring, and nothing was assigned in the last 30 days.' : undefined}>
      <MetricCard
        label="Lapsed"
        value={s ? s.lapsed : '—'}
        hint="Training past its expiry — renewal overdue"
        tone={s && s.lapsed > 0 ? 'alert' : 'default'}
        href="/learning/catalog?tab=expiring"
      />
      <MetricCard
        label="Expiring in 30 days"
        value={s ? s.expiring30 : '—'}
        hint={s ? `${n(s.expiring14)} within 14 days` : undefined}
        tone={s && s.expiring14 > 0 ? 'warning' : 'default'}
        href="/learning/catalog?tab=expiring"
      />
      <MetricCard
        label="Not finished"
        value={s ? s.open : '—'}
        hint={s ? (s.openStale > 0 ? `${n(s.openStale)} assigned 30+ days ago` : 'Assigned or in progress') : undefined}
        href="/learning/catalog?tab=enrollments&status=OPEN"
      />
      <MetricCard
        label="Completion rate · 30 days"
        value={s && s.completionRate30 !== null ? `${s.completionRate30}%` : '—'}
        hint={s && s.assigned30 > 0 ? `${n(s.completed30)} of ${n(s.assigned30)} assigned in the last 30 days` : undefined}
        nothing={s && s.completionRate30 === null ? 'Nothing assigned in 30 days' : undefined}
        href="/learning/catalog?tab=enrollments"
      />
    </MetricStrip>
  );
}

/** Sibling pages of the admin Learning desk (the routes stay where they are). */
export const LEARNING_RELATED = [{ label: 'Learning paths', to: '/learning-paths' }];
