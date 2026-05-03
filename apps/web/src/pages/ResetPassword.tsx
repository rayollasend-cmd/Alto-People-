import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Lock, ShieldCheck } from 'lucide-react';
import { ApiError, NetworkError, apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';

/**
 * Public — finishes the password-reset flow. The token comes from the URL
 * (the link the user clicked from their email). On success we don't auto-
 * sign-in: the user re-enters credentials on /login. That confirms the new
 * password works before they leave the page and avoids landing them in an
 * authenticated state with a freshly-rotated cookie that any open tab on
 * the same machine would inherit.
 */
export function ResetPassword() {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < 12;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit =
    password.length >= 12 && password === confirm && !submitting && !!token;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/auth/reset-password', {
        method: 'POST',
        body: { token, newPassword: password },
      });
      setDone(true);
      // Bounce to /login after a moment so the user sees the confirmation,
      // then re-authenticates with the new password. 1.5s is enough to read
      // "Password updated" without feeling stuck.
      setTimeout(() => navigate('/login', { replace: true }), 1500);
    } catch (err) {
      if (err instanceof NetworkError) {
        setError('Network error — check your connection and try again.');
      } else if (err instanceof ApiError && err.code === 'invalid_token') {
        setError(
          'This reset link is invalid or expired. Request a new one from the sign-in page.'
        );
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Couldn't reset the password. Try again in a minute.");
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
            Set new password
          </h1>
          <p className="text-silver text-xs md:text-sm tracking-[0.3em] uppercase">
            Alto People
          </p>
        </div>

        {done ? (
          <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 shadow-2xl animate-zoom-in text-center">
            <ShieldCheck className="mx-auto h-12 w-12 text-success mb-4" />
            <h2 className="font-display text-xl md:text-2xl text-white mb-2">
              Password updated
            </h2>
            <p className="text-silver text-sm mb-6">
              Sending you to sign in…
            </p>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 shadow-2xl animate-zoom-in"
            noValidate
          >
            <h2 className="font-display text-2xl md:text-3xl text-white mb-1">
              New password
            </h2>
            <p className="text-silver text-sm mb-6">
              Pick something you don't use on other sites. Minimum 12
              characters.
            </p>

            <div className="space-y-4">
              <div>
                <Label htmlFor="reset-password" required>
                  New password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/60 pointer-events-none" />
                  <Input
                    id="reset-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <FormHint>
                  {tooShort
                    ? `Need ${12 - password.length} more character${12 - password.length === 1 ? '' : 's'}.`
                    : 'Minimum 12 characters.'}
                </FormHint>
              </div>

              <div>
                <Label htmlFor="reset-confirm" required>
                  Confirm new password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/60 pointer-events-none" />
                  <Input
                    id="reset-confirm"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirm}
                    invalid={mismatch}
                    aria-describedby={mismatch ? 'reset-confirm-error' : undefined}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="pl-9"
                  />
                </div>
                {mismatch && (
                  <FormHint id="reset-confirm-error" variant="error">
                    Passwords don't match.
                  </FormHint>
                )}
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
              disabled={!canSubmit}
              loading={submitting}
              className="w-full mt-6"
            >
              {submitting ? 'Updating…' : 'Update password'}
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

export default ResetPassword;
