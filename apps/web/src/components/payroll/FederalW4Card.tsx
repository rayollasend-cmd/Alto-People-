import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate, ymdLocal } from '@/lib/format';
import { getFederalW4, lockInLetterUrl, saveFederalW4, uploadLockInLetter, type FederalW4Facts, type FederalW4Input } from '@/lib/payrollDeskApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Federal W-4 facts the employee's own form doesn't carry (audit Tier 3):
 * an "Exempt" claim and its year, nonresident-alien status, a 2019-or-
 * earlier W-4 never replaced (its allowances), and an IRS lock-in letter.
 * Payroll only; every save is audited (routes/federalW4.ts).
 */

const FILING: Array<{ value: 'SINGLE' | 'MARRIED_FILING_JOINTLY' | 'HEAD_OF_HOUSEHOLD'; label: string }> = [
  { value: 'SINGLE', label: 'Single or married filing separately' },
  { value: 'MARRIED_FILING_JOINTLY', label: 'Married filing jointly' },
  { value: 'HEAD_OF_HOUSEHOLD', label: 'Head of household' },
];

const FLAG_TEXT: Record<string, string> = {
  EXEMPT_EXPIRED: 'Their exempt claim ran out on February 15 — withholding is single with no adjustments until a new W-4.',
  LOCK_IN_LETTER: 'An IRS lock-in letter sets their withholding; their own W-4 can’t lower it.',
};

export function FederalW4Card({ associateId }: { associateId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll', 'federal-w4', associateId], queryFn: () => getFederalW4(associateId), retry: false });
  const [draft, setDraft] = useState<FederalW4Facts | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (body: FederalW4Input) => saveFederalW4(associateId, body),
    onSuccess: (next) => {
      qc.setQueryData(['payroll', 'federal-w4', associateId], next);
      toast.success('Federal W-4 facts saved.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  // The letter itself, filed in the person's documents beside the facts it sets.
  const fileRef = useRef<HTMLInputElement | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadLockInLetter(associateId, file),
    onSuccess: (next) => {
      qc.setQueryData(['payroll', 'federal-w4', associateId], next);
      setDraft((d) => (d ? { ...d, lockInLetter: next.lockInLetter } : next));
      toast.success('Letter filed in their documents.');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not upload the letter.'),
  });

  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.isError || !draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Federal W-4 facts</CardTitle>
          <CardDescription>{q.error instanceof ApiError ? q.error.message : 'Could not load the W-4.'}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const year = new Date().getFullYear();
  const lock = draft.lockIn;
  const onSave = () =>
    save.mutate({
      exempt: draft.exempt,
      exemptTaxYear: draft.exempt ? (draft.exemptTaxYear ?? year) : null,
      nonresidentAlien: draft.nonresidentAlien,
      pre2020Allowances: draft.pre2020Allowances,
      lockIn: lock && lock.effectiveDate ? { filingStatus: lock.filingStatus, multipleJobs: lock.multipleJobs, effectiveDate: lock.effectiveDate } : null,
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Federal W-4 facts</CardTitle>
        <CardDescription>What withholding needs that the person’s own W-4 doesn’t say. Each change is recorded in the audit trail.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(draft.effective?.flags ?? []).map((f) => (
          <p key={f} className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
            {FLAG_TEXT[f] ?? f}
          </p>
        ))}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-1" checked={draft.exempt} onChange={(e) => setDraft({ ...draft, exempt: e.target.checked, exemptTaxYear: e.target.checked ? (draft.exemptTaxYear ?? year) : null })} />
            <span>
              Claims exempt
              <span className="block text-xs text-ink-muted">No federal income tax withheld for the year; it runs out February 15 of the next.</span>
            </span>
          </label>
          {draft.exempt && (
            <Field label="Exempt for tax year">
              {(p) => <Input type="number" min={2020} max={2100} value={draft.exemptTaxYear ?? year} onChange={(e) => setDraft({ ...draft, exemptTaxYear: Number(e.target.value) || year })} {...p} />}
            </Field>
          )}
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-1" checked={draft.nonresidentAlien} onChange={(e) => setDraft({ ...draft, nonresidentAlien: e.target.checked })} />
            <span>
              Nonresident alien
              <span className="block text-xs text-ink-muted">Withholding adds the Pub 15-T amount to their wages first.</span>
            </span>
          </label>
          <Field label="Allowances on a 2019-or-earlier W-4" hint="Leave empty when they have a 2020 or later W-4.">
            {(p) => (
              <Input
                type="number"
                min={0}
                max={99}
                value={draft.pre2020Allowances ?? ''}
                onChange={(e) => setDraft({ ...draft, pre2020Allowances: e.target.value === '' ? null : Math.max(0, Math.min(99, Number(e.target.value))) })}
                {...p}
              />
            )}
          </Field>
        </div>

        <div className="rounded-md border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-ink">IRS lock-in letter</p>
            {lock ? <Badge variant="accent" size="sm">On file{lock.effectiveDate ? ` · from ${fmtDate(lock.effectiveDate)}` : ''}</Badge> : <Badge size="sm">None</Badge>}
          </div>
          {lock ? (
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <Field label="Filing status the IRS set">
                {(p) => (
                  <Select value={lock.filingStatus} onChange={(e) => setDraft({ ...draft, lockIn: { ...lock, filingStatus: e.target.value as typeof lock.filingStatus } })} {...p}>
                    {FILING.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Effective from">
                {(p) => <Input type="date" value={lock.effectiveDate ?? ''} onChange={(e) => setDraft({ ...draft, lockIn: { ...lock, effectiveDate: e.target.value } })} {...p} />}
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink">
                <input type="checkbox" checked={lock.multipleJobs} onChange={(e) => setDraft({ ...draft, lockIn: { ...lock, multipleJobs: e.target.checked } })} />
                Multiple jobs
              </label>
              <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setDraft({ ...draft, lockIn: null })}>
                Remove the letter
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setDraft({ ...draft, lockIn: { filingStatus: 'SINGLE', multipleJobs: false, effectiveDate: ymdLocal() } })}>
              Record a lock-in letter
            </Button>
          )}
          {(lock || draft.lockInLetter) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
              {draft.lockInLetter ? (
                <>
                  <span className="text-ink-muted">Letter on file:</span>
                  {draft.lockInLetter.available ? (
                    <a className="text-gold underline underline-offset-2" href={lockInLetterUrl(associateId)} target="_blank" rel="noreferrer">
                      {draft.lockInLetter.filename}
                    </a>
                  ) : (
                    <span className="text-warning">{draft.lockInLetter.filename} (file missing, upload it again)</span>
                  )}
                  <span className="text-xs text-ink-muted">uploaded {fmtDate(draft.lockInLetter.uploadedAt)}</span>
                </>
              ) : (
                <span className="text-ink-muted">The letter itself isn’t on file yet.</span>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                className="hidden"
                aria-label="Lock-in letter file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) upload.mutate(f);
                }}
              />
              <Button variant="outline" size="sm" className="ml-auto" loading={upload.isPending} onClick={() => fileRef.current?.click()}>
                {draft.lockInLetter ? 'Replace the letter' : 'Upload the letter'}
              </Button>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button onClick={onSave} loading={save.isPending} disabled={save.isPending || (!!lock && !lock.effectiveDate)}>
            Save W-4 facts
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
