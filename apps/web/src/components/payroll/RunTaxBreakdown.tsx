import { useQuery } from '@tanstack/react-query';
import { fmtMoney, fmtMoneyCompact } from '@/lib/format';
import { StackedBarChart } from '@/components/ui/charts';
import { getRunTaxLines } from '@/lib/taxJurisdictionsApi';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * A payroll run's state and local taxes by jurisdiction (lib/taxEngine) —
 * what each state, city, county and school district is owed from this run.
 * Renders nothing for a run with no jurisdiction lines (a run from before
 * the engine, or one with only federal tax).
 */
export function RunTaxBreakdown({ runId }: { runId: string }) {
  const q = useQuery({ queryKey: ['payroll', 'run', runId, 'tax-lines'], queryFn: () => getRunTaxLines(runId) });
  if (q.isLoading) return <Skeleton className="mb-5 h-24" />;
  if (q.isError || !q.data || q.data.jurisdictions.length === 0) return null;
  const { jurisdictions, totals } = q.data;
  return (
    <section aria-labelledby={`run-tax-${runId}`} className="mb-5 rounded-md border border-line p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`run-tax-${runId}`} className="text-sm font-medium text-ink">
          State and local taxes
        </h3>
        <span className="text-xs text-ink-muted">
          State {fmtMoney(totals.state)} · Local {fmtMoney(totals.local)}
          {totals.employer > 0 ? ` · Employer-paid ${fmtMoney(totals.employer)}` : ''}
        </span>
      </div>
      {jurisdictions.length > 1 && (
        <div role="img" aria-label={`Tax by jurisdiction: ${[...jurisdictions].sort((a, b) => b.amount - a.amount).map((j) => `${j.name} ${fmtMoney(j.amount)}`).join(', ')}.`} className="mb-3">
          <StackedBarChart
            data={[...jurisdictions].sort((a, b) => b.amount - a.amount).map((j) => ({ name: j.employer ? `${j.name} (employer)` : j.name, amount: j.amount }))}
            x="name"
            layout="horizontal"
            series={[{ key: 'amount', name: 'Tax' }]}
            format={fmtMoneyCompact}
          />
        </div>
      )}
      <table className="w-full text-sm">
        <caption className="sr-only">Taxes withheld in this run, by jurisdiction</caption>
        <thead>
          <tr className="text-left text-xs text-ink-muted">
            <th scope="col" className="py-1 font-normal">
              Jurisdiction
            </th>
            <th scope="col" className="hidden py-1 text-right font-normal sm:table-cell">
              People
            </th>
            <th scope="col" className="hidden py-1 text-right font-normal sm:table-cell">
              Wages
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              Tax
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {jurisdictions.map((j) => (
            <tr key={j.code}>
              <td className="py-1.5 pr-2 text-ink">
                {j.name}
                {j.employer && <span className="ml-1.5 text-xs text-ink-muted">employer-paid</span>}
              </td>
              <td className="hidden py-1.5 text-right tabular-nums text-ink-muted sm:table-cell">{j.people}</td>
              <td className="hidden py-1.5 text-right tabular-nums text-ink-muted sm:table-cell">{fmtMoney(j.wages)}</td>
              <td className="py-1.5 text-right tabular-nums text-ink">{fmtMoney(j.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
