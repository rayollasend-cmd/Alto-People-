import type { TransportBoard } from '@/lib/transportApi';

/**
 * The day in one quiet line under its name — "8 booked · 0 of 4 vans out ·
 * 0 on board · 0 done" — in ink, never a coloured zero. The measures that
 * judge the operation (on time, seat use, cost, no-shows) are the KPI row's.
 */
export function DayLine({ day, kpis }: { day: string; kpis: TransportBoard['kpis'] }) {
  const parts = [
    `${kpis.booked} booked`,
    kpis.runs === 0 ? 'no runs yet' : `${kpis.vansOut} of ${kpis.runs} ${kpis.runs === 1 ? 'van' : 'vans'} out`,
    `${kpis.onBoard} on board`,
    `${kpis.completed} done`,
    ...(kpis.noShows > 0 ? [`${kpis.noShows} ${kpis.noShows === 1 ? 'no-show' : 'no-shows'}`] : []),
  ];
  return (
    <p data-testid="transport-day-line" className="text-sm text-ink-muted">
      <span className="font-medium text-ink">{day}</span>
      <span className="tabular-nums"> · {parts.join(' · ')}</span>
    </p>
  );
}
