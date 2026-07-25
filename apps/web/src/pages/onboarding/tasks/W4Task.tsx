import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Upload } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { getW4, submitW4, type W4Status } from '@/lib/onboardingApi';
import { uploadI9Document } from '@/lib/i9Api';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Select } from '@/components/ui/Select';
import { Field, SubmitRow, TaskShell, inputCls } from './ProfileInfoTask';

const SSN_PATTERN = /^\d{3}-?\d{2}-?\d{4}$/;

const CARD_ACCEPTED_MIMES = 'application/pdf,image/png,image/jpeg,image/webp';
const CARD_MAX_BYTES = 10 * 1024 * 1024;

export function W4Task() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
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
  const cardInputRef = useRef<HTMLInputElement | null>(null);
  const [cardOnFile, setCardOnFile] = useState(false);
  const [cardUploading, setCardUploading] = useState(false);
  const [cardFilename, setCardFilename] = useState<string | null>(null);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;

  // Hydrate from server so re-opens show "•••-••-1234" rather than asking
  // the associate to retype an already-encrypted SSN.
  useEffect(() => {
    if (!applicationId) return;
    void getW4(applicationId).then((s) => {
      setStatus(s);
      setCardOnFile(!!s.hasSsnCardOnFile);
      if (s.filingStatus) setFilingStatus(s.filingStatus);
      setMultipleJobs(s.multipleJobs);
      if (s.dependentsAmount != null) setDependents(s.dependentsAmount);
      if (s.otherIncome != null) setOtherIncome(s.otherIncome);
      if (s.deductions != null) setDeductions(s.deductions);
      if (s.extraWithholding != null) setExtraWithholding(s.extraWithholding);
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
      setError('Card photo is too large (max 10 MB).');
      return;
    }
    setError(null);
    setCardUploading(true);
    try {
      await uploadI9Document(applicationId, file, 'SSN_CARD');
      setCardOnFile(true);
      setCardFilename(file.name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Card upload failed.');
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
        setError('SSN is required and must be 9 digits.');
        return;
      }
    }
    if (cardRequired) {
      setError(
        'Please upload a photo of your Social Security card before submitting.',
      );
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
      navigate(backTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submission failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TaskShell title="W-4 tax withholding" backTo={backTo}>
      <p className="text-silver text-sm mb-5">
        Federal W-4. Required for U.S. tax withholding on your wages. Your SSN
        is encrypted at rest the moment you submit it.
      </p>

      {ssnNeedsResubmit && (
        <div
          role="alert"
          className="mb-4 px-3 py-2 rounded-md border border-warning/40 bg-warning/[0.07] text-warning text-xs"
        >
          We need your Social Security number again. The copy you entered
          before can no longer be read after a system encryption-key change —
          it was never exposed, but it must be re-entered before payroll and
          tax filings can include you.
          {!cardOnFile &&
            ' We also need a photo of your Social Security card on file — upload it below before submitting.'}
        </div>
      )}

      {status?.submittedAt && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-md border border-success/30 bg-success/[0.05] text-success text-xs">
          <CheckCircle2 className="h-3.5 w-3.5" />
          You submitted this on{' '}
          {new Date(status.submittedAt).toLocaleString()}. Re-submit to update.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Filing status">
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
            <option value="SINGLE">Single or married filing separately</option>
            <option value="MARRIED_FILING_JOINTLY">Married filing jointly</option>
            <option value="HEAD_OF_HOUSEHOLD">Head of household</option>
          </Select>
        </Field>

        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={multipleJobs}
            onChange={(e) => setMultipleJobs(e.target.checked)}
          />
          I have multiple jobs or my spouse works (check Step 2 box)
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Dependents amount ($)">
            <input
              type="number"
              min={0}
              step="1"
              value={dependents}
              onChange={(e) => setDependents(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Extra withholding ($)">
            <input
              type="number"
              min={0}
              step="1"
              value={extraWithholding}
              onChange={(e) => setExtraWithholding(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Other income ($)">
            <input
              type="number"
              min={0}
              step="1"
              value={otherIncome}
              onChange={(e) => setOtherIncome(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Deductions ($)">
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
            label="Social Security card photo"
            hint="Required — a clear photo or scan, PDF, PNG, JPG, or WebP, up to 10 MB. Uploads immediately and is visible only to HR."
          >
            <input
              ref={cardInputRef}
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
                    ? `Uploaded ${cardFilename}`
                    : 'A card photo is on file.'}
                </span>
                <button
                  type="button"
                  onClick={() => cardInputRef.current?.click()}
                  disabled={cardUploading}
                  className="ml-auto text-gold hover:text-gold-bright whitespace-nowrap"
                >
                  Upload a different photo
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => cardInputRef.current?.click()}
                disabled={cardUploading}
                className={cn(
                  'w-full px-4 py-5 rounded-md border-2 border-dashed transition-colors text-sm',
                  cardUploading
                    ? 'border-navy-secondary text-silver/70 cursor-wait'
                    : 'border-navy-secondary text-silver hover:border-gold/60 hover:text-gold',
                )}
              >
                <Upload className="h-4 w-4 inline-block mr-2 -mt-0.5" />
                {cardUploading
                  ? 'Uploading…'
                  : 'Click to upload your Social Security card'}
              </button>
            )}
          </Field>
        )}

        {ssnOnFile && !replaceSsn ? (
          <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-3">
            <div className="text-xs uppercase tracking-widest text-silver mb-1">
              SSN on file
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
              Replace SSN
            </button>
          </div>
        ) : (
          <Field
            label="Social Security number"
            hint="9 digits — required. Encrypted at rest the moment you submit. Never logged."
          >
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{3}-?\d{2}-?\d{4}"
              required
              placeholder="123-45-6789"
              value={ssn}
              onChange={(e) => setSsn(e.target.value)}
              className={inputCls}
              autoComplete="off"
            />
            {ssnOnFile && replaceSsn && (
              <button
                type="button"
                onClick={() => {
                  setReplaceSsn(false);
                  setSsn('');
                }}
                className="mt-1 text-xs text-silver hover:text-white"
              >
                Cancel — keep existing SSN
              </button>
            )}
          </Field>
        )}

        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}

        <SubmitRow submitting={submitting} backTo={backTo} label="Submit W-4" />
      </form>
    </TaskShell>
  );
}
