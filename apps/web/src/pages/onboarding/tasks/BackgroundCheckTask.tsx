import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { authorizeBackgroundCheck } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { TaskShell, inputCls, Field } from './ProfileInfoTask';
import { Button } from '@/components/ui/Button';

const DISCLOSURE = [
  'As part of your onboarding, your employer will run a routine background check through a third-party consumer reporting agency. This may include a review of your criminal history, employment history, education, and identity verification.',
  '',
  'Under the federal Fair Credit Reporting Act (FCRA), you have the right to:',
  ' • Receive a copy of the report.',
  ' • Dispute the accuracy or completeness of any information in the report.',
  ' • Withdraw your consent at any time before the report is requested.',
  '',
  'A "Summary of Your Rights Under the FCRA" is available on request. By typing your full legal name and clicking "Authorize", you confirm that the information you have provided is accurate and you authorize this background check to be performed.',
].join('\n');

export function BackgroundCheckTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [typedName, setTypedName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!applicationId || submitting) return;
    if (!typedName.trim()) {
      setError('Type your full legal name to authorize.');
      return;
    }
    if (!accepted) {
      setError('Check the box to confirm you authorize the background check.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await authorizeBackgroundCheck(applicationId, {
        typedName: typedName.trim(),
        authorize: true,
      });
      toast.success('Background check authorized');
      navigate(backTo, { replace: true });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'name_mismatch') {
        setError(
          'The name you typed does not match what we have on file. Type your name as it appears on your government ID.'
        );
      } else {
        setError(err instanceof ApiError ? err.message : 'Authorization failed.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TaskShell title="Background check authorization" backTo={backTo}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-md border border-navy-secondary bg-navy-secondary/40 p-4 text-sm text-silver whitespace-pre-line leading-relaxed">
          {DISCLOSURE}
        </div>

        <label className="flex items-start gap-2 text-sm text-silver">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-navy-secondary bg-navy text-gold focus:ring-gold focus:ring-offset-0 cursor-pointer"
          />
          <span>
            I have read and understood the disclosure above. I authorize a
            background check to be performed and confirm the information I
            have provided is accurate.
          </span>
        </label>

        <Field label="Type your full legal name (acts as your signature)">
          <input
            type="text"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            className={inputCls}
            placeholder="First Last"
            autoComplete="name"
            required
          />
        </Field>

        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            loading={submitting}
            disabled={submitting || !accepted || !typedName.trim()}
          >
            {!submitting && <ShieldCheck className="h-4 w-4" />}
            {submitting ? 'Authorizing…' : 'Authorize background check'}
          </Button>
          <Link to={backTo} className="text-sm text-silver hover:text-white">
            Cancel
          </Link>
        </div>
      </form>
    </TaskShell>
  );
}
