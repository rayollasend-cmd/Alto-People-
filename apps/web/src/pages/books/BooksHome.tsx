import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CalendarCheck, CheckCircle2, CircleAlert, FileSpreadsheet, Info, NotebookPen, Plus, RefreshCcw } from '@/components/ui/icons';
import type { BooksOverview } from '@alto-people/shared';
import { useAuth, useTenant } from '@/lib/auth';
import { getBooksOverview, listJournal } from '@/lib/books/ledgerApi';
import { fmtDate, fmtDateTime, fmtMoney, fmtMoneyCompact, fmtMonthShortYear } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { LegendKey, PALETTE } from '@/components/ui/charts';
import { lazyPlot } from '@/components/ui/charts/lazyPlot';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard, type MetricTrend } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { AGING_COLORS, AgingBar } from '@/pages/finance/financeCharts';
import { Amount, PostHistoryButton, sourceLabel } from './ledger/ledgerKit';
import { sinceMonthEndWords } from './close/closeKit';

/**
 * The Books overview — the company's finances on one screen: the cash in
 * each bank and card account, what clients owe (by age) and what the
 * company owes, profit this month and this year with the last six months
 * beside it, last month's close, the QuickBooks sync, and the short list
 * of things waiting on someone.
 */

/** Who owes the money in this tenant's words: clients for a staffing company, customers otherwise. */
function useWho() {
  const has = useTenant().moduleOn('clientPortal');
  return has
    ? { one: 'client', many: 'clients', One: 'Client', Many: 'Clients' }
    : { one: 'customer', many: 'customers', One: 'Customer', Many: 'Customers' };
}

export function BooksHome() {
  const who = useWho();
  const { can } = useAuth();
  const manage = can('manage:books');
  const q = useQuery({ queryKey: ['books', 'overview'], queryFn: getBooksOverview, refetchInterval: 60_000 });
  const o = q.data;

  return (
    <ListTemplate
      title="Books"
      subtitle="The company’s own finances: cash, what you’re owed and what you owe, profit, the close and the QuickBooks sync."
      actions={[
        ...(manage ? [{ key: 'entry', label: 'Journal entry', icon: Plus, primary: true, to: '/books/journal/new' }] : []),
        { key: 'statements', label: 'Financial statements', icon: FileSpreadsheet, to: '/books/reports' },
      ]}
      summary={
        o ? (
          <MetricStrip label="The books at a glance">
            <MetricCard label="Cash" value={fmtMoney(o.cash.total)} hint={cashHint(o)} href="/books/bank" />
            {/* The same number as the aging card below (the open statements); when the ledger holds a different AR balance, the hint says so. */}
            <MetricCard label={`${who.Many} owe`} value={fmtMoney(o.receivables.openOnStatements)} hint={receivablesHint(o)} tone={o.receivables.aging.over90 > 0 || Math.abs(o.receivables.openOnStatements - o.receivables.total) >= 0.01 ? 'warning' : 'default'} href="/books/receivables" />
            <MetricCard label="You owe" value={fmtMoney(o.payables.total)} hint={o.payables.overdue > 0 ? `${fmtMoney(o.payables.overdue)} past due` : `${fmtMoney(o.payables.dueIn7Days)} due this week`} tone={o.payables.overdue > 0 ? 'alert' : 'default'} href="/books/bills" />
            <MetricCard label="Profit this month" value={fmtMoney(o.profit.month.netIncome)} hint={`${fmtMoney(o.profit.yearToDate.netIncome)} this year`} href="/books/reports" trend={profitTrend(o)} />
          </MetricStrip>
        ) : q.isLoading ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : null
      }
    >
      {q.isError ? (
        <QueryError what="the books" query={q} />
      ) : !o ? (
        <Skeleton className="h-72" />
      ) : (
        <div className="grid gap-[var(--d-stack)] lg:grid-cols-3">
          <div className="space-y-[var(--d-stack)] lg:col-span-2">
            <NeedsYou items={o.needsYou} />
            <ProfitTrend o={o} />
            <Receivables o={o} />
          </div>
          <div className="space-y-[var(--d-stack)]">
            <CashCard o={o} />
            <CloseCard o={o} />
            <QuickbooksCard o={o} />
            <RecentEntries />
          </div>
        </div>
      )}
    </ListTemplate>
  );
}

