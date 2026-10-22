import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, Mail, ShieldCheck } from 'lucide-react';
import { ApiError, NetworkError, apiFetch } from '@/lib/api';
import { useFocusFirstError } from '@/lib/useFocusFirstError';
import { AuthCardTitle, AuthShell } from '@/components/ui/AuthHeading';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

/**
 * Public — kicks off the password-reset flow. The API ALWAYS returns
 * 200 regardless of whether the email exists, so this page does the
 * same: success state appears no matter what was typed. Account
 * enumeration via "user found / user not found" UX is the leak we're
 * defending against.
 */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const formRef = useFocusFirstError<HTMLFormElement>(error);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim() },
      });
      setDone(true);
    } catch (err) {
      if (err instanceof NetworkError) {
        setError('Network error — check your connection and try again.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many reset requests. Try again in an hour.");
      } else {
        // Other backend errors are rare here (the route is permissive);
        // surface a generic message instead of dumping the code.
        setError("Couldn't send the reset email. Try again in a minute.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell>

      {done ? (
        <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3 animate-zoom-in text-center">
          <ShieldCheck className="mx-auto h-12 w-12 text-success mb-4" />
          <AuthCardTitle size="md">Check your email</AuthCardTitle>
          <p className="text-silver text-sm mb-6">
            If an Alto People account exists for{' '}
            <span className="text-white">{email.trim()}</span>, a reset link
            is on its way. The link works once and expires in 1 hour.
          </p>
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-gold hover:text-gold-bright text-sm"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back to sign in
          </Link>
        </div>
      ) : (
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3 animate-zoom-in"
          noValidate
        >
          <AuthCardTitle>Forgot password?</AuthCardTitle>
          <p className="text-silver text-sm mb-6">
            Enter the email tied to your Alto People account. We'll send a
            link that lets you choose a new password.
          </p>

          <Field label="Email" required>
            {(p) => (
              <div className="relative">
                <Mail
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/70 pointer-events-none"
                  aria-hidden="true"
                />
                <Input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-9"
                  {...p}
                />
              </div>
            )}
          </Field>

          {error && <ErrorBanner className="mt-4">{error}</ErrorBanner>}

          <Button
            type="submit"
            size="lg"
            disabled={!email || submitting}
            loading={submitting}
            className="w-full mt-6"
          >
            {submitting ? 'Sending…' : 'Send reset link'}
          </Button>

          <div className="mt-6 text-center">
            <Link
              to="/login"
              className="inline-flex items-center gap-1.5 text-silver hover:text-white text-sm"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back to sign in
            </Link>
          </div>
        </form>
      )}

    </AuthShell>
  );
}

export default ForgotPassword;
