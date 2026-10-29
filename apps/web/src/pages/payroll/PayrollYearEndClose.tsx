import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Circle } from '@/components/ui/icons';
import { getYearEndClose, type YearEndCloseResponse } from '@/lib/payrollApi';
import { fmtCount } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/Card';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * Whether a tax year had no payroll at all. The API says so (`noPayroll`);
 * an answer without it is read from the checklist: no run left open, and no
 * one owed a W-2, a 1099-NEC or a 1099-MISC.
 */
export function yearHasNoPayroll(data: YearEndCloseResponse): boolean {
  if (typeof data.noPayroll === 'boolean') return data.noPayroll;
  const byKey = new Map(data.checks.map((c) => [c.key, c]));
  const none = (key: string, prefix: string) => {
    const c = byKey.get(key);
    return !!c && c.done && c.detail.startsWith(prefix);
  };
  return (
    byKey.get('runs_disbursed')?.done === true &&
    none('w2_generated', 'No one was paid wages') &&
    none('nec_generated', 'No contractor was paid') &&
    none('misc_generated', 'No one was paid')
  );
}

/**
 * The Year-end page's Checklist tab: is the tax year wrapped up — every run
 * paid, every W-2 and 1099 made, filed and sent? Each open step links to
 * where it's fixed. (It was its own page, /payroll/year-end-close; one of
 * four homes for year-end — F500 G3.)
 */
export function YearEndChecklist({ year }: { year: number }) {
  const q = useQuery({
    queryKey: ['PayrollYearEndClose', 'data', year],
    queryFn: () => getYearEndClose(year),
  });
  const data: YearEndCloseResponse | null = q.data ?? null;

  if (q.isError) return <QueryError what="the year-end checklist" query={q} />;
  if (!data) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }
  const open = data.checks.filter((c) => !c.done).length;
  // A year with no payroll has nothing to close: say so, not "ready to close" over six green ticks (MONEY-27).
  if (yearHasNoPayroll(data)) {
    return (
      <div role="status" className="flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-4 py-3 text-sm text-ink-muted" data-testid="year-end-empty">
        <Circle className="h-5 w-5 shrink-0" aria-hidden="true" />
        {`No payroll in ${year} — nothing to close.`}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div
        role="status"
        className={cn(
          'flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium',
          data.readyToClose ? 'border-success/40 bg-success/10 text-success' : 'border-warning/40 bg-warning/10 text-warning',
        )}
      >
        {data.readyToClose ? <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" /> : <Circle className="h-5 w-5 shrink-0" aria-hidden="true" />}
        {data.readyToClose ? `${year} is ready to close.` : `${fmtCount(open, 'step')} still open before ${year} can close.`}
      </div>
      <ul className="space-y-2" aria-label={`Year-end steps for ${year}`}>
        {data.checks.map((c) => (
          <li key={c.key}>
            <Card className={c.done ? 'border-success/30 bg-success/[0.04]' : undefined}>
              <CardContent className="flex items-start gap-3 py-3 text-sm">
                {c.done ? (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
                ) : (
                  <Circle className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <div className={cn('font-medium', c.done ? 'text-success' : 'text-ink')}>{c.label}</div>
                  <div className="mt-0.5 text-xs text-ink-muted">{c.detail}</div>
                </div>
                {!c.done && (
                  <Link to={c.href} className="inline-flex shrink-0 items-center gap-1 text-xs text-accent hover:underline">
                    Resolve <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
