import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, Mail, ShieldCheck } from 'lucide-react';
import { ApiError, NetworkError, apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

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
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-login-aurora">
      <div className="w-full max-w-md">
        <div className="text-center mb-8 animate-fade-in">
          <h1 className="font-display text-4xl md:text-5xl text-gold mb-2 leading-none">
            Reset password
          </h1>
          <p className="text-silver text-xs md:text-sm tracking-[0.3em] uppercase">
            Alto People
          </p>
        </div>

        {done ? (
          <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 shadow-2xl animate-zoom-in text-center">
            <ShieldCheck className="mx-auto h-12 w-12 text-success mb-4" />
            <h2 className="font-display text-xl md:text-2xl text-white mb-2">
              Check your email
            </h2>
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
            onSubmit={handleSubmit}
            className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 shadow-2xl animate-zoom-in"
            noValidate
          >
            <h2 className="font-display text-2xl md:text-3xl text-white mb-1">
              Forgot password?
            </h2>
            <p className="text-silver text-sm mb-6">
              Enter the email tied to your Alto People account. We'll send a
              link that lets you choose a new password.
            </p>

            <div>
              <Label htmlFor="forgot-email" required>
                Email
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/60 pointer-events-none" />
                <Input
                  id="forgot-email"
                  type="email"
                  autoComplete="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            {error && (
              <div
                className="mt-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
                role="alert"
              >
                {error}
              </div>
            )}

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

        <p className="text-center text-xs text-silver/60 mt-6">
          Alto Etho LLC d/b/a Alto HR · v0.1.0
        </p>
      </div>
    </div>
  );
}

export default ForgotPassword;
