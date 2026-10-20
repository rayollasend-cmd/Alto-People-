import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { QboMappingRow } from '@alto-people/shared';
import { fmtDateTime } from '@/lib/format';
import { listQboAccounts, listQboMappings, QBO_KEY, relinkQboAccount, type QboMappingKind } from '@/lib/books/quickbooksApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { errMsg } from './qboWords';

/** What on the site is what in QuickBooks — accounts, vendors and customers — with a way to point an account somewhere else. */

const KIND_WORDS: Record<QboMappingKind, { one: string; many: string }> = {
  accounts: { one: 'account', many: 'accounts' },
  vendors: { one: 'vendor', many: 'vendors' },
  customers: { one: 'client', many: 'clients' },
};

export function MappingPanel({ manage }: { manage: boolean }) {
  const [kind, setKind] = useState<QboMappingKind>('accounts');
  const [editing, setEditing] = useState<QboMappingRow | null>(null);
  const q = useQuery({ queryKey: [...QBO_KEY, 'mappings', kind], queryFn: () => listQboMappings(kind) });

  const columns: GridColumn<QboMappingRow>[] = [
    {
      key: 'site',
      header: 'On the site',
      primary: true,
      sortable: true,
      accessor: (r) => r.siteName,
      cell: (r) => (
        <span>
          <span className="font-medium text-ink">{r.siteName}</span>
          {r.siteDetail && <span className="block text-xs text-ink-muted">{r.siteDetail}</span>}
        </span>
      ),
    },
    {
      key: 'qbo',
      header: 'In QuickBooks',
      cardMeta: true,
      sortable: true,
      accessor: (r) => r.qboName ?? (r.qboId ? `#${r.qboId}` : ''),
      cell: (r) => (r.qboId ? <span className="text-ink">{r.qboName ?? `QuickBooks #${r.qboId}`}</span> : <span className="text-ink-muted">Not linked yet — goes over with its first use</span>),
    },
    {
      key: 'home',
      header: 'Made in',
      accessor: (r) => r.owner ?? '',
      cell: (r) => (r.owner ? <Badge size="sm" variant={r.owner === 'SITE' ? 'info' : 'accent'}>{r.owner === 'SITE' ? 'The site' : 'QuickBooks'}</Badge> : '—'),
    },
    { key: 'synced', header: 'Last in step', accessor: (r) => r.lastSyncedAt ?? '', cell: (r) => (r.lastSyncedAt ? fmtDateTime(r.lastSyncedAt) : '—'), className: 'whitespace-nowrap' },
    ...(manage && kind === 'accounts'
      ? [
          {
            key: 'actions',
            header: '',
            accessor: () => null,
            searchable: false,
            csv: () => '',
            stopRowClick: true,
            align: 'right' as const,
            cell: (r: QboMappingRow) => (
              <Button size="xs" variant="ghost" onClick={() => setEditing(r)} aria-label={`Change where ${r.siteName} goes in QuickBooks`}>
                Change
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-3">
      <SegmentedControl ariaLabel="What to map" value={kind} onChange={setKind} options={[{ value: 'accounts', label: 'Accounts' }, { value: 'vendors', label: 'Vendors' }, { value: 'customers', label: 'Clients' }]} />
      <DataGrid
        id={`books-qbo-mapping-${kind}`}
        caption={`QuickBooks mapping — ${KIND_WORDS[kind].many}`}
        noun={KIND_WORDS[kind]}
        rows={q.data?.rows}
        loading={q.isLoading}
        error={q.isError ? errMsg(q.error, 'Couldn’t load the mapping.') : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(r) => r.localId}
        urlState={false}
      />
      {editing && <RelinkDialog row={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RelinkDialog({ row, onClose }: { row: QboMappingRow; onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: [...QBO_KEY, 'qbo-accounts'], queryFn: listQboAccounts });
  const [qboId, setQboId] = useState(row.qboId ?? '');
  const save = useMutation({
    mutationFn: () => relinkQboAccount(row.localId, qboId),
    onSuccess: () => {
      toast.success(`${row.siteName} now goes to the QuickBooks account you chose.`);
      void qc.invalidateQueries({ queryKey: QBO_KEY });
      onClose();
    },
    onError: (err) => toast.error(errMsg(err, 'Couldn’t change the link.')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Where ${row.siteName} goes in QuickBooks`}</DialogTitle>
          <DialogDescription>Entries on this account post to the QuickBooks account you pick, from the next sync on. What already went over stays where it is.</DialogDescription>
        </DialogHeader>
        <Field label="QuickBooks account">
          {(p) => (
            <Select value={qboId} onChange={(e) => setQboId(e.target.value)} disabled={accounts.isLoading} {...p}>
              <option value="">{accounts.isLoading ? 'Loading QuickBooks accounts…' : 'Choose an account…'}</option>
              {(accounts.data?.accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {`${a.number ? `${a.number} ` : ''}${a.name} (${a.type})${a.active ? '' : ' — inactive'}`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!qboId || qboId === row.qboId}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
