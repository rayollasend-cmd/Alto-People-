import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PayrollRunSummary } from '@alto-people/shared';
import { listPayrollRuns } from '@/lib/payrollApi';
import { fmtDateTz, fmtMoney, fmtMoneyCompact, parseYmd } from '@/lib/format';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { StackedBarChart } from '@/components/ui/charts';

/**
 * What each paid run cost, split the way the money went: take-home pay,
 * taxes withheld, other deductions, and the employer's own taxes on top.
 * The column's height is the run's whole cost; a click opens the run.
 */

const MAX_RUNS = 12;

const shortDay = (ymd: string) => fmtDateTz(parseYmd(ymd) ?? ymd);

export function costRows(runs: PayrollRunSummary[]) {
  return [...runs]
    .filter((r) => r.status === 'DISBURSED')
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
    .slice(-MAX_RUNS)
    .map((r) => {
      const deductions = Math.max(0, r.totalGross - r.totalTax - r.totalNet);
      return {
        id: r.id,
        run: shortDay(r.periodEnd),
        period: `${shortDay(r.periodStart)} – ${shortDay(r.periodEnd)}`,
        net: r.totalNet,
        tax: r.totalTax,
        deductions,
        employerTax: r.totalEmployerTax,
        cost: r.totalGross + r.totalEmployerTax,
      };
    });
}

export function PayrollCostChart({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['payroll', 'runs', 'DISBURSED'],
    queryFn: () => listPayrollRuns({ status: 'DISBURSED' }),
    staleTime: 60_000,
  });
  const rows = useMemo(() => costRows(q.data?.runs ?? []), [q.data]);
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1]!;
  const prev = rows[rows.length - 2]!;
  const change = prev.cost > 0 ? (last.cost - prev.cost) / prev.cost : 0;
  return (
    <div className="mb-4">
      <ChartFrame
        title="Cost by run"
        description={`The last ${rows.length} paid runs. Each column is the whole cost: pay, what was withheld, and employer taxes.`}
        summary={`The latest run, ${last.period}, cost ${fmtMoney(last.cost)} — ${change >= 0 ? 'up' : 'down'} ${Math.abs(change * 100).toFixed(0)}% on the run before. ${fmtMoney(last.net)} of it was take-home pay.`}
        columns={[
          { key: 'period', label: 'Period' },
          { key: 'net', label: 'Take-home pay', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'tax', label: 'Taxes withheld', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'deductions', label: 'Other deductions', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'employerTax', label: 'Employer taxes', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'cost', label: 'Total cost', numeric: true, format: (v) => fmtMoney(v as number) },
        ]}
        rows={rows}
        csvName="payroll-cost-by-run"
        height={240}
      >
        <StackedBarChart
          data={rows}
          x="run"
          series={[
            { key: 'net', name: 'Take-home pay' },
            { key: 'tax', name: 'Taxes withheld' },
            { key: 'deductions', name: 'Other deductions' },
            { key: 'employerTax', name: 'Employer taxes' },
          ]}
          format={fmtMoneyCompact}
          yLabel="Dollars"
          heading={(x) => `Period ending ${x}`}
          onBarClick={(row) => onOpenRun(String(row.id))}
        />
      </ChartFrame>
    </div>
  );
}
