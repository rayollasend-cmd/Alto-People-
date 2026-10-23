import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Scale, Undo2 } from 'lucide-react';
import type { BankReconciliationDetail, BankReconLine } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import {
  BANK_KEY,
  completeReconciliation,
  getBankAccount,
  getReconciliation,
  listReconciliations,
  reconciliationReportUrl,
  startReconciliation,
  tickReconciliation,
  undoReconciliation,
} from '@/lib/books/bankApi';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { money } from './bankKit';

/**
 * Reconcile a bank or card account to its statement: the statement's end
 * date and closing balance, then tick every line the statement shows until
 * statement balance − (beginning balance + cleared) is zero, and complete.
 */
export function ReconcilePage() {
  const { id = '' } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const manage = can('manage:books');
  const account = useQuery({ queryKey: [...BANK_KEY, 'account', id], queryFn: () => getBankAccount(id) });
  const recs = useQuery({ queryKey: [...BANK_KEY, 'recs', id], queryFn: () => listReconciliations(id) });
  const recId = params.get('rec') ?? recs.data?.reconciliations.find((r) => r.status === 'IN_PROGRESS')?.id ?? null;
  const a = account.data?.account;

  return (
    <ListTemplate
      title={a ? `Reconcile ${a.name}` : 'Reconcile'}
      subtitle="Tick each line the statement shows. Complete when the difference is zero."
      breadcrumbs={[
        { label: 'Books', to: '/books' },
        { label: 'Bank and cards', to: '/books/bank' },
        { label: a?.name ?? 'Account', to: `/books/bank/${id}` },
        { label: 'Reconcile' },
      ]}
    >
      {account.isPending || recs.isPending ? (
        <SkeletonRows count={4} rowHeight="h-20" />
      ) : account.isError ? (
        <QueryError what="this bank account" query={account} />
      ) : recId ? (
        <Reconciliation key={recId} recId={recId} manage={manage} feedId={id} />
      ) : manage ? (
        <StartForm feedId={id} lastEnd={recs.data?.reconciliations.find((r) => r.status === 'COMPLETED')?.statementEndDate ?? null} onStarted={(rid) => setParams({ rec: rid }, { replace: true })} />
      ) : (
        <EmptyState icon={Scale} title="Nothing being reconciled" description="Finance starts a reconciliation from the statement." />
      )}
    </ListTemplate>
  );
}

function lastMonthEnd(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0)).toISOString().slice(0, 10);
}

