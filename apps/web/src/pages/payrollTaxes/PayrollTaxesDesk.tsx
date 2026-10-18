import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CalendarCheck2, Download, FileText, Inbox, Landmark, RefreshCw, Scale, ShieldCheck, Wallet } from 'lucide-react';
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
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtMoney } from '@/lib/format';
import { DueBadge, KIND_SHORT, LiabilityBadge, PaymentBadge, ReturnBadge, dueText, localToday, quarterName } from './taxShared';
import { ReturnsTab } from './ReturnsTab';
import { NoticesTab } from './NoticesTab';
import { AgenciesTab } from './AgenciesTab';
import { ReconciliationTab } from './ReconciliationTab';

/**
 * Payroll taxes — what payroll owes each tax agency and when, the deposits
 * that pay it, the returns each quarter needs, reconciliation, agency
 * notices and the accounts behind it all. Built on the list template with
 * tabs; each agency drills down from the Agencies tab.
 */

type Tab = 'overview' | 'deposits' | 'returns' | 'reconciliation' | 'notices' | 'agencies';
const TABS: Tab[] = ['overview', 'deposits', 'returns', 'reconciliation', 'notices', 'agencies'];

export function PayrollTaxesDesk() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'overview') as Tab;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };
  const overview = useQuery({ queryKey: ['payroll-taxes', 'overview'], queryFn: getTaxOverview });

  return (
    <ListTemplate
      title="Payroll taxes"
      subtitle="What payroll owes each tax agency and when it’s due, the returns each quarter needs, and the letters agencies send."
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Payroll taxes' }]}
      secondaryActions={
        <Button asChild variant="ghost" size="sm">
          <Link to="/payroll/tax">Tax forms</Link>
        </Button>
      }
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
          <DepositsTab provider={overview.data?.filing.mode === 'PROVIDER'} providerLabel={overview.data?.filing.providerLabel ?? null} />
        </TabsContent>
        <TabsContent value="returns">
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
  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="flex items-start gap-3 py-4">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">You file and pay these yourself</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-muted">
              <li>Pay each deposit on EFTPS or the agency’s site by its due date, then record the confirmation number here.</li>
              <li>Generate each return here, file it with the agency, and record the confirmation.</li>
              <li>Keep each agency account current. Unemployment rates change every January.</li>
            </ul>
          </div>
          <Button asChild variant="outline" size="sm" className="self-start lg:shrink-0">
            <Link to="/integrations">Connect a payroll tax provider</Link>
          </Button>
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
  const returnItems = [...(o.returns?.previous?.items ?? []), ...(o.returns?.current?.items ?? [])].filter((r) => r.status !== 'FILED' && r.status !== 'ACCEPTED');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Late" value={fmtMoney(o.totals?.overdue ?? 0)} hint="Past the due date, not paid" accent={(o.totals?.overdue ?? 0) > 0} />
        <MetricCard label="Due in the next 14 days" value={fmtMoney(o.totals?.dueSoon ?? 0)} hint={`${(o.dueSoon ?? []).length} deposit${(o.dueSoon ?? []).length === 1 ? '' : 's'}`} />
        <MetricCard label="Open notices" value={String(o.totals?.openNotices ?? 0)} hint="Letters from agencies" accent={(o.totals?.openNotices ?? 0) > 0} />
        <MetricCard label="Failed payments" value={String(o.totals?.failedPayments ?? 0)} hint="Need sending again" accent={(o.totals?.failedPayments ?? 0) > 0} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Deposits to make</CardTitle>
          <CardDescription>Late deposits first, then everything due in the next 14 days.</CardDescription>
        </CardHeader>
        <CardContent>
          {owed.length === 0 ? (
            <EmptyState size="sm" icon={CalendarCheck2} title="You’re paid up" description={(o.upcoming ?? []).length ? `The next deposit is ${dueText(o.upcoming[0]?.dueDate, o.today).toLowerCase()}.` : 'Deposits appear here as payroll runs are paid.'} />
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
              <EmptyState size="sm" icon={FileText} title="Every return is filed" description="Returns appear here once payroll posts taxes in a quarter." />
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
            <CardTitle>Register in a new state</CardTitle>
            <CardDescription>Tax is owed or people work where there’s no agency account yet. Payroll can’t pay these agencies until you register.</CardDescription>
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
          footnote="A payment goes to one agency: select taxes for the same agency, then pay them together."
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
