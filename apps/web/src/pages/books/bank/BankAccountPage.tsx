import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Ban, CheckCheck, Download, FileSpreadsheet, HandCoins, ListChecks, MoreHorizontal, Pencil, Plus, RefreshCw, Scale, Search, Sparkles, Trash2, Undo2, Wand2 } from 'lucide-react';
import type { BankBulkAction, BankCategorizeInput, BankFeedAccountView, BankRuleInput, BankRuleView, BankTxnStatus, BankTxnSuggestions, BankTxnView } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import {
  BANK_KEY,
  applyBankRules,
  bulkDecideTxns,
  categorizeTxn,
  createBankRule,
  deleteBankRule,
  excludeTxn,
  getBankAccount,
  getTxnSuggestionsBatch,
  listBankRules,
  listBankTransactions,
  listReconciliations,
  matchTxn,
  reconciliationReportUrl,
  syncBankAccount,
  undoTxn,
  updateBankRule,
} from '@/lib/books/bankApi';
import { RECEIVABLES_KEY, getReceivablesAging, undoClientPayment } from '@/lib/books/receivablesApi';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { isTypingTarget, useListKeyboard } from '@/lib/shortcuts';
import { cn } from '@/lib/cn';
import { RecordTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { PaymentDialog, useWho } from '../receivables/receivablesKit';
import { AccountSelect, Amount, ImportButton, money } from './bankKit';

/**
 * One bank or card account in the books: transactions to review (match the
 * line already in the books, accept a suggested category, or pick one),
 * what was decided and undo, the rules that categorize on their own, and
 * the reconciliations.
 */

type Tab = 'review' | 'categorized' | 'matched' | 'excluded' | 'rules' | 'reconcile';
const TABS: Tab[] = ['review', 'categorized', 'matched', 'excluded', 'rules', 'reconcile'];

export function BankAccountPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { can } = useAuth();
  const manage = can('manage:books');
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'review') as Tab;
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === 'review') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };
  const account = useQuery({ queryKey: [...BANK_KEY, 'account', id], queryFn: () => getBankAccount(id) });
  const counts = useQuery({ queryKey: [...BANK_KEY, 'txns', id, 'counts'], queryFn: () => listBankTransactions(id, { status: 'UNMATCHED' }) });
  const sync = useMutation({
    mutationFn: () => syncBankAccount(id),
    onSuccess: (r) => {
      toast.success(`${r.added} new · ${r.updated} updated${r.removed ? ` · ${r.removed} withdrawn by the bank` : ''}${r.autoCategorized ? ` · ${r.autoCategorized} categorized by rules` : ''}.`);
      void qc.invalidateQueries({ queryKey: BANK_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'The sync failed.'),
  });

  if (account.isPending) return <SkeletonRows count={4} rowHeight="h-24" className="p-6" />;
  if (account.isError) return <QueryError what="this bank account" query={account} className="m-6" />;
  const a = account.data.account;
  const c = counts.data?.counts;

  return (
    <RecordTemplate
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Bank and cards', to: '/books/bank' }, { label: a.name }]}
      title={a.name}
      subtitle={[a.institution, a.mask ? `··${a.mask}` : null, `${a.ledgerCode} ${a.ledgerName}`].filter(Boolean).join(' · ')}
      status={
        a.feed === 'PLAID' ? (
          <Badge variant={a.lastError ? 'destructive' : 'info'}>{a.lastError ? 'Feed failing' : 'Live feed'}</Badge>
        ) : (
          <Badge variant="outline">Statement uploads</Badge>
        )
      }
      actions={
        manage ? (
          <div className="flex flex-wrap gap-2">
            {a.feed === 'PLAID' && (
              <Button variant="secondary" onClick={() => sync.mutate()} loading={sync.isPending}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Sync now
              </Button>
            )}
            <ImportButton feedAccountId={a.id} />
            <Button asChild>
              <Link to={`/books/bank/${a.id}/reconcile`}>
                <Scale className="h-4 w-4" aria-hidden="true" />
                Reconcile
              </Link>
            </Button>
          </div>
        ) : undefined
      }
      summary={<Summary a={a} />}
      tabs={[
        { key: 'review', label: 'For review', count: c?.UNMATCHED, content: <TxnList feed={a} status="UNMATCHED" manage={manage} /> },
        { key: 'categorized', label: 'Categorized', count: c?.CATEGORIZED, content: <TxnList feed={a} status="CATEGORIZED" manage={manage} /> },
        { key: 'matched', label: 'Matched', count: c?.MATCHED, content: <TxnList feed={a} status="MATCHED" manage={manage} /> },
        { key: 'excluded', label: 'Excluded', count: c?.EXCLUDED, content: <TxnList feed={a} status="EXCLUDED" manage={manage} /> },
        { key: 'rules', label: 'Rules', content: <RulesTab feed={a} manage={manage} /> },
        { key: 'reconcile', label: 'Reconciliations', content: <ReconciliationsTab feed={a} manage={manage} /> },
      ]}
      activeTab={tab}
      onTabChange={setTab}
    />
  );
}

function Summary({ a }: { a: BankFeedAccountView }) {
  const card = a.subtype === 'CREDIT_CARD';
  return (
    <div className="space-y-3">
      {a.lastError && (
        <p role="alert" className="rounded-lg border border-alert/30 bg-alert/[0.06] px-3 py-2 text-sm text-ink">
          The feed failed: {a.lastError}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label={card ? 'Owed per the books' : 'In the books'} value={money(a.booksBalance)} />
        <MetricCard label="Per the bank" value={a.bankBalance === null ? '—' : money(a.bankBalance)} hint={a.lastSyncedAt ? `As of ${fmtDateTime(a.lastSyncedAt)}` : 'From the last statement with a balance'} />
        <MetricCard label="For review" value={String(a.forReview)} accent={a.forReview > 0} />
        <MetricCard label="Reconciled through" value={a.lastReconciled ? fmtDate(a.lastReconciled.statementEndDate) : '—'} hint={a.lastReconciled ? `Statement balance ${money(a.lastReconciled.statementBalance)}` : 'Not reconciled yet'} />
      </div>
    </div>
  );
}

/* ---- Transactions ---------------------------------------------------------- */

const PAGE = 40;

function TxnList({ feed, status, manage }: { feed: BankFeedAccountView; status: BankTxnStatus; manage: boolean }) {
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const list = useQuery({ queryKey: [...BANK_KEY, 'txns', feed.id, status, q], queryFn: () => listBankTransactions(feed.id, { status, q: q.trim() || undefined }) });
  const rows = list.data?.transactions ?? [];
  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-silver" aria-hidden="true" />
        <Input aria-label="Search transactions" className="pl-9" placeholder="Search description, payee or check number" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {list.isPending ? (
        <SkeletonRows count={5} rowHeight="h-16" />
      ) : list.isError ? (
        <QueryError what="the transactions" query={list} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={status === 'UNMATCHED' ? CheckCheck : ListChecks}
          title={status === 'UNMATCHED' ? (q ? 'None match that search' : 'All caught up') : 'None here'}
          description={status === 'UNMATCHED' && !q ? 'Every transaction is matched, categorized or excluded. Import a statement or sync to bring in more.' : undefined}
        />
      ) : (
        <>
          {status === 'UNMATCHED' ? (
            <ReviewList rows={rows.slice(0, shown)} feed={feed} manage={manage} />
          ) : (
            <ul className="divide-y divide-navy-secondary rounded-lg border border-navy-secondary bg-navy">
              {rows.slice(0, shown).map((t) => (
                <DecidedRow key={t.id} t={t} manage={manage} />
              ))}
            </ul>
          )}
          {rows.length > shown && (
            <Button variant="ghost" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function TxnFacts({ t }: { t: BankTxnView }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium text-ink" title={t.description}>
        {t.payee && !t.description.toLowerCase().includes(t.payee.toLowerCase()) ? `${t.payee} — ` : ''}
        {t.description}
      </p>
      <p className="text-xs text-silver">
        {fmtDate(t.postedOn)}
        {t.reference ? ` · Ref ${t.reference}` : ''}
        {t.importedFrom === 'FEED' ? ' · Feed' : ` · ${t.importedFrom}`}
      </p>
    </div>
  );
}

/** The category a row would take on "Accept": the rule's, else last time's — none while there's a match in the books, or it looks like a client's payment. */
function acceptable(s: BankTxnSuggestions | undefined): BankCategorizeInput | null {
  // A deposit that looks like a client's payment goes through Receivables (the server's bulk Accept skips it too).
  if (!s || s.matches.length > 0 || s.client) return null;
  if (s.rule) return { accountId: s.rule.accountId, vendorId: s.rule.vendorId, clientId: s.rule.clientId, departmentId: s.rule.departmentId };
  if (s.lastTime) return { accountId: s.lastTime.accountId };
  return null;
}

type UndoBatch = { ids: string[]; payment?: boolean };

type RowAction = { id: string; kind: 'categorize'; input: BankCategorizeInput } | { id: string; kind: 'match'; lineId: string } | { id: string; kind: 'exclude' };

/**
 * For review: the page's suggestions in one request, a checkbox per row,
 * "Accept all suggested" / "Match all exact" (the selection, or every row
 * shown), and the keys — j/k move, a takes the row's suggestion, m matches,
 * x excludes, space selects, u undoes the last decision.
 */
function ReviewList({ rows, feed, manage }: { rows: BankTxnView[]; feed: BankFeedAccountView; manage: boolean }) {
  const qc = useQueryClient();
  const ids = rows.map((r) => r.id);
  // One request per change of the rows shown: a decision drops its row, which re-asks once — the refresh after a
  // decision leaves this query alone rather than asking a second time.
  const batch = useQuery({
    queryKey: [...BANK_KEY, 'suggest', feed.id, 'UNMATCHED', ids],
    queryFn: () => getTxnSuggestionsBatch(ids),
    enabled: ids.length > 0,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const sugg = batch.data?.suggestions ?? {};
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState<BankTxnView | null>(null);
  // The last decisions, newest last — `u` (or the toast) takes them back. A payment recorded from a deposit
  // comes back whole: the payment undone and the deposit back in review.
  const undoStack = useRef<UndoBatch[]>([]);
  const live = new Set(ids);
  const picked = ids.filter((id) => selected.has(id));
  const scope = picked.length > 0 ? rows.filter((r) => selected.has(r.id)) : rows;
  const toAccept = scope.filter((r) => acceptable(sugg[r.id]));
  const toMatch = scope.filter((r) => sugg[r.id]?.exactLineId);

  const refresh = () => void qc.invalidateQueries({ queryKey: BANK_KEY, predicate: (q) => q.queryKey[BANK_KEY.length] !== 'suggest' });
  const undoLast = useMutation({
    mutationFn: async (b: UndoBatch) => {
      const kept: string[] = [];
      for (let i = 0; i < b.ids.length; i++) {
        try {
          const r = await undoTxn(b.ids[i]!, b.payment ? { undoPayment: true } : {});
          if (r.paymentKept) kept.push(r.paymentKept.clientName);
        } catch (err) {
          // What wasn't undone stays on the stack — `u` tries the rest again.
          const rest = b.ids.slice(i);
          undoStack.current.push({ ...b, ids: rest });
          throw Object.assign(err instanceof Error ? err : new Error('Couldn’t undo it.'), { done: i, left: rest.length });
        }
      }
      return { n: b.ids.length, payment: !!b.payment, kept };
    },
    onSuccess: ({ n, payment, kept }) => {
      const base = payment ? 'Payment taken back; the deposit is back in For review.' : n === 1 ? 'Back in For review.' : `${n} back in For review.`;
      toast.success(kept.length ? `${base} The payment from ${kept[0]} is still recorded — undo it in Receivables if it was wrong.` : base);
      refresh();
    },
    onError: (err) => {
      const left = (err as { left?: number }).left;
      toast.error(`${err instanceof ApiError ? err.message : 'Couldn’t undo it.'}${left ? ` ${left} still to undo — press u to try again.` : ''}`);
      refresh();
    },
  });
  const remember = (decided: string[], message: string, payment = false) => {
    if (decided.length === 0) return;
    const b: UndoBatch = { ids: decided, payment };
    undoStack.current.push(b);
    if (undoStack.current.length > 20) undoStack.current.shift();
    toast.success(message, { action: { label: 'Undo', onClick: () => takeBack(b) } });
  };
  const takeBack = (b: UndoBatch) => {
    undoStack.current = undoStack.current.filter((x) => x !== b);
    undoLast.mutate(b);
  };

  const act = useMutation({
    mutationFn: (a: RowAction) => (a.kind === 'categorize' ? categorizeTxn(a.id, a.input) : a.kind === 'match' ? matchTxn(a.id, a.lineId) : excludeTxn(a.id)),
    onSuccess: (_r, a) => {
      remember([a.id], a.kind === 'categorize' ? 'Categorized.' : a.kind === 'match' ? 'Matched to the entry in the books.' : 'Excluded.');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'That didn’t go through.'),
  });
  const bulk = useMutation({
    mutationFn: (v: { action: BankBulkAction; ids: string[] }) => bulkDecideTxns(v.action, v.ids),
    onSuccess: (r) => {
      const verb = r.action === 'ACCEPT' ? 'categorized' : r.action === 'MATCH' ? 'matched' : 'excluded';
      const left = r.skipped.length ? ` · ${r.skipped.length} left for you — ${r.skipped[0]!.reason.replace(/\.$/, '').toLowerCase()}${r.skipped.length > 1 ? ', and others' : ''}` : '';
      if (r.done.length) remember(r.done, `${r.done.length} ${verb}${left}.`);
      else toast.info(`None ${verb}${left}.`);
      setSelected(new Set());
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'That didn’t go through.'),
  });
  const busyId = act.isPending ? act.variables?.id : null;
  const busyAll = bulk.isPending || undoLast.isPending;

  // Keyboard: the shared list hook moves and accepts; m / x / space / u here.
  const after = (id: string) => {
    const at = ids.indexOf(id);
    return ids[at + 1] ?? ids[at - 1] ?? null;
  };
  // A key only takes a match that's unambiguous; otherwise the row opens its choice.
  const [choosing, setChoosing] = useState<string | null>(null);
  const primary = (t: BankTxnView): 'done' | 'choose' | 'none' => {
    const s = sugg[t.id];
    const cat = acceptable(s);
    if (s?.exactLineId) act.mutate({ id: t.id, kind: 'match', lineId: s.exactLineId });
    else if (s && s.matches.length > 0) return 'choose';
    else if (cat) act.mutate({ id: t.id, kind: 'categorize', input: cat });
    else return 'none';
    return 'done';
  };
  const kb = useListKeyboard({
    items: rows,
    idOf: (t) => t.id,
    enabled: manage && !paying,
    onApprove: (t) => {
      if (busyId || busyAll) return;
      const r = primary(t);
      if (r === 'done') kb.setCursor(after(t.id));
      else if (r === 'choose') {
        setChoosing(t.id);
        toast.info('More than one entry could be it — pick the right one.');
      } else toast.info('Nothing suggested for this one — pick a category.');
    },
  });
  useEffect(() => {
    if (!manage || paying) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === 'u') {
        const last = undoStack.current.pop();
        if (last) {
          e.preventDefault();
          undoLast.mutate(last);
        }
        return;
      }
      const t = rows.find((r) => r.id === kb.cursor);
      if (!t || busyId || busyAll) return;
      if (e.key === 'm') {
        const s = sugg[t.id];
        e.preventDefault();
        if (!s?.matches.length) return void toast.info('Nothing in the books to match it to.');
        if (!s.exactLineId) {
          setChoosing(t.id);
          return void toast.info('More than one entry could be it — pick the right one.');
        }
        act.mutate({ id: t.id, kind: 'match', lineId: s.exactLineId });
        kb.setCursor(after(t.id));
      } else if (e.key === 'x') {
        e.preventDefault();
        act.mutate({ id: t.id, kind: 'exclude' });
        kb.setCursor(after(t.id));
      } else if (e.key === ' ') {
        e.preventDefault();
        toggle(t.id, !selected.has(t.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggle = (id: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allOn = picked.length > 0 && picked.length === ids.length;

  return (
    <div className="space-y-2">
      {manage && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-navy-secondary bg-navy px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="h-4 w-4 accent-gold"
              checked={allOn}
              ref={(el) => {
                if (el) el.indeterminate = picked.length > 0 && !allOn;
              }}
              onChange={(e) => setSelected(e.target.checked ? new Set(ids) : new Set())}
              aria-label="Select every transaction shown"
            />
            {picked.length > 0 ? `${picked.length} selected` : 'Select'}
          </label>
          <span className="flex-1" />
          <Button size="sm" variant="secondary" disabled={busyAll || batch.isPending || toAccept.length === 0} loading={bulk.isPending && bulk.variables?.action === 'ACCEPT'} onClick={() => bulk.mutate({ action: 'ACCEPT', ids: toAccept.map((r) => r.id) })}>
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {picked.length > 0 ? 'Accept suggested' : 'Accept all suggested'} ({toAccept.length})
          </Button>
          <Button size="sm" variant="secondary" disabled={busyAll || batch.isPending || toMatch.length === 0} loading={bulk.isPending && bulk.variables?.action === 'MATCH'} onClick={() => bulk.mutate({ action: 'MATCH', ids: toMatch.map((r) => r.id) })}>
            <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
            {picked.length > 0 ? 'Match exact' : 'Match all exact'} ({toMatch.length})
          </Button>
          {picked.length > 0 && (
            <Button size="sm" variant="ghost" disabled={busyAll} loading={bulk.isPending && bulk.variables?.action === 'EXCLUDE'} onClick={() => bulk.mutate({ action: 'EXCLUDE', ids: picked })}>
              <Ban className="h-4 w-4" aria-hidden="true" />
              Exclude ({picked.length})
            </Button>
          )}
          <span className="hidden text-2xs text-silver lg:inline" aria-hidden="true">
            j/k move · a accept · m match · x exclude · u undo
          </span>
        </div>
      )}
      <ul className="divide-y divide-navy-secondary rounded-lg border border-navy-secondary bg-navy" aria-label="Transactions for review" {...kb.listProps}>
        {rows.map((t) => (
          <ReviewRow
            key={t.id}
            t={t}
            feed={feed}
            manage={manage}
            s={sugg[t.id]}
            loading={batch.isPending}
            busy={busyId === t.id || busyAll}
            selected={selected.has(t.id) && live.has(t.id)}
            onSelect={(on) => toggle(t.id, on)}
            onAct={(a) => act.mutate(a)}
            onRecordPayment={() => setPaying(t)}
            choosing={choosing === t.id}
            onChosen={() => setChoosing(null)}
            rowProps={kb.rowProps(t.id)}
          />
        ))}
      </ul>
      {paying && <DepositPayment t={paying} client={sugg[paying.id]?.client ?? null} feed={feed} onClose={() => setPaying(null)} onRecorded={(id) => remember([id], 'Deposit matched to the payment.', true)} />}
    </div>
  );
}

function ReviewRow({
  t,
  feed,
  manage,
  s,
  loading,
  busy,
  selected,
  onSelect,
  onAct,
  onRecordPayment,
  choosing,
  onChosen,
  rowProps,
}: {
  t: BankTxnView;
  feed: BankFeedAccountView;
  manage: boolean;
  s: BankTxnSuggestions | undefined;
  loading: boolean;
  busy: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onAct: (a: RowAction) => void;
  onRecordPayment: () => void;
  choosing: boolean;
  onChosen: () => void;
  rowProps: ReturnType<ReturnType<typeof useListKeyboard>['rowProps']>;
}) {
  const who = useWho();
  const [accountId, setAccountId] = useState('');
  const [ruleFrom, setRuleFrom] = useState(false);
  const best = s?.matches[0];
  const suggestion = s?.rule ?? s?.lastTime ?? null;
  const cat = acceptable(s);
  // A card's credit is a refund, never a client's payment.
  const deposit = t.amount > 0 && feed.subtype !== 'CREDIT_CARD';
  const ambiguous = !!s && s.matches.length > 0 && !s.exactLineId;
  const [pickOpen, setPickOpen] = useState(false);
  const showPick = (choosing || pickOpen) && ambiguous;
  const payLabel = s?.client ? `Record as payment from ${s.client.name}` : `Record as a ${who.one} payment`;
  return (
    <li {...rowProps} className={cn('flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center', selected && 'bg-gold/[0.05]')}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {manage && <input type="checkbox" className="h-4 w-4 shrink-0 accent-gold" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${t.description}`} />}
        <TxnFacts t={t} />
        <Amount value={t.amount} className="shrink-0 text-sm font-semibold" />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:w-[34rem] lg:flex-nowrap lg:justify-end">
        {loading && !s ? (
          <Skeleton className="h-8 w-60" />
        ) : best ? (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-silver lg:text-right">
              <ArrowLeftRight className="mr-1 inline h-3.5 w-3.5 text-gold" aria-hidden="true" />
              Entry #{best.entryNumber} · {best.memo ?? best.source.toLowerCase()} · {fmtDate(best.date)}
              {best.daysApart > 0 ? ` (${best.daysApart} ${best.daysApart === 1 ? 'day' : 'days'} apart)` : ''}
              {s && s.matches.length > 1 && !s.exactLineId ? ` · ${s.matches.length - 1} more could be it` : ''}
            </span>
            {manage &&
              (ambiguous ? (
                <Button size="sm" variant="secondary" onClick={() => setPickOpen((o) => !o)} disabled={busy} aria-expanded={showPick}>
                  Choose ({s!.matches.length})
                </Button>
              ) : (
                <Button size="sm" onClick={() => onAct({ id: t.id, kind: 'match', lineId: best.lineId })} loading={busy} disabled={busy}>
                  Match
                </Button>
              ))}
          </>
        ) : suggestion && cat && !accountId ? (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-silver lg:text-right">
              <Sparkles className="mr-1 inline h-3.5 w-3.5 text-gold" aria-hidden="true" />
              {s?.rule ? `Rule “${s.rule.name}”` : 'Same as last time'} → {suggestion.accountCode} {suggestion.accountName}
            </span>
            {manage && (
              <>
                <Button size="sm" onClick={() => onAct({ id: t.id, kind: 'categorize', input: cat })} loading={busy} disabled={busy}>
                  Accept
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAccountId(' ')} disabled={busy}>
                  Change
                </Button>
              </>
            )}
          </>
        ) : manage ? (
          <>
            {deposit && !accountId.trim() && s?.client && (
              <Button size="sm" variant="secondary" onClick={onRecordPayment} disabled={busy} title={payLabel}>
                <HandCoins className="h-4 w-4" aria-hidden="true" />
                <span className="max-w-[12rem] truncate">Payment from {s.client.name}</span>
              </Button>
            )}
            <div className="min-w-0 flex-1 lg:w-64 lg:flex-none">
              <AccountSelect value={accountId.trim()} onChange={setAccountId} exclude={feed.ledgerAccountId} placeholder="Categorize as…" />
            </div>
            <Button size="sm" onClick={() => onAct({ id: t.id, kind: 'categorize', input: { accountId: accountId.trim() } })} loading={busy} disabled={busy || !accountId.trim()}>
              Categorize
            </Button>
          </>
        ) : (
          <span className="text-xs text-silver">Waiting for Finance</span>
        )}
        {manage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={`More for ${t.description}`} disabled={busy}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {deposit && (
                <DropdownMenuItem onSelect={onRecordPayment}>
                  <HandCoins className="h-4 w-4" aria-hidden="true" />
                  {payLabel}
                </DropdownMenuItem>
              )}
              {best && (
                <DropdownMenuItem onSelect={() => setAccountId(' ')}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  Categorize instead
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setRuleFrom(true)}>
                <Wand2 className="h-4 w-4" aria-hidden="true" />
                Make a rule from this
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAct({ id: t.id, kind: 'exclude' })}>
                <Ban className="h-4 w-4" aria-hidden="true" />
                Exclude (a duplicate, or booked another way)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {showPick && manage && s && (
        <ul className="w-full space-y-1 rounded-md border border-line bg-surface-raised p-2" aria-label={`Entries that could be ${t.description}`}>
          {s.matches.map((m) => (
            <li key={m.lineId} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-ink">
                Entry #{m.entryNumber} · {m.memo ?? m.source.toLowerCase()} · {fmtDate(m.date)}
                {m.daysApart > 0 ? ` (${m.daysApart} ${m.daysApart === 1 ? 'day' : 'days'} apart)` : ' (same day)'}
              </span>
              <Button
                size="xs"
                onClick={() => {
                  onAct({ id: t.id, kind: 'match', lineId: m.lineId });
                  setPickOpen(false);
                  onChosen();
                }}
                disabled={busy}
              >
                Match this
              </Button>
            </li>
          ))}
        </ul>
      )}
      {best && accountId && manage && (
        <div className="flex w-full items-center gap-2 lg:justify-end">
          <div className="w-full lg:w-64">
            <AccountSelect value={accountId.trim()} onChange={setAccountId} exclude={feed.ledgerAccountId} placeholder="Categorize as…" />
          </div>
          <Button size="sm" onClick={() => onAct({ id: t.id, kind: 'categorize', input: { accountId: accountId.trim() } })} disabled={busy || !accountId.trim()}>
            Categorize
          </Button>
        </div>
      )}
      {ruleFrom && <RuleDialog feed={feed} seed={seedFrom(t)} onClose={() => setRuleFrom(false)} />}
    </li>
  );
}

/** A deposit recorded as a client payment: the receivables dialog, prefilled, and the deposit matched once it's recorded. */
function DepositPayment({ t, client, feed, onClose, onRecorded }: { t: BankTxnView; client: { id: string; name: string } | null; feed: BankFeedAccountView; onClose: () => void; onRecorded: (txnId: string) => void }) {
  const aging = useQuery({ queryKey: [...RECEIVABLES_KEY, 'aging', 'for-deposit'], queryFn: () => getReceivablesAging() });
  if (aging.isPending) return null;
  if (aging.isError) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record the deposit as a payment</DialogTitle>
            <DialogDescription>Couldn’t load who owes what.</DialogDescription>
          </DialogHeader>
          <QueryError what="what’s owed" query={aging} />
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <PaymentDialog
      open
      onOpenChange={(o) => !o && onClose()}
      initialClientId={client?.id ?? null}
      extraClient={client}
      rows={aging.data.rows}
      statements={aging.data.statements}
      deposit={{ transaction: t, ledgerAccountId: feed.ledgerAccountId, ledgerLabel: `${feed.ledgerCode} ${feed.ledgerName}` }}
      onRecorded={(r) => {
        if (r.depositMatched ?? r.bankTransaction?.status === 'MATCHED') onRecorded(t.id);
      }}
    />
  );
}

function seedFrom(t: BankTxnView): Partial<BankRuleInput> {
  const words = (t.payee || t.description).replace(/[#*0-9]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' ');
  return { name: words, contains: words.toLowerCase(), direction: t.amount < 0 ? 'OUT' : 'IN' };
}

function DecidedRow({ t, manage }: { t: BankTxnView; manage: boolean }) {
  const qc = useQueryClient();
  const undo = useMutation({
    mutationFn: (opts: { undoPayment?: boolean } = {}) => undoTxn(t.id, opts),
    onSuccess: (r, opts) => {
      void qc.invalidateQueries({ queryKey: ['books'] });
      if (opts.undoPayment) return void toast.success('Payment taken back; the deposit is back in For review.');
      if (r.paymentKept) {
        // Only the match was undone: say so, and offer to take the payment back too.
        const kept = r.paymentKept;
        return void toast.success(`Back in For review. The payment from ${kept.clientName} is still recorded.`, {
          action: {
            label: 'Undo the payment too',
            onClick: () =>
              void undoClientPayment(kept.id, 'Recorded from a bank deposit by mistake')
                .then(() => {
                  toast.success('Payment taken back.');
                  void qc.invalidateQueries({ queryKey: ['books'] });
                })
                .catch((err) => toast.error(err instanceof ApiError ? err.message : 'Couldn’t undo the payment.')),
          },
        });
      }
      toast.success('Back in For review.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'That didn’t go through.'),
  });
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <TxnFacts t={t} />
      <span className="w-full text-xs text-silver sm:w-auto sm:max-w-[20rem] sm:truncate">
        {t.status === 'CATEGORIZED' && t.category ? (
          <>
            {t.category.transfer ? 'Transfer to ' : ''}
            {t.category.code} {t.category.name}
            {t.ruleName ? <Badge size="sm" variant="outline" className="ml-2">Rule: {t.ruleName}</Badge> : null}
          </>
        ) : t.status === 'MATCHED' && t.matched ? (
          <Link className="text-gold hover:underline" to={`/books/journal/${t.matched.entryId}`}>
            Entry #{t.matched.entryNumber} · {fmtDate(t.matched.date)}
          </Link>
        ) : t.status === 'EXCLUDED' ? (
          'Excluded'
        ) : null}
      </span>
      <Amount value={t.amount} className="shrink-0 text-sm font-semibold" />
      {manage && (
        <Button size="sm" variant="ghost" onClick={() => undo.mutate({})} loading={undo.isPending}>
          <Undo2 className="h-4 w-4" aria-hidden="true" />
          Undo
        </Button>
      )}
    </li>
  );
}

/* ---- Rules ----------------------------------------------------------------- */

function RulesTab({ feed, manage }: { feed: BankFeedAccountView; manage: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const rules = useQuery({ queryKey: [...BANK_KEY, 'rules'], queryFn: listBankRules });
  const [editing, setEditing] = useState<BankRuleView | 'new' | null>(null);
  const apply = useMutation({
    mutationFn: () => applyBankRules(feed.id),
    onSuccess: (r) => {
      toast.success(r.categorized ? `${r.categorized} ${r.categorized === 1 ? 'transaction' : 'transactions'} categorized.` : 'No waiting transaction fits a rule.');
      void qc.invalidateQueries({ queryKey: BANK_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not apply the rules.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteBankRule(id),
    onSuccess: () => {
      toast.success('Rule deleted.');
      void qc.invalidateQueries({ queryKey: [...BANK_KEY, 'rules'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete the rule.'),
  });
  const list = rules.data?.rules ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-silver">Rules apply to every bank and card account, first by priority. Auto rules categorize as transactions arrive; the rest are suggestions you accept.</p>
        {manage && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => apply.mutate()} loading={apply.isPending} disabled={list.length === 0}>
              <Wand2 className="h-4 w-4" aria-hidden="true" />
              Apply rules now
            </Button>
            <Button onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New rule
            </Button>
          </div>
        )}
      </div>
      {rules.isPending ? (
        <SkeletonRows count={3} />
      ) : rules.isError ? (
        <QueryError what="the rules" query={rules} />
      ) : list.length === 0 ? (
        <EmptyState icon={Wand2} title="Make the first rule" description="“Anything from SHELL is vehicle fuel.” Rules save categorizing the same thing every month — make one from any transaction too." />
      ) : (
        <ul className="divide-y divide-navy-secondary rounded-lg border border-navy-secondary bg-navy">
          {list.map((r) => (
            <li key={r.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-3', !r.isActive && 'opacity-60')}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {r.name}
                  {r.autoApply && (
                    <Badge size="sm" variant="accent" className="ml-2">
                      Auto
                    </Badge>
                  )}
                  {!r.isActive && (
                    <Badge size="sm" variant="outline" className="ml-2">
                      Off
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-silver">
                  {r.direction === 'IN' ? 'Money in' : r.direction === 'OUT' ? 'Money out' : 'Anything'} containing “{r.contains}”
                  {r.minAmount !== null || r.maxAmount !== null ? ` · ${r.minAmount !== null ? money(r.minAmount) : '$0'}–${r.maxAmount !== null ? money(r.maxAmount) : 'any'}` : ''} → {r.accountCode} {r.accountName}
                  {` · priority ${r.priority}`}
                </p>
              </div>
              {manage && (
                <div className="flex gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${r.name}`}
                    onClick={async () => {
                      if (await confirm({ title: `Delete the rule “${r.name}”?`, description: 'What it already categorized stays as it is.', confirmLabel: 'Delete', destructive: true })) remove.mutate(r.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleDialog feed={feed} rule={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RuleDialog({ feed, rule, seed, onClose }: { feed: BankFeedAccountView; rule?: BankRuleView; seed?: Partial<BankRuleInput>; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(rule?.name ?? seed?.name ?? '');
  const [contains, setContains] = useState(rule?.contains ?? seed?.contains ?? '');
  const [direction, setDirection] = useState<'IN' | 'OUT' | 'ANY'>(rule?.direction ?? seed?.direction ?? 'ANY');
  const [min, setMin] = useState(rule?.minAmount != null ? String(rule.minAmount) : '');
  const [max, setMax] = useState(rule?.maxAmount != null ? String(rule.maxAmount) : '');
  const [accountId, setAccountId] = useState(rule?.accountId ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [autoApply, setAutoApply] = useState(rule?.autoApply ?? false);
  const [isActive, setIsActive] = useState(rule?.isActive ?? true);
  const amount = (s: string) => (s.trim() === '' ? null : Number(s));
  const valid = !!name.trim() && !!contains.trim() && !!accountId && [min, max, priority].every((v) => v.trim() === '' || Number.isFinite(Number(v)));
  const save = useMutation({
    mutationFn: () => {
      const body: BankRuleInput = { name: name.trim(), contains: contains.trim(), direction, minAmount: amount(min), maxAmount: amount(max), accountId, priority: Number(priority) || 100, autoApply, isActive };
      return rule ? updateBankRule(rule.id, body) : createBankRule(body);
    },
    onSuccess: () => {
      toast.success(rule ? 'Rule saved.' : 'Rule made. “Apply rules now” to use it on what’s waiting.');
      void qc.invalidateQueries({ queryKey: BANK_KEY });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the rule.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? `Edit “${rule.name}”` : 'New rule'}</DialogTitle>
          <DialogDescription>When a transaction’s description or payee contains these words, categorize it here.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Fuel" />}</Field>
          <Field label="Contains">{(p) => <Input {...p} value={contains} maxLength={120} onChange={(e) => setContains(e.target.value)} placeholder="shell" />}</Field>
          <Field label="Direction">
            {(p) => (
              <Select {...p} value={direction} onChange={(e) => setDirection(e.target.value as 'IN' | 'OUT' | 'ANY')}>
                <option value="ANY">Money in or out</option>
                <option value="OUT">Money out</option>
                <option value="IN">Money in</option>
              </Select>
            )}
          </Field>
          <Field label="Priority" hint="Lower runs first">{(p) => <Input {...p} type="number" min={0} value={priority} onChange={(e) => setPriority(e.target.value)} />}</Field>
          <Field label="Smallest amount" hint="Optional">{(p) => <Input {...p} type="number" min={0} step="0.01" value={min} onChange={(e) => setMin(e.target.value)} />}</Field>
          <Field label="Largest amount" hint="Optional">{(p) => <Input {...p} type="number" min={0} step="0.01" value={max} onChange={(e) => setMax(e.target.value)} />}</Field>
          <Field label="Categorize as" className="sm:col-span-2">
            {(p) => <AccountSelect {...p} value={accountId} onChange={setAccountId} exclude={feed.ledgerAccountId} />}
          </Field>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} />
          <span>
            <span className="block text-ink">Categorize automatically</span>
            <span className="block text-xs text-silver">As transactions arrive, without asking. Off: it’s offered as a one-click suggestion.</span>
          </span>
        </label>
        {rule && (
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <span className="text-ink">Rule is on</span>
          </label>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>
            {rule ? 'Save rule' : 'Make the rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---- Reconciliations ------------------------------------------------------- */

function ReconciliationsTab({ feed, manage }: { feed: BankFeedAccountView; manage: boolean }) {
  const recs = useQuery({ queryKey: [...BANK_KEY, 'recs', feed.id], queryFn: () => listReconciliations(feed.id) });
  const list = useMemo(() => recs.data?.reconciliations ?? [], [recs.data]);
  const open = list.find((r) => r.status === 'IN_PROGRESS');
  return (
    <div className="space-y-3">
      {manage && (
        <div className="flex justify-end">
          <Button asChild>
            <Link to={`/books/bank/${feed.id}/reconcile`}>
              <Scale className="h-4 w-4" aria-hidden="true" />
              {open ? 'Continue the open reconciliation' : 'Reconcile a statement'}
            </Link>
          </Button>
        </div>
      )}
      {recs.isPending ? (
        <SkeletonRows count={3} />
      ) : recs.isError ? (
        <QueryError what="the reconciliations" query={recs} />
      ) : list.length === 0 ? (
        <EmptyState icon={Scale} title="Reconcile the first statement" description="Enter the statement’s end date and closing balance, tick what cleared, and finish at a zero difference." />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {list.map((r) => (
            <li key={r.id}>
              <Card className="h-full">
                <CardContent className="flex h-full flex-col gap-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-ink">Through {fmtDate(r.statementEndDate)}</p>
                    <Badge size="sm" variant={r.status === 'COMPLETED' ? 'success' : 'pending'}>
                      {r.status === 'COMPLETED' ? 'Reconciled' : 'In progress'}
                    </Badge>
                  </div>
                  <p className="text-sm text-silver">
                    Statement balance <span className="tabular-nums text-ink">{money(r.statementBalance)}</span> · {r.clearedCount} cleared
                  </p>
                  <p className="text-xs text-silver">{r.completedAt ? `Completed ${fmtDateTime(r.completedAt)}${r.completedByName ? ` by ${r.completedByName}` : ''}` : 'Started, not finished'}</p>
                  <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="secondary" asChild>
                      <Link to={`/books/bank/${feed.id}/reconcile?rec=${r.id}`}>
                        <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
                        Open
                      </Link>
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={reconciliationReportUrl(r.id)}>
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Report
                      </a>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
