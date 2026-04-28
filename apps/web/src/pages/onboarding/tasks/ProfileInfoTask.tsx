import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { submitProfile } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';

const STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

export function ProfileInfoTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dob, setDob] = useState('');
  const [phone, setPhone] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('FL');
  const [zip, setZip] = useState('');
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
      await submitProfile(applicationId, {
        firstName,
        lastName,
        dob: dob ? new Date(dob).toISOString() : null,
        phone: phone || null,
        addressLine1: addressLine1 || null,
        addressLine2: addressLine2 || null,
        city: city || null,
        state: state || null,
        zip: zip || null,
      });
      navigate(backTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submission failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TaskShell title="Profile information" backTo={backTo}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="First name">
            <input
              type="text"
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Last name">
            <input
              type="text"
              required
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Date of birth">
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Phone">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        <Field label="Address line 1">
          <input
            type="text"
            value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Address line 2">
          <input
            type="text"
            value={addressLine2}
            onChange={(e) => setAddressLine2(e.target.value)}
            className={inputCls}
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="sm:col-span-2">
            <Field label="City">
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="State">
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className={inputCls}
            >
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ZIP">
            <input
              type="text"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              className={inputCls}
              maxLength={10}
            />
          </Field>
        </div>

        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}

        <SubmitRow submitting={submitting} backTo={backTo} />
      </form>
    </TaskShell>
  );
}

/* Shared bits exported so the other task forms reuse them ---------------- */

export const inputCls =
  'w-full px-3 py-2 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-widest text-silver mb-1.5">
        {label}
      </span>
      {children}
      {hint && <span className="block text-xs text-silver/60 mt-1">{hint}</span>}
    </label>
  );
}

export function SubmitRow({
  submitting,
  backTo,
  label = 'Save',
}: {
  submitting: boolean;
  backTo: string;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <Button type="submit" loading={submitting} disabled={submitting}>
        {submitting ? 'Saving…' : label}
      </Button>
      <Link to={backTo} className="text-sm text-silver hover:text-white">
        Cancel
      </Link>
    </div>
  );
}

export function TaskShell({
  title,
  children,
  backTo,
}: {
  title: string;
  children: React.ReactNode;
  backTo: string;
}) {
  return (
    <div className="max-w-2xl mx-auto">
      <Link
        to={backTo}
        className="text-sm text-silver hover:text-gold inline-block mb-3"
      >
        ← Back to checklist
      </Link>
      <h1 className="font-display text-3xl md:text-4xl text-white mb-6">
        {title}
      </h1>
      <div className="bg-navy border border-navy-secondary rounded-lg p-5 md:p-6">
        {children}
      </div>
    </div>
  );
}
