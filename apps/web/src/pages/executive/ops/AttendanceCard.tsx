import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import type { LegacySummary } from './execLegacyApi';
import { PulseCard, isAttendanceKind } from './opsShared';

/**
 * Attendance over the last thirty days: unexcused events by kind, the
 * worst first, each with its share. Counts in ink — the kind is the news,
 * not a colour.
 */
export function AttendanceCard({ summary }: { summary: { data: LegacySummary | undefined; isError: boolean; error: unknown; refetch: () => unknown; isFetching?: boolean } }) {
  const { t } = useI18n();
  const s = summary.data ?? null;
  const rows = s ? [...s.attendance30d].sort((a, b) => b.count - a.count) : [];
  const total = rows.reduce((n, r) => n + r.count, 0);
  return (
    <PulseCard
      title={t('execPortal.ops.attTitle')}
      description={s ? (total === 0 ? t('execPortal.ops.attClean') : t('execPortal.ops.attDesc', { count: total })) : undefined}
      link={{ to: '/compliance', label: t('execPortal.ops.attLink') }}
      testId="exec-ops-attendance"
    >
      {summary.isError && !s ? (
        <QueryError what={t('execPortal.ops.attWhat')} query={summary} />
      ) : !s ? (
        <SkeletonRows count={3} rowHeight="h-8" />
      ) : total === 0 ? null : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.kind} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="text-ink">{isAttendanceKind(r.kind) ? t(`execPortal.ops.kindPlural.${r.kind}`) : t('execPortal.ops.kindOther')}</span>
              <span className="tabular-nums text-ink">
                {r.count.toLocaleString('en-US')}
                <span className="ml-2 inline-block w-10 text-right text-xs2 text-ink-muted">{Math.round((r.count / total) * 100)}%</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </PulseCard>
  );
}
