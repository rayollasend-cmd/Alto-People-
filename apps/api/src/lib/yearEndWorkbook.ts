import { tableSheet, toBuffer, workbook } from './docKit/xlsx.js';
import type { PersonVariance, ReconRow, YearEndReconciliation } from './yearEndReconciliation.js';

/**
 * The year-end reconciliation as a workbook in the house style: one sheet
 * per section (every source side by side, the variance, OK or not), the
 * pre-filing checklist, and the people behind the wage variance.
 */
export async function yearEndWorkbook(recon: YearEndReconciliation, people: PersonVariance[], company: string): Promise<Buffer> {
  const wb = workbook({ company });
  const made = new Date(recon.generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' });
  const subtitle = `${company} · tax year ${recon.year} · prepared ${made} · ${recon.summary.variances} variance${recon.summary.variances === 1 ? '' : 's'}, ${recon.summary.blocking} blocking`;

  for (const section of recon.sections) {
    tableSheet<ReconRow>(wb, {
      name: section.title.split(':')[0]!.slice(0, 31),
      title: section.title,
      subtitle,
      note: recon.generatedQuarters.length ? `Generated now from paychecks (none on file): ${recon.generatedQuarters.join(', ')}.` : undefined,
      columns: [
        { header: 'Figure', key: 'label', width: 52, value: (r) => r.label },
        ...section.sources.map((s) => ({ header: s.label, key: s.key, type: 'money' as const, width: 18, value: (r: ReconRow) => r.values[s.key] ?? null })),
        { header: 'Variance', key: 'variance', type: 'money', width: 14, value: (r) => r.variance },
        { header: 'Status', key: 'status', width: 12, value: (r) => (r.ok ? 'Agrees' : 'Check') },
        { header: 'Note', key: 'note', width: 40, value: (r) => r.note ?? '' },
      ],
      rows: section.rows,
    });
  }

  tableSheet(wb, {
    name: 'Checklist',
    title: 'Pre-filing checklist',
    subtitle,
    columns: [
      { header: 'Severity', key: 'severity', width: 12, value: (c) => (c.severity === 'BLOCKING' ? 'Blocking' : c.severity === 'WARNING' ? 'Warning' : 'Info') },
      { header: 'What', key: 'message', width: 80 },
      { header: 'People', key: 'count', type: 'number', width: 10 },
      { header: 'Who', key: 'who', width: 60, value: (c) => (c.people ?? []).map((p) => p.name).join(', ') },
    ],
    rows: recon.checklist,
  });

  tableSheet<PersonVariance>(wb, {
    name: 'People · box 1',
    title: 'Wages by person: paychecks vs W-2 box 1',
    subtitle,
    columns: [
      { header: 'Person', key: 'name', width: 30 },
      { header: 'Paychecks', key: 'paychecks', type: 'money', total: true },
      { header: 'W-2 box 1', key: 'w2', type: 'money', total: true },
      { header: 'Difference', key: 'difference', type: 'money', total: true },
      { header: 'W-2', key: 'w2Source', width: 12, value: (p) => (p.w2Source === 'stored' ? 'On file' : p.w2Source === 'computed' ? 'Not generated' : 'None') },
      { header: 'Checks', key: 'checks', type: 'number', value: (p) => p.checks.length },
    ],
    rows: people,
  });

  return toBuffer(wb);
}
