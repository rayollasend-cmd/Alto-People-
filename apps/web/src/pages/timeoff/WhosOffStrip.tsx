import type { TimeOffCategory } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { parseYmd, ymdLocal } from '@/lib/format';
import type { TimeOffSummary, WhosOffRow } from '@/lib/timeOffApi';

/**
 * Who's off, the next two weeks (F500 G2): one row per person with approved
 * time off, one column per day, and a count per day at the foot — so a
 * scheduler sees the coverage holes before building the week. Dates are
 * the org's calendar days (YYYY-MM-DD keys), never instants.
 */

const CATEGORY: Record<TimeOffCategory, string> = {
  SICK: 'Sick',
  VACATION: 'Vacation',
  PTO: 'PTO',
  BEREAVEMENT: 'Bereavement',
  JURY_DUTY: 'Jury duty',
  OTHER: 'Other',
};

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const DAY_NUM = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'UTC' });
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The 14 day keys starting at `from`. */
export function stripDays(from: string, count = 14): string[] {
  const out: string[] = [];
  const d = parseYmd(from);
  if (!d) return out;
  for (let i = 0; i < count; i++) {
    out.push(ymdLocal(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const atNoon = (key: string) => new Date(`${key}T12:00:00Z`);

export function WhosOffStrip({ summary }: { summary: TimeOffSummary }) {
  const days = stripDays(summary.today);
  const people = new Map<string, { name: string; rows: WhosOffRow[] }>();
  for (const r of summary.whosOff) {
    const p = people.get(r.associateId) ?? { name: r.name, rows: [] };
    p.rows.push(r);
    people.set(r.associateId, p);
  }
  const list = [...people.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  const offOn = (rows: WhosOffRow[], day: string) => rows.find((r) => r.startDate <= day && r.endDate >= day) ?? null;
  const perDay = days.map((d) => list.filter(([, p]) => offOn(p.rows, d)).length);

  if (list.length === 0) {
    return (
      <p className="text-sm text-silver/70" data-testid="whos-off-empty">
        No one has approved time off between {MONTH_DAY.format(atNoon(days[0]!))} and {MONTH_DAY.format(atNoon(days[13]!))}.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto" data-testid="whos-off">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-xs">
        <caption className="sr-only">Approved time off, one row per person, for the next 14 days</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 bg-surface pb-1.5 pr-3 text-left font-medium text-silver/70">
              Who
            </th>
            {days.map((d) => (
              <th
                key={d}
                scope="col"
                className={cn('px-0.5 pb-1.5 text-center font-normal tabular-nums', d === summary.today ? 'text-gold' : 'text-silver/60')}
              >
                <span className="block text-2xs uppercase">{WEEKDAY.format(atNoon(d))}</span>
                <span className="block">{DAY_NUM.format(atNoon(d))}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map(([id, p]) => (
            <tr key={id}>
              <th scope="row" className="sticky left-0 z-10 max-w-[10rem] truncate bg-surface py-1 pr-3 text-left font-medium text-ink">
                {p.name}
              </th>
              {days.map((d) => {
                const off = offOn(p.rows, d);
                return (
                  <td key={d} className="px-0.5 py-1">
                    <span
                      className={cn('block h-5 rounded-sm', off ? 'bg-gold/50' : 'bg-navy-secondary/30')}
                      title={off ? `${p.name} · ${CATEGORY[off.category]} · ${MONTH_DAY.format(atNoon(d))}` : undefined}
                      aria-label={off ? `${CATEGORY[off.category]}` : undefined}
                      role={off ? 'img' : undefined}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="sticky left-0 z-10 bg-surface pt-1.5 pr-3 text-left font-normal text-silver/70">
              Out
            </th>
            {perDay.map((n, i) => (
              <td key={days[i]} className={cn('pt-1.5 text-center tabular-nums', n > 0 ? 'text-ink' : 'text-silver/40')}>
                {n}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
