import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Eye, EyeOff, Lock, ShieldCheck } from '@/components/ui/icons';
import { ApiError, NetworkError, apiFetch } from '@/lib/api';
import { LinkProblem } from '@/components/LinkProblem';
import { Skeleton } from '@/components/ui/Skeleton';
import { useFocusFirstError } from '@/lib/useFocusFirstError';
import { AuthCardTitle, AuthShell } from '@/components/ui/AuthHeading';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

/**
 * "ok" once the 12-char floor is met; "strong" when it also mixes upper +
 * lower case and a digit. Deliberately simple — the server only enforces
 * length, this is a nudge, not a gate.
 */
function passwordStrength(pw: string): 'ok' | 'strong' | null {
  if (pw.length < 12) return null;
  return /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw)
    ? 'strong'
    : 'ok';
}

/** Eye toggle rendered inside a password field's right edge. */
function ShowPasswordToggle({
  shown,
  onToggle,
}: {
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? 'Hide password' : 'Show password'}
      className="absolute right-2.5 coarse:right-1 top-1/2 -translate-y-1/2 p-1 coarse:p-2.5 rounded text-silver/70 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      {shown ? (
        <EyeOff className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Eye className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}

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
  // Ask first whether the link still works (non-consuming), so a dead link
  // says so up front — not after two 12-character passwords (F500 G5).
  const check = useQuery({
    queryKey: ['auth', 'reset-link', token],
    queryFn: () => apiFetch<{ email: string; expiresAt: string }>(`/auth/reset-password/${encodeURIComponent(token)}`),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  });
  const linkState: 'checking' | 'ok' | 'expired' | 'invalid' | 'unknown' = !token
    ? 'invalid'
    : check.isPending
      ? 'checking'
      : check.data
        ? 'ok'
        : check.error instanceof ApiError && check.error.status === 410
          ? 'expired'
          : check.error instanceof ApiError && check.error.status === 404
            ? 'invalid'
            : 'unknown';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const formRef = useFocusFirstError<HTMLFormElement>(error);

  const tooShort = password.length > 0 && password.length < 12;
  const mismatch = confirm.length > 0 && password !== confirm;
  const strength = passwordStrength(password);
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
        setError('expired');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Couldn't reset the password. Try again in a minute.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const newLink = (
    <Button asChild size="lg" className="w-full sm:w-auto">
      <Link to="/forgot-password">Send me a new link</Link>
    </Button>
  );

  if (linkState === 'checking') {
    return (
      <AuthShell>
        <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3" aria-busy="true">
          <AuthCardTitle>New password</AuthCardTitle>
          <Skeleton className="h-4 w-3/4 mb-6" />
          <Skeleton className="h-10 w-full mb-3" />
          <Skeleton className="h-10 w-full" />
        </div>
      </AuthShell>
    );
  }
  if (linkState === 'expired' || linkState === 'invalid') {
    return (
      <AuthShell>
        <LinkProblem
          kind={linkState}
          title={linkState === 'expired' ? 'This reset link has expired' : 'This reset link isn’t valid'}
          reason={
            linkState === 'expired'
              ? 'Reset links work for one hour, and only once. Ask for a new one — it takes a minute.'
              : 'It may have been cut off or mistyped. Ask for a new one — it takes a minute.'
          }
          action={newLink}
        >
          <Link to="/login" className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to sign in
          </Link>
        </LinkProblem>
      </AuthShell>
    );
  }

  return (
    <AuthShell>

      {done ? (
        <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3 animate-zoom-in text-center">
          <ShieldCheck className="mx-auto h-12 w-12 text-success mb-4" />
          <AuthCardTitle size="md">Password updated</AuthCardTitle>
          <p className="text-silver text-sm mb-6">
            Sending you to sign in…
          </p>
        </div>
      ) : (
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3 animate-zoom-in"
          noValidate
        >
          <AuthCardTitle>New password</AuthCardTitle>
          <p className="text-silver text-sm mb-6">
            {check.data ? (
              <>
                For <span className="text-ink" data-testid="reset-email">{check.data.email}</span>.{' '}
              </>
            ) : null}
            Pick something you don't use on other sites. Minimum 12
            characters.
          </p>

          <div className="space-y-4">
            <Field
              label="New password"
              required
              hint={
                tooShort
                  ? `Need ${12 - password.length} more character${12 - password.length === 1 ? '' : 's'}.`
                  : strength === 'strong'
                    ? 'Strength: strong.'
                    : strength === 'ok'
                      ? 'Strength: ok — mix upper and lower case with a number to make it strong.'
                      : 'Minimum 12 characters.'
              }
            >
              {(p) => (
                <div className="relative">
                  <Lock
                    className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/70 pointer-events-none"
                    aria-hidden="true"
                  />
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    minLength={12}
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9 pr-10"
                    {...p}
                  />
                  <ShowPasswordToggle
                    shown={showPassword}
                    onToggle={() => setShowPassword((v) => !v)}
                  />
                </div>
              )}
            </Field>

            <Field
              label="Confirm new password"
              required
              error={mismatch ? "Passwords don't match." : undefined}
            >
              {(p) => (
                <div className="relative">
                  <Lock
                    className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/70 pointer-events-none"
                    aria-hidden="true"
                  />
                  <Input
                    type={showConfirm ? 'text' : 'password'}
                    autoComplete="new-password"
                    minLength={12}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="pl-9 pr-10"
                    {...p}
                  />
                  <ShowPasswordToggle
                    shown={showConfirm}
                    onToggle={() => setShowConfirm((v) => !v)}
                  />
                </div>
              )}
            </Field>
          </div>

          {error === 'expired' ? (
            // The submit-time answer offers the action, not directions to it.
            <ErrorBanner className="mt-4">
              This reset link has expired or was already used.{' '}
              <Link to="/forgot-password" className="font-medium underline underline-offset-2">
                Send me a new link
              </Link>
            </ErrorBanner>
          ) : (
            error && <ErrorBanner className="mt-4">{error}</ErrorBanner>
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

    </AuthShell>
  );
}

export default ResetPassword;
