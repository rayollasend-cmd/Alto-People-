import { useEffect, useState, type FormEvent } from 'react';
import { safeNextPath } from '@/lib/safeNextPath';
import { useNavigate, useParams } from 'react-router-dom';
import { Eye, EyeOff, Lock } from 'lucide-react';
import type {
  AcceptInviteResponse,
  InviteSummary,
} from '@alto-people/shared';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Logo } from '@/components/Logo';
import { fmtDateTime } from '@/lib/format';

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

export function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { signIn: _signIn } = useAuth();   // not used, but keeps the auth context warm
  void _signIn;

  const [invite, setInvite] = useState<InviteSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Self-service renewal shown in the invalid/expired state.
  const [renewEmail, setRenewEmail] = useState('');
  const [renewSubmitting, setRenewSubmitting] = useState(false);
  const [renewSent, setRenewSent] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('Missing invitation token.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<InviteSummary>(`/auth/invite/${encodeURIComponent(token)}`);
        if (cancelled) return;
        setInvite(res);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setError('This invitation is invalid or has expired. Ask HR to resend it.');
        } else {
          setError(err instanceof Error ? err.message : 'Could not load invitation.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const passwordOk = password.length >= 12 && password === confirm;
  const strength = passwordStrength(password);

  const handleRenew = async (e: FormEvent) => {
    e.preventDefault();
    if (renewSubmitting || !renewEmail.trim()) return;
    setRenewSubmitting(true);
    try {
      await apiFetch<{ ok: boolean }>('/auth/invite/renew', {
        method: 'POST',
        body: { email: renewEmail.trim() },
      });
    } catch {
      // Deliberately swallowed — the confirmation below is neutral by design
      // (the server never reveals whether the email has a pending invite).
    } finally {
      setRenewSubmitting(false);
      setRenewSent(true);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || submitting || !passwordOk) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<AcceptInviteResponse>('/auth/accept-invite', {
        method: 'POST',
        body: { token, password },
      });
      // Cookie is set by the server. Force a full reload of the app so the
      // AuthProvider re-runs /auth/me and picks up the new session cleanly.
      // The server tells us where to land — usually the new associate's
      // onboarding checklist; falls back to / for HR-created users.
      // Same guard as the login page's ?next=: a bare startsWith('/')
      // still admits "//evil.com", which is protocol-relative and
      // navigates off-origin.
      window.location.assign(safeNextPath(res?.nextPath));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('This account is already active. Try signing in instead.');
      } else if (err instanceof ApiError && err.status === 404) {
        setError('Invitation expired. Ask HR to resend it.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not accept invitation.');
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-login-aurora">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Logo size="xl" className="mx-auto mb-4 rounded-xl" alt="Alto HR" />
          <h1 className="font-display text-5xl md:text-6xl text-gold mb-2 leading-none">
            Alto People
          </h1>
          <p className="text-silver text-xs md:text-sm tracking-[0.3em] uppercase">
            Welcome aboard
          </p>
        </div>

        <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3">
          {loading && (
            <div>
              <Skeleton className="h-7 w-2/3 mb-3" />
              <Skeleton className="h-4 w-full mb-2" />
              <Skeleton className="h-4 w-1/2 mb-6" />
              <Skeleton className="h-10 w-full mb-3" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}

          {!loading && error && !invite && (
            <>
              <h2 className="text-2xl md:text-3xl text-white mb-3">
                Invitation problem
              </h2>
              <ErrorBanner className="mb-4">{error}</ErrorBanner>

              {renewSent ? (
                <p className="text-silver text-sm mb-4">
                  If that email has a pending invitation, a fresh link is on
                  its way.
                </p>
              ) : (
                <form onSubmit={handleRenew} noValidate className="mb-4">
                  <p className="text-silver text-sm mb-3">
                    Enter your email and we'll send you a fresh invitation
                    link.
                  </p>
                  <Field label="Email" required className="mb-3">
                    {(p) => (
                      <Input
                        type="email"
                        autoComplete="email"
                        inputMode="email"
                        value={renewEmail}
                        onChange={(e) => setRenewEmail(e.target.value)}
                        {...p}
                      />
                    )}
                  </Field>
                  <Button
                    type="submit"
                    loading={renewSubmitting}
                    disabled={renewSubmitting || !renewEmail.trim()}
                    className="w-full"
                  >
                    {renewSubmitting ? 'Sending…' : 'Send me a new link'}
                  </Button>
                </form>
              )}

              <Button variant="ghost" onClick={() => navigate('/login')}>
                Go to sign in
              </Button>
            </>
          )}

          {!loading && invite && (
            <form onSubmit={handleSubmit} noValidate>
              <h2 className="text-2xl md:text-3xl text-white mb-1">
                {invite.firstName ? `Welcome, ${invite.firstName}` : 'Welcome'}
              </h2>
              <p className="text-silver text-sm mb-1">
                Set a password to access your onboarding tasks.
              </p>
              <p className="text-silver/70 text-xs mb-6">{invite.email}</p>

              <Field
                label="Password"
                required
                hint={
                  strength === 'strong'
                    ? 'Strength: strong.'
                    : strength === 'ok'
                      ? 'Strength: ok — mix upper and lower case with a number to make it strong.'
                      : 'Minimum 12 characters.'
                }
                className="mb-4"
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
                label="Confirm password"
                required
                error={
                  confirm && password !== confirm
                    ? "Passwords don't match."
                    : undefined
                }
                className="mb-2"
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

              {error && <ErrorBanner className="mt-4">{error}</ErrorBanner>}

              <Button
                type="submit"
                size="lg"
                loading={submitting}
                disabled={!passwordOk}
                className="w-full mt-4"
              >
                {submitting ? 'Setting up…' : 'Set password & sign in'}
              </Button>
              <p className="text-2xs text-silver/70 text-center mt-4">
                This link expires {fmtDateTime(invite.expiresAt)}.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
