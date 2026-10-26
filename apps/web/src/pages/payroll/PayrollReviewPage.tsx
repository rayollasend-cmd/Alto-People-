import { useState } from 'react';
import { fmtMoneyAxis } from '@/components/ui/charts/axes';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Download, FileSearch, FileSpreadsheet, ShieldAlert, ShieldCheck, ShieldQuestion } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateOnlyRange, fmtDateTime, fmtHours, fmtMoney, fmtPercent } from '@/lib/format';
import {
  FLAG_LABEL,
  SERIOUS_FLAGS,
  downloadPayrollReview,
  getPayrollReview,
  signPayrollReview,
  type PayrollReviewReport,
  type ReviewGroup,
  type ReviewRow,
  type ReviewState,
} from '@/lib/payrollReviewApi';
import { RunPageShell, type RunSubPageProps } from './RunPageShell';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { useMediaQuery } from '@/lib/useViewport';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { Waterfall } from '@/components/ui/charts';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Input';
import { RunTotalsMismatch } from '@/components/payroll/RunTotalsMismatch';
import { RunStatusBadge } from '@/lib/payrollRunStatus';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/Table';

/**
 * The pre-payroll review. One run, read the way an accountant reads a
 * payroll register before it goes out: the totals against last payroll,
 * the cash the run needs, the taxes it owes, the paychecks that moved, the
 * totals by department and state, and every paycheck line by line. At the
 * bottom they sign off on this exact version of the numbers. If a paycheck
 * changes afterwards, the sign-off no longer holds and the run can't pay
 * until someone reviews it again.
 */


export function PayrollReviewPage({ runId, embedded = false }: RunSubPageProps = {}) {
  const params = useParams<{ id: string }>();
  const id = runId ?? params.id ?? '';
  const q = useQuery({ queryKey: ['payroll', 'review', id], queryFn: () => getPayrollReview(id), enabled: !!id });
  // Payroll › the run › Review (F500 G3: run pages name their run).
  const crumbs = [
    { label: 'Payroll', to: '/payroll' },
    { label: 'Run', to: `/payroll/runs/${id}` },
    { label: 'Review' },
  ];

  if (q.isError) {
    return (
      <RunPageShell embedded={embedded} title="Review payroll" breadcrumbs={crumbs}>
        <EmptyState
          title="We couldn’t load this report"
          description={q.error instanceof ApiError ? q.error.message : undefined}
          action={
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        />
      </RunPageShell>
    );
  }
  if (!q.data) {
    return (
      <RunPageShell embedded={embedded} title="Review payroll" breadcrumbs={crumbs}>
        <Skeleton className="h-20" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </RunPageShell>
    );
  }
  return <Review report={q.data.report} signoff={q.data.signoff} crumbs={crumbs} embedded={embedded} />;
}

function Review({ report, signoff, crumbs, embedded }: { report: PayrollReviewReport; signoff: ReviewState; crumbs: Array<{ label: string; to?: string }>; embedded: boolean }) {
  const r = report.run;
  const [downloading, setDownloading] = useState<'pdf' | 'xlsx' | null>(null);
  const download = async (format: 'pdf' | 'xlsx') => {
    setDownloading(format);
    try {
      await downloadPayrollReview(r.id, format);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download the report.');
    } finally {
      setDownloading(null);
    }
  };
  const open = r.status === 'DRAFT' || r.status === 'FINALIZED';
  const flagged = report.rows.filter((x) => x.flags.length > 0);
  // The run records totals its paychecks don't add up to (lib/payrollRunTotals): the
  // tiles read the run's recorded totals — the same as the run record's header — and
  // nothing below pretends the paychecks are the run (F500 audit 2026-10-26: a header
  // of $4,054.50 gross over Review tiles and ledgers of $0.00).
  const disagree = r.totalsAgree === false || (r.totalsAgree === undefined && report.totals.people === 0 && (r.storedGross ?? 0) > 0);
  const nothingBehind = disagree && report.totals.people === 0;

  return (
    <RunPageShell
      embedded={embedded}
      title="Review payroll"
      topbarTitle="Review"
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="tabular-nums">{fmtDateOnlyRange(r.periodStart, r.periodEnd)}</span>
          <span aria-hidden="true">·</span>
          {r.clientName ?? 'All clients'}
          <RunStatusBadge status={r.status} />
        </span>
      }
      breadcrumbs={crumbs}
      primaryAction={
        open && signoff.required && signoff.canSign && !disagree ? (
          <Button asChild>
            <a href="#signoff">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Sign off
            </a>
          </Button>
        ) : (
          <Button asChild variant="secondary">
            <Link to={`/payroll/runs/${r.id}/close`}>
              Guided close
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        )
      }
      secondaryActions={
        <>
          <Button variant="secondary" loading={downloading === 'pdf'} disabled={!!downloading} onClick={() => void download('pdf')}>
            <Download className="h-4 w-4" aria-hidden="true" />
            PDF
          </Button>
          <Button variant="secondary" loading={downloading === 'xlsx'} disabled={!!downloading} onClick={() => void download('xlsx')}>
            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
            Excel
          </Button>
        </>
      }
      summary={
        <div className="space-y-3">
          {/* First: it changes how every number below should be read (apps/api/src/lib/payrollRunTotals.ts). */}
          <RunTotalsMismatch
            check={{
              totalGross: report.run.storedGross,
              totalNet: report.run.storedNet,
              itemsGross: report.totals.gross,
              itemsNet: report.totals.net,
              paychecks: report.totals.people,
              totalsAgree: !disagree,
              status: r.status,
            }}
          />
          <SignoffBanner signoff={signoff} status={r.status} />
          {signoff.current && open && !disagree && <PayNext runId={r.id} status={r.status} net={report.totals.net} />}
          <Totals report={report} disagree={disagree} />
        </div>
      }
    >
      {disagree && !nothingBehind && (
        <p className="text-sm text-ink-muted" data-testid="review-paychecks-basis">
          Below: the {report.totals.people} {report.totals.people === 1 ? 'paycheck' : 'paychecks'} in this run, which don’t add up to its recorded totals.
        </p>
      )}
      {!nothingBehind && (
        <>
          <PayWaterfall report={report} />
          <div className="grid gap-[var(--d-stack)] lg:grid-cols-2">
            <MoneyCard
              title="Cash required"
              description="What leaves the bank because of this run."
              lines={report.cash.lines}
              totalLabel="Total cash required"
              total={report.cash.total}
            />
            <TaxesCard report={report} />
          </div>

          {(report.payByCheck?.length ?? 0) > 0 && <PaperChecks rows={report.payByCheck!} runId={r.id} />}

          <LookAt rows={flagged} previous={report.previous} checked={report.rows.length} />
          <Breakdown report={report} />
        </>
      )}
      <Register rows={report.rows} totals={report.totals} nothingBehind={nothingBehind} />
      {open && <SignoffPanel report={report} signoff={signoff} blocked={disagree} />}
    </RunPageShell>
  );
}

