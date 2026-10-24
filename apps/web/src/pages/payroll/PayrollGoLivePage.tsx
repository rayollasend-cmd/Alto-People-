import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, RefreshCw, XCircle } from '@/components/ui/icons';
import type { GoLiveCheck, GoLiveStatus, PayrollGoLive } from '@alto-people/shared';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { ProgressBar } from '@/components/ui/Progress';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Running payroll in-house: every company-level account and setting a
 * real payroll needs — the employer and its EIN, the federal and state tax
 * accounts, filing, how paychecks go out, schedules, controls, the books —
 * read from the site's own records, each with where to fix it.
 * GET /payroll/go-live (lib/payrollGoLive).
 */

export const getPayrollGoLive = () => apiFetch<PayrollGoLive>('/payroll/go-live');

const LOOK: Record<GoLiveStatus, { Icon: typeof CheckCircle2; tone: string; label: string; badge: 'success' | 'destructive' | 'pending' | 'outline' }> = {
  DONE: { Icon: CheckCircle2, tone: 'text-success', label: 'Set up', badge: 'success' },
  MISSING: { Icon: XCircle, tone: 'text-alert', label: 'Needed', badge: 'destructive' },
  WARNING: { Icon: AlertTriangle, tone: 'text-warning', label: 'Worth fixing', badge: 'pending' },
  INFO: { Icon: Info, tone: 'text-info', label: 'Good to know', badge: 'outline' },
};

export function PayrollGoLivePage() {
  const q = useQuery({ queryKey: ['payroll', 'go-live'], queryFn: getPayrollGoLive, staleTime: 30_000 });
  const [view, setView] = useState<'todo' | 'all'>('todo');
  const r = q.data;

  return (
    // "Payroll setup checklist" (F500 G3): "Run payroll in-house" read like a place to run payroll.
    <ListTemplate
      title="Payroll setup checklist"
      subtitle="Everything the company needs on file to pay people, withhold and deposit the right taxes, and file, checked against what’s here, with where to fix each one."
      actions={[{ key: 'recheck', label: 'Check again', icon: RefreshCw, onSelect: () => void q.refetch(), loading: q.isFetching && !q.isLoading }]}
      summary={r ? <Summary r={r} /> : null}
      filters={
        r ? (
          <SegmentedControl
            ariaLabel="Show"
            value={view}
            onChange={setView}
            options={[
              { value: 'todo', label: `What needs doing (${r.missing + r.warnings})` },
              { value: 'all', label: `Everything (${r.total})` },
            ]}
          />
        ) : null
      }
    >
      {q.isLoading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Checking the company’s payroll setup">
          <Skeleton className="h-28" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : q.isError || !r ? (
        <QueryError what="the payroll setup" query={q} />
      ) : (
        <div className="space-y-4">
          {r.sections.map((s) => {
            const checks = view === 'all' ? s.checks : s.checks.filter((c) => c.status === 'MISSING' || c.status === 'WARNING');
            if (checks.length === 0) return null;
            const left = s.checks.filter((c) => c.status === 'MISSING').length;
            return (
              <section key={s.key} aria-labelledby={`golive-${s.key}`}>
                <Card>
                  <CardContent className="p-0">
                    <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                      <h2 id={`golive-${s.key}`} className="text-base font-medium text-ink">
                        {s.title}
                      </h2>
                      {left > 0 ? (
                        <Badge variant="destructive" size="sm">
                          {left} needed
                        </Badge>
                      ) : s.checks.every((c) => c.status === 'DONE' || c.status === 'INFO') ? (
                        <Badge variant="success" size="sm">
                          Set up
                        </Badge>
                      ) : null}
                    </header>
                    <ul className="divide-y divide-line">
                      {checks.map((c) => (
                        <CheckRow key={c.key} check={c} />
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </section>
            );
          })}
          {view === 'todo' && r.missing + r.warnings === 0 && (
            <EmptyState icon={CheckCircle2} title="Nothing left to do" description="Everything a real payroll needs is on file. Show everything to see what was checked." />
          )}
        </div>
      )}
    </ListTemplate>
  );
}

function Summary({ r }: { r: PayrollGoLive }) {
  const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card className={cn(r.ready ? 'border-success/40' : 'border-alert/40')}>
        <CardContent className="space-y-2 pt-[var(--d-tile)]">
          <p className="text-2xs font-medium uppercase tracking-widest text-ink-muted">Ready to run payroll</p>
          <p className={cn('text-2xl font-semibold', r.ready ? 'text-success' : 'text-alert')}>{r.ready ? 'Yes' : `Not yet — ${r.missing} needed`}</p>
          <ProgressBar percent={pct} hideLabel label="Payroll setup" />
          <p className="text-xs text-ink-muted">
            {r.done} of {r.total} set up
          </p>
        </CardContent>
      </Card>
      <MetricCard label="Worth fixing" value={String(r.warnings)} hint="Won’t stop a run, but will cost you" />
      <MetricCard label="States" value={String(r.states.length)} hint={r.states.length ? r.states.join(', ') : 'Where people live and work'} />
    </div>
  );
}

function CheckRow({ check: c }: { check: GoLiveCheck }) {
  const look = LOOK[c.status];
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3 sm:flex-nowrap">
      <look.Icon className={cn('mt-0.5 h-5 w-5 shrink-0', look.tone)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
          {c.title}
          <Badge variant={look.badge} size="sm">
            {look.label}
          </Badge>
        </p>
        <p className="mt-0.5 text-sm text-ink-muted">{c.detail}</p>
      </div>
      {c.fix && c.status !== 'DONE' && (
        <Link to={c.fix.to} className="inline-flex shrink-0 items-center gap-1 self-center text-sm font-medium text-accent hover:underline">
          {c.fix.label}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      )}
    </li>
  );
}
