import type { ExecFinancials, ExecKpiId } from '@alto-people/shared';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { QueryError } from '@/components/ui/QueryError';
import { Waterfall } from '@/components/ui/charts';
import { execHref, useExecFinancials, type ExecFrame } from '@/lib/executiveApi';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { fmtDateOnly } from '@/lib/format';
import { useMinWidth } from '@/lib/useViewport';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { Figure, Figures, Preview, PreviewBody } from './PreviewParts';

/**
 * Financials, in one look (2026-10-27): where the period's billing went —
 * billed, less pay, the overtime premium, the employer's burden and
 * overhead, down to margin — then the three money facts a chairman asks
 * next: cash in the bank, the lowest it gets in the next thirteen weeks,
 * and how long clients take to pay.
 */
export function FinancialsPreview({ frame }: { frame: ExecFrame }) {
  const { t } = useI18n();
  const q = useExecFinancials(frame);
  const d = q.data;
  return (
    <Preview
      id="exec-home-financials"
      title={t('execPortal.home.fin.title')}
      answer={d ? financialsAnswer(d, t) : undefined}
      open={{ to: execHref('/executive/financials', frame), label: t('execPortal.home.fin.open') }}
      testId="exec-preview-financials"
    >
      {!d ? q.isError ? <QueryError what={t('execPortal.home.fin.what')} query={q} /> : <PreviewBody height={360} /> : <FinancialsBody d={d} />}
    </Preview>
  );
}

type T = ReturnType<typeof useI18n>['t'];

const kpiOf = (d: ExecFinancials, id: ExecKpiId) => d.kpis.find((k) => k.id === id) ?? null;

function financialsAnswer(d: ExecFinancials, t: T): string {
  const billed = d.waterfall.find((s) => s.key === 'billed')?.amount ?? kpiOf(d, 'revenue')?.value ?? null;
  const margin = d.waterfall.find((s) => s.key === 'margin')?.amount ?? kpiOf(d, 'grossMargin')?.value ?? null;
  if (!billed || margin === null) return t('execPortal.home.fin.answerNone');
  return t('execPortal.home.fin.answer', { billed: fmtExecMoney(billed), margin: fmtExecMoney(margin), pct: `${((margin / billed) * 100).toFixed(1)}%` });
}

function FinancialsBody({ d }: { d: ExecFinancials }) {
  const { t } = useI18n();
  // Six bars share a phone's width: the overtime premium's label shortens so the labels don't run together.
  const wide = useMinWidth(640);
  const billed = d.waterfall.find((s) => s.key === 'billed');
  const margin = d.waterfall.find((s) => s.key === 'margin');
  const costs = d.waterfall.filter((s) => s.key !== 'billed' && s.key !== 'margin');
  const rows = d.waterfall.map((s) => ({ step: s.label, amount: s.key === 'billed' || s.key === 'margin' ? s.amount : -s.amount }));
  const summary =
    billed && margin && billed.amount > 0
      ? t('execPortal.home.fin.chartSummary', { billed: fmtExecMoney(billed.amount), margin: fmtExecMoney(margin.amount), pct: `${((margin.amount / billed.amount) * 100).toFixed(1)}%` })
      : t('execPortal.home.fin.answerNone');
  const cashKpi = kpiOf(d, 'cash');
  const dsoKpi = kpiOf(d, 'dso');
  const cashToday = d.cash?.today ?? cashKpi?.value ?? null;
  const low = d.cash?.lowPoint ?? null;
  return (
    <div className="space-y-3">
      <ChartFrame
        title={t('execPortal.home.fin.chartTitle')}
        summary={summary}
        columns={[
          { key: 'step', label: t('execPortal.home.fin.colStep') },
          { key: 'amount', label: t('execPortal.home.fin.colAmount'), numeric: true, format: (v) => (typeof v === 'number' ? fmtExecMoney(v) : '—') },
        ]}
        rows={rows}
        csvName="billed-to-margin"
        height={190}
        empty={<p className="py-6 text-sm text-ink-muted">{t('execPortal.home.fin.chartEmpty')}</p>}
      >
        {billed && (
          <Waterfall
            start={{ label: t('execPortal.home.fin.step.billed'), value: billed.amount }}
            steps={costs.map((s) => ({ label: s.key === 'overtimePremium' && !wide ? t('execPortal.home.fin.stepShortOvertime') : t(`execPortal.home.fin.step.${s.key}`), value: -s.amount }))}
            end={{ label: t('execPortal.home.fin.step.margin') }}
            format={fmtExecMoney}
            words={{ total: t('execPortal.home.fin.wordTotal'), up: t('execPortal.home.fin.wordUp'), down: t('execPortal.home.fin.wordDown') }}
          />
        )}
      </ChartFrame>
      <Figures>
        <Figure
          label={t('execPortal.home.fin.cashToday')}
          value={fmtExecMoney(cashToday)}
          title={cashToday !== null ? fmtExecExact(cashToday, 'money') : undefined}
          sub={d.cash ? t('execPortal.home.fin.cashAccounts', { count: d.cash.accounts }) : t('execPortal.home.fin.cashNone')}
          testId="exec-fin-cash"
        />
        <Figure
          label={t('execPortal.home.fin.lowPoint')}
          value={fmtExecMoney(low?.balance ?? null)}
          title={low ? fmtExecExact(low.balance, 'money') : undefined}
          sub={
            low
              ? low.belowMinimum && d.cash?.minimum != null
                ? t('execPortal.home.fin.lowBelow', { date: fmtDateOnly(low.weekStart, { year: 'auto' }), minimum: fmtExecMoney(d.cash.minimum) })
                : t('execPortal.home.fin.lowWeek', { date: fmtDateOnly(low.weekStart, { year: 'auto' }) })
              : t('execPortal.home.fin.lowNone')
          }
          subClassName={low?.belowMinimum ? 'font-medium text-negative-800' : undefined}
          testId="exec-fin-low"
        />
        <Figure
          label={t('execPortal.home.fin.dso')}
          value={dsoKpi?.value != null ? String(Math.round(dsoKpi.value)) : '—'}
          title={dsoKpi?.definition}
          sub={dsoKpi?.value != null ? t('execPortal.home.fin.dsoSub', { count: Math.round(dsoKpi.value) }) : t('execPortal.home.fin.dsoNone')}
          testId="exec-fin-dso"
        />
      </Figures>
    </div>
  );
}

