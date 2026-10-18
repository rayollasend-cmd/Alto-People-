import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import {
  getMyStateCertificates,
  getStateCertificates,
  getStateW4Forms,
  saveMyStateCertificate,
  saveStateCertificate,
  type StateCertificate,
  type StateCertificateInput,
} from '@/lib/taxcompApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * A state's own withholding certificate (AL A-4, MD MW507, OR-W-4 …), for
 * the worker's work state. Two homes: the worker fills it after the W-4
 * (`mode="self"`), and payroll sees or corrects it on the person record
 * (`mode="hr"`). Renders nothing when the state has no certificate of its own.
 */

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'.-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

type Props = { mode: 'self' } | { mode: 'hr'; associateId: string };

export function StateCertificateCard(props: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const self = props.mode === 'self';
  const mine = useQuery({ queryKey: ['state-w4', 'me'], queryFn: getMyStateCertificates, enabled: self });
  const forms = useQuery({ queryKey: ['payroll', 'state-w4-forms'], queryFn: getStateW4Forms });
  const hrAssociateId = props.mode === 'hr' ? props.associateId : null;
  const theirs = useQuery({
    queryKey: ['state-w4', hrAssociateId],
    queryFn: () => getStateCertificates(hrAssociateId!),
    enabled: !!hrAssociateId,
  });

  const state = self ? (mine.data?.needed?.state ?? null) : (theirs.data?.workState ?? null);
  const formInfo = state ? forms.data?.forms.find((f) => f.state === state) : undefined;
  const existing: StateCertificate | undefined = (self ? mine.data?.certificates : theirs.data?.certificates)?.find((c) => c.state === state);
  const [f, setF] = useState<StateCertificateInput | null>(null);
  useEffect(() => {
    if (!state) return;
    setF(
      existing
        ? { state, filingStatus: existing.filingStatus, allowances: existing.allowances, dependents: existing.dependents, additionalWithholding: existing.additionalWithholding, exempt: existing.exempt, county: existing.county }
        : { state, filingStatus: 'SINGLE', allowances: 1, dependents: 0, additionalWithholding: 0, exempt: false, county: null },
    );
  }, [state, existing]);

  const save = useMutation({
    mutationFn: () => (self ? saveMyStateCertificate(f!) : saveStateCertificate(hrAssociateId!, f!)),
    onSuccess: () => {
      toast.success(t('ob.stateW4.saved'));
      void qc.invalidateQueries({ queryKey: ['state-w4'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('ob.stateW4.failed')),
  });

  const loading = forms.isLoading || (self ? mine.isLoading : theirs.isLoading);
  if (loading) return <Skeleton className="h-40" />;
  if (!state || !formInfo || !f) return null;
  const isMd = state === 'MD';
  const n = (v: string) => (v === '' ? 0 : Number(v));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('ob.stateW4.title', { state: formInfo.name, form: formInfo.form })}</CardTitle>
        <CardDescription>{t('ob.stateW4.intro', { state: formInfo.name })}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!isMd || f.county) save.mutate();
          }}
        >
          <Field label={t('ob.stateW4.filingStatus')}>
            {(p) => (
              <Select {...p} value={f.filingStatus} onChange={(e) => setF({ ...f, filingStatus: e.target.value as StateCertificateInput['filingStatus'] })}>
                <option value="SINGLE">{t('ob.stateW4.single')}</option>
                <option value="MARRIED">{t('ob.stateW4.married')}</option>
                <option value="HEAD_OF_HOUSEHOLD">{t('ob.stateW4.hoh')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('ob.stateW4.allowances')} hint={t('ob.stateW4.allowancesHint')}>
            {(p) => <Input {...p} type="number" min="0" max="30" inputMode="numeric" value={f.allowances} onChange={(e) => setF({ ...f, allowances: n(e.target.value) })} />}
          </Field>
          <Field label={t('ob.stateW4.dependents')}>
            {(p) => <Input {...p} type="number" min="0" max="30" inputMode="numeric" value={f.dependents} onChange={(e) => setF({ ...f, dependents: n(e.target.value) })} />}
          </Field>
          <Field label={t('ob.stateW4.extra')}>
            {(p) => <Input {...p} type="number" min="0" step="1" inputMode="decimal" value={f.additionalWithholding} onChange={(e) => setF({ ...f, additionalWithholding: n(e.target.value) })} />}
          </Field>
          {isMd && (
            <Field label={t('ob.stateW4.county')} className="sm:col-span-2">
              {(p) => (
                <Select {...p} value={f.county ?? ''} onChange={(e) => setF({ ...f, county: e.target.value || null })} required>
                  <option value="">{t('ob.stateW4.pickCounty')}</option>
                  {forms.data?.marylandCounties.map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm text-ink coarse:min-h-11 sm:col-span-2">
            <input type="checkbox" className="h-4 w-4 coarse:h-6 coarse:w-6" checked={f.exempt} onChange={(e) => setF({ ...f, exempt: e.target.checked })} />
            {t('ob.stateW4.exempt', { state: formInfo.name })}
          </label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" loading={save.isPending} disabled={isMd && !f.county}>
              {t('ob.stateW4.save', { form: formInfo.form })}
            </Button>
            {existing?.signedAt && <span className="text-xs text-ink-muted">{t('ob.stateW4.signedOn', { date: fmtDate(existing.signedAt) })}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
