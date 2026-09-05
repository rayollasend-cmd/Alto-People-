import { useEffect, useRef, useState, type FormEvent } from 'react';
import { UPLOAD_MAX_BYTES } from '@alto-people/shared';
import { useNavigate, useParams } from 'react-router-dom';
import { Camera, CheckCircle2, Upload } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { getW4, submitW4, type W4Status } from '@/lib/onboardingApi';
import { uploadI9Document } from '@/lib/i9Api';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime } from '@/lib/format';
import { Select } from '@/components/ui/Select';
import { Field, SubmitRow, TaskShell, inputCls, useNextTask } from './ProfileInfoTask';

const SSN_PATTERN = /^\d{3}-?\d{2}-?\d{4}$/;

const CARD_ACCEPTED_MIMES = 'application/pdf,image/png,image/jpeg,image/webp';
const CARD_MAX_BYTES = UPLOAD_MAX_BYTES;

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
  const [dependents, setDependents] = useState('0');
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
  useEffect(() => {
    if (!applicationId) return;
    void getW4(applicationId)
      .then((s) => {
        setStatus(s);
        setCardOnFile(!!s.hasSsnCardOnFile);
        if (s.filingStatus) setFilingStatus(s.filingStatus);
        setMultipleJobs(s.multipleJobs);
        if (s.dependentsAmount != null) setDependents(s.dependentsAmount);
        if (s.otherIncome != null) setOtherIncome(s.otherIncome);
        if (s.deductions != null) setDeductions(s.deductions);
        if (s.extraWithholding != null) setExtraWithholding(s.extraWithholding);
      })
      .catch((err) => {
        // A failed hydration must NOT fall through to a blank form: the
        // associate would see factory defaults, believe that's what's on
        // file, and resubmit zeroed elections over their real ones (the
        // null status also silently bypassed the SSN-card resubmit gate).
        setError(
          err instanceof ApiError
            ? t('ob.w4.loadFailedWith', { message: err.message })
            : t('ob.w4.loadFailed'),
        );
      });
  }, [applicationId]);

  const ssnOnFile = !!status?.hasSsnOnFile;
  const ssnNeedsResubmit = !!status?.ssnNeedsResubmit;
  const showSsnInput = !ssnOnFile || replaceSsn;
  // A card image is mandatory for any resubmit without one on file —
  // re-collection or otherwise. First-time onboarding (no submission yet)
  // collects it on the I-9 step instead.
  const showCardSection =
    !!status && !cardOnFile && (ssnNeedsResubmit || status.hasSubmission);
  const cardRequired = showCardSection;

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
        dependentsAmount: Number(dependents) || 0,
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
    <TaskShell title={t('ob.w4.title')} backTo={backTo}>
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

      <form onSubmit={handleSubmit} className="space-y-4">
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

        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={multipleJobs}
            onChange={(e) => setMultipleJobs(e.target.checked)}
          />
          {t('ob.w4.multipleJobs')}
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
        </div>

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
                    <button
                      type="button"
                      {...p}
                      onClick={() => cardCameraRef.current?.click()}
                      disabled={cardUploading}
                      className="ml-auto text-gold hover:text-gold-bright whitespace-nowrap"
                    >
                      {t('ob.w4.takeNewPhoto')}
                    </button>
                    <button
                      type="button"
                      onClick={() => cardFileRef.current?.click()}
                      disabled={cardUploading}
                      className="text-gold hover:text-gold-bright whitespace-nowrap"
                    >
                      {t('ob.w4.chooseFile')}
                    </button>
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

        {ssnOnFile && !replaceSsn ? (
          <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-3">
            <div className="text-xs uppercase tracking-widest text-silver mb-1">
              {t('ob.w4.ssnOnFile')}
            </div>
            <div className="font-mono text-white tracking-widest">
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
                className="-mt-2 text-xs text-silver hover:text-white"
              >
                {t('ob.w4.cancelKeepSsn')}
              </button>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}

        <SubmitRow submitting={submitting} backTo={backTo} label={t('ob.w4.submit')} next={next} />
      </form>
    </TaskShell>
  );
}
