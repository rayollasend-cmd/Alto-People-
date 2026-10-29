import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { ApiError } from '@/lib/api';
import { useExecTargets, useSetExecTargets, type ExecTargetsInput, type ExecTargetsResponse } from '@/lib/executiveApi';
import { fmtExecMoney } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { quarterWords } from './util';

/**
 * Set the plan (2026-10-27): the quarter's five targets — revenue, gross
 * margin, headcount, turnover and fill rate — each beside what the quarter
 * has done so far, so the chairman sets a number with the run-rate in view.
 * A blank field clears that target. The scorecard prorates the plan by the
 * days gone, so it reads on or off plan from the first week.
 */

type FieldKey = 'revenue' | 'margin' | 'headcount' | 'turnover' | 'fill';
type Form = Record<FieldKey, string>;

const pctText = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`);

/** "1,200,000" / "$1.2" / "" → a number, null for blank, NaN for nonsense. */
export function parsePlanNumber(raw: string): number | null {
  const s = raw.replace(/[\s$,%]/g, '');
  if (s === '') return null;
  if (!/^-?\d*\.?\d+$/.test(s)) return Number.NaN;
  return Number(s);
}

function toForm(targets: ExecTargetsResponse['targets']): Form {
  const s = (n: number | null | undefined, money = false) =>
    n === null || n === undefined ? '' : money ? Math.round(n).toLocaleString('en-US') : String(n);
  return {
    revenue: s(targets?.revenueTarget, true),
    margin: s(targets?.marginTarget, true),
    headcount: s(targets?.headcountTarget),
    turnover: s(targets?.turnoverPctTarget),
    fill: s(targets?.fillRatePctTarget),
  };
}

type Problems = Partial<Record<FieldKey, string>>;

export function SetPlanDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const targets = useExecTargets();
  const save = useSetExecTargets();
  const data = targets.data;
  const [form, setForm] = useState<Form | null>(null);
  const [initial, setInitial] = useState<Form | null>(null);
  const [problems, setProblems] = useState<Problems>({});

  // Fill the form once per opening, from the plan as it stands.
  useEffect(() => {
    if (!open) {
      setForm(null);
      setInitial(null);
      setProblems({});
      return;
    }
    if (data && form === null) {
      const f = toForm(data.targets);
      setForm(f);
      setInitial(f);
    }
  }, [open, data, form]);

  const quarter = quarterWords(data?.quarter);
  const dirty = !!form && !!initial && (Object.keys(form) as FieldKey[]).some((k) => form[k] !== initial[k]);
  const set = (k: FieldKey) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setProblems((p) => ({ ...p, [k]: undefined }));
  };

  const revenue = form ? parsePlanNumber(form.revenue) : null;
  const margin = form ? parsePlanNumber(form.margin) : null;
  const impliedPct = revenue !== null && margin !== null && Number.isFinite(revenue) && Number.isFinite(margin) && revenue > 0 ? (margin / revenue) * 100 : null;

  const validate = (f: Form): { problems: Problems; body: Omit<ExecTargetsInput, 'quarter'> } => {
    const out: Problems = {};
    const num = (k: FieldKey, opts: { max?: number; maxMsg?: string; whole?: boolean } = {}) => {
      const n = parsePlanNumber(f[k]);
      if (n === null) return null;
      if (!Number.isFinite(n)) {
        out[k] = t('execPortal.home.plan.notNumber');
        return null;
      }
      if (n < 0) {
        out[k] = t('execPortal.home.plan.negative');
        return null;
      }
      if (opts.whole && !Number.isInteger(n)) {
        out[k] = t('execPortal.home.plan.whole');
        return null;
      }
      if (opts.max !== undefined && n > opts.max) {
        out[k] = opts.maxMsg;
        return null;
      }
      return n;
    };
    const body = {
      revenueTarget: num('revenue'),
      marginTarget: num('margin'),
      headcountTarget: num('headcount', { whole: true }),
      turnoverPctTarget: num('turnover', { max: 999, maxMsg: t('execPortal.home.plan.turnoverMax') }),
      fillRatePctTarget: num('fill', { max: 100, maxMsg: t('execPortal.home.plan.fillMax') }),
    };
    if (!out.margin && body.marginTarget !== null && body.revenueTarget !== null && body.marginTarget > body.revenueTarget) {
      out.margin = t('execPortal.home.plan.marginOverRevenue');
    }
    return { problems: out, body };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || !data) return;
    const { problems: found, body } = validate(form);
    setProblems(found);
    if (Object.values(found).some(Boolean)) return;
    try {
      await save.mutateAsync({ quarter: data.quarter, ...body });
      toast.success(t('execPortal.home.plan.saved', { quarter: quarter.long }));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError && err.status < 500 && err.message.trim() ? err.message : t('execPortal.home.plan.saveFailed'));
    }
  };

  const a = data?.actuals;
  const pace = a && data && data.elapsedPct > 0 ? a.revenueQtd / (data.elapsedPct / 100) : null;
  const marginPctQtd = a && a.revenueQtd > 0 ? (a.marginQtd / a.revenueQtd) * 100 : null;

  // A render function for Field: the control with its $ or % drawn inside it.
  const adorned =
    (k: FieldKey, prefix: string | null, suffix: string | null, inputMode: 'decimal' | 'numeric') =>
    (p: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': true | undefined }) => (
        <div className="relative w-full max-w-[14rem]">
          {prefix && <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-ink-muted" aria-hidden="true">{prefix}</span>}
          <Input
            {...p}
            inputMode={inputMode}
            autoComplete="off"
            value={form?.[k] ?? ''}
            onChange={set(k)}
            invalid={!!problems[k]}
            className={[prefix ? 'pl-7' : '', suffix ? 'pr-8' : '', 'tabular-nums'].join(' ')}
          />
          {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-ink-muted" aria-hidden="true">{suffix}</span>}
        </div>
    );

  return (
    <Drawer open={open} onOpenChange={onOpenChange} confirmDiscard={dirty} width="max-w-md">
      <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-1 flex-col" noValidate data-testid="exec-plan-form">
        <DrawerHeader>
          <DrawerTitle>{data ? t('execPortal.home.plan.title', { quarter: quarter.long }) : t('execPortal.setPlan')}</DrawerTitle>
          <DrawerDescription>
            {data ? t('execPortal.home.plan.description', { elapsed: data.elapsedPct }) : t('execPortal.home.plan.descriptionLoading')}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="space-y-5 pt-0">
          {!data || !form || !a ? (
            targets.isError ? <QueryError what={t('execPortal.home.plan.what')} query={targets} /> : <SkeletonRows count={5} rowHeight="h-16" />
          ) : (
            <>
              <Field
                label={t('execPortal.home.plan.revenue')}
                hint={pace !== null ? t('execPortal.home.plan.revenueHintPace', { actual: fmtExecMoney(a.revenueQtd), pace: fmtExecMoney(pace) }) : t('execPortal.home.plan.revenueHint', { actual: fmtExecMoney(a.revenueQtd) })}
                error={problems.revenue}
              >
                {adorned('revenue', '$', null, 'decimal')}
              </Field>
              <Field
                label={t('execPortal.home.plan.margin')}
                hint={t('execPortal.home.plan.marginHint', { actual: fmtExecMoney(a.marginQtd), pct: pctText(marginPctQtd) })}
                error={problems.margin}
              >
                {(p) => (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {adorned('margin', '$', null, 'decimal')(p)}
                    <span className="text-xs2 tabular-nums text-ink-muted" aria-live="polite" data-testid="exec-plan-implied">
                      {impliedPct !== null ? t('execPortal.home.plan.implied', { pct: pctText(impliedPct) }) : ''}
                    </span>
                  </div>
                )}
              </Field>
              <Field label={t('execPortal.home.plan.headcount')} hint={t('execPortal.home.plan.headcountHint', { actual: a.headcount })} error={problems.headcount}>
                {adorned('headcount', null, null, 'numeric')}
              </Field>
              <Field label={t('execPortal.home.plan.turnover')} hint={t('execPortal.home.plan.turnoverHint', { actual: pctText(a.turnoverAnnualizedPct) })} error={problems.turnover}>
                {adorned('turnover', null, '%', 'decimal')}
              </Field>
              <Field
                label={t('execPortal.home.plan.fill')}
                hint={a.fillRatePct !== null ? t('execPortal.home.plan.fillHint', { actual: pctText(a.fillRatePct) }) : t('execPortal.home.plan.fillHintNone')}
                error={problems.fill}
              >
                {adorned('fill', null, '%', 'decimal')}
              </Field>
              <p className="text-xs text-ink-muted">{t('execPortal.home.plan.blankClears')}</p>
            </>
          )}
        </DrawerBody>
        <DrawerFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('execPortal.home.plan.cancel')}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!form || save.isPending}>
            {t('execPortal.home.plan.save')}
          </Button>
        </DrawerFooter>
      </form>
    </Drawer>
  );
}
