import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CalendarCheck2, Download, FileText, History, Inbox, Landmark, RefreshCw, Scale, ShieldCheck, Wallet } from '@/components/ui/icons';
import {
  cancelTaxPayment,
  createTaxPayment,
  downloadPaymentWorksheet,
  getTaxOverview,
  listLiabilities,
  listPayments,
  markTaxPaymentPaid,
  refreshTaxPayments,
  retryTaxPayment,
  type DepositLine,
  type Liability,
  type TaxOverview,
  type TaxPayment,
} from '@/lib/payrollTaxesApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtDateOnlyRange, fmtMoney } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { DueBadge, KIND_SHORT, LiabilityBadge, PaymentBadge, ReturnBadge, dueText, localToday, quarterName } from './taxShared';
import { ReturnsTab } from './ReturnsTab';
import { NoticesTab } from './NoticesTab';
import { AgenciesTab, RebuildDialog } from './AgenciesTab';
import { ReconciliationTab } from './ReconciliationTab';

/**
 * Payroll taxes — what payroll owes each tax agency and when, the deposits
 * that pay it, the returns each quarter needs, reconciliation, agency
 * notices and the accounts behind it all. Built on the list template with
 * tabs; each agency drills down from the Agencies tab.
 */

type Tab = 'overview' | 'deposits' | 'returns' | 'reconciliation' | 'notices' | 'agencies';
const TABS: Tab[] = ['overview', 'deposits', 'returns', 'reconciliation', 'notices', 'agencies'];

/** "2026-Q4" → "Q4 2026". */
export function quarterShort(label: string): string {
  const m = /^(\d{4})-Q([1-4])$/.exec(label);
  return m ? `Q${m[2]} ${m[1]}` : label;
}

export function PayrollTaxesDesk() {
  // A tab is a place: Back returns to the one you came from; ?tab= deep links keep working.
  const [tab, setTab] = useUrlParam<Tab>('tab', 'overview', TABS, { history: 'push' });
  const overview = useQuery({ queryKey: ['payroll-taxes', 'overview'], queryFn: getTaxOverview });

  return (
    <ListTemplate
      title="Payroll taxes"
      subtitle="What payroll owes each tax agency and when it’s due, the returns each quarter needs, and the letters agencies send."
      related={[
        { label: 'Year-end forms', to: '/payroll/year-end?tab=forms' },
        { label: 'Tax tables', to: '/payroll/tax-tables' },
        { label: 'Garnishments', to: '/payroll/garnishments' },
      ]}
      summary={overview.data && tab === 'overview' ? <FilingBanner filing={overview.data.filing} /> : null}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="deposits">Deposits</TabsTrigger>
            <TabsTrigger value="returns">Returns</TabsTrigger>
            <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
            <TabsTrigger value="notices">Notices</TabsTrigger>
            <TabsTrigger value="agencies">Agencies</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview">
          <OverviewTab query={overview} onTab={setTab} />
        </TabsContent>
        <TabsContent value="deposits">
          <UnpostedAlert overview={overview.data} />
          <DepositsTab provider={overview.data?.filing.mode === 'PROVIDER'} providerLabel={overview.data?.filing.providerLabel ?? null} />
        </TabsContent>
        <TabsContent value="returns">
          <UnpostedAlert overview={overview.data} />
          <ReturnsTab provider={overview.data?.filing.mode === 'PROVIDER'} />
        </TabsContent>
        <TabsContent value="reconciliation">
          <ReconciliationTab />
        </TabsContent>
        <TabsContent value="notices">
          <NoticesTab />
        </TabsContent>
        <TabsContent value="agencies">
          <AgenciesTab registrations={overview.data?.registrations ?? []} />
        </TabsContent>
      </Tabs>
    </ListTemplate>
  );
}

/* ----- Paid payrolls whose taxes never posted ------------------------------------- */

/**
 * The paid payrolls whose taxes never reached this desk. Every number on it
 * — "paid up", this quarter, the returns — leaves them out until they post,
 * so this sits above them, with the fix: post them (the Agencies tab's "Post
 * past payrolls", from the oldest such payday), or, for a run with no paid
 * paychecks to post from, open the run.
 */
