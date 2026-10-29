import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { cn } from '@/lib/cn';
import { rateWhatIfAnnualLaborCost, rateWhatIfAnnualMargin } from '@/lib/execWhatIf';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { fmtMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import type { LegacySummary } from '../ops/execLegacyApi';

/**
 * The rate negotiation model: if the bill rate or the pay rate moved, what
 * happens to a year's gross margin? Run on the company's real volume — the
 * last four complete weeks' average hours, overtime priced the way the
 * paycheck prices it (lib/execWhatIf) — with employer burden. The answer is
 * one signed figure, rounded, with its basis said in words; the exact
 * amount rides in its tooltip.
 *
 * A company that bills no one (`billing` off — a hotel employing its own
 * team) gets the pay side alone: what a pay change does to a year's fully
 * loaded labor cost. More cost is the bad news there.
 */
export function RateModelCard({ rates, trend, billing = true }: { rates: LegacySummary['rates']; trend: LegacySummary['trend']; billing?: boolean }) {
  const { t } = useI18n();
  const [bill, setBill] = useState(rates.billRate.toFixed(2));
  const [pay, setPay] = useState(rates.payRate.toFixed(2));
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const recent = trend.slice(-4);
  const weeklyHours = recent.length ? recent.reduce((n, w) => n + w.workedHours, 0) / recent.length : 0;
  const weeklyOt = recent.length ? recent.reduce((n, w) => n + w.otHours, 0) / recent.length : 0;
  const b = billing ? num(bill, rates.billRate) : rates.billRate;
  const p = num(pay, rates.payRate);
  // Billing: the margin a year. Pay only: the labor cost a year.
  const measure = (bb: number, pp: number) => (billing ? rateWhatIfAnnualMargin(recent, bb, pp, rates) : rateWhatIfAnnualLaborCost(recent, pp, rates));
  const current = measure(rates.billRate, rates.payRate);
  const adjusted = measure(b, p);
  const delta = adjusted - current;
  const changed = Math.abs(b - rates.billRate) > 0.0001 || Math.abs(p - rates.payRate) > 0.0001;
  const sign = delta > 0.5 ? '+' : delta < -0.5 ? '−' : '±';
  const good = billing ? delta > 0 : delta < 0;
  const tone = !changed || Math.abs(delta) < 0.5 ? 'text-ink' : good ? 'text-positive-800' : 'text-negative-800';
  const k = billing ? '' : 'Pay';

  return (
    <Card className="min-w-0" data-testid="exec-rate-model">
      <CardContent className="space-y-4 p-4 md:p-5">
        <SectionTitle title={t(`execPortal.scen.rateTitle${k}`)} description={t(`execPortal.scen.rateDesc${k}`)} />
        {recent.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('execPortal.scen.rateNoHours')}</p>
        ) : (
          <>
            <div className={cn('grid gap-3', billing ? 'grid-cols-2 sm:max-w-sm' : 'grid-cols-1 sm:max-w-[12rem]')}>
              {billing && (
                <Field label={t('execPortal.scen.billRate')} hint={t('execPortal.scen.rateNow', { rate: fmtMoney(rates.billRate) })}>
                  {(f) => <Input {...f} type="number" inputMode="decimal" step="0.25" min="0" value={bill} onChange={(e) => setBill(e.target.value)} className="tabular-nums" />}
                </Field>
              )}
              <Field label={t('execPortal.scen.payRate')} hint={t('execPortal.scen.rateNow', { rate: fmtMoney(rates.payRate) })}>
                {(f) => <Input {...f} type="number" inputMode="decimal" step="0.25" min="0" value={pay} onChange={(e) => setPay(e.target.value)} className="tabular-nums" />}
              </Field>
            </div>
            <div className="rounded-md border border-line-subtle p-4" aria-live="polite" data-testid="exec-rate-result">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{t(`execPortal.scen.rateResultLabel${k}`)}</div>
              <div className={cn('mt-1 font-display text-[2.25rem] leading-none tabular-nums', tone)} title={fmtExecExact(delta, 'money')}>
                {sign}
                {fmtExecMoney(Math.abs(delta))}
              </div>
              <p className="mt-2 text-xs2 text-ink-muted">
                {changed
                  ? t(`execPortal.scen.rateResultSub${k}`, { now: fmtExecMoney(current), next: fmtExecMoney(adjusted) })
                  : t(`execPortal.scen.rateResultSame${k}`, { now: fmtExecMoney(current) })}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs2 text-ink-muted">
                {t('execPortal.scen.rateBasis', { hours: Math.round(weeklyHours).toLocaleString('en-US'), ot: Math.round(weeklyOt).toLocaleString('en-US'), burden: rates.burdenPct })}
              </p>
              {changed && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setBill(rates.billRate.toFixed(2));
                    setPay(rates.payRate.toFixed(2));
                  }}
                >
                  {t(`execPortal.scen.reset${k}`)}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
