import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck } from '@/components/ui/icons';
import type { Shift as ShiftRecord } from '@alto-people/shared';
import { listShifts } from '@/lib/schedulingApi';
import { useTerm } from '@/lib/auth';
import { fmtDayHeaderTz, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ListTemplate } from '@/components/templates';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui';

/**
 * Every store's coverage for the next seven days on one screen (role walk
 * HR 6 — the one item of the walk never built). "Which store is short
 * this week?" used to be Scheduling → Week → client → location → scan,
 * four clicks per store. Each cell is filled / needed with the unconfirmed
 * count, short cells in the alert colour, and a cell opens that store's
 * day with its open shifts.
 */

const DAYS = 7;

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: calendar arithmetic on a date key pinned at UTC noon
  return d.toISOString().slice(0, 10);
}

/** The shift's calendar day in its store's zone (a late shift is that store's night, not UTC's). */
function dayOf(s: ShiftRecord): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: s.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(s.startsAt));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

interface Cell {
  needed: number;
  filled: number;
  unconfirmed: number;
}
interface StoreRow {
  key: string;
  locationId: string | null;
  clientId: string | null;
  name: string;
  timezone: string;
  days: Record<string, Cell>;
  short: number;
}

export function CoverageBoard() {
  const term = useTerm();
  const from = ymdLocal();
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(from, i)), [from]);
  const to = days[DAYS - 1]!;
  const q = useQuery({
    queryKey: ['scheduling', 'coverage', from, to],
    queryFn: () => listShifts({ from, to }),
    staleTime: 60_000,
  });

  const rows = useMemo<StoreRow[]>(() => {
    const byStore = new Map<string, StoreRow>();
    for (const s of q.data?.shifts ?? []) {
      if (s.status === 'CANCELLED') continue;
      const key = s.locationId ?? `client:${s.clientId ?? 'company'}`;
      let row = byStore.get(key);
      if (!row) {
        row = {
          key,
          locationId: s.locationId,
          clientId: s.clientId,
          name: s.locationName ?? s.location ?? s.clientName ?? 'Company',
          timezone: s.timezone,
          days: {},
          short: 0,
        };
        byStore.set(key, row);
      }
      const day = dayOf(s);
      const cell = (row.days[day] ??= { needed: 0, filled: 0, unconfirmed: 0 });
      cell.needed += 1;
      if (s.assignedAssociateId) {
        cell.filled += 1;
        if (s.publishedAt && !s.acknowledgedAt) cell.unconfirmed += 1;
      }
    }
    for (const row of byStore.values()) {
      row.short = days.reduce((n, d) => n + Math.max(0, (row.days[d]?.needed ?? 0) - (row.days[d]?.filled ?? 0)), 0);
    }
    // Shortest first: that is who you came to find.
    return [...byStore.values()].sort((a, b) => b.short - a.short || a.name.localeCompare(b.name));
  }, [q.data, days]);

  const totalShort = rows.reduce((n, r) => n + r.short, 0);

  return (
    <ListTemplate
      title="Coverage"
      subtitle={`Every ${term('site').toLowerCase()}, the next ${DAYS} days: filled / needed, with the unconfirmed count. A cell opens that day's open shifts.`}
      breadcrumbs={[{ label: 'Scheduling', to: '/scheduling' }, { label: 'Coverage' }]}
      facts={[{ label: 'Short this week', value: q.data ? String(totalShort) : '—' }, { label: term('sites'), value: q.data ? String(rows.length) : '—' }]}
    >
      <Card>
        <CardContent className="p-0">
          {q.isError ? (
            <div className="p-4">
              <QueryError what="the coverage board" query={q} />
            </div>
          ) : !q.data ? (
            <div className="p-4">
              <SkeletonRows count={5} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={CalendarCheck} title="No shifts in the next seven days" description="Nothing is scheduled yet, so there is nothing to cover." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Coverage by store and day">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                    <th scope="col" className="sticky left-0 bg-navy px-3 py-2">{term('site')}</th>
                    {days.map((d) => (
                      <th key={d} scope="col" className="px-2 py-2 text-center whitespace-nowrap">
                        {fmtDayHeaderTz(`${d}T12:00:00Z`, 'UTC')}
                      </th>
                    ))}
                    <th scope="col" className="px-3 py-2 text-right">Short</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-b border-line/60">
                      <th scope="row" className="sticky left-0 bg-navy px-3 py-2 text-left font-medium text-ink">
                        {r.name}
                      </th>
                      {days.map((d) => {
                        const c = r.days[d];
                        const short = c ? c.needed - c.filled : 0;
                        const href = `/scheduling?view=day&date=${d}${r.locationId ? `&location=${r.locationId}` : ''}${r.clientId ? `&client=${r.clientId}` : ''}${short > 0 ? '&open=1' : ''}`;
                        return (
                          <td key={d} className="px-1 py-1 text-center">
                            {c ? (
                              <Link
                                to={href}
                                className={cn(
                                  'block rounded-md px-2 py-1.5 tabular-nums hover:ring-1 hover:ring-gold/40',
                                  short > 0 ? 'bg-alert/15 text-alert font-medium' : 'bg-success/10 text-ink',
                                )}
                                aria-label={`${r.name}, ${d}: ${c.filled} of ${c.needed} filled${short > 0 ? `, ${short} short` : ''}${c.unconfirmed > 0 ? `, ${c.unconfirmed} unconfirmed` : ''}`}
                              >
                                {c.filled} / {c.needed}
                                {c.unconfirmed > 0 && <span className="block text-2xs text-ink-muted">{c.unconfirmed} unconfirmed</span>}
                              </Link>
                            ) : (
                              <span className="block px-2 py-1.5 text-ink-muted/50">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className={cn('px-3 py-2 text-right tabular-nums', r.short > 0 ? 'text-alert font-medium' : 'text-ink-muted')}>{r.short}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </ListTemplate>
  );
}
