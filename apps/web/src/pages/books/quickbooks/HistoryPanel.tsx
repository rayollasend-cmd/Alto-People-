import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine } from '@/components/ui/icons';
import type { QboSyncEventRow } from '@alto-people/shared';
import { fmtDateTime } from '@/lib/format';
import { listQboEvents, QBO_KEY } from '@/lib/books/quickbooksApi';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { errMsg, LOCAL_WORDS } from './qboWords';

/** Every send and every pull, newest first — what happened, to what, and what QuickBooks said. */

const RESULT: Record<QboSyncEventRow['result'], { label: string; tone: NonNullable<BadgeProps['variant']> }> = {
  OK: { label: 'Done', tone: 'success' },
  SKIPPED: { label: 'Left alone', tone: 'default' },
  CONFLICT: { label: 'Needs a decision', tone: 'pending' },
  ERROR: { label: 'Failed', tone: 'destructive' },
};

type Filter = 'ALL' | QboSyncEventRow['result'];

export function HistoryPanel() {
  const [filter, setFilter] = useState<Filter>('ALL');
  const q = useInfiniteQuery({
    queryKey: [...QBO_KEY, 'events', filter],
    queryFn: ({ pageParam }) => listQboEvents({ cursor: pageParam, limit: 100, result: filter === 'ALL' ? undefined : filter }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = q.data?.pages.flatMap((p) => p.events);

  const columns: GridColumn<QboSyncEventRow>[] = [
    { key: 'when', header: 'When', accessor: (e) => e.createdAt, cell: (e) => fmtDateTime(e.createdAt), sortable: true, className: 'whitespace-nowrap tabular-nums' },
    {
      key: 'way',
      header: 'Way',
      cardMeta: true,
      accessor: (e) => (e.direction === 'PUSH' ? 'Sent' : 'Brought in'),
      cell: (e) => (
        <span className="inline-flex items-center gap-1.5 text-ink-muted">
          {e.direction === 'PUSH' ? <ArrowUpFromLine className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />}
          {e.direction === 'PUSH' ? 'Sent' : 'Brought in'}
        </span>
      ),
    },
    { key: 'result', header: 'Result', accessor: (e) => RESULT[e.result]?.label ?? e.result, cell: (e) => <Badge size="sm" variant={RESULT[e.result]?.tone ?? 'default'}>{RESULT[e.result]?.label ?? e.result}</Badge> },
    {
      key: 'record',
      header: 'Record',
      accessor: (e) => `${e.localType ? (LOCAL_WORDS[e.localType] ?? e.localType) : ''} ${e.qboType ? `QuickBooks ${e.qboType} ${e.qboId ?? ''}` : ''}`.trim(),
      cell: (e) => <span className="text-sm text-ink-muted">{[e.localType ? (LOCAL_WORDS[e.localType] ?? e.localType) : null, e.qboType ? `QuickBooks ${e.qboType}${e.qboId ? ` ${e.qboId}` : ''}` : null].filter(Boolean).join(' · ') || '—'}</span>,
    },
    { key: 'message', header: 'What happened', primary: true, accessor: (e) => e.message ?? '', cell: (e) => <span className="text-sm text-ink">{e.message ?? '—'}</span> },
  ];

  return (
    <div className="space-y-3">
      <SegmentedControl
        ariaLabel="Which events"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'ALL', label: 'Everything' },
          { value: 'ERROR', label: 'Failed' },
          { value: 'CONFLICT', label: 'Needs a decision' },
          { value: 'OK', label: 'Done' },
        ]}
      />
      <DataGrid
        id="books-qbo-history"
        caption="QuickBooks sync history"
        noun={{ one: 'event', many: 'events' }}
        rows={rows}
        loading={q.isLoading}
        error={q.isError ? errMsg(q.error, 'Couldn’t load the history.') : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(e) => e.id}
        urlState={false}
      />
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
            Show older
          </Button>
        </div>
      )}
    </div>
  );
}
