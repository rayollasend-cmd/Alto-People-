import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { UserRoundX } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { updateMyW4 } from '@/lib/payrollApi';
import {
  estimateMyW4,
  getW4EstimatorContext,
  type FilingStatus,
  type W4EstimateInput,
  type W4EstimateResult,
  type W4Projection,
} from '@/lib/payExpApi';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import '@/lib/i18n/en/w4est';

/**
 * The W-4 estimator: "am I withholding the right amount?" Starts from the
 * worker's own paychecks this year and asks four questions (filing status,
 * pay per check, checks left, children); another job, other dependents,
 * other income and deductions wait behind "More about your situation". It
 * shows the refund or balance due as things stand and with the W-4 it
 * suggests, and submits that W-4 through the usual W-4 flow.
 */

const FS: FilingStatus[] = ['SINGLE', 'MARRIED_FILING_JOINTLY', 'HEAD_OF_HOUSEHOLD'];
const FS_KEY: Record<FilingStatus, MessageKey> = {
  SINGLE: 'w4est.fs.SINGLE',
  MARRIED_FILING_JOINTLY: 'w4est.fs.MARRIED_FILING_JOINTLY',
  HEAD_OF_HOUSEHOLD: 'w4est.fs.HEAD_OF_HOUSEHOLD',
};

type Form = Record<'payPerPeriod' | 'periodsRemaining' | 'ytdWages' | 'ytdFederalWithheld' | 'otherJobsAnnual' | 'otherJobsWithheldAnnual' | 'otherIncome' | 'deductionsAboveStandard' | 'childrenUnder17' | 'otherDependents', string> & {
  filingStatus: FilingStatus;
};

const num = (s: string) => (s.trim() === '' ? 0 : Number(s));

