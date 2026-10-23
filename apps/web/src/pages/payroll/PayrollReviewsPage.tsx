import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ShieldAlert, ShieldCheck } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { getReviewQueue } from '@/lib/payrollReviewApi';
import { listPayrollRuns } from '@/lib/payrollApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Payroll waiting on a sign-off: every run whose review report no one has
 * signed (or whose numbers changed after the sign-off) that this person may
 * sign, oldest pay period first, and the latest sign-offs for the record.
 */

const KIND_LABEL: Record<string, string> = { REGULAR: 'Regular', OFF_CYCLE: 'Off-cycle', AMENDMENT: 'Amendment' };

export function PayrollReviewsPage() {
  const q = useQuery({ queryKey: ['payroll', 'reviews'], queryFn: getReviewQueue });
  // For the record: paid runs with no sign-off on them (paid before the review existed, or with it not required).
  const paid = useQuery({ queryKey: ['payroll', 'runs', 'DISBURSED'], queryFn: () => listPayrollRuns({ status: 'DISBURSED' }) });
  const unsigned = (paid.data?.runs ?? []).filter((r) => !r.reviewSignedAt).slice(0, 10);
  // One run waiting: open it — the list would be a click with nothing to
  // choose. ?all=1 keeps the list (and Back never bounces: it's a replace).
  const [params] = useSearchParams();
  // Only on data fetched for this visit: a cached list from before a
  // sign-off would send the person to a run that no longer waits on them.
  const fresh = q.isFetchedAfterMount && !q.isFetching;
  const only = fresh && q.data?.waiting.length === 1 ? q.data.waiting[0] : null;
  if (only && params.get('all') !== '1') return <Navigate to={`/payroll/runs/${only.id}/review`} replace />;
  if (!fresh && params.get('all') !== '1' && q.data?.waiting.length === 1) return <Skeleton className="h-64" />;
  return (
    <ListTemplate
      title="Payroll to review"
      subtitle="Runs that can’t pay out until someone reads the review report and signs off."
    >
      {q.isError ? (
        <EmptyState
          title="We couldn’t load the runs to review"
          description={q.error instanceof ApiError ? q.error.message : undefined}
          action={
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        />
      ) : !q.data ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Waiting on you{q.data.waiting.length > 0 && <span className="ml-1.5 text-ink-muted">({q.data.waiting.length})</span>}</CardTitle>
              <CardDescription>Oldest pay period first. A run you created goes to someone else, unless no one else processes payroll.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {q.data.waiting.length === 0 ? (
                <div className="px-5 pb-5">
                  <EmptyState size="sm" icon={ShieldCheck} title="Nothing to sign" description="Every run is signed off, or waiting on someone else." />
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {q.data.waiting.map((r) => (
                    <li key={r.id}>
                      <Link
                        to={`/payroll/runs/${r.id}/review`}
                        className="flex min-h-14 items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
                      >
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
                            <span className="tabular-nums">
                              {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}
                            </span>
                            {r.kind !== 'REGULAR' && (
                              <Badge size="sm" withDot={false} variant="outline">
                                {KIND_LABEL[r.kind] ?? r.kind}
                              </Badge>
                            )}
                            {r.changedSinceSignoff && (
                              <Badge size="sm" withDot={false} variant="destructive">
                                Changed since sign-off
                              </Badge>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs tabular-nums text-ink-muted">
                            {r.clientName ?? 'All clients'} · {r.people} paychecks · net {fmtMoney(r.totalNet)}
                            {r.createdByName && ` · run by ${r.createdByName}`}
                          </span>
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1 text-sm text-accent">
                          Review
                          <ArrowRight className="h-4 w-4" aria-hidden="true" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          {q.data.recent.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent sign-offs</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y divide-line">
                  {q.data.recent.map((s) => (
                    <li key={s.id}>
                      <Link to={`/payroll/runs/${s.runId}/review`} className="flex min-h-12 items-center justify-between gap-3 px-5 py-3 text-sm transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none">
                        <span className="min-w-0">
                          <span className="block tabular-nums text-ink">
                            {fmtDate(s.periodStart)} – {fmtDate(s.periodEnd)} · {s.clientName ?? 'All clients'}
                          </span>
                          <span className="block truncate text-xs text-ink-muted">
                            {s.signedByName ?? 'A reviewer'} · {fmtDateTime(s.signedAt)}
                            {s.soleReviewer && ' · only payroll person'}
                          </span>
                        </span>
                        <ShieldCheck className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {unsigned.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Paid without a sign-off</CardTitle>
                <CardDescription>For the record: paid runs no one signed off on, paid before the review existed or when it wasn’t required.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y divide-line" aria-label="Paid without a sign-off">
                  {unsigned.map((r) => (
                    <li key={r.id}>
                      <Link to={`/payroll/runs/${r.id}/review`} className="flex min-h-12 items-center justify-between gap-3 px-5 py-3 text-sm transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none">
                        <span className="min-w-0">
                          <span className="block tabular-nums text-ink">
                            {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)} · {r.clientName ?? 'All clients'}
                          </span>
                          <span className="block text-xs tabular-nums text-ink-muted">
                            {r.disbursedAt ? `Paid ${fmtDate(r.disbursedAt)}` : 'Paid'} · net {fmtMoney(r.totalNet)}
                          </span>
                        </span>
                        <ShieldAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </ListTemplate>
  );
}
