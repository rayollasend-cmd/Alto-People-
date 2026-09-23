import { useQuery } from '@tanstack/react-query';
import { Download, History as HistoryIcon } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
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
 * Rows are a grid on purpose. Tiles are for a handful of live shifts; two
 * hundred past ones need columns you can sort, search, hide and export.
 * The server's own ordering (?sort=recent|worst|store) is what the rows
 * arrive in; the grid's column sort is a further cut on top of it and is
 * kept out of the URL so the two never fight over the same parameter.
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

const pctOf = (s: OpsShiftRow) =>
  s.completionPct ?? (s.taskTotal > 0 ? Math.round((s.taskDone / s.taskTotal) * 100) : null);

const storeOf = (s: OpsShiftRow) => s.locationName ?? s.clientName;

export function OpsHistory({
  query,
  onOpenRecord,
}: {
  query: OpsHistoryQuery;
  onOpenRecord: (shiftId: string) => void;
}) {
  // The query layer, not a hand-rolled effect: the same range asked for
  // twice is fetched once, Back restores the answer instantly, a failed
  // poll retries, and the banner clears itself on the next success —
  // which the old effect had to remember to do by hand.
  const {
    data,
    error: queryError,
    isPending,
    refetch,
  } = useQuery({
    queryKey: ['ops', 'history', query],
    queryFn: () => getOpsHistory(query),
    placeholderData: (prev) => prev,
  });
  const loading = isPending;
  const error = queryError
    ? queryError instanceof ApiError
      ? queryError.message
      : 'Could not load the record.'
    : null;

  const columns: GridColumn<OpsShiftRow>[] = [
    {
      key: 'day',
      header: 'Day',
      accessor: (s) => s.dateKey,
      csv: (s) => s.dateKey,
      sortable: true,
      className: 'whitespace-nowrap text-silver',
      cell: (s) => fmtDayKey(s.dateKey),
      cardMeta: true,
    },
    {
      key: 'store',
      header: 'Store',
      accessor: (s) => storeOf(s),
      sortable: true,
      primary: true,
      cell: (s) => (
        <>
          <span className="font-medium text-white">{storeOf(s)}</span>
          {s.locationName && <div className="text-2xs text-silver/60">{s.clientName}</div>}
        </>
      ),
    },
    {
      key: 'shift',
      header: 'Shift',
      accessor: (s) => `${PERIOD_LABEL[s.period] ?? s.period} ${s.department}`,
      sortable: true,
      cardMeta: true,
      className: 'text-silver',
      cell: (s) => (
        <>
          <span className="text-gold">{PERIOD_LABEL[s.period] ?? s.period}</span> {s.department}
          {s.departments && s.departments.length > 1 && (
            <span className="text-2xs text-silver/60"> +{s.departments.length - 1}</span>
          )}
        </>
      ),
    },
    {
      key: 'opened',
      header: 'Opened',
      accessor: (s) => new Date(s.openedAt).getTime(),
      csv: (s) => fmtFull(s.openedAt),
      searchable: false,
      sortable: true,
      className: 'whitespace-nowrap tabular-nums text-silver',
      cell: (s) => <span title={fmtFull(s.openedAt)}>{fmtClock(s.openedAt)}</span>,
    },
    {
      key: 'closed',
      header: 'Closed',
      accessor: (s) => (s.closedAt ? new Date(s.closedAt).getTime() : null),
      csv: (s) => (s.closedAt ? fmtFull(s.closedAt) : 'still running'),
      searchable: false,
      sortable: true,
      className: 'whitespace-nowrap tabular-nums text-silver',
      cell: (s) =>
        s.closedAt ? (
          <span title={fmtFull(s.closedAt)}>{fmtClock(s.closedAt)}</span>
        ) : (
          <span className="text-success">live</span>
        ),
    },
    {
      key: 'ran',
      header: 'Ran',
      accessor: (s) =>
        s.closedAt ? new Date(s.closedAt).getTime() - new Date(s.openedAt).getTime() : null,
      csv: (s) => fmtDuration(s.openedAt, s.closedAt) || '',
      searchable: false,
      sortable: true,
      className: 'whitespace-nowrap tabular-nums text-silver/80',
      cell: (s) => fmtDuration(s.openedAt, s.closedAt) || '—',
    },
    {
      key: 'checklist',
      header: 'Checklist',
      accessor: (s) => pctOf(s),
      csv: (s) => `${pctOf(s) ?? ''}`,
      searchable: false,
      sortable: true,
      className: 'whitespace-nowrap tabular-nums',
      cell: (s) => {
        const pct = pctOf(s);
        return (
          <>
            <span className={cn('font-medium', pctTone(pct))}>{pct === null ? '—' : `${pct}%`}</span>
            <span className="ml-1.5 text-2xs text-silver/70">
              {s.taskDone}/{s.taskTotal}
            </span>
          </>
        );
      },
    },
    {
      key: 'submittedBy',
      header: 'Submitted by',
      accessor: (s) => s.submittedByAccount ?? s.openedByAccount ?? null,
      sortable: true,
      // The supervisor account that submitted the shift. A record with no
      // signature on it cannot settle a question about the shift.
      cell: (s) => (
        <>
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
        </>
      ),
    },
    {
      key: 'flags',
      header: 'Flags',
      accessor: (s) =>
        [
          s.tempAlerts > 0 ? `${s.tempAlerts} temp` : null,
          s.closedIncomplete ? 'incomplete' : null,
          s.status === 'ACTIVE' ? 'running' : null,
        ]
          .filter(Boolean)
          .join(' ') || 'clean',
      sortable: true,
      cell: (s) => (
        <div className="flex flex-wrap items-center gap-1">
          {s.tempAlerts > 0 && <Badge variant="destructive" size="sm">{s.tempAlerts} temp</Badge>}
          {s.closedIncomplete && <Badge variant="destructive" size="sm">incomplete</Badge>}
          {s.status === 'ACTIVE' && <Badge variant="accent" size="sm">running</Badge>}
          {s.tempAlerts === 0 && !s.closedIncomplete && s.status !== 'ACTIVE' && (
            <span className="text-2xs text-silver/60">clean</span>
          )}
        </div>
      ),
    },
    {
      key: 'notes',
      header: 'Closing note',
      accessor: (s) => s.closingSummary,
      defaultHidden: true,
      className: 'max-w-[20rem] truncate text-xs text-silver/80',
    },
    {
      key: 'packet',
      header: 'Packet',
      accessor: () => null,
      searchable: false,
      csv: () => '',
      align: 'right',
      className: 'whitespace-nowrap',
      cell: (s) => (
        <a
          href={opsPacketUrl('shift', { shiftId: s.id })}
          target="_blank"
          rel="noreferrer"
          download
          onClick={(e) => e.stopPropagation()}
          aria-label={`Download the SOP packet for the ${
            PERIOD_LABEL[s.period] ?? s.period
          } shift at ${storeOf(s)} on ${fmtDayKey(s.dateKey)}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded text-silver/60 transition-colors hover:bg-navy-secondary/40 hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      ),
    },
  ];

  return (
    <Card>
      <CardContent className="p-3">
        <DataGrid<OpsShiftRow>
          id="ops-history"
          caption={
            data
              ? `Store Ops shifts from ${fmtDayKey(data.range.from)} to ${fmtDayKey(data.range.to)}, times in ${OPS_TZ}`
              : 'Store Ops shifts'
          }
          rows={data?.shifts ?? null}
          columns={columns}
          rowKey={(s) => s.id}
          loading={loading}
          error={error}
          onRetry={() => void refetch()}
          search={{ placeholder: 'Store, department, supervisor, closing note…' }}
          urlState={false}
          exportCsv={{ filename: 'store-ops-shifts' }}
          footnote={data?.truncated ? 'capped at 500, narrow the dates' : undefined}
          onRowClick={(s) => onOpenRecord(s.id)}
          rowActionLabel={(s) =>
            `Open the ${PERIOD_LABEL[s.period] ?? s.period} ${s.department} shift at ${storeOf(s)} on ${fmtDayKey(
              s.dateKey,
            )}`
          }
          empty={{
            icon: HistoryIcon,
            title: 'No shifts match',
            description: 'Widen the dates, or clear the store and period filters above.',
          }}
        />
      </CardContent>
    </Card>
  );
}
