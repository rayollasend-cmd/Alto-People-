import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CreditCard, Landmark, Plus, RefreshCw } from 'lucide-react';
import type { BankFeedAccountView } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { BANK_KEY, listBankAccounts } from '@/lib/books/bankApi';
import { fmtCount, fmtDate, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useUrlParam } from '@/lib/useUrlState';
import { RulesSection } from './bankRules';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { AddAccountDialog, ConnectBankButton, money } from './bankKit';

/**
 * Books › Bank and cards: every bank and card account the books keep, what
 * the books say against what the bank says, what's waiting for review,
 * and when each was last reconciled.
 */
export function BankPage() {
  const { can } = useAuth();
  const manage = can('manage:books');
  const navigate = useNavigate();
  const q = useQuery({ queryKey: [...BANK_KEY, 'accounts'], queryFn: listBankAccounts });
  const [adding, setAdding] = useState(false);
  const accounts = q.data?.accounts ?? [];
  const active = accounts.filter((a) => a.isActive);
  const review = active.reduce((n, a) => n + a.forReview, 0);
  const cash = active.filter((a) => a.subtype === 'BANK').reduce((n, a) => n + a.booksBalance, 0);
  const owed = active.filter((a) => a.subtype === 'CREDIT_CARD').reduce((n, a) => n + a.booksBalance, 0);
  const stale = active.filter(needsReconciling).length;
  // The company-wide rules live here, beside the accounts they apply to (?view=rules).
  const [view, setView] = useUrlParam<View>('view', 'accounts', VIEWS, { history: 'push' });

  return (
    <ListTemplate
      title="Bank and cards"
      subtitle="Bank and card activity matched to the books, categorized by rule, and reconciled to each statement."
      primaryAction={
        manage ? (
          <div className="flex flex-wrap gap-2">
            <ConnectBankButton />
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add an account
            </Button>
          </div>
        ) : undefined
      }
      summary={
        <MetricStrip label="Bank and cards at a glance" empty={!q.isSuccess || accounts.length === 0}>
          <MetricCard label="Cash in the books" value={money(cash)} hint={fmtCount(active.filter((a) => a.subtype === 'BANK').length, 'bank account')} tone="neutral" />
          <MetricCard label="Owed on cards" value={money(owed)} hint={fmtCount(active.filter((a) => a.subtype === 'CREDIT_CARD').length, 'card')} tone="neutral" />
          <MetricCard label="Waiting for review" value={review} hint={review ? 'Transactions to match or categorize' : undefined} tone={review > 0 ? 'warning' : 'default'} nothing={review ? undefined : 'All caught up'} />
          <MetricCard
            label="Need reconciling"
            value={stale}
            hint={stale ? `${stale === 1 ? 'Its last statement was' : 'Their last statements were'} reconciled over ${STALE_DAYS} days ago, or never` : undefined}
            tone={stale > 0 ? 'warning' : 'default'}
            nothing={stale ? undefined : `All reconciled in the last ${STALE_DAYS} days`}
          />
        </MetricStrip>
      }
    >
      <Tabs value={view} onValueChange={(v) => setView(v as View)}>
        <TabsList>
          <TabsTrigger value="accounts">Accounts{accounts.length ? ` (${accounts.length})` : ''}</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
        </TabsList>
      </Tabs>
      {view === 'rules' ? (
        <RulesSection manage={manage} />
      ) : q.isPending ? (
        <SkeletonRows count={3} rowHeight="h-40" />
      ) : q.isError ? (
        <QueryError what="the bank accounts" query={q} />
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="Add your first bank account"
          description="Pick the operating account or the company card from the chart, then import a statement — or connect the bank for a live feed."
          action={
            manage ? (
              <Button onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add an account
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a) => (
            <li key={a.id}>
              <AccountCard a={a} />
            </li>
          ))}
        </ul>
      )}
      <AddAccountDialog open={adding} onOpenChange={setAdding} onCreated={(id) => navigate(`/books/bank/${id}`)} />
    </ListTemplate>
  );
}

type View = 'accounts' | 'rules';
const VIEWS: View[] = ['accounts', 'rules'];

/** A statement reconciled longer ago than this — or never — needs reconciling. */
export const STALE_DAYS = 45;

function daysSince(ymd: string): number {
  return Math.floor((Date.now() - new Date(`${ymd}T12:00:00Z`).getTime()) / 86_400_000);
}

export function needsReconciling(a: Pick<BankFeedAccountView, 'lastReconciled'>): boolean {
  return !a.lastReconciled || daysSince(a.lastReconciled.statementEndDate) > STALE_DAYS;
}

function AccountCard({ a }: { a: BankFeedAccountView }) {
  const card = a.subtype === 'CREDIT_CARD';
  const Icon = card ? CreditCard : Landmark;
  const gap = a.bankBalance === null ? null : Math.round((a.bankBalance - a.booksBalance) * 100) / 100;
  return (
    <Card interactive className={cn('h-full', !a.isActive && 'opacity-60')}>
      <Link to={`/books/bank/${a.id}`} className="block h-full rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright">
        <CardContent className="flex h-full flex-col gap-4 p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gold/10 text-gold" aria-hidden="true">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-words font-medium text-ink">{a.name}</p>
              <p className="break-words text-xs text-silver">
                {[a.institution, a.mask ? `··${a.mask}` : null].filter(Boolean).join(' ') || (card ? 'Credit card' : 'Bank account')}
              </p>
              <p className="break-words text-xs text-silver">In the books as {a.ledgerCode} {a.ledgerName}</p>
            </div>
            {a.feed === 'PLAID' ? (
              <Badge size="sm" variant={a.lastError ? 'destructive' : 'info'}>
                {a.lastError ? 'Feed failing' : 'Live feed'}
              </Badge>
            ) : (
              <Badge size="sm" variant="outline">
                Statements
              </Badge>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs text-silver">{card ? 'Owed per the books' : 'In the books'}</dt>
              <dd className="text-xl font-semibold tabular-nums text-ink">{money(a.booksBalance)}</dd>
            </div>
            <div>
              <dt className="text-xs text-silver">Per the bank</dt>
              <dd className="text-xl font-semibold tabular-nums text-ink">{a.bankBalance === null ? '—' : money(a.bankBalance)}</dd>
            </div>
          </dl>
          {gap !== null && gap !== 0 && (
            <p className="-mt-2 text-xs text-silver">
              {money(Math.abs(gap))} {gap > 0 ? 'more at the bank' : 'less at the bank'} — usually checks and deposits still in transit.
            </p>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-navy-secondary pt-3 text-xs">
            {a.forReview > 0 ? (
              <span className="flex items-center gap-1 font-medium text-warning">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                {a.forReview} for review
              </span>
            ) : (
              <span className="text-success">All reviewed</span>
            )}
            <span className="text-silver">{a.lastReconciled ? `Reconciled through ${fmtDate(a.lastReconciled.statementEndDate)}` : 'Not reconciled yet'}</span>
            {a.feed === 'PLAID' && a.lastSyncedAt && (
              <span className="flex items-center gap-1 text-silver">
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {fmtDateTime(a.lastSyncedAt)}
              </span>
            )}
            <ArrowRight className="ml-auto h-4 w-4 text-silver" aria-hidden="true" />
          </div>
        </CardContent>
      </Link>
    </Card>
  );
}
