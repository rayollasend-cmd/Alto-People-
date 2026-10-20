import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Inbox, RotateCcw } from 'lucide-react';
import type { QboOutboxRow } from '@alto-people/shared';
import { fmtDateTime } from '@/lib/format';
import { listQboOutbox, QBO_KEY, retryQboFailed, retryQboOutbox } from '@/lib/books/quickbooksApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { errMsg, LOCAL_WORDS } from './qboWords';

/** Site changes on their way to QuickBooks — and the ones that couldn't go, with QuickBooks' own reason. */

export function OutboxPanel({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [...QBO_KEY, 'outbox'], queryFn: () => listQboOutbox() });
  const refresh = () => qc.invalidateQueries({ queryKey: QBO_KEY });
  const retry = useMutation({ mutationFn: retryQboOutbox, onSuccess: () => { toast.success('It goes with the next sync.'); void refresh(); }, onError: (err) => toast.error(errMsg(err)) });
  const retryAll = useMutation({ mutationFn: retryQboFailed, onSuccess: (r) => { toast.success(`${r.retried} will go with the next sync.`); void refresh(); }, onError: (err) => toast.error(errMsg(err)) });
  const rows = q.data?.rows;
  const failed = rows?.filter((r) => r.status === 'FAILED').length ?? 0;

  const columns: GridColumn<QboOutboxRow>[] = [
    {
      key: 'what',
      header: 'What',
      primary: true,
      accessor: (r) => r.label,
      cell: (r) => (
        <span className="min-w-0">
          {r.link ? (
            <Link to={r.link} className="font-medium text-ink hover:text-gold hover:underline">
              {r.label}
            </Link>
          ) : (
            <span className="font-medium text-ink">{r.label}</span>
          )}
          <span className="block text-xs text-ink-muted">{`${LOCAL_WORDS[r.localType] ?? r.localType} · ${r.op === 'DELETE' ? 'to remove' : 'to send'}`}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cardMeta: true,
      accessor: (r) => r.status,
      cell: (r) => (
        <Badge size="sm" variant={r.status === 'FAILED' ? 'destructive' : 'pending'}>
          {r.status === 'FAILED' ? 'Couldn’t go' : r.attempts ? `Trying again (${r.attempts})` : 'Waiting'}
        </Badge>
      ),
    },
    { key: 'next', header: 'Next try', accessor: (r) => r.nextAttemptAt, cell: (r) => (r.status === 'FAILED' ? '—' : fmtDateTime(r.nextAttemptAt)), className: 'whitespace-nowrap' },
    { key: 'why', header: 'QuickBooks said', accessor: (r) => r.lastError ?? '', cell: (r) => <span className="text-sm text-ink-muted">{r.lastError ?? '—'}</span> },
    {
      key: 'actions',
      header: '',
      accessor: () => null,
      searchable: false,
      csv: () => '',
      stopRowClick: true,
      align: 'right',
      cell: (r) =>
        manage && r.status === 'FAILED' ? (
          <Button size="xs" variant="ghost" onClick={() => retry.mutate(r.id)}>
            Try again
          </Button>
        ) : null,
    },
  ];

  if (rows && rows.length === 0) return <EmptyState icon={Inbox} title="Nothing waiting" description="Every change on the site is in QuickBooks." />;
  return (
    <div className="space-y-3">
      {manage && failed > 0 && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => retryAll.mutate()} loading={retryAll.isPending}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            {`Try all ${failed} again`}
          </Button>
        </div>
      )}
      <DataGrid
        id="books-qbo-outbox"
        caption="Waiting to go to QuickBooks"
        noun={{ one: 'change', many: 'changes' }}
        rows={rows}
        loading={q.isLoading}
        error={q.isError ? errMsg(q.error, 'Couldn’t load the queue.') : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(r) => r.id}
        urlState={false}
      />
    </div>
  );
}
