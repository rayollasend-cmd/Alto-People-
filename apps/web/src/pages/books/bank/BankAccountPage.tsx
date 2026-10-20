import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Ban, CheckCheck, Download, FileSpreadsheet, ListChecks, MoreHorizontal, Pencil, Plus, RefreshCw, Scale, Search, Sparkles, Trash2, Undo2, Wand2 } from 'lucide-react';
import type { BankFeedAccountView, BankRuleInput, BankRuleView, BankTxnStatus, BankTxnView } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import {
  BANK_KEY,
  applyBankRules,
  categorizeTxn,
  createBankRule,
  deleteBankRule,
  excludeTxn,
  getBankAccount,
  getTxnSuggestions,
  listBankRules,
  listBankTransactions,
  listReconciliations,
  matchTxn,
  reconciliationReportUrl,
  syncBankAccount,
  undoTxn,
  updateBankRule,
} from '@/lib/books/bankApi';
import { fmtDate, fmtDateTime } from '@/lib/format';
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
          <ul className="divide-y divide-navy-secondary rounded-lg border border-navy-secondary bg-navy">
            {rows.slice(0, shown).map((t) => (status === 'UNMATCHED' ? <ReviewRow key={t.id} t={t} feed={feed} manage={manage} /> : <DecidedRow key={t.id} t={t} manage={manage} />))}
          </ul>
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

function useTxnMutation<T>(fn: (v: T) => Promise<unknown>, done: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(done);
      void qc.invalidateQueries({ queryKey: BANK_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'That didn’t go through.'),
  });
}

function ReviewRow({ t, feed, manage }: { t: BankTxnView; feed: BankFeedAccountView; manage: boolean }) {
  const s = useQuery({ queryKey: [...BANK_KEY, 'suggest', t.id], queryFn: () => getTxnSuggestions(t.id), staleTime: 60_000 });
  const [accountId, setAccountId] = useState('');
  const [ruleFrom, setRuleFrom] = useState(false);
  const categorize = useTxnMutation((v: { accountId: string; vendorId?: string | null; clientId?: string | null; departmentId?: string | null }) => categorizeTxn(t.id, v), 'Categorized.');
  const match = useTxnMutation((lineId: string) => matchTxn(t.id, lineId), 'Matched to the entry in the books.');
  const exclude = useTxnMutation(() => excludeTxn(t.id), 'Excluded.');
  const busy = categorize.isPending || match.isPending || exclude.isPending;
  const best = s.data?.matches[0];
  const suggestion = s.data?.rule ?? s.data?.lastTime ?? null;
  return (
    <li className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <TxnFacts t={t} />
        <Amount value={t.amount} className="shrink-0 text-sm font-semibold" />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:w-[34rem] lg:flex-nowrap lg:justify-end">
        {s.isPending ? (
          <Skeleton className="h-8 w-60" />
        ) : best ? (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-silver lg:text-right">
              <ArrowLeftRight className="mr-1 inline h-3.5 w-3.5 text-gold" aria-hidden="true" />
              Entry #{best.entryNumber} · {best.memo ?? best.source.toLowerCase()} · {fmtDate(best.date)}
              {best.daysApart > 0 ? ` (${best.daysApart} ${best.daysApart === 1 ? 'day' : 'days'} apart)` : ''}
            </span>
            {manage && (
              <Button size="sm" onClick={() => match.mutate(best.lineId)} loading={match.isPending} disabled={busy}>
                Match
              </Button>
            )}
          </>
        ) : suggestion && !accountId ? (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-silver lg:text-right">
              <Sparkles className="mr-1 inline h-3.5 w-3.5 text-gold" aria-hidden="true" />
              {s.data?.rule ? `Rule “${s.data.rule.name}”` : 'Same as last time'} → {suggestion.accountCode} {suggestion.accountName}
            </span>
            {manage && (
              <>
                <Button
                  size="sm"
                  onClick={() => categorize.mutate({ accountId: suggestion.accountId, ...(s.data?.rule ? { vendorId: s.data.rule.vendorId, clientId: s.data.rule.clientId, departmentId: s.data.rule.departmentId } : {}) })}
                  loading={categorize.isPending}
                  disabled={busy}
                >
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
            <div className="min-w-0 flex-1 lg:w-64 lg:flex-none">
              <AccountSelect value={accountId.trim()} onChange={setAccountId} exclude={feed.ledgerAccountId} placeholder="Categorize as…" />
            </div>
            <Button size="sm" onClick={() => categorize.mutate({ accountId: accountId.trim() })} loading={categorize.isPending} disabled={busy || !accountId.trim()}>
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
              <DropdownMenuItem onSelect={() => exclude.mutate(undefined)}>
                <Ban className="h-4 w-4" aria-hidden="true" />
                Exclude (a duplicate, or booked another way)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {best && accountId && manage && (
        <div className="flex w-full items-center gap-2 lg:justify-end">
          <div className="w-full lg:w-64">
            <AccountSelect value={accountId.trim()} onChange={setAccountId} exclude={feed.ledgerAccountId} placeholder="Categorize as…" />
          </div>
          <Button size="sm" onClick={() => categorize.mutate({ accountId: accountId.trim() })} disabled={busy || !accountId.trim()}>
            Categorize
          </Button>
        </div>
      )}
      {ruleFrom && <RuleDialog feed={feed} seed={seedFrom(t)} onClose={() => setRuleFrom(false)} />}
    </li>
  );
}

function seedFrom(t: BankTxnView): Partial<BankRuleInput> {
  const words = (t.payee || t.description).replace(/[#*0-9]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' ');
  return { name: words, contains: words.toLowerCase(), direction: t.amount < 0 ? 'OUT' : 'IN' };
}

function DecidedRow({ t, manage }: { t: BankTxnView; manage: boolean }) {
  const undo = useTxnMutation(() => undoTxn(t.id), 'Back in For review.');
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
        <Button size="sm" variant="ghost" onClick={() => undo.mutate(undefined)} loading={undo.isPending}>
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
