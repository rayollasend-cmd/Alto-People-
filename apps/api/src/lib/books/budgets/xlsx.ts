import type { BudgetVsActual } from '@alto-people/shared';
import { tableSheet, toBuffer, workbook, type XlColumn } from '../../docKit/xlsx.js';

/** Budget vs actual as a workbook in the house style: year to date, then month by month. */
export async function renderBudgetVsActualXlsx(report: BudgetVsActual, o: { company: string; budgetName: string }): Promise<Buffer> {
  const wb = workbook({ company: o.company });
  const rows = report.sections.flatMap((s) => s.rows.map((r) => ({ ...r, sectionLabel: s.label })));
  type R = (typeof rows)[number];
  const ytd: XlColumn<R>[] = [
    { header: 'Section', key: 'sectionLabel', width: 20 },
    { header: 'Account', key: 'account', width: 34, value: (r) => `${r.code} ${r.name}` },
    { header: 'Budget YTD', key: 'by', type: 'money', total: true, value: (r) => r.ytd.budget },
    { header: 'Actual YTD', key: 'ay', type: 'money', total: true, value: (r) => r.ytd.actual },
    { header: 'Variance', key: 'v', type: 'money', total: true, value: (r) => r.ytd.variance },
    { header: 'Variance %', key: 'vp', type: 'percent', value: (r) => (r.ytd.variancePct === null ? null : r.ytd.variancePct / 100) },
    { header: 'Annual budget', key: 'ab', type: 'money', total: true, value: (r) => r.annualBudget },
    { header: 'Forecast', key: 'f', type: 'money', total: true, value: (r) => r.forecast },
    { header: 'Run rate', key: 'rr', type: 'money', total: true, value: (r) => r.runRate },
  ];
  tableSheet(wb, {
    name: 'Year to date',
    title: `${o.budgetName} — budget vs actual`,
    subtitle: `Fiscal ${report.fiscalYear}, through ${report.through} (${report.monthsElapsed} of 12 months)`,
    note: 'Income rows: a positive variance is favorable. Cost and expense rows: a negative variance is favorable.',
    columns: ytd,
    rows,
  });
  const monthly: XlColumn<R>[] = [
    { header: 'Account', key: 'account', width: 34, value: (r) => `${r.code} ${r.name}` },
    ...report.periods.flatMap((p, i) => [
      { header: `${p} budget`, key: `b${i}`, type: 'money' as const, total: true, value: (r: R) => r.months[i]!.budget },
      { header: `${p} actual`, key: `a${i}`, type: 'money' as const, total: true, value: (r: R) => (p <= report.through ? r.months[i]!.actual : null) },
    ]),
  ];
  tableSheet(wb, { name: 'By month', title: `${o.budgetName} — by month`, subtitle: `Fiscal ${report.fiscalYear}`, columns: monthly, rows });
  return toBuffer(wb);
}
