import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtDate, fmtPercent } from '@/lib/format';
import { getPayChecks, resolvePayCheckFlags, type PayChecksSummary } from '@/lib/payExpApi';
import { listPayrollRuns } from '@/lib/payrollApi';
import { RunPageShell, type RunSubPageProps } from './RunPageShell';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { RunStatusBadge } from '@/lib/payrollRunStatus';

/**
 * Paycheck confirmations — "Check my pay before payday", payroll's side: for
 * one run, how many people confirmed their check, who flagged a line and
 * why, and the link to the case or punch fix behind each flag. Open flags
 * block the guided close until they're handled here.
 *
 * Named "Paycheck confirmations" (F500 G3): "Pay checks", "Paper checks"
 * and "Manual checks" were three meanings of "checks". It is also the run
 * record's Confirmations tab (embedded, the run comes from the record).
 */

type Row = PayChecksSummary['open'][number];

export function PayChecksPage({ runId: fixedRunId, embedded = false }: RunSubPageProps = {}) {
  const term = useTerm();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const runId = fixedRunId ?? params.get('run');
  const q = useQuery({ queryKey: ['payroll', 'pay-checks', runId], queryFn: () => getPayChecks(runId!), enabled: !!runId });
  // Opened without a run: the run still open (draft or finalized) is the one to check — open it.
  const openRuns = useQuery({ queryKey: ['payroll', 'runs', 'OPEN'], queryFn: () => listPayrollRuns({ status: 'OPEN' }), enabled: !runId });
  const openRun = (openRuns.data?.runs ?? []).find((r) => r.status === 'DRAFT' || r.status === 'FINALIZED') ?? null;
  useEffect(() => {
    if (runId || !openRun) return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('run', openRun.id);
      return next;
    }, { replace: true });
  }, [runId, openRun, setParams]);
  const resolve = useMutation({
    mutationFn: (associateId: string) => resolvePayCheckFlags(runId!, associateId),
    onSuccess: () => {
      toast.success('Marked handled.');
      void qc.invalidateQueries({ queryKey: ['payroll', 'pay-checks', runId] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not mark it handled.'),
  });
  const d = q.data;
  const columns: GridColumn<Row>[] = [
    { key: 'person', header: term('worker'), accessor: (r) => r.name, primary: true },
    {
      key: 'flags',
      header: 'What they flagged',
      accessor: (r) => r.flags.map((f) => f.note).join(' · '),
      cell: (r) => (
        <ul className="space-y-1">
          {r.flags.map((f, i) => (
            <li key={i} className="text-sm">
              <Badge variant="pending">{f.kind === 'HOURS' ? 'Hours' : f.kind === 'RATE' ? 'Rate' : f.kind === 'TAX' ? 'Tax' : f.kind === 'DEDUCTION' ? 'Deduction' : 'Other'}</Badge>{' '}
              <span className="text-ink">{f.note}</span>{' '}
              {f.caseId && (
                <Link className="text-gold underline underline-offset-2" to={`/hr-cases?case=${f.caseId}`}>
                  Case
                </Link>
              )}
              {f.correctionId && (
                <Link className="text-gold underline underline-offset-2" to="/time-attendance?tab=corrections">
                  Punch fix
                </Link>
              )}
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      stopRowClick: true,
      cell: (r) => (
        <Button size="sm" variant="secondary" disabled={resolve.isPending} onClick={() => resolve.mutate(r.associateId)} aria-label={`Mark ${r.name}'s flags handled`}>
          Mark handled
        </Button>
      ),
    },
  ];
  return (
    <RunPageShell
      embedded={embedded}
      title="Paycheck confirmations"
      subtitle={d ? `Pay period ${fmtDate(d.run.periodStart)} – ${fmtDate(d.run.periodEnd)}: who confirmed their paycheck before payday, and what they flagged.` : 'Who confirmed their paycheck before payday, and what they flagged.'}
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, ...(runId ? [{ label: 'Run', to: `/payroll/runs/${runId}` }] : []), { label: 'Paycheck confirmations' }]}
      summary={
        d ? (
          <MetricStrip label="Paycheck confirmations">
            {/* No one to confirm is "nothing", never a fake 0%. */}
            <MetricCard
              label="Confirmed"
              value={d.people === 0 ? '—' : fmtPercent(d.confirmationRate, { fromFraction: true })}
              nothing={d.people === 0 ? 'No one to confirm yet' : undefined}
              hint={d.people > 0 ? `${d.confirmed} of ${d.people}` : undefined}
            />
            <MetricCard label="Open flags" value={String(d.openFlags)} hint={d.openFlags ? 'Blocking the close' : 'Nothing blocking'} tone={d.openFlags > 0 ? 'alert' : 'default'} />
            <MetricCard label="Flagged" value={String(d.flagged)} hint="people who flagged a line" />
            <MetricCard label="No answer" value={String(d.unanswered)} hint="haven’t looked yet" />
          </MetricStrip>
        ) : runId ? (
          <Skeleton className="h-24" />
        ) : null
      }
    >
      {!runId ? (
        openRuns.isLoading || openRun ? <Skeleton className="h-64" /> : <RunPicker />
      ) : (
        <DataGrid
          id="pay-check-flags"
          caption="Open flags"
          rows={d?.open}
          columns={columns}
          rowKey={(r) => r.associateId}
          loading={q.isLoading}
          error={q.isError ? (q.error instanceof ApiError ? q.error.message : 'Could not load the confirmations.') : null}
          onRetry={() => void q.refetch()}
          noun={{ one: 'person with open flags', many: 'people with open flags' }}
          empty={{ title: 'No open flags', description: 'Nobody has flagged a line on their paycheck, or every flag is handled.' }}
        />
      )}
    </RunPageShell>
  );
}


/** Opened without a run: the recent runs to choose from, newest first. */
function RunPicker() {
  const runs = useQuery({ queryKey: ['payroll', 'runs', 'pay-checks-picker'], queryFn: () => listPayrollRuns() });
  const recent = (runs.data?.runs ?? []).filter((r) => r.status !== 'CANCELLED').slice(0, 8);
  if (runs.isLoading) return <Skeleton className="h-64" />;
  if (!recent.length) {
    return <EmptyState title="No payroll runs yet" description="Paycheck confirmations open once a run is drafted." action={<Button asChild variant="secondary"><Link to="/payroll">Go to payroll</Link></Button>} />;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a run</CardTitle>
        <CardDescription>No run is open right now. Pick a past run to see who confirmed their paycheck and what they flagged.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-line">
          {recent.map((r) => (
            <li key={r.id}>
              <Link
                to={`/payroll/pay-checks?run=${r.id}`}
                className="flex min-h-12 items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink tabular-nums">
                    {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}
                  </span>
                  <span className="block truncate text-xs text-ink-muted">{r.clientName ?? 'All clients'} · {r.itemCount} paychecks</span>
                </span>
                <RunStatusBadge status={r.status} />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
