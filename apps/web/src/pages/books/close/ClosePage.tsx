import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarCheck } from 'lucide-react';
import type { CloseMonthSummary } from '@alto-people/shared';
import { listCloseMonths } from '@/lib/books/closeApi';
import { fmtDate } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { ProgressBar } from '@/components/ui/Progress';
import { CloseStatusBadge, pct } from './closeKit';

/**
 * The month-end close, month by month: where each month stands, who
 * prepared it and who signed it off. The month after the last close is
 * the one to work.
 */
export function ClosePage() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['books', 'close', 'list'], queryFn: listCloseMonths });
  const months = q.data?.months ?? [];
  const next = months.find((m) => m.periodKey === q.data?.nextToClose) ?? null;
  const closed = months.filter((m) => m.status === 'CLOSED').length;
  const waiting = months.filter((m) => m.status === 'READY').length;

  const columns: GridColumn<CloseMonthSummary>[] = [
    { key: 'month', header: 'Month', accessor: (m) => m.periodKey, primary: true, sortable: true, cell: (m) => <span className="font-medium text-ink">{m.label}</span> },
    { key: 'status', header: 'Status', accessor: (m) => m.status, cardMeta: true, cell: (m) => <CloseStatusBadge status={m.status} ended={m.ended} size="sm" /> },
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
    { key: 'prepared', header: 'Prepared by', accessor: (m) => m.preparedByName ?? '', cell: (m) => m.preparedByName ?? '—' },
    { key: 'signed', header: 'Signed off by', accessor: (m) => m.signedOffByName ?? '', cell: (m) => m.signedOffByName ?? '—' },
    { key: 'closed', header: 'Closed', accessor: (m) => m.closedAt ?? '', sortable: true, cell: (m) => (m.closedAt ? fmtDate(m.closedAt) : m.pendingReopen ? 'Reopen requested' : '—') },
  ];

  return (
    <ListTemplate
      title="Month-end close"
      subtitle="Each month’s checklist, its lock, and a second person’s sign-off. A closed month takes no more entries."
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Month-end close' }]}
      primaryAction={
        next ? (
          <Button onClick={() => navigate(`/books/close/${next.periodKey}`)}>
            Close {next.label}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : undefined
      }
      summary={
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Next to close" value={next ? next.label : 'All caught up'} hint={next ? `${next.tasksDone} of ${next.tasksTotal} steps done` : 'Every month that has ended is closed'} />
          <MetricCard label="Waiting for sign-off" value={waiting} hint={waiting ? 'A second person signs each close' : 'Nothing waiting'} accent={waiting > 0} />
          <MetricCard label="Closed, last 12 months" value={closed} />
        </div>
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
        search={false}
        empty={{ icon: CalendarCheck, title: 'No months yet', description: 'The close starts with the first month the books cover.' }}
      />
    </ListTemplate>
  );
}