/* ---- Sign-off state, up top ------------------------------------------- */

function SignoffBanner({ signoff, status }: { signoff: ReviewState; status: PayrollReviewReport['run']['status'] }) {
  const s = signoff.current;
  if (s) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/5 p-3.5">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        <div className="min-w-0 text-sm">
          <p className="font-medium text-ink">
            Signed off by {s.signedByName ?? 'a reviewer'} · {fmtDateTime(s.signedAt)}
          </p>
          <p className="mt-0.5 text-ink-muted">
            {s.soleReviewer ? 'Signed by the person who ran it: no one else processes payroll here.' : 'These exact numbers are approved to pay.'}
            {s.note && <span className="text-ink"> “{s.note}”</span>}
          </p>
        </div>
      </div>
    );
  }
  if (signoff.stale) {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-lg border border-alert/40 bg-alert/5 p-3.5">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-alert" aria-hidden="true" />
        <div className="min-w-0 text-sm">
          <p className="font-medium text-ink">The numbers changed after the sign-off</p>
          <p className="mt-0.5 text-ink-muted">
            {signoff.stale.signedByName ?? 'A reviewer'} signed off {fmtDateTime(signoff.stale.signedAt)}. A paycheck changed since, so the run can’t pay until someone reviews it again.
          </p>
        </div>
      </div>
    );
  }
  if (!signoff.required || status === 'DISBURSED' || status === 'CANCELLED') return null;
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-accent/40 bg-accent-fill/5 p-3.5">
      <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-ink">Not signed off yet</p>
        <p className="mt-0.5 text-ink-muted">
          {signoff.canSign ? 'Read the report, then sign off at the bottom. The run can’t pay out until someone does.' : `The run can’t pay out until someone signs off. ${signoff.cannotSignReason ?? ''}`}
        </p>
      </div>
    </div>
  );
}

