import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarCheck } from 'lucide-react';
import type { CloseMonthSummary } from '@alto-people/shared';
import { listCloseMonths } from '@/lib/books/closeApi';
import { fmtDate, ymdLocal } from '@/lib/format';
import { useDesktopTable } from '@/lib/useViewport';
import { ListTemplate } from '@/components/templates';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { ProgressBar } from '@/components/ui/Progress';
import { CloseStatusBadge, pct, sinceMonthEndWords } from './closeKit';

/**
 * The month-end close, month by month: where each month stands, how long
 * an ended month has waited, who prepared it and who signed it off. The
 * month after the last close is the one to work.
 */
export function ClosePage() {
  const desktop = useDesktopTable();
  const today = ymdLocal();
  const q = useQuery({ queryKey: ['books', 'close', 'list'], queryFn: listCloseMonths });
  const months = q.data?.months ?? [];
  const next = months.find((m) => m.periodKey === q.data?.nextToClose) ?? null;
  const closed = months.filter((m) => m.status === 'CLOSED').length;
  const waiting = months.filter((m) => m.status === 'READY').length;
  const waited = (m: CloseMonthSummary) => (m.status !== 'CLOSED' && m.ended ? sinceMonthEndWords(m.periodKey, today) : null);
  /** Who and when, only what's there: "Prepared by Dana · signed off by Lee · closed Oct 5". */
  const people = (m: CloseMonthSummary) =>
    [m.preparedByName && `Prepared by ${m.preparedByName}`, m.signedOffByName && `signed off by ${m.signedOffByName}`, m.closedAt ? `closed ${fmtDate(m.closedAt)}` : m.pendingReopen ? 'reopen requested' : null]
      .filter(Boolean)
      .join(' · ');

  const columns: GridColumn<CloseMonthSummary>[] = [
    { key: 'month', header: 'Month', accessor: (m) => m.periodKey, primary: true, sortable: true, cell: (m) => <span className="font-medium text-ink">{m.label}</span> },
    {
      key: 'status',
      header: 'Status',
      accessor: (m) => m.status,
      cardMeta: true,
      cell: (m) => (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <CloseStatusBadge status={m.status} ended={m.ended} size="sm" />
          {waited(m) && <span className="text-xs text-ink-muted">{waited(m)}</span>}
        </span>
      ),
    },
    {
      key: 'progress',
      header: 'Checklist',
      accessor: (m) => pct(m.tasksDone, m.tasksTotal),
      searchable: false,
      width: '14rem',
      cell: (m) => (
        <span className="flex items-center gap-3">
          <ProgressBar percent={pct(m.tasksDone, m.tasksTotal)} hideLabel className="w-28" label={`${m.label} checklist`} />
          <span className="text-xs tabular-nums text-ink-muted">
            {m.tasksDone}/{m.tasksTotal}
          </span>
        </span>
      ),
    },
    // A phone card shows only what's there — one line of who and when, not three empty "—" fields.
    ...(desktop
      ? ([
          { key: 'prepared', header: 'Prepared by', accessor: (m) => m.preparedByName ?? '', cell: (m) => m.preparedByName ?? '—' },
          { key: 'signed', header: 'Signed off by', accessor: (m) => m.signedOffByName ?? '', cell: (m) => m.signedOffByName ?? '—' },
          { key: 'closed', header: 'Closed', accessor: (m) => m.closedAt ?? '', sortable: true, cell: (m) => (m.closedAt ? fmtDate(m.closedAt) : m.pendingReopen ? 'Reopen requested' : '—') },
        ] satisfies GridColumn<CloseMonthSummary>[])
      : ([{ key: 'people', header: 'Who', accessor: (m) => people(m), cardMeta: true, cell: (m) => (people(m) ? <span>{people(m)}</span> : null) }] satisfies GridColumn<CloseMonthSummary>[])),
  ];

  return (
    <ListTemplate
      title="Month-end close"
      subtitle="Each month’s checklist, its lock, and a second person’s sign-off. A closed month takes no more entries."
      actions={next ? [{ key: 'next', label: `Close ${next.label}`, icon: ArrowRight, primary: true, to: `/books/close/${next.periodKey}` }] : undefined}
      summary={
        <MetricStrip label="The close at a glance" empty={q.isSuccess && months.length === 0}>
          <MetricCard
            label="Next to close"
            value={next ? next.label : 'All caught up'}
            hint={next ? [`${next.tasksDone} of ${next.tasksTotal} steps done`, waited(next)].filter(Boolean).join(' · ') : 'Every month that has ended is closed'}
            href={next ? `/books/close/${next.periodKey}` : undefined}
          />
          <MetricCard label="Waiting for sign-off" value={waiting} hint={waiting ? 'A second person signs each close' : undefined} nothing={waiting ? undefined : 'Nothing waiting'} tone={waiting ? 'warning' : 'default'} />
          <MetricCard label="Closed, last 12 months" value={closed} />
        </MetricStrip>
      }
    >
      <DataGrid
        id="books-close-months"
        caption="Months"
        noun={{ one: 'month', many: 'months' }}
        rows={q.data ? months : null}
        loading={q.isLoading}
        error={q.error ? 'Couldn’t load the close.' : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(m) => m.periodKey}
        rowHref={(m) => `/books/close/${m.periodKey}`}
        rowActionLabel={(m) => `Open the ${m.label} close`}
        search={false}
        empty={{ icon: CalendarCheck, title: 'No months yet', description: 'The close starts with the first month the books cover.' }}
      />
    </ListTemplate>
  );
}
