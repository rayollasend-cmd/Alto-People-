import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UPLOAD_MAX_BYTES } from '@alto-people/shared';
import { useNavigate, useParams } from 'react-router-dom';
import { Camera, CheckCircle2, ChevronDown, Upload } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { getW4, submitW4, type W4Status } from '@/lib/onboardingApi';
import { uploadI9Document } from '@/lib/i9Api';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtMoneyWhole } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Field, SubmitRow, TaskShell, inputCls, useNextTask } from './ProfileInfoTask';
import { StateCertificateCard } from '@/components/payroll/StateCertificateCard';

const SSN_PATTERN = /^\d{3}-?\d{2}-?\d{4}$/;

const CARD_ACCEPTED_MIMES =
  'application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif';
const CARD_MAX_BYTES = UPLOAD_MAX_BYTES;

// The IRS Step 3 amounts (Form W-4, 2020 onward): $2,000 for each
// qualifying child under 17, $500 for each other dependent.
export const W4_CHILD_CREDIT = 2000;
export const W4_OTHER_DEPENDENT_CREDIT = 500;

/** Step 3's total from the two counts, the way the form adds it up. */
export function w4DependentsAmount(children: string, others: string): number {
  const n = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  return n(children) * W4_CHILD_CREDIT + n(others) * W4_OTHER_DEPENDENT_CREDIT;
}