/* ---- After sign-off: straight on to paying ------------------------------ */

function PayNext({ runId, status, net }: { runId: string; status: PayrollReviewReport['run']['status']; net: number }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gold/30 bg-gold/5 p-3.5">
      <p className="text-sm text-ink">{status === 'DRAFT' ? 'Signed off. Finalize the run, then pay it out.' : 'Signed off and ready to pay out.'}</p>
      <Button asChild>
        <Link to={`/payroll?run=${runId}&next=pay`}>
          {status === 'DRAFT' ? 'Finalize & disburse' : 'Disburse'} {fmtMoney(net)}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </Button>
    </div>
  );
}

/* ---- Gross to net to cash, as one picture ------------------------------ */

function PayWaterfall({ report }: { report: PayrollReviewReport }) {
  const t = report.totals;
  if (t.gross <= 0) return null;
  const pay = [
    { label: 'Pre-tax deductions', value: -t.preTax },
    { label: 'Taxes withheld', value: -t.employeeTaxes },
    { label: 'After-tax deductions', value: -t.postTax },
    { label: 'Other', value: -t.other },
    { label: 'Reimbursements', value: t.reimbursements },
  ].filter((x) => Math.abs(x.value) >= 0.005);
  // What else leaves the bank beyond net pay: withholding and deductions
  // sent on, then the employer's own taxes.
  const sentOn = Math.max(0, report.cash.total - t.net - t.employerTaxes);
  const cash = [
    { label: 'Withheld, sent on', value: sentOn },
    { label: 'Employer taxes', value: t.employerTaxes },
  ].filter((x) => x.value >= 0.005);
  const rows = [
    { step: 'Gross pay', amount: t.gross },
    ...pay.map((x) => ({ step: x.label, amount: x.value })),
    { step: 'Net pay', amount: t.net },
    ...cash.map((x) => ({ step: x.label, amount: x.value })),
    { step: 'Cash required', amount: report.cash.total },
  ];
  const words = { total: 'Total', up: 'Adds', down: 'Comes out' };
  return (
    <ChartFrame
      title="Where the money goes"
      description="Gross pay down to what people take home, then up to what leaves the bank."
      summary={`Gross pay ${fmtMoney(t.gross)} becomes net pay ${fmtMoney(t.net)} after ${fmtMoney(t.preTax + t.employeeTaxes + t.postTax + t.other)} withheld; with employer taxes and money sent on, the run needs ${fmtMoney(report.cash.total)} in cash.`}
      columns={[
        { key: 'step', label: 'Step' },
        { key: 'amount', label: 'Amount', numeric: true, format: (v) => fmtMoney(v as number) },
      ]}
      rows={rows}
      csvName="payroll-waterfall"
      height={300}
    >
      <div className="grid h-full grid-rows-2 gap-3 *:min-h-0 lg:grid-cols-[3fr_2fr] lg:grid-rows-1 lg:gap-4">
        <Waterfall start={{ label: 'Gross', value: t.gross }} steps={pay} end={{ label: 'Net pay' }} format={fmtMoneyAxis} words={words} />
        <Waterfall start={{ label: 'Net pay', value: t.net }} steps={cash} end={{ label: 'Cash required' }} format={fmtMoneyAxis} words={words} />
      </div>
    </ChartFrame>
  );
}

/* ---- Totals against last payroll -------------------------------------- */

function vsLast(now: number, before: number | undefined, money = true): React.ReactNode {
  if (before === undefined) return 'No earlier payroll to compare';
  const d = now - before;
  if (Math.abs(d) < 0.005) return 'Same as last payroll';
  const share = before !== 0 ? d / Math.abs(before) : null;
  return (
    <span className={cn('tabular-nums', share !== null && Math.abs(share) >= 0.25 ? 'text-warning' : 'text-ink-muted')}>
      {d > 0 ? '+' : '−'}
      {money ? fmtMoney(Math.abs(d)) : Math.abs(d)}
      {share !== null && ` (${fmtPercent(Math.abs(share), { fromFraction: true })})`} vs last payroll
    </span>
  );
}