export function W4Estimator() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const ctx = useQuery({ queryKey: ['me', 'w4Estimator'], queryFn: () => getW4EstimatorContext() });
  // An office account with no worker record has no paychecks: say so, not "couldn't load".
  const noRecord = ctx.error instanceof ApiError && ctx.error.code === 'no_associate_record';
  const [form, setForm] = useState<Form | null>(null);
  const [result, setResult] = useState<W4EstimateResult | null>(null);
  // Opens by itself when the W-4 on file already has other income or deductions, so they're not hidden.
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!ctx.data || form) return;
    const c = ctx.data;
    setForm({
      filingStatus: c.current?.filingStatus ?? 'SINGLE',
      payPerPeriod: c.payPerPeriod ? String(c.payPerPeriod) : '',
      periodsRemaining: String(c.periodsRemaining),
      ytdWages: String(c.ytdWages),
      ytdFederalWithheld: String(c.ytdFederalWithheld),
      otherJobsAnnual: '',
      otherJobsWithheldAnnual: '',
      otherIncome: c.current?.otherIncome ? String(c.current.otherIncome) : '',
      deductionsAboveStandard: c.current?.deductions ? String(c.current.deductions) : '',
      childrenUnder17: '',
      otherDependents: '',
    });
    if ((c.current?.otherIncome ?? 0) > 0 || (c.current?.deductions ?? 0) > 0) setMoreOpen(true);
  }, [ctx.data, form]);

  const estimate = useMutation({
    mutationFn: (body: W4EstimateInput) => estimateMyW4(body),
    onSuccess: (r) => setResult(r),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('w4est.loadFailed')),
  });
  const submit = useMutation({
    mutationFn: () =>
      updateMyW4({
        filingStatus: result!.suggested.filingStatus,
        multipleJobs: false,
        dependentsAmount: result!.suggested.dependentsAmount,
        otherIncome: result!.suggested.otherIncome,
        deductions: result!.suggested.deductions,
        extraWithholding: result!.suggested.extraWithholding,
      }),
    onSuccess: () => {
      toast.success(t('w4est.submitted'));
      void qc.invalidateQueries({ queryKey: ['W4Card'] });
      void qc.invalidateQueries({ queryKey: ['me', 'w4Estimator'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('w4est.submitFailed')),
  });

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
    setResult(null);
  };
  const valid =
    !!form &&
    (['payPerPeriod', 'periodsRemaining', 'ytdWages', 'ytdFederalWithheld', 'otherJobsAnnual', 'otherJobsWithheldAnnual', 'otherIncome', 'deductionsAboveStandard', 'childrenUnder17', 'otherDependents'] as const).every(
      (k) => Number.isFinite(num(form[k])) && num(form[k]) >= 0,
    );

  return (
    <ListTemplate
      title={t('w4est.title')}
      subtitle={t('w4est.subtitle')}
      breadcrumbs={[{ label: t('w4est.crumbPay'), to: '/payroll' }, { label: t('w4est.title') }]}
    >
      {noRecord && <EmptyState icon={UserRoundX} title={t('w4est.noRecordTitle')} description={t('w4est.noRecordBody')} />}
      {ctx.isError && !noRecord && (
        <ErrorBanner
          className="mb-4"
          action={
            <Button size="sm" variant="secondary" onClick={() => void ctx.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('w4est.loadFailed')}
        </ErrorBanner>
      )}
      {!form && !ctx.isError && <Skeleton className="h-96" />}
      {form && ctx.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('w4est.about')}</CardTitle>
              <CardDescription>{ctx.data.payPerPeriod > 0 ? t('w4est.filledFromPay') : t('w4est.noChecks')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!valid || !form) return;
                  estimate.mutate({
                    filingStatus: form.filingStatus,
                    payFrequency: ctx.data!.payFrequency,
                    payPerPeriod: num(form.payPerPeriod),
                    periodsRemaining: Math.floor(num(form.periodsRemaining)),
                    ytdWages: num(form.ytdWages),
                    ytdFederalWithheld: num(form.ytdFederalWithheld),
                    otherJobsAnnual: num(form.otherJobsAnnual),
                    otherJobsWithheldAnnual: num(form.otherJobsWithheldAnnual),
                    otherIncome: num(form.otherIncome),
                    deductionsAboveStandard: num(form.deductionsAboveStandard),
                    childrenUnder17: Math.floor(num(form.childrenUnder17)),
                    otherDependents: Math.floor(num(form.otherDependents)),
                  });
                }}
              >
                <div className="sm:col-span-2">
                  <Field label={t('w4est.filingStatus')}>
                    {(p) => (
                      <Select value={form.filingStatus} onChange={set('filingStatus')} {...p}>
                        {FS.map((f) => (
                          <option key={f} value={f}>
                            {t(FS_KEY[f])}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
                <Money label={t('w4est.payPerPeriod')} value={form.payPerPeriod} onChange={set('payPerPeriod')} />
                <Count label={t('w4est.periodsRemaining')} value={form.periodsRemaining} onChange={set('periodsRemaining')} />
                <Count label={t('w4est.children')} value={form.childrenUnder17} onChange={set('childrenUnder17')} />
                {(ctx.data.ytdWages > 0 || ctx.data.ytdFederalWithheld > 0) && (
                  <p className="text-sm text-ink-muted sm:col-span-2" data-testid="w4est-so-far">
                    {t('w4est.soFar', { paid: fmtMoney(num(form.ytdWages)), withheld: fmtMoney(num(form.ytdFederalWithheld)) })}
                  </p>
                )}
                {/* Four questions first; the rest only matters for some people, and the paid and withheld totals are already filled in from paychecks. */}
                <details className="group sm:col-span-2" open={moreOpen} onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}>
                  <summary className="cursor-pointer list-none py-1 text-sm font-medium text-accent underline underline-offset-2 coarse:min-h-11 [&::-webkit-details-marker]:hidden">
                    {t('w4est.more')}
                  </summary>
                  <p className="mt-1 text-xs text-ink-muted">{t('w4est.moreHint')}</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Money label={t('w4est.otherJobs')} value={form.otherJobsAnnual} onChange={set('otherJobsAnnual')} />
                    <Money label={t('w4est.otherJobsWithheld')} value={form.otherJobsWithheldAnnual} onChange={set('otherJobsWithheldAnnual')} />
                    <Count label={t('w4est.otherDependents')} value={form.otherDependents} onChange={set('otherDependents')} />
                    <Money label={t('w4est.otherIncome')} value={form.otherIncome} onChange={set('otherIncome')} />
                    <Money label={t('w4est.deductions')} value={form.deductionsAboveStandard} onChange={set('deductionsAboveStandard')} />
                    <Money label={t('w4est.ytdWages')} value={form.ytdWages} onChange={set('ytdWages')} />
                    <Money label={t('w4est.ytdWithheld')} value={form.ytdFederalWithheld} onChange={set('ytdFederalWithheld')} />
                  </div>
                </details>
                <div className="sm:col-span-2">
                  <Button type="submit" className="w-full sm:w-auto" loading={estimate.isPending} disabled={!valid || estimate.isPending}>
                    {t('w4est.estimate')}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="space-y-4" aria-live="polite">
            {estimate.isPending && <Skeleton className="h-64" />}
            {result && !estimate.isPending && (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle>{t('w4est.resultTitle')}</CardTitle>
                    <CardDescription>{t('w4est.yearTax', { amount: fmtMoney(result.estimatedTax) })}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {result.asIs && <Outcome label={t('w4est.asIs')} p={result.asIs} />}
                    <Outcome label={t('w4est.withSuggested')} p={result.withSuggested} />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>{t('w4est.suggestedTitle')}</CardTitle>
                    <CardDescription>{t(FS_KEY[result.suggested.filingStatus])}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <dl className="space-y-1.5 text-sm">
                      <Line label={t('w4est.dependentsAmount')} value={fmtMoney(result.suggested.dependentsAmount)} />
                      <Line label={t('w4est.otherIncomeStep')} value={fmtMoney(result.suggested.otherIncome)} />
                      <Line label={t('w4est.deductionsStep')} value={fmtMoney(result.suggested.deductions)} />
                      <Line label={t('w4est.extra')} value={fmtMoney(result.suggested.extraWithholding)} />
                    </dl>
                    <Button className="mt-4 w-full sm:w-auto" loading={submit.isPending} disabled={submit.isPending} onClick={() => submit.mutate()}>
                      {t('w4est.submit')}
                    </Button>
                  </CardContent>
                </Card>
              </>
            )}
            <p className="text-xs text-ink-muted">{t('w4est.disclaimer')}</p>
          </div>
        </div>
      )}
    </ListTemplate>
  );
}

function Money({ label, value, onChange }: { label: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <Field label={label}>
      {(p) => <Input type="number" inputMode="decimal" min="0" step="0.01" value={value} onChange={onChange} {...p} />}
    </Field>
  );
}

function Count({ label, value, onChange }: { label: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <Field label={label}>
      {(p) => <Input type="number" inputMode="numeric" min="0" step="1" value={value} onChange={onChange} {...p} />}
    </Field>
  );
}

function Outcome({ label, p }: { label: string; p: W4Projection }) {
  const { t } = useI18n();
  const even = Math.abs(p.refund) < 1;
  return (
    <div className="rounded-md border border-line p-3">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={cn('mt-1 text-lg font-semibold tabular-nums', even ? 'text-success' : p.refund > 0 ? 'text-ink' : 'text-warning')}>
        {even ? t('w4est.onTrack') : p.refund > 0 ? t('w4est.refund', { amount: fmtMoney(p.refund) }) : t('w4est.owe', { amount: fmtMoney(-p.refund) })}
      </div>
      <div className="text-xs text-ink-muted tabular-nums">{t('w4est.perCheck', { amount: fmtMoney(p.perCheck) })}</div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}
