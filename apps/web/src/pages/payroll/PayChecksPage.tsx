import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { getPayChecks, resolvePayCheckFlags, type PayChecksSummary } from '@/lib/payExpApi';
import { listPayrollRuns } from '@/lib/payrollApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * "Check my pay before payday", payroll's side: for one run, how many
 * people confirmed their check, who flagged a line and why, and the link to
 * the case or punch fix behind each flag. Open flags block the guided close
 * until they're handled here.
 */

type Row = PayChecksSummary['open'][number];

export function PayChecksPage() {
  const term = useTerm();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const runId = params.get('run');
  const q = useQuery({ queryKey: ['payroll', 'pay-checks', runId], queryFn: () => getPayChecks(runId!), enabled: !!runId });
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
      cell: (r) => (
        <Button size="sm" variant="secondary" disabled={resolve.isPending} onClick={() => resolve.mutate(r.associateId)} aria-label={`Mark ${r.name}'s flags handled`}>
          Mark handled
        </Button>
      ),
    },
  ];
  return (
    <ListTemplate
      title="Pay checks before payday"
      subtitle={d ? `Pay period ${fmtDate(d.run.periodStart)} – ${fmtDate(d.run.periodEnd)}: who confirmed their check and what was flagged.` : 'Who confirmed their check and what was flagged.'}
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, ...(runId ? [{ label: 'Guided close', to: `/payroll/runs/${runId}/close` }] : []), { label: 'Pay checks before payday' }]}
      summary={
        d ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Confirmed" value={`${Math.round(d.confirmationRate * 100)}%`} hint={`${d.confirmed} of ${d.people}`} />
            <Stat label="Open flags" value={String(d.openFlags)} hint={d.openFlags ? 'Blocking the close' : 'Nothing blocking'} />
            <Stat label="Flagged" value={String(d.flagged)} hint="people who flagged a line" />
            <Stat label="No answer" value={String(d.unanswered)} hint="haven’t looked yet" />
          </div>
        ) : runId ? (
          <Skeleton className="h-24" />
        ) : null
      }
    >
      {!runId ? (
        <RunPicker />
      ) : (
        <DataGrid
          id="pay-check-flags"
          caption="Open flags"
          rows={d?.open}
          columns={columns}
          rowKey={(r) => r.associateId}
          loading={q.isLoading}
          error={q.isError ? (q.error instanceof ApiError ? q.error.message : 'Could not load pay checks.') : null}
          onRetry={() => void q.refetch()}
          noun={{ one: 'person with open flags', many: 'people with open flags' }}
        />
      )}
    </ListTemplate>
  );
}

const RUN_STATUS: Record<string, string> = { DRAFT: 'Draft', FINALIZED: 'Finalized', DISBURSED: 'Paid', CANCELLED: 'Cancelled' };

/** Opened without a run: the recent runs to choose from, newest first. */
function RunPicker() {
  const runs = useQuery({ queryKey: ['payroll', 'runs', 'pay-checks-picker'], queryFn: () => listPayrollRuns() });
  const recent = (runs.data?.runs ?? []).filter((r) => r.status !== 'CANCELLED').slice(0, 8);
  if (runs.isLoading) return <Skeleton className="h-64" />;
  if (!recent.length) {
    return <EmptyState title="No payroll runs yet" description="Pay checks open for review once a run is drafted." action={<Button asChild variant="secondary"><Link to="/payroll">Go to payroll</Link></Button>} />;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a run</CardTitle>
        <CardDescription>See who confirmed their check and what they flagged.</CardDescription>
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
                <Badge variant={r.status === 'DRAFT' ? 'default' : r.status === 'FINALIZED' ? 'pending' : 'success'}>{RUN_STATUS[r.status] ?? r.status}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent>
        <div className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">{label}</div>
        <div className="mt-2 font-display text-2xl leading-none tabular-nums text-ink">{value}</div>
        <div className="mt-1.5 truncate text-xs text-ink-muted">{hint}</div>
      </CardContent>
    </Card>
  );
}