export function W4Task() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();

  const [status, setStatus] = useState<W4Status | null>(null);
  const [filingStatus, setFilingStatus] = useState<
    'SINGLE' | 'MARRIED_FILING_JOINTLY' | 'HEAD_OF_HOUSEHOLD'
  >('SINGLE');
  const [multipleJobs, setMultipleJobs] = useState(false);
  // Step 3 is asked the way the IRS form asks it — how many children, how
  // many other dependents — and the dollar total is worked out here. A
  // total already on file can't be split back into people, so it opens in
  // "amount" mode showing what was filed, with a way back to counting.
  const [dependentsMode, setDependentsMode] = useState<'count' | 'amount'>('count');
  const [children, setChildren] = useState('0');
  const [otherDependents, setOtherDependents] = useState('0');
  const [dependents, setDependents] = useState('0');
  const [step4Open, setStep4Open] = useState(false);
  const [otherIncome, setOtherIncome] = useState('0');
  const [deductions, setDeductions] = useState('0');
  const [extraWithholding, setExtraWithholding] = useState('0');
  const [ssn, setSsn] = useState('');
  const [replaceSsn, setReplaceSsn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Two pickers, one handler: `capture` locks iOS to the camera, so a
  // camera-only input made an emailed PDF of the card unselectable.
  const cardCameraRef = useRef<HTMLInputElement | null>(null);
  const cardFileRef = useRef<HTMLInputElement | null>(null);
  const [cardOnFile, setCardOnFile] = useState(false);
  const [cardUploading, setCardUploading] = useState(false);
  const [cardFilename, setCardFilename] = useState<string | null>(null);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('W4');

  // Hydrate from server so re-opens show "•••-••-1234" rather than asking
  // the associate to retype an already-encrypted SSN.
  const statusQuery = useQuery({
    queryKey: ['W4Task', 'status', applicationId],
    queryFn: () => getW4(applicationId!),
    enabled: Boolean(applicationId),
  });
  useEffect(() => {
    const s = statusQuery.data;
    if (s === undefined) return;
    setStatus(s);
    setCardOnFile(!!s.hasSsnCardOnFile);
    if (s.filingStatus) setFilingStatus(s.filingStatus);
    setMultipleJobs(s.multipleJobs);
    if (s.dependentsAmount != null && Number(s.dependentsAmount) > 0) {
      setDependents(s.dependentsAmount);
      setDependentsMode('amount');
    }
    if (s.otherIncome != null) setOtherIncome(s.otherIncome);
    if (s.deductions != null) setDeductions(s.deductions);
    if (s.extraWithholding != null) setExtraWithholding(s.extraWithholding);
    // Step 4 opens by itself only when something in it was filed.
    if ([s.otherIncome, s.deductions, s.extraWithholding].some((v) => v != null && Number(v) > 0)) {
      setStep4Open(true);
    }
  }, [statusQuery.data]);
  useEffect(() => {
    if (!statusQuery.isError) return;
    const err = statusQuery.error;
    setError(
      err instanceof ApiError
        ? t('ob.w4.loadFailedWith', { message: err.message })
        : t('ob.w4.loadFailed'),
    );
  }, [statusQuery.isError, statusQuery.error, t]);

  const ssnOnFile = !!status?.hasSsnOnFile;
  const ssnNeedsResubmit = !!status?.ssnNeedsResubmit;
  const showSsnInput = !ssnOnFile || replaceSsn;
  // A card image is mandatory for any resubmit without one on file —
  // re-collection or otherwise. First-time onboarding (no submission yet)
  // collects it on the I-9 step instead.
  const showCardSection =
    !!status && !cardOnFile && (ssnNeedsResubmit || status.hasSubmission);
  const cardRequired = showCardSection;
  const dependentsAmount =
    dependentsMode === 'count'
      ? w4DependentsAmount(children, otherDependents)
      : Number(dependents) || 0;
  const adjustments = [
    { label: t('ob.w4.extraShort'), value: Number(extraWithholding) || 0 },
    { label: t('ob.w4.otherIncomeShort'), value: Number(otherIncome) || 0 },
    { label: t('ob.w4.deductionsShort'), value: Number(deductions) || 0 },
  ].filter((a) => a.value > 0);
  const typedLast4 = ssn.replace(/\D/g, '').slice(-4);

  const onCardFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow same-file re-selection
    if (!file || !applicationId) return;
    if (file.size > CARD_MAX_BYTES) {
      setError(t('ob.w4.cardTooLarge'));
      return;
    }
    setError(null);
    setCardUploading(true);
    try {
      await uploadI9Document(applicationId, file, 'SSN_CARD');
      setCardOnFile(true);
      setCardFilename(file.name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('ob.w4.cardUploadFailed'));
    } finally {
      setCardUploading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!applicationId || submitting) return;
    setError(null);

    if (showSsnInput) {
      if (!ssn || !SSN_PATTERN.test(ssn)) {
        setError(t('ob.w4.ssnInvalid'));
        return;
      }
    }
    if (cardRequired) {
      setError(t('ob.w4.cardRequiredError'));
      return;
    }

    setSubmitting(true);
    try {
      await submitW4(applicationId, {
        filingStatus,
        multipleJobs,
        dependentsAmount,
        otherIncome: Number(otherIncome) || 0,
        deductions: Number(deductions) || 0,
        extraWithholding: Number(extraWithholding) || 0,
        ssn: showSsnInput ? ssn : undefined,
      });
      navigate(next?.route ?? backTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('ob.w4.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TaskShell title={t('ob.w4.title')} backTo={backTo} kind="W4">
      <p className="text-silver text-sm mb-5">{t('ob.w4.intro')}</p>

      {ssnNeedsResubmit && (
        <div
          role="alert"
          className="mb-4 px-3 py-2 rounded-md border border-warning/40 bg-warning/[0.07] text-warning text-xs"
        >
          {t('ob.w4.ssnResubmitNotice')}
          {!cardOnFile && ` ${t('ob.w4.ssnResubmitCardNote')}`}
        </div>
      )}

      {status?.submittedAt && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-md border border-success/30 bg-success/[0.05] text-success text-xs">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t('ob.w4.submittedOn', { date: fmtDateTime(status.submittedAt) })}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Step 1 — who you are for the IRS: filing status and SSN. */}
        <section className="space-y-4">
          <W4StepHeading id="w4-step1" title={t('ob.w4.step1')} />
          <Field label={t('ob.w4.filingStatus')}>
            <Select
              value={filingStatus}
              onChange={(e) =>
                setFilingStatus(
                  e.target.value as
                    | 'SINGLE'
                    | 'MARRIED_FILING_JOINTLY'
                    | 'HEAD_OF_HOUSEHOLD'
                )
              }
            >
              <option value="SINGLE">{t('ob.w4.filingSingle')}</option>
              <option value="MARRIED_FILING_JOINTLY">{t('ob.w4.filingJointly')}</option>
              <option value="HEAD_OF_HOUSEHOLD">{t('ob.w4.filingHoh')}</option>
            </Select>
          </Field>

          {ssnOnFile && !replaceSsn ? (
            <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-3">
              <div className="text-xs uppercase tracking-widest text-silver mb-1">
                {t('ob.w4.ssnOnFile')}
              </div>
              <div className="font-mono text-ink tracking-widest">
                •••-••-{status?.ssnLast4 ?? '••••'}
              </div>
              <button
                type="button"
                onClick={() => {
                  setReplaceSsn(true);
                  setSsn('');
                }}
                className="mt-2 text-xs text-gold hover:text-gold-bright"
              >
                {t('ob.w4.replaceSsn')}
              </button>
            </div>
          ) : (
            <>
              <Field
                label={t('ob.w4.ssnLabel')}
                required
                hint={t('ob.w4.ssnHint')}
              >
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="\d{3}-?\d{2}-?\d{4}"
                  required
                  placeholder={t('ob.w4.ssnPlaceholder')}
                  value={ssn}
                  onChange={(e) => setSsn(e.target.value)}
                  className={inputCls}
                  autoComplete="off"
                />
              </Field>
              {ssnOnFile && replaceSsn && (
                <button
                  type="button"
                  onClick={() => {
                    setReplaceSsn(false);
                    setSsn('');
                  }}
                  className="-mt-2 text-xs text-silver hover:text-ink"
                >
                  {t('ob.w4.cancelKeepSsn')}
                </button>
              )}
            </>
          )}

          {(showCardSection || (cardFilename && cardOnFile)) && (
            <Field
              label={t('ob.w4.cardLabel')}
              hint={t('ob.w4.cardHint')}
            >
              {/* Composite control: the label + hint bind to whichever upload
                  button is active, so screen readers land on a named action. */}
              {(p) => (
                <div>
                  <input
                    ref={cardCameraRef}
                    type="file"
                    accept={CARD_ACCEPTED_MIMES}
                    capture="environment"
                    onChange={onCardFileChange}
                    className="hidden"
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                  <input
                    ref={cardFileRef}
                    type="file"
                    accept={CARD_ACCEPTED_MIMES}
                    onChange={onCardFileChange}
                    className="hidden"
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                  {cardOnFile ? (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-success/30 bg-success/[0.05] text-success text-xs">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 truncate">
                        {cardFilename
                          ? t('ob.w4.cardUploaded', { name: cardFilename })
                          : t('ob.w4.cardOnFile')}
                      </span>
                      {/* Kit buttons, not bare text: a focus ring, and the
                          coarse-pointer bump to a 44px target on phones —
                          where this task is actually done. */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        {...p}
                        onClick={() => cardCameraRef.current?.click()}
                        disabled={cardUploading}
                        className="ml-auto -my-1.5 text-gold hover:text-gold-bright"
                      >
                        {t('ob.w4.takeNewPhoto')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => cardFileRef.current?.click()}
                        disabled={cardUploading}
                        className="-my-1.5 text-gold hover:text-gold-bright"
                      >
                        {t('ob.w4.chooseFile')}
                      </Button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        {...p}
                        onClick={() => cardCameraRef.current?.click()}
                        disabled={cardUploading}
                        className={cn(
                          'px-4 py-5 rounded-md border-2 border-dashed transition-colors text-sm',
                          cardUploading
                            ? 'border-navy-secondary text-silver/70 cursor-wait'
                            : 'border-navy-secondary text-silver hover:border-gold/60 hover:text-gold',
                        )}
                      >
                        <Camera className="h-4 w-4 inline-block mr-2 -mt-0.5" />
                        {cardUploading ? t('ob.w4.uploading') : t('ob.w4.takePhoto')}
                      </button>
                      <button
                        type="button"
                        onClick={() => cardFileRef.current?.click()}
                        disabled={cardUploading}
                        className={cn(
                          'px-4 py-5 rounded-md border-2 border-dashed transition-colors text-sm',
                          cardUploading
                            ? 'border-navy-secondary text-silver/70 cursor-wait'
                            : 'border-navy-secondary text-silver hover:border-gold/60 hover:text-gold',
                        )}
                      >
                        <Upload className="h-4 w-4 inline-block mr-2 -mt-0.5" />
                        {cardUploading ? t('ob.w4.uploading') : t('ob.w4.chooseFile')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </Field>
          )}

        </section>

        {/* Step 2 — multiple jobs. */}
        <section className="space-y-2">
          <W4StepHeading id="w4-step2" title={t('ob.w4.step2')} hint={t('ob.w4.step2Hint')} />
          <label className="flex items-start gap-2 text-sm text-ink coarse:min-h-11">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={multipleJobs}
              onChange={(e) => setMultipleJobs(e.target.checked)}
            />
            {t('ob.w4.multipleJobsShort')}
          </label>
        </section>

        {/* Step 3 — dependents, counted; the dollars are worked out. */}
        <section className="space-y-3">
          <W4StepHeading id="w4-step3" title={t('ob.w4.step3')} hint={t('ob.w4.step3Hint')} />
          {dependentsMode === 'count' ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t('ob.w4.children')} hint={t('ob.w4.childrenHint')}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step="1"
                    value={children}
                    onChange={(e) => setChildren(e.target.value)}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('ob.w4.otherDependents')} hint={t('ob.w4.otherDependentsHint')}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step="1"
                    value={otherDependents}
                    onChange={(e) => setOtherDependents(e.target.value)}
                    className={inputCls}
                  />
                </Field>
              </div>
              <p className="text-sm text-ink" data-testid="w4-dependents-total" aria-live="polite">
                {t('ob.w4.dependentsTotal', { amount: fmtMoneyWhole(dependentsAmount) })}
              </p>
            </>
          ) : (
            <Field label={t('ob.w4.dependents')}>
              <input
                type="number"
                min={0}
                step="1"
                value={dependents}
                onChange={(e) => setDependents(e.target.value)}
                className={inputCls}
              />
            </Field>
          )}
          <button
            type="button"
            onClick={() => setDependentsMode(dependentsMode === 'count' ? 'amount' : 'count')}
            className="text-xs text-gold hover:text-gold-bright coarse:min-h-11"
          >
            {dependentsMode === 'count' ? t('ob.w4.enterAmountInstead') : t('ob.w4.countInstead')}
          </button>
        </section>

        {/* Step 4 — optional; most people leave it at 0, so it starts closed. */}
        <details
          open={step4Open}
          onToggle={(e) => setStep4Open((e.currentTarget as HTMLDetailsElement).open)}
          className="rounded-md border border-navy-secondary"
        >
          <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">{t('ob.w4.step4')}</span>
              <span className="block text-xs text-silver">{t('ob.w4.step4Hint')}</span>
            </span>
            <ChevronDown
              className={cn('h-4 w-4 shrink-0 text-silver transition-transform', step4Open && 'rotate-180')}
              aria-hidden
            />
          </summary>
          <div className="grid grid-cols-1 gap-4 border-t border-navy-secondary p-3 sm:grid-cols-3">
            <Field label={t('ob.w4.otherIncome')}>
              <input
                type="number"
                min={0}
                step="1"
                value={otherIncome}
                onChange={(e) => setOtherIncome(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label={t('ob.w4.deductions')}>
              <input
                type="number"
                min={0}
                step="1"
                value={deductions}
                onChange={(e) => setDeductions(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label={t('ob.w4.extraWithholding')}>
              <input
                type="number"
                min={0}
                step="1"
                value={extraWithholding}
                onChange={(e) => setExtraWithholding(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>
        </details>

        {/* What will be filed, read back before it is. */}
        <section className="rounded-md border border-gold/30 bg-gold/[0.04] p-3">
          <h2 id="w4-review" className="mb-2 text-sm font-medium text-ink">
            {t('ob.w4.reviewTitle')}
          </h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm" data-testid="w4-review">
            <dt className="text-silver">{t('ob.w4.filingStatus')}</dt>
            <dd className="text-ink">
              {filingStatus === 'SINGLE'
                ? t('ob.w4.filingSingle')
                : filingStatus === 'MARRIED_FILING_JOINTLY'
                  ? t('ob.w4.filingJointly')
                  : t('ob.w4.filingHoh')}
            </dd>
            <dt className="text-silver">{t('ob.w4.reviewMultipleJobs')}</dt>
            <dd className="text-ink">{multipleJobs ? t('ob.w4.yes') : t('ob.w4.no')}</dd>
            <dt className="text-silver">{t('ob.w4.reviewDependents')}</dt>
            <dd className="text-ink tabular-nums">{fmtMoneyWhole(dependentsAmount)}</dd>
            <dt className="text-silver">{t('ob.w4.reviewAdjustments')}</dt>
            <dd className="text-ink">
              {adjustments.length === 0
                ? t('ob.w4.reviewNone')
                : adjustments.map((a) => `${a.label} ${fmtMoneyWhole(a.value)}`).join(' · ')}
            </dd>
            <dt className="text-silver">{t('ob.w4.reviewSsn')}</dt>
            <dd className="font-mono text-ink">
              {!showSsnInput
                ? `•••-••-${status?.ssnLast4 ?? '••••'}`
                : typedLast4.length === 4
                  ? `•••-••-${typedLast4}`
                  : <span className="font-sans text-silver">{t('ob.w4.reviewSsnMissing')}</span>}
            </dd>
          </dl>
        </section>

        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}

        <SubmitRow submitting={submitting} backTo={backTo} label={t('ob.w4.submit')} next={next} />
      </form>
      {/* A work state with its own certificate (AL A-4, MD MW507 …) asks for it here too. */}
      {isAssociate && (
        <div className="mt-6">
          <StateCertificateCard mode="self" />
        </div>
      )}
    </TaskShell>
  );
}

function W4StepHeading({ id, title, hint }: { id: string; title: string; hint?: string }) {
  return (
    <div>
      <h2 id={id} className="text-sm font-medium uppercase tracking-wider text-gold">
        {title}
      </h2>
      {hint && <p className="mt-0.5 text-xs text-silver">{hint}</p>}
    </div>
  );
}