/** The last few entries posted — where the Books' own pages are one sidebar click away, this is what changed. */
function RecentEntries() {
  const q = useQuery({ queryKey: ['books', 'journal', 'recent'], queryFn: () => listJournal({ limit: 5 }) });
  const rows = q.data?.entries ?? [];
  return (
    <Card>
      <CardContent className="p-4">
        <SectionTitle
          as="h3"
          title="Recent entries"
          icon={NotebookPen}
          trailing={
            <Link to="/books/journal" className="text-sm text-accent hover:underline">
              Journal
            </Link>
          }
        />
        {q.isLoading ? (
          <Skeleton className="mt-3 h-24" />
        ) : q.isError ? (
          <p className="mt-2 text-sm text-ink-muted">Couldn’t load the journal.</p>
        ) : rows.length === 0 ? (
          <div className="mt-2 space-y-2">
            <p className="text-sm text-ink-muted">Nothing has posted yet. Post history to bring payroll runs, statements and payments in.</p>
            <PostHistoryButton size="sm" variant="secondary" />
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-line text-sm">
            {rows.map((e) => (
              <li key={e.id}>
                <Link to={`/books/journal/${e.id}`} className="flex items-start justify-between gap-3 py-2 hover:text-accent">
                  <span className="min-w-0">
                    <span className="block break-words text-ink">{e.memo ?? `${sourceLabel(e.source)} entry`}</span>
                    <span className="text-2xs text-ink-muted">
                      #{e.number} · {fmtDate(e.date)}
                      {e.status === 'VOID' ? ' · void' : ''}
                    </span>
                  </span>
                  <Amount value={e.amount} className={e.status === 'VOID' ? 'line-through' : undefined} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function NeedsYou({ items }: { items: BooksOverview['needsYou'] }) {
  return (
    <Card>
      <CardContent className="p-4">
        <SectionTitle as="h3" title="Needs you" description={items.length ? undefined : 'Every bill is approved, the bank is matched and the sync is clear.'} />
        {items.length > 0 && (
          <ul className="mt-3 divide-y divide-line">
            {items.map((n) => {
              const Icon = n.tone === 'alert' ? CircleAlert : n.tone === 'warning' ? AlertTriangle : Info;
              return (
                <li key={n.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                  <Link to={n.to} className="flex min-w-0 flex-1 basis-60 items-center gap-3 text-sm text-ink hover:text-accent">
                    <Icon className={cn('h-4 w-4 shrink-0', n.tone === 'alert' ? 'text-alert' : n.tone === 'warning' ? 'text-warning' : 'text-info')} aria-hidden="true" />
                    <span className="flex-1">{n.label}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                  </Link>
                  {/* The books don't hold history yet: the fix is one press, here. */}
                  {n.key === 'ar-unposted' && <PostHistoryButton size="sm" className="ml-7 sm:ml-0" />}
                </li>
              );
            })}
          </ul>
        )}
        {items.length === 0 && (
          <p className="mt-2 flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> All clear.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The Profit chart's drawing (recharts) loads with the chart, not the page (lazyPlot). */
const ProfitPlot = lazyPlot(() => import('./BooksProfit.plot').then((m) => ({ default: m.ProfitPlot })));

function ProfitTrend({ o }: { o: BooksOverview }) {
  const ytd = o.profit.yearToDate;
  const rows = o.profit.trend.map((t) => ({ month: t.label, income: t.income, netIncome: t.netIncome }));
  const best = [...o.profit.trend].sort((x, y) => y.netIncome - x.netIncome)[0];
  const losing = o.profit.trend.filter((t) => t.netIncome < 0).length;
  const summary = o.profit.trend.length
    ? `Income and net income, the last ${o.profit.trend.length === 1 ? 'month' : `${o.profit.trend.length} months`}. Best: ${best!.label}, ${fmtMoney(best!.netIncome)} kept${losing ? `; ${losing} ${losing === 1 ? 'month' : 'months'} at a loss` : ''}.`
    : 'No months to show yet.';
  return (
    <ChartFrame
      title="Profit"
      description={
        <>
          This year: {fmtMoney(ytd.income)} in, {fmtMoney(ytd.netIncome)} kept{ytd.grossMarginPct == null ? '' : ` · ${ytd.grossMarginPct}% gross margin`} ·{' '}
          <Link to="/books/reports" className="text-accent hover:underline">
            Profit and loss
          </Link>
        </>
      }
      summary={summary}
      columns={[
        { key: 'month', label: 'Month' },
        { key: 'income', label: 'Income', numeric: true, format: (v) => fmtMoney(Number(v)) },
        { key: 'netIncome', label: 'Net income', numeric: true, format: (v) => fmtMoney(Number(v)) },
      ]}
      rows={rows}
      csvName="profit-by-month"
      height={220}
      // No income or expense in six months: a $0–$4 axis says nothing — say so in words
      // (the frame collapses an all-zero chart on its own; this is what it says).
      empty={<EmptyState size="sm" icon={FileSpreadsheet} title="Nothing to chart yet" description="Nothing has posted to income or expenses in the last six months." />}
    >
      <div className="flex h-full w-full flex-col">
        <div className="min-h-0 flex-1">
          <ProfitPlot rows={rows} />
        </div>
        <div className="mt-1">
          <LegendKey items={[{ name: 'Income', color: PALETTE.primary }, { name: 'Net income', color: PALETTE.tertiary }, ...(losing ? [{ name: 'Net loss', color: PALETTE.bad }] : [])]} />
        </div>
      </div>
    </ChartFrame>
  );
}

/** The Cash card's hint: how many bank and card accounts are actually connected (the Bank page's list), not the ledger's. */
function cashHint(o: BooksOverview): string {
  const n = o.cash.connectedAccounts;
  return n > 0 ? `${n} ${n === 1 ? 'account' : 'accounts'} connected to the bank` : 'From the ledger — no bank connected yet';
}

function receivablesHint(o: BooksOverview): string {
  const r = o.receivables;
  if (Math.abs(r.openOnStatements - r.total) >= 0.01) return `${fmtMoney(r.total)} in the ledger — post history to match`;
  return r.aging.over90 > 0 ? `${fmtMoney(r.aging.over90)} over 90 days` : 'nothing over 90 days';
}

/** The profit card's sparkline: net income by month; the change is last month against the one before (this month is still going). */
function profitTrend(o: BooksOverview): MetricTrend | undefined {
  const series = o.profit.trend.map((t) => t.netIncome);
  if (series.length < 3 || !series.every((v) => Number.isFinite(v)) || series.every((v) => v === 0)) return undefined;
  return { series, delta: series[series.length - 2]! - series[series.length - 3]!, deltaLabel: 'last month', format: (n) => fmtMoneyCompact(n), unit: 'month' };
}

/** The one aging palette (pages/finance/financeCharts) — 1–30 and 31–60 days read as two blocks, not one. */
const AGING: Array<{ key: keyof BooksOverview['receivables']['aging']; label: string }> = [
  { key: 'current', label: 'Not yet due' },
  { key: 'days1to30', label: '1–30 days' },
  { key: 'days31to60', label: '31–60' },
  { key: 'days61to90', label: '61–90' },
  { key: 'over90', label: 'Over 90' },
];

function Receivables({ o }: { o: BooksOverview }) {
  const who = useWho();
  const r = o.receivables;
  const open = AGING.reduce((s, a) => s + r.aging[a.key], 0);
  return (
    <Card>
      <CardContent className="p-4">
        <SectionTitle
          as="h3"
          title={`What ${who.many} owe`}
          description={open > 0 ? `${fmtMoney(open)} on finalized statements, by how late it is` : 'Every finalized statement is paid.'}
          trailing={
            <Link to="/books/receivables" className="text-sm text-accent hover:underline">
              Receivables
            </Link>
          }
        />
        {open > 0 && (
          <>
            <div className="mt-4" role="img" aria-label={`Receivables by age: ${AGING.filter((a) => r.aging[a.key] > 0).map((a) => `${a.label} ${fmtMoney(r.aging[a.key])}`).join(', ')}`}>
              <AgingBar buckets={AGING.map((a) => ({ key: a.key, label: a.label, amount: r.aging[a.key] }))} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-5">
              {AGING.map((a) => (
                <div key={a.key}>
                  <dt className="flex items-center gap-1.5 text-2xs text-ink-muted">
                    <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: AGING_COLORS[a.key] }} aria-hidden="true" />
                    {a.label}
                  </dt>
                  <dd className="tabular-nums text-ink">{fmtMoney(r.aging[a.key])}</dd>
                </div>
              ))}
            </dl>
            {r.topClients.length > 0 && (
              <ul className="mt-4 divide-y divide-line text-sm">
                {r.topClients.map((c) => (
                  <li key={c.clientId} className="flex items-start justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <Link to={`/clients/${c.clientId}?tab=statements`} className="break-words text-ink hover:text-accent">
                        {c.name}
                      </Link>
                      {c.oldestDueAt && <span className="block text-2xs text-ink-muted">Oldest due {fmtDate(c.oldestDueAt)}</span>}
                    </span>
                    <Amount value={c.open} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CashCard({ o }: { o: BooksOverview }) {
  return (
    <Card>
      <CardContent className="p-4">
        <SectionTitle
          as="h3"
          title="Cash"
          trailing={
            <Link to="/books/bank" className="text-sm text-accent hover:underline">
              Bank and cards
            </Link>
          }
        />
        {o.cash.connectedAccounts === 0 && (
          <p className="mt-2 text-xs text-ink-muted">
            Balances from the ledger. No bank is connected yet —{' '}
            <Link to="/books/bank" className="text-accent hover:underline">
              connect one
            </Link>{' '}
            to match its transactions.
          </p>
        )}
        <ul className="mt-2 divide-y divide-line text-sm">
          {o.cash.accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 py-2">
              <Link to={`/books/accounts/${a.id}`} className="min-w-0 truncate text-ink hover:text-accent">
                {a.name}
                {a.subtype === 'CREDIT_CARD' && <span className="ml-1 text-2xs text-ink-muted">card balance</span>}
              </Link>
              <Amount value={a.balance} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CloseCard({ o }: { o: BooksOverview }) {
  const c = o.close;
  const month = fmtMonthShortYear(`${c.periodKey}-15`);
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <SectionTitle as="h3" title="Month-end close" icon={CalendarCheck} />
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-ink">{month}</span>
          <Badge variant={c.status === 'CLOSED' ? 'success' : 'pending'}>{c.status === 'CLOSED' ? 'Closed' : 'Not closed'}</Badge>
        </div>
        <p className="text-xs text-ink-muted">
          {c.status === 'CLOSED' && c.closedAt
            ? `Closed ${fmtDateTime(c.closedAt)}`
            : [c.tasksTotal ? `${c.tasksDone} of ${c.tasksTotal} close steps done` : 'The close checklist hasn’t started.', sinceMonthEndWords(c.periodKey, o.asOf)].filter(Boolean).join(' · ')}
        </p>
        <Button asChild size="sm" variant="secondary">
          <Link to={`/books/close/${c.periodKey}`}>Open the close</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function QuickbooksCard({ o }: { o: BooksOverview }) {
  const qb = o.quickbooks;
  return (
    <Card className={cn(qb.failed + qb.openConflicts > 0 && 'border-alert/40')}>
      <CardContent className="space-y-2 p-4">
        <SectionTitle as="h3" title="QuickBooks" icon={RefreshCcw} />
        {qb.connected ? (
          <>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-ink">{qb.companyName ?? 'Connected'}</span>
              <Badge variant={qb.status === 'CONNECTED' ? 'success' : 'pending'}>{qb.status === 'CONNECTED' ? 'In sync' : qb.status === 'NEEDS_RECONNECT' ? 'Reconnect' : 'Paused'}</Badge>
            </div>
            <p className="text-xs text-ink-muted">
              {qb.lastPushAt ? `Sent ${fmtDateTime(qb.lastPushAt)}` : 'Nothing sent yet'} · {qb.lastPullAt ? `checked ${fmtDateTime(qb.lastPullAt)}` : 'not checked yet'}
            </p>
            {(qb.pending > 0 || qb.failed > 0 || qb.openConflicts > 0) && (
              <p className="text-xs text-ink">
                {[qb.pending ? `${qb.pending} waiting to go` : '', qb.failed ? `${qb.failed} failed` : '', qb.openConflicts ? `${qb.openConflicts} to decide` : ''].filter(Boolean).join(' · ')}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-muted">Not connected. Connect the company’s QuickBooks and everything here goes there, and back.</p>
        )}
        <Button asChild size="sm" variant="secondary">
          <Link to="/books/quickbooks">{qb.connected ? 'Open the sync' : 'Connect QuickBooks'}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