function Totals({ report, disagree = false }: { report: PayrollReviewReport; disagree?: boolean }) {
  const t = report.totals;
  const p = report.previous;
  const r = report.run;
  // A phone has the "Cash required" card right below: the tile would say it twice (and strand a fifth tile).
  const wide = useMediaQuery('(min-width: 640px)');
  if (disagree) {
    // The run's recorded totals, as its header shows them; what the paychecks add up to beside each.
    // What the paychecks add up to — beside the figures where they differ.
    const behind = (n: number, recorded: number | undefined) => (recorded === undefined || Math.abs(recorded - n) >= 0.005 ? `Paychecks add up to ${fmtMoney(n)}` : undefined);
    return (
      <div className="space-y-1.5" data-testid="review-recorded-totals">
        <MetricStrip label="Run totals as recorded">
          <MetricCard label="Paychecks" value={String(t.people)} />
          <MetricCard label="Gross pay" value={fmtMoney(r.storedGross ?? t.gross)} hint={behind(t.gross, r.storedGross)} />
          <MetricCard label="Net pay" value={fmtMoney(r.storedNet ?? t.net)} hint={behind(t.net, r.storedNet)} />
          {r.storedTax !== undefined && <MetricCard label="Taxes withheld" value={fmtMoney(r.storedTax)} hint={behind(t.employeeTaxes, r.storedTax)} />}
          <MetricCard label="Employer taxes" value={fmtMoney(r.storedEmployerTax ?? t.employerTaxes)} hint={behind(t.employerTaxes, r.storedEmployerTax)} />
        </MetricStrip>
        <p className="text-xs text-ink-muted">The totals recorded on the run, as in its header.</p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <MetricStrip label="Run totals">
        <MetricCard label="People paid" value={String(t.people)} hint={p ? vsLast(t.people, p.people, false) : undefined} />
        <MetricCard label="Gross pay" value={fmtMoney(t.gross)} hint={p ? vsLast(t.gross, p.gross) : undefined} />
        <MetricCard label="Net pay" value={fmtMoney(t.net)} hint={p ? vsLast(t.net, p.net) : undefined} />
        {/* The employer cost only when it says something the tile doesn't. */}
        <MetricCard label="Employer taxes" value={fmtMoney(t.employerTaxes)} hint={Math.abs(t.employerCost - t.employerTaxes) >= 0.005 ? `Employer cost ${fmtMoney(t.employerCost)}` : undefined} />
        {wide ? <MetricCard label="Cash required" value={fmtMoney(report.cash.total)} hint="Pay, taxes and money owed onward" /> : null}
      </MetricStrip>
      {/* Said once, not on every tile. */}
      {!p && <p className="text-xs text-ink-muted">First payroll: nothing earlier to compare.</p>}
    </div>
  );
}

/* ---- Cash and taxes ---------------------------------------------------- */

function MoneyCard({ title, description, lines, totalLabel, total }: { title: string; description: string; lines: Array<{ key: string; label: string; amount: number }>; totalLabel: string; total: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-line text-sm">
          {lines.map((l) => (
            <div key={l.key} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-ink-muted">{l.label}</dt>
              <dd className="tabular-nums text-ink">{fmtMoney(l.amount)}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4 pt-2.5">
            <dt className="font-medium text-ink">{totalLabel}</dt>
            <dd className="font-medium tabular-nums text-ink">{fmtMoney(total)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function TaxesCard({ report }: { report: PayrollReviewReport }) {
  const section = (label: string, lines: Array<{ key: string; label: string; amount: number }>) => (
    <>
      <div className="pb-1 pt-3 text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted first:pt-0">{label}</div>
      {lines.map((l) => (
        <div key={`${label}-${l.key}`} className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="text-ink-muted">{l.label}</dt>
          <dd className="tabular-nums text-ink">{fmtMoney(l.amount)}</dd>
        </div>
      ))}
    </>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Taxes owed</CardTitle>
        <CardDescription>Withheld from pay, and what the employer owes on top.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="text-sm">
          {section('Withheld from pay', report.taxes.employee)}
          {section('Employer', report.taxes.employer)}
          <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-line pt-2.5">
            <dt className="font-medium text-ink">Total taxes</dt>
            <dd className="font-medium tabular-nums text-ink">{fmtMoney(report.taxes.total)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/* ---- Paid by paper check this time --------------------------------------- */

function PaperChecks({ rows, runId }: { rows: NonNullable<PayrollReviewReport['payByCheck']>; runId: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>
            Paid by check this time <span className="ml-1 text-ink-muted">({rows.length})</span>
          </CardTitle>
          <CardDescription>How these people are paid changes, not how much. They’re left out of the bank file and printed from Paper checks.</CardDescription>
        </div>
        <Button asChild size="sm" variant="ghost">
          <Link to={`/payroll/runs/${runId}/checks`}>
            Paper checks
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-line">
          {rows.map((p) => (
            <li key={p.itemId} className="flex items-baseline justify-between gap-3 px-5 py-2.5 text-sm">
              <span className="min-w-0">
                <span className="block truncate text-ink">{p.name}</span>
                <span className="block truncate text-xs text-ink-muted">{p.reason}</span>
              </span>
              <span className="shrink-0 tabular-nums text-ink">{fmtMoney(p.net)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---- Paychecks to look at --------------------------------------------- */

function LookAt({ rows, previous, checked }: { rows: ReviewRow[]; previous: PayrollReviewReport['previous']; checked: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Paychecks to look at{rows.length > 0 && <span className="ml-1.5 text-ink-muted">({rows.length})</span>}</CardTitle>
        <CardDescription>
          {previous
            ? `First paychecks, net pay that moved at least 25% and $100 since each person’s last check, and W-2 checks that withhold nothing. Biggest changes first.`
            : 'First paychecks and W-2 checks that withhold nothing. There’s no earlier payroll to compare against.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {checked === 0 ? (
          // Nothing to check is not the same as all clear (finance walk 11).
          <EmptyState size="sm" icon={FileSearch} title="Nothing to check" description="This run has no paychecks, so there is nothing to compare or flag." />
        ) : rows.length === 0 ? (
          <EmptyState size="sm" icon={ShieldCheck} title="Nothing unusual" description="No first paychecks, no sharp swings, and every W-2 check withholds tax." />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {shown.map((r) => {
                const serious = r.flags.some((f) => SERIOUS_FLAGS.has(f));
                return (
                  <li key={r.itemId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium text-ink">
                        {serious && <AlertTriangle className="h-4 w-4 shrink-0 text-alert" aria-label="Likely error" />}
                        <span className="truncate">{r.name}</span>
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {r.flags.map((f) => (
                          <Badge key={f} size="sm" withDot={false} variant={SERIOUS_FLAGS.has(f) ? 'destructive' : f === 'FIRST_PAYCHECK' ? 'info' : 'pending'}>
                            {FLAG_LABEL[f]}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-baseline gap-3 text-sm tabular-nums sm:text-right">
                      <span className="text-ink-muted">{r.prior ? fmtMoney(r.prior.net) : 'No last check'}</span>
                      <ArrowRight className="h-3.5 w-3.5 self-center text-ink-muted" aria-label="to" />
                      <span className="font-medium text-ink">{fmtMoney(r.net)}</span>
                      {r.netChange !== null && (
                        <span className={cn('min-w-[5.5rem] text-right', r.netChange >= 0 ? 'text-success' : 'text-alert')}>
                          {r.netChange >= 0 ? '+' : '−'}
                          {fmtMoney(Math.abs(r.netChange))}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {rows.length > shown.length && (
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll(true)}>
                Show all {rows.length}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ---- By department / by state ----------------------------------------- */

function Breakdown({ report }: { report: PayrollReviewReport }) {
  const [by, setBy] = useState<'department' | 'state'>('department');
  const groups: ReviewGroup[] = by === 'department' ? report.byDepartment : report.byState;
  const sum = (k: 'people' | 'gross' | 'net' | 'employerTaxes') => groups.reduce((s, g) => s + g[k], 0);
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Totals by {by === 'department' ? 'department' : 'work state'}</CardTitle>
          <CardDescription>Where the money goes, largest first.</CardDescription>
        </div>
        <SegmentedControl
          ariaLabel="Group totals by"
          value={by}
          onChange={setBy}
          options={[
            { value: 'department', label: 'Department' },
            { value: 'state', label: 'State' },
          ]}
        />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{by === 'department' ? 'Department' : 'Work state'}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">People</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Employer taxes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <TableRow key={g.name}>
                <TableCell className="text-ink">
                  {g.name}
                  <span className="block text-xs text-ink-muted sm:hidden">
                    {g.people} {g.people === 1 ? 'person' : 'people'}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{g.people}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(g.gross)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(g.net)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtMoney(g.employerTaxes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-medium text-ink">Total</TableCell>
              <TableCell className="hidden text-right font-medium tabular-nums sm:table-cell">{sum('people')}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{fmtMoney(sum('gross'))}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{fmtMoney(sum('net'))}</TableCell>
              <TableCell className="hidden text-right font-medium tabular-nums sm:table-cell">{fmtMoney(sum('employerTaxes'))}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}

/* ---- The register ------------------------------------------------------ */

function Register({ rows, totals, nothingBehind = false }: { rows: ReviewRow[]; totals: PayrollReviewReport['totals']; nothingBehind?: boolean }) {
  const money = (pick: (r: ReviewRow) => number) => (r: ReviewRow) => fmtMoney(pick(r));
  const taxes = (r: ReviewRow) => r.federal + r.socialSecurity + r.medicare + r.stateTax + r.localTax + (r.stateProgram ?? 0);
  const deductions = (r: ReviewRow) => r.preTax + r.postTax + r.other;
  const columns: GridColumn<ReviewRow>[] = [
    {
      key: 'name',
      header: 'Person',
      primary: true,
      sortable: true,
      accessor: (r) => r.name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-ink">{r.name}</span>
          {r.type === 'CONTRACTOR' && (
            <Badge size="sm" withDot={false} variant="outline">
              1099
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'department', header: 'Department', sortable: true, accessor: (r) => r.department ?? '—', defaultHidden: true },
    { key: 'state', header: 'State', sortable: true, accessor: (r) => r.state ?? '—', cardMeta: true },
    { key: 'hours', header: 'Hours', align: 'right', sortable: true, searchable: false, accessor: (r) => r.hours, cell: (r) => fmtHours(r.hours), className: 'tabular-nums' },
    { key: 'gross', header: 'Gross', align: 'right', sortable: true, searchable: false, accessor: (r) => r.gross, cell: money((r) => r.gross), className: 'tabular-nums' },
    { key: 'taxes', header: 'Taxes', align: 'right', sortable: true, searchable: false, accessor: taxes, cell: (r) => fmtMoney(taxes(r)), className: 'tabular-nums' },
    { key: 'federal', header: 'Federal', align: 'right', sortable: true, searchable: false, defaultHidden: true, accessor: (r) => r.federal, cell: money((r) => r.federal), className: 'tabular-nums' },
    { key: 'ss', header: 'Social Security', align: 'right', sortable: true, searchable: false, defaultHidden: true, accessor: (r) => r.socialSecurity, cell: money((r) => r.socialSecurity), className: 'tabular-nums' },
    { key: 'medicare', header: 'Medicare', align: 'right', sortable: true, searchable: false, defaultHidden: true, accessor: (r) => r.medicare, cell: money((r) => r.medicare), className: 'tabular-nums' },
    { key: 'stateTax', header: 'State tax', align: 'right', sortable: true, searchable: false, defaultHidden: true, accessor: (r) => r.stateTax, cell: money((r) => r.stateTax), className: 'tabular-nums' },
    { key: 'localTax', header: 'Local tax', align: 'right', sortable: true, searchable: false, defaultHidden: true, accessor: (r) => r.localTax, cell: money((r) => r.localTax), className: 'tabular-nums' },
    { key: 'stateProgram', header: 'Disability & leave', align: 'right', sortable: true, searchable: false, defaultHidden: true, accessor: (r) => r.stateProgram ?? 0, cell: money((r) => r.stateProgram ?? 0), className: 'tabular-nums' },
    { key: 'deductions', header: 'Deductions', align: 'right', sortable: true, searchable: false, accessor: deductions, cell: (r) => fmtMoney(deductions(r)), className: 'tabular-nums' },
    { key: 'net', header: 'Net', align: 'right', sortable: true, searchable: false, accessor: (r) => r.net, cell: (r) => <span className="font-medium text-ink">{fmtMoney(r.net)}</span>, className: 'tabular-nums' },
    {
      key: 'change',
      header: 'vs last check',
      align: 'right',
      sortable: true,
      searchable: false,
      accessor: (r) => r.netChange ?? 0,
      cell: (r) =>
        r.netChange === null ? (
          <span className="text-ink-muted">First</span>
        ) : (
          <span className={cn(Math.abs(r.netChange) < 0.005 ? 'text-ink-muted' : r.netChange > 0 ? 'text-success' : 'text-alert')}>
            {Math.abs(r.netChange) < 0.005 ? 'Same' : `${r.netChange > 0 ? '+' : '−'}${fmtMoney(Math.abs(r.netChange))}`}
          </span>
        ),
      className: 'tabular-nums',
    },
    { key: 'employer', header: 'Employer tax', align: 'right', sortable: true, searchable: false, defaultHidden: true, accessor: (r) => r.employerTaxes, cell: money((r) => r.employerTaxes), className: 'tabular-nums' },
  ];
  return (
    <section aria-labelledby="register-title" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="register-title" className="text-base font-medium text-ink">
          Every paycheck
        </h2>
        {rows.length > 0 && (
          <p className="text-xs tabular-nums text-ink-muted">
            {totals.people} {totals.people === 1 ? 'person' : 'people'} · {fmtHours(totals.hours)} · gross {fmtMoney(totals.gross)} · net {fmtMoney(totals.net)}
          </p>
        )}
      </div>
      <DataGrid
        id="payroll-review-register"
        caption="Every paycheck in this run"
        rows={rows}
        columns={columns}
        rowKey={(r) => r.itemId}
        noun={{ one: 'paycheck', many: 'paychecks' }}
        defaultSort={{ key: 'name', direction: 'asc' }}
        empty={
          nothingBehind
            ? { title: 'No paychecks behind these totals', description: 'There is nothing to break down until the run has paychecks. See the alert above.' }
            : { title: 'No paychecks in this run', description: 'Nothing to review: no approved time or earnings fell in its period.' }
        }
      />
    </section>
  );
}

/* ---- Sign off ---------------------------------------------------------- */

function SignoffPanel({ report, signoff, blocked = false }: { report: PayrollReviewReport; signoff: ReviewState; blocked?: boolean }) {
  const qc = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const sign = useMutation({
    mutationFn: () => signPayrollReview(report.run.id, { fingerprint: report.fingerprint, note: note.trim() || null }),
    onSuccess: () => {
      toast.success('Signed off. The run can pay out.');
      setConfirmed(false);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['payroll'] });
      void qc.invalidateQueries({ queryKey: ['me', 'inbox'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'review_changed') {
        toast.error('The numbers changed while you were reading. The report has been refreshed: check it again.');
        void qc.invalidateQueries({ queryKey: ['payroll', 'review', report.run.id] });
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'Could not sign off.');
    },
  });
  const history = signoff.history;

  return (
    <Card id="signoff" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>Sign off</CardTitle>
        <CardDescription>
          {signoff.required
            ? 'Your sign-off approves these exact numbers to pay. If any paycheck changes afterwards, someone signs again.'
            : 'Sign-off is optional here, and still recorded with the run.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {signoff.current ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Signed off by {signoff.current.signedByName ?? 'a reviewer'} · {fmtDateTime(signoff.current.signedAt)}
          </p>
        ) : blocked ? (
          <p className="text-sm text-ink-muted">Sign-off waits until the run’s totals and its paychecks agree.</p>
        ) : !signoff.canSign ? (
          <p className="text-sm text-ink-muted">{signoff.cannotSignReason}</p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmed) sign.mutate();
            }}
          >
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 cursor-pointer accent-gold" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>
                <span className="block font-medium text-ink">I reviewed these numbers and approve this payroll to pay</span>
                <span className="mt-0.5 block text-ink-muted tabular-nums">
                  {report.totals.people} paychecks · net {fmtMoney(report.totals.net)} · cash required {fmtMoney(report.cash.total)}
                </span>
              </span>
            </label>
            <label className="block text-sm">
              <span className="text-ink-muted">Note for the record (optional)</span>
              <Textarea className="mt-1" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tied out to the time report; Maria’s raise is expected." />
            </label>
            <Button type="submit" loading={sign.isPending} disabled={!confirmed || sign.isPending}>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Sign off on these numbers
            </Button>
          </form>
        )}
        {history.length > 0 && (
          <div>
            <h3 className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">History</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {history.map((h, i) => (
                <li key={h.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-ink">{h.signedByName ?? 'A reviewer'}</span>
                  <span className="text-ink-muted">{fmtDateTime(h.signedAt)}</span>
                  {i === 0 && signoff.stale && <Badge size="sm" withDot={false} variant="destructive">Numbers changed since</Badge>}
                  {i === 0 && signoff.current && <Badge size="sm" withDot={false} variant="success">Current</Badge>}
                  {h.note && <span className="w-full text-ink-muted">“{h.note}”</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-2xs text-ink-muted">Version {report.fingerprint.slice(0, 12)} · prepared {fmtDateTime(report.generatedAt)}</p>
      </CardContent>
    </Card>
  );
}
