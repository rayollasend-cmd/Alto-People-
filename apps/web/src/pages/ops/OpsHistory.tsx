import { useEffect, useMemo, useState } from 'react';
import { Download, History as HistoryIcon } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SearchInput } from '@/components/ui/FilterBar';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  getOpsHistory,
  opsPacketUrl,
  type OpsHistoryQuery,
  type OpsShiftRow,
} from '@/lib/opsApi';
import { fmtClock, fmtDayKey, fmtDuration, fmtFull, OPS_TZ } from './opsTime';

/**
 * The record: every ops shift in a range, for a store, a period, a
 * department — sorted by what needs attention.
 *
 * This is the half of the board that never existed. The live wall answers
 * "what is happening"; this answers "what happened", which is the
 * question actually asked at a Monday review: the overnight at Destin
 * last Tuesday, or every morning shift at Front Beach this month.
 *
 * Rows are a table on purpose. Tiles are for a handful of live shifts;
 * two hundred past ones need columns you can scan down and sort.
 */

const PERIOD_LABEL: Record<string, string> = {
  MORNING: 'Morning',
  EVENING: 'Evening',
  CLOSING: 'Closing',
  OVERNIGHT: 'Overnight',
};


function pctTone(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return 'text-silver/60';
  if (pct >= 90) return 'text-success';
  if (pct >= 70) return 'text-gold';
  return 'text-alert';
}

export function OpsHistory({
  query,
  onOpenRecord,
}: {
  query: OpsHistoryQuery;
  onOpenRecord: (shiftId: string) => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getOpsHistory>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadAt, setReloadAt] = useState(0);
  const [search, setSearch] = useState('');

  const key = JSON.stringify(query);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getOpsHistory(JSON.parse(key) as OpsHistoryQuery)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // Clearing on success matters: a stuck banner over a working
        // board is how the old one behaved, and only a reload cleared it.
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load the record.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, reloadAt]);

  const rows = useMemo(() => {
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return data?.shifts ?? [];
    return (data?.shifts ?? []).filter((s) => {
      const hay = [
        s.locationName,
        s.clientName,
        s.department,
        s.position,
        s.openedByEmail,
        s.closingSummary,
        PERIOD_LABEL[s.period],
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [data, search]);

  if (error) {
    return (
      <ErrorBanner
        action={
          <Button size="sm" variant="outline" onClick={() => setReloadAt(Date.now())}>
            Try again
          </Button>
        }
      >
        {error}
      </ErrorBanner>
    );
  }

  if (loading && !data) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (!data) return null;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-navy-secondary p-3">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Store, department, supervisor, closing note…"
            aria-label="Search these shifts"
            wrapperClassName="min-w-[13rem] flex-1"
          />
          <p className="text-xs text-silver/70 tabular-nums">
            {rows.length === (data.shifts.length ?? 0)
              ? `${rows.length} shift${rows.length === 1 ? '' : 's'}`
              : `${rows.length} of ${data.shifts.length}`}
            {data.truncated && ' · capped at 500, narrow the dates'}
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={HistoryIcon}
              title="No shifts match"
              description="Widen the dates, or clear the store and period filters above."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-sm">
              <caption className="sr-only">
                Store Ops shifts from {fmtDayKey(data.range.from)} to{' '}
                {fmtDayKey(data.range.to)}, times in {OPS_TZ}
              </caption>
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wider text-silver/70">
                  <th scope="col" className="px-3 py-2 font-semibold">Day</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Store</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Shift</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Opened</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Closed</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Ran</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Checklist</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Submitted by</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Flags</th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    <span className="sr-only">Packet</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <HistoryRow key={s.id} shift={s} onOpen={() => onOpenRecord(s.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryRow({ shift: s, onOpen }: { shift: OpsShiftRow; onOpen: () => void }) {
  const pct = s.completionPct ?? (s.taskTotal > 0 ? Math.round((s.taskDone / s.taskTotal) * 100) : null);
  return (
    <tr className="border-t border-navy-secondary/60 hover:bg-navy-secondary/20">
      <td className="whitespace-nowrap px-3 py-2 text-silver">{fmtDayKey(s.dateKey)}</td>
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open the ${PERIOD_LABEL[s.period] ?? s.period} ${s.department} shift at ${
            s.locationName ?? s.clientName
          } on ${fmtDayKey(s.dateKey)}`}
          className="text-left font-medium text-white hover:text-gold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          {s.locationName ?? s.clientName}
        </button>
        {s.locationName && (
          <div className="text-2xs text-silver/60">{s.clientName}</div>
        )}
      </td>
      <td className="px-3 py-2 text-silver">
        <span className="text-gold">{PERIOD_LABEL[s.period] ?? s.period}</span>{' '}
        {s.department}
        {s.departments && s.departments.length > 1 && (
          <span className="text-2xs text-silver/60"> +{s.departments.length - 1}</span>
        )}
      </td>
      <td
        className="whitespace-nowrap px-3 py-2 tabular-nums text-silver"
        title={fmtFull(s.openedAt)}
      >
        {fmtClock(s.openedAt)}
      </td>
      <td
        className="whitespace-nowrap px-3 py-2 tabular-nums text-silver"
        title={s.closedAt ? fmtFull(s.closedAt) : 'Still running'}
      >
        {s.closedAt ? fmtClock(s.closedAt) : <span className="text-success">live</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-silver/80">
        {fmtDuration(s.openedAt, s.closedAt) || '—'}
      </td>
      <td className="whitespace-nowrap px-3 py-2 tabular-nums">
        <span className={cn('font-medium', pctTone(pct))}>
          {pct === null ? '—' : `${pct}%`}
        </span>
        <span className="ml-1.5 text-2xs text-silver/70">
          {s.taskDone}/{s.taskTotal}
        </span>
      </td>
      <td className="px-3 py-2">
        {/* The supervisor account that submitted the shift. A record with
            no signature on it cannot settle a question about the shift. */}
        <div className="max-w-[12rem] truncate text-silver" title={s.submittedByAccount ?? undefined}>
          {s.submittedByAccount ?? (
            <span className="text-silver/50">
              {s.status === 'ACTIVE' ? 'not yet submitted' : 'unknown account'}
            </span>
          )}
        </div>
        {s.openedByAccount && s.openedByAccount !== s.submittedByAccount && (
          <div className="max-w-[12rem] truncate text-2xs text-gold" title={s.openedByAccount}>
            opened by {s.openedByAccount}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {s.tempAlerts > 0 && <Badge variant="destructive" size="sm">{s.tempAlerts} temp</Badge>}
          {s.closedIncomplete && <Badge variant="destructive" size="sm">incomplete</Badge>}
          {s.status === 'ACTIVE' && <Badge variant="accent" size="sm">running</Badge>}
          {s.tempAlerts === 0 && !s.closedIncomplete && s.status !== 'ACTIVE' && (
            <span className="text-2xs text-silver/60">clean</span>
          )}
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <a
          href={opsPacketUrl('shift', { shiftId: s.id })}
          target="_blank"
          rel="noreferrer"
          download
          aria-label={`Download the SOP packet for the ${
            PERIOD_LABEL[s.period] ?? s.period
          } shift at ${s.locationName ?? s.clientName} on ${fmtDayKey(s.dateKey)}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded text-silver/60 transition-colors hover:bg-navy-secondary/40 hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </td>
    </tr>
  );
}
