import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { submitW4 } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { Field, SubmitRow, TaskShell, inputCls } from './ProfileInfoTask';

export function W4Task() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [filingStatus, setFilingStatus] = useState<
    'SINGLE' | 'MARRIED_FILING_JOINTLY' | 'HEAD_OF_HOUSEHOLD'
  >('SINGLE');
  const [multipleJobs, setMultipleJobs] = useState(false);
  const [dependents, setDependents] = useState('0');
  const [otherIncome, setOtherIncome] = useState('0');
  const [deductions, setDeductions] = useState('0');
  const [extraWithholding, setExtraWithholding] = useState('0');
  const [ssn, setSsn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!applicationId || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await submitW4(applicationId, {
        filingStatus,
        multipleJobs,
        dependentsAmount: Number(dependents) || 0,
        otherIncome: Number(otherIncome) || 0,
        deductions: Number(deductions) || 0,
        extraWithholding: Number(extraWithholding) || 0,
        ssn: ssn ? ssn : undefined,
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
        Provide federal tax withholding details. SSN is encrypted at rest.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Filing status">
          <select
            value={filingStatus}
            onChange={(e) =>
              setFilingStatus(
                e.target.value as
                  | 'SINGLE'
                  | 'MARRIED_FILING_JOINTLY'
                  | 'HEAD_OF_HOUSEHOLD'
              )
            }
            className={inputCls}
          >
            <option value="SINGLE">Single or married filing separately</option>
            <option value="MARRIED_FILING_JOINTLY">Married filing jointly</option>
            <option value="HEAD_OF_HOUSEHOLD">Head of household</option>
          </select>
        </Field>

        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={multipleJobs}
            onChange={(e) => setMultipleJobs(e.target.checked)}
          />
          I have multiple jobs or my spouse works (check Step 2 box)
        </label>

        <div className="grid grid-cols-2 gap-4">
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

        <Field
          label="Social Security number"
          hint="9 digits. Encrypted at rest. Optional in Phase 4 demo."
        >
          <input
            type="text"
            inputMode="numeric"
            pattern="\d{3}-?\d{2}-?\d{4}"
            placeholder="123-45-6789"
            value={ssn}
            onChange={(e) => setSsn(e.target.value)}
            className={inputCls}
            autoComplete="off"
          />
        </Field>

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
