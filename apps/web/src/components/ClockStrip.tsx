import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtDateOnly } from '@/lib/format';
import { HomeMeta } from '@/components/home/HomeMeta';

/**
 * The company clock — one rhythm rendered on the HR, Finance, and
 * Workforce consoles alike: week end (Fri) → Tuesday close → payday.
 * Same dates in every building, so "the close is tomorrow" is ambient
 * knowledge instead of a fact Finance keeps announcing.
 *
 * `useClockParts()` gives the three phrases for a home's HomeMeta line;
 * `<ClockStrip />` draws them alone (the relay board).
 */

interface CompanyClock {
  weekEndsOn: string;
  closeOn: string;
  payday: { date: string; schedule: string } | null;
}

/** Calendar days, said the short way: "Fri, Oct 23" (the year only when it isn't this one). */
const day = (value: string) => fmtDateOnly(value, { weekday: true, year: 'auto' });

/** "Week ends Fri, Oct 23", "Close Tue, Oct 27", "Payday Fri, Oct 30" — or [] without view:org / before load. */
export function useClockParts(): string[] {
  const { t } = useI18n();
  const { can } = useAuth();
  const enabled = can('view:org');
  const query = useQuery({
    queryKey: ['company', 'clock'],
    queryFn: () => apiFetch<CompanyClock>('/company/clock'),
    enabled,
    staleTime: 10 * 60_000,
  });
  const data = query.data;
  if (!enabled || !data) return [];
  return [
    t('clock.weekEnds', { date: day(data.weekEndsOn) }),
    t('clock.close', { date: day(data.closeOn) }),
    ...(data.payday ? [t('clock.payday', { date: day(data.payday.date) })] : []),
  ];
}

export function ClockStrip({ className }: { className?: string }) {
  const parts = useClockParts();
  if (parts.length === 0) return null;
  return <HomeMeta items={parts} className={className} />;
}
