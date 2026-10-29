import type { ExecFinancials, ExecWaterfallStep } from '@alto-people/shared';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { Waterfall } from '@/components/ui/charts';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import { useMinWidth } from '@/lib/useViewport';
import '@/lib/i18n/en/execPortal';
import { pct1 } from './finMath';

/** "−$120,000.00" — the exact figure with a real minus sign, for the table. */
export function signedExact(v: number): string {
  return `${v < 0 ? '−' : ''}${fmtExecExact(Math.abs(v), 'money')}`;
}

/**
 * Where the money goes: the period's billing, less base pay, the overtime
 * premium, the employer's burden and overhead, down to the margin left —
 * every step labelled on its bar, the exact amounts behind Table.
 */
export function MarginWaterfall({ d }: { d: ExecFinancials }) {
  const { t } = useI18n();
  // A phone has room under each bar for a word, not "Overtime premium": the
  // short names there, the full ones in the table.
  const wide = useMinWidth(640);
  const name = (s: ExecWaterfallStep) => (wide ? s.label : t(`execPortal.fin.wf.short.${s.key}`));
  const billed = d.waterfall.find((s) => s.key === 'billed');
  const margin = d.waterfall.find((s) => s.key === 'margin');
  const costs = d.waterfall.filter((s) => s.key !== 'billed' && s.key !== 'margin');
  const b = billed?.amount ?? 0;
  const costTotal = costs.reduce((s, c) => s + c.amount, 0);
  const biggest = [...costs].sort((x, y) => y.amount - x.amount)[0];
  const rows = d.waterfall.map((s) => {
    const signed = s.key === 'billed' || s.key === 'margin' ? s.amount : -s.amount;
    return { step: s.label, amount: signed, share: b > 0 ? (s.amount / b) * 100 : null };
  });
  const summary =
    b > 0 && margin
      ? [
          t('execPortal.fin.wf.summary', { billed: fmtExecMoney(b), cost: fmtExecMoney(costTotal), margin: fmtExecMoney(margin.amount), pct: pct1((margin.amount / b) * 100) }),
          biggest && biggest.amount > 0 ? t('execPortal.fin.wf.biggest', { label: biggest.label, amount: fmtExecMoney(biggest.amount), pct: pct1((biggest.amount / b) * 100) }) : '',
        ]
          .filter(Boolean)
          .join(' ')
      : t('execPortal.fin.wf.empty');
  return (
    <ChartFrame
      title={t('execPortal.fin.wf.title')}
      description={b > 0 ? summary : t('execPortal.fin.wf.desc')}
      summary={summary}
      columns={[
        { key: 'step', label: t('execPortal.fin.wf.colStep') },
        { key: 'amount', label: t('execPortal.fin.wf.colAmount'), numeric: true, format: (v) => (typeof v === 'number' ? signedExact(v) : '—') },
        { key: 'share', label: t('execPortal.fin.wf.colShare'), numeric: true, format: (v) => (typeof v === 'number' ? pct1(v) : '—') },
      ]}
      rows={b > 0 ? rows : []}
      csvName="where-the-money-goes"
      height={340}
      empty={<p className="py-6 text-sm text-ink-muted">{t('execPortal.fin.wf.empty')}</p>}
    >
      {billed && (
        <Waterfall
          start={{ label: name(billed), value: billed.amount }}
          steps={costs.filter((s) => s.amount !== 0).map((s) => ({ label: name(s), value: -s.amount }))}
          end={{ label: margin ? name(margin) : t('execPortal.fin.weeks.margin') }}
          format={fmtExecMoney}
          words={{ total: t('execPortal.fin.wf.total'), down: t('execPortal.fin.wf.cost') }}
        />
      )}
    </ChartFrame>
  );
}
