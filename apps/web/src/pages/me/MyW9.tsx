import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Download, FileSignature } from 'lucide-react';
import { downloadMyW9, getMyW9, submitMyW9, type MyW9 as MyW9Data, type W9Submit } from '@/lib/certifiedPayrollApi';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { fmtDate } from '@/lib/format';
import { useI18n, type MessageKey } from '@/lib/i18n';

/**
 * A contractor's own W-9: who they are for tax purposes, their SSN or EIN
 * (kept encrypted; only the last four ever show again) and the signed
 * certification. Payroll needs it before paying without 24% backup
 * withholding; a corrected one also answers a first B-notice.
 */

const CLASSES: Array<{ value: W9Submit['taxClassification']; key: MessageKey }> = [
  { value: 'INDIVIDUAL', key: 'w9.class.individual' },
  { value: 'C_CORP', key: 'w9.class.cCorp' },
  { value: 'S_CORP', key: 'w9.class.sCorp' },
  { value: 'PARTNERSHIP', key: 'w9.class.partnership' },
  { value: 'TRUST', key: 'w9.class.trust' },
  { value: 'LLC', key: 'w9.class.llc' },
  { value: 'OTHER', key: 'w9.class.other' },
];

export function MyW9() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['me', 'w9'], queryFn: getMyW9 });
  const [editing, setEditing] = useState(false);

  return (
    <ListTemplate className="mx-auto max-w-2xl" title={t('w9.title')} subtitle={t('w9.subtitle')} breadcrumbs={[{ label: t('w9.crumb.me'), to: '/me' }, { label: t('w9.title') }]}>
      {q.isError ? (
        <QueryError what={t('w9.title')} query={q} />
      ) : q.isLoading || !q.data ? (
        <SkeletonRows count={6} />
      ) : !q.data.required ? (
        <EmptyState icon={FileSignature} title={t('w9.notNeeded.title')} description={t('w9.notNeeded.body')} />
      ) : q.data.status === 'SIGNED' && !editing ? (
        <SignedCard data={q.data} onEdit={() => setEditing(true)} />
      ) : (
        <W9Form data={q.data} onDone={() => setEditing(false)} />
      )}
    </ListTemplate>
  );
}

function SignedCard({ data, onEdit }: { data: MyW9Data; onEdit: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <Card className="border-success/30 bg-success/5">
        <CardContent className="flex items-start gap-3 py-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium text-ink">{t('w9.signed.title')}</p>
            <p className="text-sm text-ink-muted">{t('w9.signed.body', { date: data.signedAt ? fmtDate(data.signedAt) : '', last4: data.form.tinLast4 ?? '' })}</p>
          </div>
        </CardContent>
      </Card>
      {data.backupWithholding ? <BackupNotice /> : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="outline"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await downloadMyW9();
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Download className="mr-1.5 h-4 w-4" aria-hidden />
          {t('w9.download')}
        </Button>
        <Button variant="ghost" onClick={onEdit}>
          {t('w9.update')}
        </Button>
      </div>
    </div>
  );
}

function BackupNotice() {
  const { t } = useI18n();
  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="flex items-start gap-3 py-4">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
        <p className="text-sm text-ink-muted">{t('w9.backup.body')}</p>
      </CardContent>
    </Card>
  );
}

