import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CalendarCheck, CheckCircle2, CircleAlert, FileSpreadsheet, Info, NotebookPen, Plus, RefreshCcw } from 'lucide-react';
import type { BooksOverview } from '@alto-people/shared';
import { useAuth, useTenant } from '@/lib/auth';
import { getBooksOverview } from '@/lib/books/ledgerApi';
import { fmtDateTime, fmtMoney, fmtMoneyCompact, fmtMonthShortYear } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { StackedBarChart } from '@/components/ui/charts';
import { MetricCard, type MetricTrend } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { Amount } from './ledger/ledgerKit';

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
      primaryAction={
        manage ? (
          <Button asChild>
            <Link to="/books/journal/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Journal entry
            </Link>
          </Button>
        ) : undefined
      }
      secondaryActions={
        <Button asChild variant="secondary">
          <Link to="/books/reports">
            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
            Financial statements
          </Link>
        </Button>
      }
      summary={
        o ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Cash" value={fmtMoney(o.cash.total)} hint={`${o.cash.accounts.length} bank and card ${o.cash.accounts.length === 1 ? 'account' : 'accounts'}`} href="/books/bank" />
            <MetricCard label={`${who.Many} owe`} value={fmtMoney(o.receivables.total)} hint={o.receivables.aging.over90 > 0 ? `${fmtMoney(o.receivables.aging.over90)} over 90 days` : 'nothing over 90 days'} accent={o.receivables.aging.over90 > 0} href="/books/receivables" />
            <MetricCard label="You owe" value={fmtMoney(o.payables.total)} hint={o.payables.overdue > 0 ? `${fmtMoney(o.payables.overdue)} past due` : `${fmtMoney(o.payables.dueIn7Days)} due this week`} accent={o.payables.overdue > 0} href="/books/bills" />
            <MetricCard label="Profit this month" value={fmtMoney(o.profit.month.netIncome)} hint={`${fmtMoney(o.profit.yearToDate.netIncome)} this year`} href="/books/reports" trend={profitTrend(o)} />
          </div>
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
            <Card>
              <CardContent className="space-y-2 p-4 text-sm">
                <SectionTitle as="h3" title="Go to" />
                {[
                  { to: '/books/journal', label: 'Journal', icon: NotebookPen },
                  { to: '/books/accounts', label: 'Chart of accounts', icon: FileSpreadsheet },
                  { to: '/books/reports', label: 'Profit and loss, balance sheet, cash flow', icon: FileSpreadsheet },
                ].map((l) => (
                  <Link key={l.to} to={l.to} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-ink hover:bg-surface-raised">
                    <l.icon className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                    <span className="flex-1">{l.label}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                  </Link>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </ListTemplate>
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
                <li key={n.key}>
                  <Link to={n.to} className="flex items-center gap-3 py-2.5 text-sm text-ink hover:text-accent">
                    <Icon className={cn('h-4 w-4 shrink-0', n.tone === 'alert' ? 'text-alert' : n.tone === 'warning' ? 'text-warning' : 'text-info')} aria-hidden="true" />
                    <span className="flex-1">{n.label}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                  </Link>
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
    >
      <StackedBarChart
        data={rows}
        x="month"
        stacked={false}
        series={[
          { key: 'income', name: 'Income' },
          { key: 'netIncome', name: 'Net income' },
        ]}
        format={(v) => fmtMoneyCompact(v)}
        highlight={rows[rows.length - 1]?.month}
      />
    </ChartFrame>
  );
}

/** The profit card's sparkline: net income by month; the change is last month against the one before (this month is still going). */
function profitTrend(o: BooksOverview): MetricTrend | undefined {
  const series = o.profit.trend.map((t) => t.netIncome);
  if (series.length < 3) return undefined;
  return { series, delta: series[series.length - 2]! - series[series.length - 3]!, deltaLabel: 'last month', format: (n) => fmtMoneyCompact(n), unit: 'month' };
}

const AGING: Array<{ key: keyof BooksOverview['receivables']['aging']; label: string; tone: string }> = [
  { key: 'current', label: 'Not yet due', tone: 'bg-success/60' },
  { key: 'days1to30', label: '1–30 days', tone: 'bg-warning/50' },
  { key: 'days31to60', label: '31–60', tone: 'bg-warning/70' },
  { key: 'days61to90', label: '61–90', tone: 'bg-alert/60' },
  { key: 'over90', label: 'Over 90', tone: 'bg-alert' },
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
            <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-surface-raised" role="img" aria-label="Receivables by age">
              {AGING.map((a) => (r.aging[a.key] > 0 ? <span key={a.key} className={a.tone} style={{ width: `${(r.aging[a.key] / open) * 100}%` }} title={`${a.label}: ${fmtMoney(r.aging[a.key])}`} /> : null))}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-5">
              {AGING.map((a) => (
                <div key={a.key}>
                  <dt className="flex items-center gap-1.5 text-2xs text-ink-muted">
                    <span className={cn('h-2 w-2 rounded-sm', a.tone)} aria-hidden="true" />
                    {a.label}
                  </dt>
                  <dd className="tabular-nums text-ink">{fmtMoney(r.aging[a.key])}</dd>
                </div>
              ))}
            </dl>
            {r.topClients.length > 0 && (
              <ul className="mt-4 divide-y divide-line text-sm">
                {r.topClients.map((c) => (
                  <li key={c.clientId} className="flex items-center justify-between gap-3 py-2">
                    <Link to={`/clients/${c.clientId}?tab=statements`} className="min-w-0 truncate text-ink hover:text-accent">
                      {c.name}
                    </Link>
                    <span className="text-2xs text-ink-muted">{c.oldestDueAt ? `oldest due ${c.oldestDueAt}` : ''}</span>
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
          <Badge variant={c.status === 'CLOSED' ? 'success' : 'pending'}>{c.status === 'CLOSED' ? 'Closed' : 'Open'}</Badge>
        </div>
        <p className="text-xs text-ink-muted">
          {c.status === 'CLOSED' && c.closedAt ? `Closed ${fmtDateTime(c.closedAt)}` : c.tasksTotal ? `${c.tasksDone} of ${c.tasksTotal} close steps done` : 'The close checklist hasn’t started.'}
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
