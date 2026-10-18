import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send, Users } from 'lucide-react';
import { centsToMoney, getDeposits, sendPrenotes, type DepositAccount } from '@/lib/bankingApi';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { fmtDate } from '@/lib/format';

/**
 * Employees' bank accounts as our ACH sees them: verified or not, how a
 * paycheck splits, and whether the zero-dollar test (prenote) cleared.
 */

const PRENOTE: Record<string, { label: string; tone: NonNullable<BadgeProps['variant']> }> = {
  CLEARED: { label: 'Test cleared', tone: 'success' },
  SENT: { label: 'Test sent', tone: 'info' },
  RETURNED: { label: 'Test came back', tone: 'destructive' },
};

function splitText(a: DepositAccount): string {
  if (!a.split) return a.isPrimary ? 'Rest of pay' : '—';
  if (a.split.kind === 'AMOUNT') return `${centsToMoney(a.split.amountCents ?? 0)} each check`;
  return `${a.split.percent ?? 0}% of each check`;
}

export function DepositsTab({ requirePrenote, onAch }: { requirePrenote: boolean; onAch: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll-banking', 'deposits'], queryFn: getDeposits });
  const send = useMutation({
    mutationFn: sendPrenotes,
    onSuccess: (r) => {
      toast.success(r.sent ? `Tests sent to ${r.sent} account${r.sent === 1 ? '' : 's'}.` : 'Every verified account already has its test.');
      void qc.invalidateQueries({ queryKey: ['payroll-banking'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const c = q.data?.counts;
  const cols: GridColumn<DepositAccount>[] = [
    { key: 'name', header: 'Person', primary: true, accessor: (a) => a.name, cell: (a) => <span className="font-medium text-ink">{a.name}</span>, sortable: true },
    { key: 'account', header: 'Account', accessor: (a) => a.accountLast4 ?? '', cell: (a) => `${a.bankName ? `${a.bankName} ` : ''}${a.accountType === 'SAVINGS' ? 'savings' : 'checking'} ····${a.accountLast4 ?? '—'}`, cardMeta: true },
    { key: 'split', header: 'Gets', accessor: (a) => splitText(a) },
    { key: 'verified', header: 'Verified', accessor: (a) => (a.verified ? 'Yes' : 'No'), cell: (a) => (a.verified ? <Badge variant="success">Verified</Badge> : <Badge variant="pending">Not verified</Badge>), searchable: false },
    {
      key: 'prenote',
      header: 'Bank test',
      accessor: (a) => a.prenoteStatus ?? '',
      searchable: false,
      cell: (a) => {
        if (!a.prenoteStatus) return <span className="text-sm text-ink-muted">{a.verified ? 'Not sent yet' : 'After verification'}</span>;
        const p = PRENOTE[a.prenoteStatus]!;
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant={p.tone}>{p.label}</Badge>
            {a.prenoteSentAt && <span className="text-xs text-ink-muted">{fmtDate(a.prenoteSentAt)}</span>}
          </span>
        );
      },
    },
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Test cleared" value={c ? String(c.cleared) : '—'} hint="Ready for pay" />
        <MetricCard label="Test out" value={c ? String(c.sent) : '—'} hint="Clears in two banking days" />
        <MetricCard label="Test came back" value={c ? String(c.returned) : '—'} hint="Pay is held from these" accent={(c?.returned ?? 0) > 0} />
        <MetricCard label="Split paychecks" value={c ? String(c.split) : '—'} hint="Accounts taking a share" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-ink-muted">
          {requirePrenote
            ? 'Each newly verified account gets a zero-dollar test first. Pay isn’t held while it’s out; if the bank sends it back, pay to that account stops until the person fixes it.'
            : 'Tests are off: new accounts are paid without one. Turn them on in Setup.'}
        </p>
        {onAch && requirePrenote && (
          <Button size="sm" variant="outline" onClick={() => send.mutate()} loading={send.isPending} disabled={!c || c.due === 0}>
            <Send className="mr-1.5 h-4 w-4" aria-hidden /> {c && c.due > 0 ? `Send ${c.due} test${c.due === 1 ? '' : 's'} now` : 'No tests due'}
          </Button>
        )}
      </div>
      <DataGrid<DepositAccount>
        id="payroll-banking-deposits"
        caption="Employee bank accounts"
        noun={{ one: 'account', many: 'accounts' }}
        rows={q.data?.accounts}
        loading={q.isLoading}
        error={q.isError ? (q.error as Error).message : null}
        onRetry={() => void q.refetch()}
        columns={cols}
        rowKey={(a) => a.id}
        defaultSort={{ key: 'name', direction: 'asc' }}
        empty={{ icon: Users, title: 'No bank accounts on file', description: 'Accounts appear here as people add direct deposit.' }}
      />
    </div>
  );
}