export function UnpostedAlert({ overview }: { overview: TaxOverview | undefined }) {
  const [posting, setPosting] = useState(false);
  const u = overview?.unposted;
  if (!u || u.count === 0) return null;
  const postable = u.runs.filter((r) => !r.paychecksMissing);
  const broken = u.runs.filter((r) => r.paychecksMissing);
  const oldest = postable[0]?.paidOn ?? null;
  const runWord = (n: number) => (n === 1 ? 'paid payroll' : 'paid payrolls');
  return (
    <div role="alert" className="mb-4 flex flex-col gap-3 rounded-lg border border-alert/40 bg-alert/[0.06] p-4 sm:flex-row sm:items-start" data-testid="unposted-taxes">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-alert" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-ink">
          {`${u.count} ${runWord(u.count)} ${u.count === 1 ? 'hasn’t' : 'haven’t'} posted ${u.count === 1 ? 'its' : 'their'} taxes (${fmtMoney(u.amount)})`}
        </p>
        <p className="mt-0.5 text-ink-muted">Deposits, this quarter’s numbers and the returns below leave {u.count === 1 ? 'it' : 'them'} out until {u.count === 1 ? 'it posts' : 'they post'}.</p>
        {broken.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-ink-muted">
            {broken.map((r) => (
              <li key={r.id}>
                {`${r.periodStart && r.periodEnd ? fmtDateOnlyRange(r.periodStart, r.periodEnd) : 'A paid run'} records ${fmtMoney(r.amount)} in taxes but has no paid paychecks to post them from. `}
                <Link to={`/payroll/runs/${r.id}`} className="text-accent underline underline-offset-2">
                  Open the run
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      {postable.length > 0 && (
        <Button size="sm" className="shrink-0" onClick={() => setPosting(true)}>
          <History className="mr-1.5 h-4 w-4" aria-hidden /> Post past payrolls
        </Button>
      )}
      {posting && <RebuildDialog initialFrom={oldest} onClose={() => setPosting(false)} />}
    </div>
  );
}

/* ----- Who files: the penalty guarantee, or the customer's own checklist ----- */

function FilingBanner({ filing }: { filing: TaxOverview['filing'] }) {
  if (filing.mode === 'PROVIDER' && filing.penaltyGuarantee) {
    return (
      <Card className="border-success/30 bg-success/5">
        <CardContent className="flex items-start gap-3 py-4">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium text-ink">{`Covered by ${filing.providerLabel}’s penalty guarantee`}</p>
            <p className="text-sm text-ink-muted">
              {`${filing.providerLabel} pays your deposits and files your returns from what payroll posts here. If one they handle is late or wrong, they pay the penalty.`}
              {filing.environment === 'SANDBOX' ? ' This connection is in sandbox: nothing is really paid or filed yet.' : ''}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (filing.mode === 'PROVIDER') {
    return (
      <Card className="border-gold/40 bg-gold/5">
        <CardContent className="flex items-start gap-3 py-4">
          <Landmark className="mt-0.5 h-5 w-5 shrink-0 text-gold" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium text-ink">{`Paid and filed through ${filing.providerLabel}`}</p>
            <p className="text-sm text-ink-muted">
              Your agreement doesn’t include a penalty guarantee, so penalties for a late or wrong filing stay with you. Watch the deadlines below.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }
  return <InHouseBanner />;
}

/**
 * In house: the three steps the customer does themselves. In full the first
 * time; once read, one line with "How this works" (it took a third of a
 * phone's first screen on every visit).
 */
function InHouseBanner() {
  const [read, setRead] = useState(() => {
    try {
      return window.localStorage.getItem('alto.payrollTaxes.inHouseRead') === '1';
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState(!read);
  const markRead = () => {
    setRead(true);
    setOpen(false);
    try {
      window.localStorage.setItem('alto.payrollTaxes.inHouseRead', '1');
    } catch {
      /* private window: shown in full again next time */
    }
  };
  if (!open) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-ink" data-testid="in-house-line">
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        You file and pay these yourself.
        <button type="button" className="text-accent underline underline-offset-2" onClick={() => setOpen(true)}>
          How this works
        </button>
      </p>
    );
  }
  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="flex items-start gap-3 py-4">
        <AlertTriangle className="mt-0.5 hidden h-5 w-5 shrink-0 text-warning sm:block" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">You file and pay these yourself</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-muted">
              <li>Pay each deposit on EFTPS or the agency’s site by its due date, then record the confirmation number here.</li>
              <li>Generate each return here, file it with the agency, and record the confirmation.</li>
              <li>Keep each agency account current. Unemployment rates change every January.</li>
            </ul>
          </div>
          <div className="flex flex-wrap gap-2 self-start lg:shrink-0">
            <Button asChild variant="outline" size="sm">
              <Link to="/integrations">Connect a payroll tax provider</Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={markRead}>
              {read ? 'Hide' : 'Got it'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ----- Overview ----------------------------------------------------------------- */

function OverviewTab({ query, onTab }: { query: ReturnType<typeof useQuery<TaxOverview>>; onTab: (t: Tab) => void }) {
  const [paying, setPaying] = useState<DepositLine | null>(null);
  if (query.isError) return <QueryError what="payroll taxes" query={query} />;
  if (query.isLoading || !query.data) return <SkeletonRows count={6} />;
  const o = query.data;
  const owed = [...(o.overdue ?? []), ...(o.dueSoon ?? [])];
  const checklist = [...(o.returns?.previous?.items ?? []), ...(o.returns?.current?.items ?? [])];
  const returnItems = checklist.filter((r) => r.status !== 'FILED' && r.status !== 'ACCEPTED');
  const next = [...(o.dueSoon ?? []), ...(o.upcoming ?? [])][0] ?? null;
  const unposted = o.unposted?.count ?? 0;
  const late = o.totals?.overdue ?? 0;
  const dueSoon = o.totals?.dueSoon ?? 0;
  return (
    <div className="space-y-4">
      <UnpostedAlert overview={o} />
      {(o.totals?.failedPayments ?? 0) > 0 && (
        <p role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-alert/30 bg-alert/[0.05] px-3 py-2 text-sm text-ink">
          <AlertTriangle className="h-4 w-4 shrink-0 text-alert" aria-hidden />
          {`${o.totals.failedPayments} tax payment${o.totals.failedPayments === 1 ? '' : 's'} failed and need${o.totals.failedPayments === 1 ? 's' : ''} sending again.`}
          <Link to="/payroll/taxes?tab=deposits" className="font-medium text-accent underline underline-offset-2" onClick={(e) => { e.preventDefault(); onTab('deposits'); }}>
            Open payments
          </Link>
        </p>
      )}
      <MetricStrip label="Payroll taxes at a glance">
        <MetricCard label="Late" value={fmtMoney(late)} nothing={late === 0 ? 'Nothing late' : undefined} tone={late > 0 ? 'alert' : 'default'} hint="Past the due date, not paid" href="/payroll/taxes?tab=deposits" />
        <MetricCard
          label="Due in the next 14 days"
          value={fmtMoney(dueSoon)}
          nothing={dueSoon === 0 ? 'Nothing due in 14 days' : undefined}
          hint={`${(o.dueSoon ?? []).length} deposit${(o.dueSoon ?? []).length === 1 ? '' : 's'}`}
          href="/payroll/taxes?tab=deposits"
        />
        <MetricCard
          label="Next deposit"
          value={next ? fmtDate(next.dueDate) : '—'}
          nothing={next ? undefined : unposted > 0 ? 'None posted yet' : 'None scheduled'}
          hint={next ? `${fmtMoney(next.amount)} · ${next.agency}` : undefined}
          href="/payroll/taxes?tab=deposits"
        />
        <MetricCard
          label={`Taxes ${o.quarter ? quarterShort(o.quarter.periodLabel) : 'this quarter'}`}
          value={fmtMoney(o.quarter?.posted ?? 0)}
          nothing={(o.quarter?.posted ?? 0) === 0 ? (unposted > 0 ? 'None posted yet' : 'No payroll taxes yet') : undefined}
          hint={o.quarter ? `${fmtMoney(o.quarter.deposited)} deposited · withheld and employer share` : undefined}
          href="/payroll/taxes?tab=reconciliation"
        />
      </MetricStrip>

      <Card>
        <CardHeader>
          <CardTitle>Deposits to make</CardTitle>
          <CardDescription>Late deposits first, then everything due in the next 14 days.</CardDescription>
        </CardHeader>
        <CardContent>
          {owed.length === 0 ? (
            unposted > 0 || !o.hasLiabilities ? (
              // "Paid up" only means something once taxes have posted.
              <EmptyState size="sm" icon={CalendarCheck2} title="No deposits due yet" description={unposted > 0 ? 'The paid payroll above hasn’t posted its taxes, so nothing is listed to pay.' : 'Deposits appear here as payroll runs are paid.'} />
            ) : (
              <EmptyState size="sm" icon={CalendarCheck2} title="You’re paid up" description={(o.upcoming ?? []).length ? `The next deposit is ${dueText(o.upcoming[0]?.dueDate, o.today).toLowerCase()}.` : 'Every tax posted so far is paid.'} />
            )
          ) : (
            <ul className="divide-y divide-navy-secondary">
              {owed.map((l) => (
                <li key={`${l.kind}|${l.jurisdiction}|${l.dueDate}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink">{l.agency}</p>
                    <p className="text-sm text-ink-muted">{`${KIND_SHORT[l.kind]} · ${dueText(l.dueDate, o.today)}`}</p>
                  </div>
                  <DueBadge due={l.dueDate} today={o.today} />
                  <span className="tabular-nums font-medium text-ink">{fmtMoney(l.amount)}</span>
                  {l.scheduled === l.liabilities ? (
                    <Button size="sm" variant="ghost" onClick={() => onTab('deposits')}>
                      See payment
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setPaying(l)} aria-label={`Pay ${l.agency}, ${fmtMoney(l.amount)}`}>
                      Pay
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Returns to file</CardTitle>
            <CardDescription>{`For ${quarterName(o.returns?.previous?.periodLabel ?? '')} and ${quarterName(o.returns?.current?.periodLabel ?? '')}.`}</CardDescription>
          </CardHeader>
          <CardContent>
            {returnItems.length === 0 ? (
              checklist.length === 0 ? (
                <EmptyState size="sm" icon={FileText} title="No returns due yet" description={unposted > 0 ? 'The paid payroll above hasn’t posted its taxes; its quarter’s returns appear once it does.' : 'Returns appear here once payroll posts taxes in a quarter.'} />
              ) : (
                <EmptyState size="sm" icon={FileText} title="Every return is filed" description={`All ${checklist.length} return${checklist.length === 1 ? '' : 's'} for these two quarters are filed.`} />
              )
            ) : (
              <ul className="divide-y divide-navy-secondary">
                {returnItems.map((r) => (
                  <li key={`${r.kind}|${r.jurisdiction}|${r.periodLabel}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">{`${r.label} · ${r.agency}`}</p>
                      <p className="text-xs text-ink-muted">{`${r.periodLabel} · ${dueText(r.dueDate, o.today)}`}</p>
                    </div>
                    <ReturnBadge status={r.status} />
                  </li>
                ))}
              </ul>
            )}
            {returnItems.length > 0 && (
              <Button variant="outline" size="sm" className="mt-3" onClick={() => onTab('returns')}>
                Open returns
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agency letters waiting on you</CardTitle>
            <CardDescription>Notices with a response deadline, soonest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {(o.noticesDue ?? []).length === 0 ? (
              <EmptyState size="sm" icon={Inbox} title="No responses due" description="Log a letter from an agency on the Notices tab to track its deadline." />
            ) : (
              <ul className="divide-y divide-navy-secondary">
                {o.noticesDue.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">{`${n.agencyName} · ${n.noticeType}`}</p>
                      <p className="text-xs text-ink-muted">{`Respond by ${fmtDate(n.responseDueAt)}${n.amountDue ? ` · ${fmtMoney(n.amountDue)} in question` : ''}`}</p>
                    </div>
                    <DueBadge due={n.responseDueAt} today={o.today} />
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" size="sm" className="mt-3" onClick={() => onTab('notices')}>
              Open notices
            </Button>
          </CardContent>
        </Card>
      </div>

      {(o.registrations ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Tax accounts to set up</CardTitle>
            <CardDescription>Federal and state accounts payroll needs and doesn’t have yet. Payroll can’t pay these agencies until you register.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-navy-secondary">
              {o.registrations.slice(0, 6).map((r) => (
                <li key={`${r.kind}|${r.jurisdiction}`} className="py-2.5">
                  <p className="text-sm font-medium text-ink">{r.agencyName}</p>
                  <p className="text-xs text-ink-muted">{r.reason}</p>
                </li>
              ))}
            </ul>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => onTab('agencies')}>
              {o.registrations.length > 6 ? `See all ${o.registrations.length}` : 'Set up accounts'}
            </Button>
          </CardContent>
        </Card>
      )}

      {paying && <PayDepositDialog line={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}

/** Pay one deposit line: every open liability for that agency due that day. */
function PayDepositDialog({ line, onClose }: { line: DepositLine; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll-taxes', 'liabilities', 'OPEN', line.kind, line.jurisdiction], queryFn: () => listLiabilities({ status: 'OPEN', kind: line.kind, jurisdiction: line.jurisdiction }) });
  const ids = useMemo(() => (q.data?.liabilities ?? []).filter((l) => l.dueDate === line.dueDate).map((l) => l.id), [q.data, line.dueDate]);
  const pay = useMutation({
    mutationFn: () => createTaxPayment(ids),
    onSuccess: (r) => {
      toast.success(r.pending ? 'Sent for a second approval before it goes out.' : r.payment.method === 'PROVIDER' ? 'Payment sent to your provider.' : 'Payment started. Pay it on the agency’s site, then record the confirmation.');
      void qc.invalidateQueries({ queryKey: ['payroll-taxes'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Pay ${line.agency}`}</DialogTitle>
          <DialogDescription>{`${fmtMoney(line.amount)} · ${dueText(line.dueDate)}`}</DialogDescription>
        </DialogHeader>
        {q.isError ? <QueryError what="this deposit" query={q} /> : q.isLoading ? <SkeletonRows count={2} /> : (
          <p className="text-sm text-ink-muted">{`This covers ${ids.length} payroll${ids.length === 1 ? '' : 's'}. With a provider connected, the money goes out through them after a second person approves. Otherwise you pay on EFTPS or the agency’s site and record the confirmation here.`}</p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          <Button onClick={() => pay.mutate()} loading={pay.isPending} disabled={ids.length === 0}>
            Start payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- Deposits ----------------------------------------------------------------- */

type DepositView = 'to-pay' | 'payments';

function DepositsTab({ provider, providerLabel }: { provider: boolean; providerLabel: string | null }) {
  const [view, setView] = useState<DepositView>('to-pay');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const today = localToday();
  const liabilities = useQuery({ queryKey: ['payroll-taxes', 'liabilities', 'OPEN'], queryFn: () => listLiabilities({ status: 'OPEN' }), enabled: view === 'to-pay' });
  const payments = useQuery({ queryKey: ['payroll-taxes', 'payments'], queryFn: () => listPayments(), enabled: view === 'payments' });
  const [recording, setRecording] = useState<TaxPayment | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['payroll-taxes'] });

  const pay = useMutation({
    mutationFn: (ids: string[]) => createTaxPayment(ids),
    onSuccess: (r) => {
      toast.success(r.pending ? 'Sent for a second approval before it goes out.' : r.payment.method === 'PROVIDER' ? 'Payment sent to your provider.' : 'Payment started. Pay it on the agency’s site, then record the confirmation.');
      invalidate();
      setView('payments');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const cancel = useMutation({ mutationFn: (id: string) => cancelTaxPayment(id), onSuccess: () => { toast.success('Payment cancelled. Its taxes are open to pay again.'); invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const retry = useMutation({ mutationFn: (id: string) => retryTaxPayment(id), onSuccess: (r) => { toast[r.payment.status === 'FAILED' ? 'error' : 'success'](r.payment.status === 'FAILED' ? (r.payment.failureReason ?? 'It failed again.') : 'Sent again.'); invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const refresh = useMutation({ mutationFn: refreshTaxPayments, onSuccess: (r) => { toast.success(r.changed ? `${r.changed} payment${r.changed === 1 ? '' : 's'} updated.` : 'Nothing has changed yet.'); invalidate(); }, onError: (e: Error) => toast.error(e.message) });

  const liabCols: GridColumn<Liability>[] = [
    { key: 'agency', header: 'Agency', primary: true, accessor: (l) => l.agency, cell: (l) => <span className="font-medium text-ink">{l.agency}</span>, sortable: true },
    { key: 'kind', header: 'Tax', accessor: (l) => KIND_SHORT[l.kind], cardMeta: true },
    { key: 'paid', header: 'Payday', accessor: (l) => l.liabilityDate, cell: (l) => fmtDate(l.liabilityDate), sortable: true },
    { key: 'due', header: 'Due', accessor: (l) => l.dueDate, cell: (l) => <span className="flex flex-wrap items-center gap-2">{fmtDate(l.dueDate)}<DueBadge due={l.dueDate} today={today} /></span>, sortable: true },
    { key: 'amount', header: 'Amount', accessor: (l) => l.amount, cell: (l) => fmtMoney(l.amount), align: 'right', sortable: true, className: 'tabular-nums' },
    { key: 'status', header: 'Status', accessor: (l) => l.status, cell: (l) => <LiabilityBadge status={l.status} />, searchable: false },
  ];

  const payCols: GridColumn<TaxPayment>[] = [
    { key: 'agency', header: 'Agency', primary: true, accessor: (p) => p.agency, cell: (p) => <span className="font-medium text-ink">{p.agency}</span>, sortable: true },
    { key: 'period', header: 'Period', accessor: (p) => p.periodLabel, cardMeta: true },
    { key: 'due', header: 'Due', accessor: (p) => p.dueDate, cell: (p) => <span className="flex flex-wrap items-center gap-2">{fmtDate(p.dueDate)}<DueBadge due={p.dueDate} today={today} done={p.status === 'PAID' || p.status === 'CANCELLED'} /></span>, sortable: true },
    { key: 'amount', header: 'Amount', accessor: (p) => p.amount, cell: (p) => fmtMoney(p.amount), align: 'right', sortable: true, className: 'tabular-nums' },
    { key: 'how', header: 'How', accessor: (p) => (p.method === 'PROVIDER' ? (providerLabel ?? 'Provider') : p.method === 'EFTPS' ? 'EFTPS' : 'Agency site') },
    {
      key: 'status',
      header: 'Status',
      accessor: (p) => p.status,
      searchable: false,
      cell: (p) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <PaymentBadge status={p.status} />
          {p.late && <Badge variant="pending">Paid late</Badge>}
        </span>
      ),
    },
    { key: 'confirmation', header: 'Confirmation', accessor: (p) => p.confirmationNumber ?? '', cell: (p) => p.confirmationNumber ?? (p.failureReason ? <span className="text-sm text-alert">{p.failureReason}</span> : <span className="text-ink-muted">—</span>) },
    {
      key: 'actions',
      header: 'Actions',
      accessor: () => '',
      searchable: false,
      stopRowClick: true,
      cell: (p) => (
        <div className="flex flex-wrap gap-1.5">
          {p.status === 'SCHEDULED' && p.method !== 'PROVIDER' && (
            <Button size="xs" onClick={() => setRecording(p)}>
              Record payment
            </Button>
          )}
          {p.status === 'FAILED' && p.method === 'PROVIDER' && (
            <Button size="xs" onClick={() => retry.mutate(p.id)} loading={retry.isPending && retry.variables === p.id}>
              Send again
            </Button>
          )}
          {p.method !== 'PROVIDER' && p.status !== 'CANCELLED' && (
            <Button size="xs" variant="outline" onClick={() => downloadPaymentWorksheet(p.id).catch((e: Error) => toast.error(e.message))} aria-label={`Download the worksheet for ${p.agency}`}>
              <Download className="mr-1 h-3.5 w-3.5" aria-hidden /> Worksheet
            </Button>
          )}
          {(p.status === 'SCHEDULED' || p.status === 'FAILED') && (
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => {
                if (await confirm({ title: 'Cancel this payment?', description: 'Its taxes go back to “To pay”. Nothing has been sent to the agency.', confirmLabel: 'Cancel payment', cancelLabel: 'Keep it', destructive: true })) cancel.mutate(p.id);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        {view === 'to-pay'
          ? 'Taxes posted by paid payrolls, by agency and due date. A payment goes to one agency: select taxes for the same agency, then pay them together.'
          : 'Payments started here, how each was made, and the agency’s confirmation.'}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<DepositView>
          ariaLabel="Deposits view"
          value={view}
          onChange={setView}
          options={[
            { value: 'to-pay', label: 'To pay' },
            { value: 'payments', label: 'Payments' },
          ]}
        />
        {provider && view === 'payments' && (
          <Button size="sm" variant="outline" onClick={() => refresh.mutate()} loading={refresh.isPending}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden /> Check with provider
          </Button>
        )}
      </div>
      {view === 'to-pay' ? (
        <DataGrid<Liability>
          id="payroll-taxes-liabilities"
          caption="Taxes to pay"
          noun={{ one: 'tax to pay', many: 'taxes to pay' }}
          rows={liabilities.data?.liabilities}
          loading={liabilities.isLoading}
          error={liabilities.isError ? (liabilities.error as Error).message : null}
          onRetry={() => void liabilities.refetch()}
          columns={liabCols}
          rowKey={(l) => l.id}
          defaultSort={{ key: 'due', direction: 'asc' }}
          selectable={{
            selectAllLabel: 'Select every tax shown',
            actions: (selected, clear) => (
              <Button
                size="sm"
                onClick={() => {
                  pay.mutate(selected, { onSuccess: clear });
                }}
                loading={pay.isPending}
              >
                <Wallet className="mr-1.5 h-4 w-4" aria-hidden /> {`Pay ${selected.length} selected`}
              </Button>
            ),
          }}
          empty={{ icon: CalendarCheck2, title: 'Nothing to pay', description: 'Taxes appear here when a payroll run is paid.' }}
        />
      ) : (
        <DataGrid<TaxPayment>
          id="payroll-taxes-payments"
          caption="Tax payments"
          noun={{ one: 'payment', many: 'payments' }}
          rows={payments.data?.payments}
          loading={payments.isLoading}
          error={payments.isError ? (payments.error as Error).message : null}
          onRetry={() => void payments.refetch()}
          columns={payCols}
          rowKey={(p) => p.id}
          empty={{ icon: Scale, title: 'No payments yet', description: 'Start one from “To pay”.' }}
        />
      )}
      {recording && <RecordPaymentDialog payment={recording} onClose={() => setRecording(null)} onDone={invalidate} />}
    </div>
  );
}

function RecordPaymentDialog({ payment, onClose, onDone }: { payment: TaxPayment; onClose: () => void; onDone: () => void }) {
  const [confirmation, setConfirmation] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => markTaxPaymentPaid(payment.id, confirmation.trim(), paidOn || undefined),
    onSuccess: (r) => {
      toast.success(r.payment.late ? 'Recorded. It was paid after the due date, so watch for a notice.' : 'Recorded as paid.');
      onDone();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Record the ${payment.agency} payment`}</DialogTitle>
          <DialogDescription>{`${fmtMoney(payment.amount)} for ${payment.periodLabel} · ${dueText(payment.dueDate)}`}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (confirmation.trim().length < 3) {
              setError('Enter the confirmation number the agency gave you.');
              return;
            }
            save.mutate();
          }}
        >
          <Field label="Confirmation number" required hint={payment.kind.startsWith('FEDERAL') ? 'EFTPS shows an EFT acknowledgement number after you pay.' : 'The number the agency’s site shows after you pay.'} error={error}>
            {(p) => <Input {...p} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} maxLength={80} autoComplete="off" />}
          </Field>
          <Field label="Paid on" hint="Leave empty for today.">
            {(p) => <Input {...p} type="date" value={paidOn} max={localToday()} onChange={(e) => setPaidOn(e.target.value)} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Not now</Button>
            <Button type="submit" loading={save.isPending}>Record payment</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