function W9Form({ data, onDone }: { data: MyW9Data; onDone: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [f, setF] = useState({
    legalName: data.form.legalName ?? '',
    businessName: data.form.businessName ?? '',
    taxClassification: (data.form.taxClassification ?? 'INDIVIDUAL') as W9Submit['taxClassification'],
    llcTaxClass: (data.form.llcTaxClass ?? '') as '' | 'C' | 'S' | 'P',
    exemptPayeeCode: data.form.exemptPayeeCode ?? '',
    fatcaCode: data.form.fatcaCode ?? '',
    addressLine1: data.form.addressLine1 ?? '',
    city: data.form.city ?? '',
    state: data.form.state ?? '',
    zip: data.form.zip ?? '',
    tinType: (data.form.tinType ?? 'SSN') as 'SSN' | 'EIN',
    tin: '',
    subjectToBackup: data.form.subjectToBackup,
    signatureName: '',
    certify: false,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const digits = f.tin.replace(/\D/g, '');
  const ok =
    f.legalName.trim().length >= 2 &&
    f.addressLine1.trim().length >= 3 &&
    f.city.trim() &&
    f.state.trim().length === 2 &&
    /^\d{5}(-?\d{4})?$/.test(f.zip.trim()) &&
    digits.length === 9 &&
    (f.taxClassification !== 'LLC' || f.llcTaxClass) &&
    f.signatureName.trim().length >= 2 &&
    f.certify;
  const save = useMutation({
    mutationFn: () =>
      submitMyW9({
        legalName: f.legalName.trim(),
        businessName: f.businessName.trim() || null,
        taxClassification: f.taxClassification,
        llcTaxClass: f.taxClassification === 'LLC' && f.llcTaxClass ? f.llcTaxClass : null,
        exemptPayeeCode: f.exemptPayeeCode.trim() || null,
        fatcaCode: f.fatcaCode.trim() || null,
        addressLine1: f.addressLine1.trim(),
        city: f.city.trim(),
        state: f.state.trim().toUpperCase(),
        zip: f.zip.trim(),
        tinType: f.tinType,
        tin: digits,
        subjectToBackup: f.subjectToBackup,
        signatureName: f.signatureName.trim(),
        certify: true,
      }),
    onSuccess: () => {
      toast.success(t('w9.saved'));
      void qc.invalidateQueries({ queryKey: ['me', 'w9'] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) save.mutate();
      }}
    >
      {data.backupWithholding ? <BackupNotice /> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('w9.section.who')}</CardTitle>
          <CardDescription>{t('w9.section.whoHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('w9.legalName')} required hint={t('w9.legalNameHint')} className="sm:col-span-2">
            <Input value={f.legalName} autoComplete="name" onChange={(e) => set('legalName', e.target.value)} />
          </Field>
          <Field label={t('w9.businessName')} className="sm:col-span-2">
            <Input value={f.businessName} autoComplete="organization" onChange={(e) => set('businessName', e.target.value)} />
          </Field>
          <Field label={t('w9.classification')} required>
            <Select value={f.taxClassification} onChange={(e) => set('taxClassification', e.target.value as W9Submit['taxClassification'])}>
              {CLASSES.map((c) => (
                <option key={c.value} value={c.value}>
                  {t(c.key)}
                </option>
              ))}
            </Select>
          </Field>
          {f.taxClassification === 'LLC' ? (
            <Field label={t('w9.llcClass')} required>
              <Select value={f.llcTaxClass} onChange={(e) => set('llcTaxClass', e.target.value as typeof f.llcTaxClass)}>
                <option value="">{t('w9.choose')}</option>
                <option value="C">{t('w9.class.cCorp')}</option>
                <option value="S">{t('w9.class.sCorp')}</option>
                <option value="P">{t('w9.class.partnership')}</option>
              </Select>
            </Field>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('w9.section.address')}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-6">
          <Field label={t('w9.street')} required className="sm:col-span-6">
            <Input value={f.addressLine1} autoComplete="address-line1" onChange={(e) => set('addressLine1', e.target.value)} />
          </Field>
          <Field label={t('w9.city')} required className="sm:col-span-3">
            <Input value={f.city} autoComplete="address-level2" onChange={(e) => set('city', e.target.value)} />
          </Field>
          <Field label={t('w9.state')} required className="sm:col-span-1">
            <Input value={f.state} maxLength={2} autoComplete="address-level1" onChange={(e) => set('state', e.target.value.toUpperCase())} />
          </Field>
          <Field label={t('w9.zip')} required className="sm:col-span-2">
            <Input value={f.zip} inputMode="numeric" autoComplete="postal-code" onChange={(e) => set('zip', e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('w9.section.tin')}</CardTitle>
          <CardDescription>{t('w9.section.tinHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <SegmentedControl
            ariaLabel={t('w9.tinType')}
            value={f.tinType}
            onChange={(v) => set('tinType', v)}
            options={[
              { value: 'SSN', label: t('w9.ssn') },
              { value: 'EIN', label: t('w9.ein') },
            ]}
          />
          <Field label={f.tinType === 'SSN' ? t('w9.ssnLabel') : t('w9.einLabel')} required hint={data.form.tinLast4 ? t('w9.tinOnFile', { last4: data.form.tinLast4 }) : undefined}>
            <Input value={f.tin} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={11} onChange={(e) => set('tin', e.target.value.replace(/[^\d-]/g, ''))} />
          </Field>
          <details className="rounded-md border border-navy-secondary p-3">
            <summary className="cursor-pointer text-sm text-ink">{t('w9.exemptions')}</summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label={t('w9.exemptPayee')}>
                <Input value={f.exemptPayeeCode} maxLength={4} onChange={(e) => set('exemptPayeeCode', e.target.value)} />
              </Field>
              <Field label={t('w9.fatca')}>
                <Input value={f.fatcaCode} maxLength={4} onChange={(e) => set('fatcaCode', e.target.value)} />
              </Field>
            </div>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('w9.section.certify')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-muted">
            <li>{t('w9.cert1')}</li>
            <li>{f.subjectToBackup ? t('w9.cert2Crossed') : t('w9.cert2')}</li>
            <li>{t('w9.cert3')}</li>
            <li>{t('w9.cert4')}</li>
          </ol>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-0.5" checked={f.subjectToBackup} onChange={(e) => set('subjectToBackup', e.target.checked)} />
            <span>{t('w9.subjectToBackup')}</span>
          </label>
          <Field label={t('w9.signature')} required hint={t('w9.signatureHint')}>
            <Input value={f.signatureName} autoComplete="name" onChange={(e) => set('signatureName', e.target.value)} />
          </Field>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-0.5" checked={f.certify} onChange={(e) => set('certify', e.target.checked)} />
            <span>{t('w9.perjury')}</span>
          </label>
        </CardContent>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {data.status === 'SIGNED' ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('w9.cancel')}
          </Button>
        ) : null}
        <Button type="submit" disabled={!ok} loading={save.isPending}>
          {t('w9.sign')}
        </Button>
      </div>
    </form>
  );
}
