import { Link } from 'react-router-dom';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { useLegacyBatons } from './execLegacyApi';
import { PulseCard } from './opsShared';

/**
 * Work moving between teams (what the old home called batons in flight):
 * each count is work sitting between two departments, waiting on the next
 * step, and each opens the desk that works it. A zero is quiet ink — there
 * is nothing to celebrate in an empty queue — and a real count is amber,
 * or red for the two that carry risk (a leaver still registered with the
 * client, an open safety incident).
 */
type BatonKey = 'unapprovedTimesheets' | 'readyToSchedule' | 'payrollCasesOpen' | 'incidentsOpen' | 'closeOuts' | 'transfers' | 'adds';
type Item = { key: BatonKey; value: number; to: string; tone: 'caution' | 'negative' };

export function BatonsCard({ clients = true }: { clients?: boolean }) {
  const { t } = useI18n();
  const q = useLegacyBatons();
  const b = q.data?.batons ?? null;
  const items: Item[] = b
    ? [
        { key: 'unapprovedTimesheets', value: b.unapprovedTimesheets, to: '/time-attendance', tone: 'caution' },
        { key: 'readyToSchedule', value: b.readyToSchedule, to: '/scheduling', tone: 'caution' },
        { key: 'payrollCasesOpen', value: b.payrollCasesOpen, to: '/hr-cases', tone: 'caution' },
        { key: 'incidentsOpen', value: b.incidentsOpen, to: '/compliance/osha', tone: 'negative' },
        // Fieldglass is the clients' vendor system: a company with no clients has none.
        ...(clients
          ? ([
              { key: 'closeOuts', value: b.fieldglass.closeOuts, to: '/people', tone: 'negative' },
              { key: 'transfers', value: b.fieldglass.transfers, to: '/people', tone: 'caution' },
              { key: 'adds', value: b.fieldglass.adds, to: '/people', tone: 'caution' },
            ] satisfies Item[])
          : []),
      ]
    : [];
  const waiting = items.reduce((n, i) => n + i.value, 0);
  return (
    <PulseCard
      title={t('execPortal.ops.batonsTitle')}
      description={b ? (waiting === 0 ? t('execPortal.ops.batonsClear') : t('execPortal.ops.batonsDesc', { count: waiting })) : t('execPortal.ops.batonsDescLoading')}
      testId="exec-ops-batons"
    >
      {q.isError && !b ? (
        <QueryError what={t('execPortal.ops.batonsWhat')} query={q} />
      ) : !b ? (
        <Skeleton className="h-16" />
      ) : (
        <ul className={cn('grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4', clients && 'xl:grid-cols-7')}>
          {items.map((i) => (
            <li key={i.key} className="min-w-0">
              <Link to={i.to} className="group block min-h-11 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid={`exec-baton-${i.key}`}>
                <div
                  className={cn('text-2xl font-medium tabular-nums', i.value === 0 ? 'text-ink-muted' : i.tone === 'negative' ? 'text-negative-800' : 'text-caution-800')}
                  data-tone={i.value === 0 ? 'none' : i.tone}
                >
                  {i.value.toLocaleString('en-US')}
                </div>
                <div className="mt-0.5 text-xs2 text-ink-muted group-hover:text-ink">{t(`execPortal.ops.baton.${i.key}`)}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PulseCard>
  );
}
