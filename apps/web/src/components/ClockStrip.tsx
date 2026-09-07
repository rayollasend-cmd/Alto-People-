import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';

/**
 * The company clock — one rhythm strip rendered on the HR, Finance, and
 * Workforce consoles alike: week end (Fri) → Tuesday close → payday.
 * Same dates in every building, so "the close is tomorrow" is ambient
 * knowledge instead of a fact Finance keeps announcing.
 */

interface CompanyClock {
  weekEndsOn: string;
  closeOn: string;
  payday: { date: string; schedule: string } | null;
}

/** Date-only keys (YYYY-MM-DD) must not shift across timezones — anchor
 *  them to noon UTC before formatting. */
const dayKey = (key: string) => fmtDate(`${key}T12:00:00Z`);

export function ClockStrip({ className }: { className?: string }) {
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
  if (!enabled || !data) return null;

  const parts = [
    t('clock.weekEnds', { date: dayKey(data.weekEndsOn) }),
    t('clock.close', { date: dayKey(data.closeOn) }),
    ...(data.payday ? [t('clock.payday', { date: fmtDate(data.payday.date) })] : []),
  ];
  return (
    <div
      className={
        'flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs uppercase tracking-[0.14em] text-silver/60 ' +
        (className ?? '')
      }
    >
      <CalendarClock className="h-3 w-3 text-gold/60" aria-hidden="true" />
      {parts.map((p, i) => (
        <span key={p} className="flex items-center gap-2 whitespace-nowrap">
          {i > 0 && (
            <span aria-hidden="true" className="text-silver/30">
              ·
            </span>
          )}
          {p}
        </span>
      ))}
    </div>
  );
}
