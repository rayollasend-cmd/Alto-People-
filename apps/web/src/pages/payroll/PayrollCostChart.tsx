import { useMemo } from 'react';
import { fmtMoneyAxis } from '@/components/ui/charts/axes';
import { useQuery } from '@tanstack/react-query';
import type { PayrollRunSummary } from '@alto-people/shared';
import { listPayrollRuns } from '@/lib/payrollApi';
import { fmtDateTz, fmtMoney, parseYmd } from '@/lib/format';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { StackedBarChart } from '@/components/ui/charts';

/**
 * What each paid run cost, split the way the money went: take-home pay,
 * taxes withheld, other deductions, and the employer's own taxes on top.
 * The column's height is the run's whole cost; a click opens the run.
 */

const MAX_RUNS = 12;

const shortDay = (ymd: string) => fmtDateTz(parseYmd(ymd) ?? ymd);

/**
 * One column per pay period: the regular runs that paid it (one per pay
 * schedule or client) added together. Manual checks, off-cycle runs,
 * amendments and daily settlements stay out — a $300 manual check next to
 * a $90,000 payroll would read as a 99% drop.
 */
export function costRows(runs: PayrollRunSummary[]) {
  const byPeriod = new Map<string, { periodStart: string; periodEnd: string; ids: string[]; net: number; tax: number; deductions: number; employerTax: number }>();
  for (const r of runs) {
    if (r.status !== 'DISBURSED' || (r.kind ?? 'REGULAR') !== 'REGULAR') continue;
    const key = `${r.periodStart}|${r.periodEnd}`;
    const p = byPeriod.get(key) ?? { periodStart: r.periodStart, periodEnd: r.periodEnd, ids: [], net: 0, tax: 0, deductions: 0, employerTax: 0 };
    p.ids.push(r.id);
    p.net += r.totalNet;
    p.tax += r.totalTax;
    // Reimbursements ride on net pay: never a negative deduction.
    p.deductions += Math.max(0, r.totalGross - r.totalTax - r.totalNet);
    p.employerTax += r.totalEmployerTax;
    byPeriod.set(key, p);
  }
  return [...byPeriod.values()]
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.periodStart.localeCompare(b.periodStart))
    .slice(-MAX_RUNS)
    .map((p) => ({
      id: p.ids[0]!,
      runs: p.ids.length,
      run: shortDay(p.periodEnd),
      period: `${shortDay(p.periodStart)} – ${shortDay(p.periodEnd)}`,
      net: p.net,
      tax: p.tax,
      deductions: p.deductions,
      employerTax: p.employerTax,
      // What the stack adds up to — the cash the period took.
      cost: p.net + p.tax + p.deductions + p.employerTax,
    }));
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
        title="Cost by pay period"
        description={`The last ${rows.length} paid periods, regular payroll only (every schedule's run for the period together). Each column is the whole cost: pay, what was withheld, and employer taxes.`}
        summary={`The latest period, ${last.period}, cost ${fmtMoney(last.cost)} — ${change >= 0 ? 'up' : 'down'} ${Math.abs(change * 100).toFixed(0)}% on the period before. ${fmtMoney(last.net)} of it was take-home pay.`}
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
          format={fmtMoneyAxis}
          yLabel="Dollars"
          heading={(x) => `Period ending ${x}`}
          onBarClick={(row) => (Number(row.runs) === 1 ? onOpenRun(String(row.id)) : undefined)}
        />
      </ChartFrame>
    </div>
  );
}
