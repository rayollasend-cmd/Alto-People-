import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Pause, Play, Send } from 'lucide-react';
import { AGING_BUCKET_KEYS, AGING_BUCKET_LABELS, type ReceivablesAgingRow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { usePrompt } from '@/lib/confirm';
import { pauseClientDunning, resumeClientDunning } from '@/lib/clientsApi';
import { fmtDate, fmtMoney, fmtMoneyCompact, fmtStatementNo, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  RECEIVABLES_KEY,
  addCollectionNote,
  getDsoTrend,
  sendReminderNow,
  type CollectionItem,
} from '@/lib/books/receivablesApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { StackedBarChart, TrendLineChart } from '@/components/ui/charts';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toaster';
import { AGING_COLORS } from '@/pages/finance/financeCharts';
import { useWho } from './receivablesKit';

/**
 * Finance walk 7 — collections, in Receivables: every open statement with
 * where the reminder cadence stands, the last promise or call, and the day
 * the next action is due (the sort); send a reminder now, log a promise to
 * pay, pause a client — without leaving the page. Beside it, what each
 * client owes by age (the one aging definition) and days to collect, month
 * by month.
 */

const money = (n: number) => fmtMoney(n, { precise: true });

/** The reminder cadence's stages in words (lib/statementDunning). */
export const REMINDER_STAGE: Record<number, string> = {
  0: 'None sent',
  1: '3 days before due',
  2: 'On the due day',
  3: '7 days late',
  4: '14 days late',
  5: '30 days late (final)',
};

const statementNo = (n: number | null) => fmtStatementNo(n, 'Statement');

/** Send now, promise to pay, pause / resume — one set of actions for the worklist and the client's expanded row. */
export function useCollectionActions() {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const [promising, setPromising] = useState<CollectionItem | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: RECEIVABLES_KEY });
  const send = useMutation({
    mutationFn: (i: CollectionItem) => sendReminderNow(i.clientId, i.statementId),
    onSuccess: (r, i) => {
      toast.success(`Reminder sent to ${i.clientName}${r.recipients ? ` (${r.recipients} ${r.recipients === 1 ? 'person' : 'people'})` : ''} — ${REMINDER_STAGE[r.stage]?.toLowerCase() ?? `stage ${r.stage}`}.`);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send the reminder.'),
  });
  const pause = useMutation({
    mutationFn: async (i: CollectionItem) => {
      if (i.paused) {
        await resumeClientDunning(i.clientId);
        return 'resumed' as const;
      }
      const note = await prompt({
        title: `Pause reminders to ${i.clientName}?`,
        description: 'No reminders go to this client until you resume. Say why, so whoever picks this up knows.',
        reasonLabel: 'Why',
        reasonPlaceholder: `Disputing the overtime line on ${statementNo(i.number)}`,
        reasonMaxLength: 500,
        confirmLabel: 'Pause reminders',
      });
      if (!note) return null;
      await pauseClientDunning(i.clientId, note);
      return 'paused' as const;
    },
    onSuccess: (r) => {
      if (!r) return;
      toast.success(r === 'paused' ? 'Reminders paused.' : 'Reminders resumed.');
      refresh();
      void qc.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change reminders.'),
  });
  return { send, pause, promising, setPromising, refresh };
}

export function CollectionActions({ item, actions }: { item: CollectionItem; actions: ReturnType<typeof useCollectionActions> }) {
  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      <Button size="xs" variant="ghost" onClick={() => actions.send.mutate(item)} loading={actions.send.isPending && actions.send.variables?.statementId === item.statementId} disabled={item.reminderStage >= 5} title={item.reminderStage >= 5 ? 'Every reminder in the cadence has gone' : undefined}>
        <Send className="h-3.5 w-3.5" aria-hidden="true" />
        Send reminder now
      </Button>
      <Button size="xs" variant="ghost" onClick={() => actions.setPromising(item)}>
        <HandCoins className="h-3.5 w-3.5" aria-hidden="true" />
        Log promise
      </Button>
      <Button size="xs" variant="ghost" onClick={() => actions.pause.mutate(item)} loading={actions.pause.isPending && actions.pause.variables?.clientId === item.clientId}>
        {item.paused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
        {item.paused ? 'Resume' : 'Pause'}
      </Button>
    </span>
  );
}

/** Where the cadence stands for one statement: stage, last sent, next scheduled. */
export function ReminderLine({ item }: { item: CollectionItem }) {
  return (
    <span className="text-xs text-silver">
      {REMINDER_STAGE[item.reminderStage] ?? `Stage ${item.reminderStage}`}
      {item.lastReminderAt ? ` · sent ${fmtDate(item.lastReminderAt)}` : ''}
      {item.paused ? <span className="text-warning"> · paused{item.pauseNote ? ` — ${item.pauseNote}` : ''}</span> : item.nextReminderOn ? ` · next ${fmtDate(item.nextReminderOn)}` : ''}
    </span>
  );
}

export function CollectionsGrid({ items, loading, error, onRetry, manage }: { items: CollectionItem[]; loading: boolean; error: string | null; onRetry: () => void; manage: boolean }) {
  const who = useWho();
  const actions = useCollectionActions();
  const today = ymdLocal();
  const columns: GridColumn<CollectionItem>[] = [
    { key: 'client', header: who.One, accessor: (i) => i.clientName, sortable: true, primary: true, cell: (i) => <Link to={`/clients/${i.clientId}?tab=statements`} className="font-medium text-ink hover:text-gold hover:underline">{i.clientName}</Link> },
    { key: 'statement', header: 'Statement', accessor: (i) => i.number ?? 0, sortable: true, cardMeta: true, cell: (i) => `${statementNo(i.number)} · ${fmtDate(i.periodStart)} – ${fmtDate(i.periodEnd)}` },
    { key: 'open', header: 'Open', accessor: (i) => i.open, csv: (i) => i.open.toFixed(2), sortable: true, searchable: false, align: 'right', className: 'tabular-nums font-medium', cell: (i) => money(i.open) },
    {
      key: 'late',
      header: 'Days late',
      accessor: (i) => i.daysPastDue,
      sortable: true,
      searchable: false,
      align: 'right',
      cell: (i) => (i.daysPastDue > 0 ? <Badge size="sm" variant={i.daysPastDue > 60 ? 'destructive' : 'pending'}>{i.daysPastDue} days</Badge> : <span className="text-xs text-silver">due {fmtDate(i.dueOn)}</span>),
    },
    { key: 'reminder', header: 'Reminders', accessor: (i) => i.reminderStage, sortable: true, searchable: false, cell: (i) => <ReminderLine item={i} /> },
    {
      key: 'note',
      header: 'Last contact',
      accessor: (i) => i.lastNote?.note ?? '',
      cell: (i) =>
        i.lastNote ? (
          <span className="text-xs text-silver">
            {i.lastNote.kind === 'PROMISE' ? `Promised ${i.lastNote.promisedAmount !== null ? money(i.lastNote.promisedAmount) : ''} by ${fmtDate(i.lastNote.promisedOn ?? '')}` : i.lastNote.kind === 'CALL' ? 'Call' : 'Note'}
            {' — '}
            {i.lastNote.note}
          </span>
        ) : (
          <span className="text-xs text-silver">—</span>
        ),
    },
    {
      key: 'next',
      header: 'Next action',
      accessor: (i) => i.nextActionOn,
      sortable: true,
      searchable: false,
      cell: (i) => <span className={cn('whitespace-nowrap text-xs tabular-nums', i.nextActionOn <= today ? 'font-medium text-alert' : 'text-ink')}>{i.nextActionOn <= today ? 'Today' : fmtDate(i.nextActionOn)}</span>,
    },
    ...(manage ? [{ key: 'actions', header: '', accessor: () => null, searchable: false, csv: () => '', align: 'right' as const, stopRowClick: true, cell: (i: CollectionItem) => <CollectionActions item={i} actions={actions} /> }] : []),
  ];
  return (
    <>
      <DataGrid
        id="books-receivables-collections"
        caption="Collections"
        rows={items}
        columns={columns}
        rowKey={(i) => i.statementId}
        loading={loading}
        error={error}
        onRetry={onRetry}
        noun={{ one: 'statement', many: 'statements' }}
        exportCsv={{ filename: `collections-${ymdLocal()}` }}
        defaultSort={{ key: 'next', direction: 'asc' }}
        empty={{ icon: HandCoins, title: 'Nothing to collect', description: 'Every finalized statement is paid.' }}
        footnote="Sorted by when the next action is due: a promise’s date, the reminder cadence’s next send, or today for anything late."
      />
      {actions.promising && <PromiseDialog item={actions.promising} onClose={() => actions.setPromising(null)} onSaved={actions.refresh} />}
    </>
  );
}

export function PromiseDialog({ item, onClose, onSaved }: { item: CollectionItem; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<'PROMISE' | 'CALL' | 'NOTE'>('PROMISE');
  const [on, setOn] = useState('');
  const [amount, setAmount] = useState(item.open.toFixed(2));
  const [note, setNote] = useState('');
  useEffect(() => setAmount(item.open.toFixed(2)), [item]);
  const save = useMutation({
    mutationFn: () =>
      addCollectionNote(item.clientId, {
        kind,
        note: note.trim(),
        statementId: item.statementId,
        promisedOn: kind === 'PROMISE' ? on : null,
        promisedAmount: kind === 'PROMISE' && Number(amount) > 0 ? Number(amount) : null,
      }),
    onSuccess: () => {
      toast.success(kind === 'PROMISE' ? `Promise logged — ${item.clientName} pays by ${fmtDate(on)}.` : 'Logged.');
      onSaved();
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not log it.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item.clientName} — {statementNo(item.number)}</DialogTitle>
          <DialogDescription>{money(item.open)} open{item.daysPastDue > 0 ? `, ${item.daysPastDue} days late` : ''}. What did they say?</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="What happened">
          {(['PROMISE', 'CALL', 'NOTE'] as const).map((k) => (
            <Button key={k} size="sm" type="button" role="radio" aria-checked={kind === k} variant={kind === k ? 'primary' : 'secondary'} onClick={() => setKind(k)}>
              {k === 'PROMISE' ? 'Promise to pay' : k === 'CALL' ? 'Call' : 'Note'}
            </Button>
          ))}
        </div>
        {kind === 'PROMISE' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Pays by">{(p) => <Input type="date" min={ymdLocal()} value={on} onChange={(e) => setOn(e.target.value)} {...p} />}</Field>
            <Field label="Amount">{(p) => <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} {...p} />}</Field>
          </div>
        )}
        <Field label="Note">{(p) => <Input value={note} maxLength={1000} placeholder={kind === 'PROMISE' ? 'Check goes out Friday — spoke with Dana in AP' : 'Left a voicemail for AP'} onChange={(e) => setNote(e.target.value)} {...p} />}</Field>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!note.trim() || (kind === 'PROMISE' && !on)}>
            {kind === 'PROMISE' ? 'Log promise' : 'Log it'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What each client owes, split by the one aging definition (days past due). */
export function AgingByClientChart({ rows }: { rows: ReceivablesAgingRow[] }) {
  const who = useWho();
  if (rows.length === 0) return null;
  const top = [...rows].sort((a, b) => b.open - a.open).slice(0, 8);
  const data = top.map((r) => ({ client: r.clientName, ...r.buckets, total: r.open }));
  const late = top.filter((r) => r.open - r.buckets.current > 0).length;
  const summary = `${top.length} ${top.length === 1 ? who.one : who.many} with money open; ${late} past due. Most owed: ${top[0]!.clientName}, ${money(top[0]!.open)}.`;
  return (
    <ChartFrame
      title={`What ${who.many} owe, by age`}
      description="Days past each statement’s due date — the same buckets on the finance home, in Books and the executive view."
      summary={summary}
      columns={[
        { key: 'client', label: who.One },
        ...AGING_BUCKET_KEYS.map((k) => ({ key: k, label: AGING_BUCKET_LABELS[k], numeric: true, format: (v: unknown) => money(Number(v)) })),
        { key: 'total', label: 'Total', numeric: true, format: (v) => money(Number(v)) },
      ]}
      rows={data}
      csvName="receivables-by-age"
      height={Math.max(160, 44 + top.length * 32)}
    >
      <StackedBarChart
        data={data}
        x="client"
        layout="horizontal"
        series={AGING_BUCKET_KEYS.map((k) => ({ key: k, name: AGING_BUCKET_LABELS[k], color: AGING_COLORS[k] }))}
        format={(v) => fmtMoneyCompact(v)}
      />
    </ChartFrame>
  );
}

/** Days to collect, month by month: how long statements paid that month took. */
export function DsoTrendChart() {
  const q = useQuery({ queryKey: [...RECEIVABLES_KEY, 'dso'], queryFn: () => getDsoTrend(6) });
  const months = q.data?.months ?? [];
  if (!q.data) return null;
  const paid = months.filter((m) => m.days !== null);
  const summary = paid.length
    ? `Days to collect over the last ${months.length} months: ${paid.map((m) => `${m.label} ${m.days}`).join(', ')}.`
    : 'No statements were paid in the last six months.';
  return (
    <ChartFrame
      title="Days to collect"
      description="For the statements paid each month, the average days from finalized to paid."
      summary={summary}
      columns={[
        { key: 'label', label: 'Month' },
        { key: 'days', label: 'Days to collect', numeric: true, format: (v) => (v === null || v === undefined ? '—' : String(v)) },
        { key: 'statements', label: 'Statements paid', numeric: true },
        { key: 'collected', label: 'Collected', numeric: true, format: (v) => money(Number(v)) },
      ]}
      rows={(paid.length ? months : []) as unknown as Array<Record<string, unknown>>}
      csvName="days-to-collect"
      height={200}
      empty={<p className="flex h-full items-center justify-center text-sm text-ink-muted">No statements were paid in the last six months.</p>}
    >
      <TrendLineChart data={months as unknown as Array<Record<string, unknown>>} x="label" series={[{ key: 'days', name: 'Days to collect' }]} format={(v) => `${v}d`} zeroBased />
    </ChartFrame>
  );
}