function StartForm({ feedId, lastEnd, onStarted }: { feedId: string; lastEnd: string | null; onStarted: (id: string) => void }) {
  const qc = useQueryClient();
  const [end, setEnd] = useState(lastMonthEnd());
  const [balance, setBalance] = useState('');
  const start = useMutation({
    mutationFn: () => startReconciliation(feedId, { statementEndDate: end, statementBalance: Number(balance) }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: BANK_KEY });
      onStarted(r.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not start the reconciliation.'),
  });
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(end) && balance.trim() !== '' && Number.isFinite(Number(balance)) && (!lastEnd || end > lastEnd);
  return (
    <Card className="max-w-xl">
      <CardContent className="space-y-4 p-6">
        <div>
          <p className="font-medium text-ink">From the statement</p>
          <p className="text-sm text-silver">{lastEnd ? `Reconciled through ${fmtDate(lastEnd)}. This one starts the day after.` : 'The first reconciliation of this account.'}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Statement end date" error={lastEnd && end <= lastEnd ? `Pick a date after ${fmtDate(lastEnd)}.` : undefined}>
            {(p) => <Input {...p} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />}
          </Field>
          <Field label="Ending balance" hint="As printed on the statement">
            {(p) => <Input {...p} type="number" step="0.01" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" />}
          </Field>
        </div>
        <Button onClick={() => start.mutate()} loading={start.isPending} disabled={!ok}>
          <Scale className="h-4 w-4" aria-hidden="true" />
          Start reconciling
        </Button>
      </CardContent>
    </Card>
  );
}

function Reconciliation({ recId, feedId, manage }: { recId: string; feedId: string; manage: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = [...BANK_KEY, 'rec', recId];
  const q = useQuery({ queryKey: key, queryFn: () => getReconciliation(recId) });
  const setData = (d: BankReconciliationDetail) => qc.setQueryData(key, d);
  const tick = useMutation({
    mutationFn: (v: { lineIds: string[]; cleared: boolean }) => tickReconciliation(recId, v.lineIds, v.cleared),
    onSuccess: setData,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update the line.'),
  });
  const complete = useMutation({
    mutationFn: () => completeReconciliation(recId),
    onSuccess: (d) => {
      setData(d);
      toast.success(`Reconciled through ${fmtDate(d.statementEndDate)}.`);
      void qc.invalidateQueries({ queryKey: BANK_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not complete.'),
  });
  const undo = useMutation({
    mutationFn: () => undoReconciliation(recId),
    onSuccess: (d) => {
      setData(d);
      toast.success('Reopened. Its lines are ticked again, not cleared.');
      void qc.invalidateQueries({ queryKey: BANK_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not undo.'),
  });

  if (q.isPending) return <SkeletonRows count={6} rowHeight="h-12" />;
  if (q.isError) return <QueryError what="the reconciliation" query={q} />;
  const d = q.data;
  const done = d.status === 'COMPLETED';
  const card = d.subtype === 'CREDIT_CARD';
  const zero = Math.round(d.difference * 100) === 0;
  return (
    <div className="space-y-4 pb-24">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={done ? 'success' : 'pending'}>{done ? 'Reconciled' : 'In progress'}</Badge>
        <span className="text-sm text-silver">Statement through {fmtDate(d.statementEndDate)}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="ghost" asChild>
            <a href={reconciliationReportUrl(d.id)}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Report
            </a>
          </Button>
          {done && manage && d.canUndo && (
            <Button
              variant="secondary"
              loading={undo.isPending}
              onClick={async () => {
                if (await confirm({ title: 'Undo this reconciliation?', description: 'It reopens with its lines ticked; nothing in the books changes.', confirmLabel: 'Undo' })) undo.mutate();
              }}
            >
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              Undo
            </Button>
          )}
        </div>
      </div>
      {/* One pane under the other until there's room for both side by side. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Column
          title={card ? 'Charges' : 'Deposits and other credits'}
          lines={d.lines.filter((l) => l.amount > 0)}
          disabled={done || !manage || tick.isPending}
          onTick={(lineIds, cleared) => tick.mutate({ lineIds, cleared })}
        />
        <Column
          title={card ? 'Payments and credits' : 'Checks and payments'}
          lines={d.lines.filter((l) => l.amount < 0)}
          disabled={done || !manage || tick.isPending}
          onTick={(lineIds, cleared) => tick.mutate({ lineIds, cleared })}
        />
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-label="Statement balance against what’s ticked"
        data-testid="reconcile-balance-bar"
        className="sticky bottom-0 z-10 -mx-4 grid grid-cols-2 items-center gap-x-6 gap-y-1.5 border-t border-navy-secondary bg-navy/95 px-4 py-2.5 backdrop-blur sm:mx-0 sm:flex sm:flex-wrap sm:gap-y-2 sm:rounded-lg sm:border sm:py-3"
      >
        <Fact label="Statement balance" value={money(d.statementBalance)} />
        <Fact label="Beginning balance" value={money(d.beginningBalance)} />
        <Fact label="Cleared" value={money(d.clearedBalance)} />
        <Fact label="Difference" value={money(d.difference)} tone={zero ? 'good' : 'bad'} />
        <div className="col-span-2 flex items-center justify-end gap-2 sm:ml-auto">
          {done ? (
            <span className="flex items-center gap-1.5 text-sm font-medium text-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Reconciled
            </span>
          ) : manage ? (
            <Button onClick={() => complete.mutate()} loading={complete.isPending} disabled={!zero || tick.isPending}>
              {zero ? 'Complete the reconciliation' : 'Difference must be zero'}
            </Button>
          ) : null}
          <Button variant="ghost" asChild>
            <Link to={`/books/bank/${feedId}?tab=reconcile`}>Done</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <p className="text-xs text-silver">{label}</p>
      <p className={cn('text-base font-semibold tabular-nums sm:text-lg', tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-warning' : 'text-ink')}>{value}</p>
    </div>
  );
}

function Column({ title, lines, disabled, onTick }: { title: string; lines: BankReconLine[]; disabled: boolean; onTick: (lineIds: string[], cleared: boolean) => void }) {
  const ticked = lines.filter((l) => l.cleared);
  const total = useMemo(() => ticked.reduce((s, l) => s + Math.round(l.amount * 100), 0) / 100, [ticked]);
  const allTicked = lines.length > 0 && ticked.length === lines.length;
  return (
    <Card className="min-w-0">
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-navy-secondary px-4 py-3">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-gold"
              aria-label={`Tick every line in ${title}`}
              checked={allTicked}
              disabled={disabled || lines.length === 0}
              onChange={() => onTick(lines.filter((l) => l.cleared === allTicked).map((l) => l.lineId), !allTicked)}
            />
            <span className="font-medium text-ink">{title}</span>
          </label>
          <span className="ml-auto text-sm text-silver">
            {ticked.length} of {lines.length} · <span className="tabular-nums text-ink">{money(Math.abs(total))}</span>
          </span>
        </div>
        {lines.length === 0 ? (
          <EmptyState size="sm" title="None through the statement date." />
        ) : (
          <ul className="max-h-[32rem] divide-y divide-navy-secondary overflow-auto">
            {lines.map((l) => (
              <li key={l.lineId}>
                <label className={cn('flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-navy-secondary/30', l.cleared && 'bg-gold/[0.04]')}>
                  <input type="checkbox" className="h-4 w-4 shrink-0 accent-gold" checked={l.cleared} disabled={disabled} onChange={() => onTick([l.lineId], !l.cleared)} />
                  {/* Below sm the date sits over the memo, so the amount never leaves the screen. */}
                  <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
                    <span className="shrink-0 text-xs tabular-nums text-silver sm:w-20">{fmtDate(l.date)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink" title={l.memo ?? undefined}>
                      {l.memo ?? `Entry #${l.entryNumber}`}
                      <span className="ml-1.5 text-xs text-silver">#{l.entryNumber}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-ink">{money(Math.abs(l.amount))}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
