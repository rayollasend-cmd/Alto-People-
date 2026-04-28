import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import type {
  AcceptInviteResponse,
  InviteSummary,
} from '@alto-people/shared';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import { Logo } from '@/components/Logo';

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
  const [submitting, setSubmitting] = useState(false);

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
      const dest = res?.nextPath && res.nextPath.startsWith('/') ? res.nextPath : '/';
      window.location.assign(dest);
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
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-br from-midnight via-navy to-navy-secondary">
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

        <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 shadow-2xl">
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
              <h2 className="font-display text-2xl md:text-3xl text-white mb-3">
                Invitation problem
              </h2>
              <div
                role="alert"
                className="mb-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
              >
                {error}
              </div>
              <Button variant="ghost" onClick={() => navigate('/login')}>
                Go to sign in
              </Button>
            </>
          )}

          {!loading && invite && (
            <form onSubmit={handleSubmit} noValidate>
              <h2 className="font-display text-2xl md:text-3xl text-white mb-1">
                {invite.firstName ? `Welcome, ${invite.firstName}` : 'Welcome'}
              </h2>
              <p className="text-silver text-sm mb-1">
                Set a password to access your onboarding tasks.
              </p>
              <p className="text-silver/60 text-xs mb-6">{invite.email}</p>

              <div className="mb-4">
                <Label htmlFor="invite-password" required>
                  Password
                </Label>
                <div className="relative">
                  <Lock
                    className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/60 pointer-events-none"
                    aria-hidden="true"
                  />
                  <Input
                    id="invite-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <FormHint>Minimum 12 characters.</FormHint>
              </div>

              <div className="mb-2">
                <Label htmlFor="invite-confirm" required>
                  Confirm password
                </Label>
                <div className="relative">
                  <Lock
                    className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/60 pointer-events-none"
                    aria-hidden="true"
                  />
                  <Input
                    id="invite-confirm"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    value={confirm}
                    invalid={!!confirm && password !== confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="pl-9"
                  />
                </div>
                {confirm && password !== confirm && (
                  <FormHint variant="error">Passwords don't match.</FormHint>
                )}
              </div>

              {error && (
                <div
                  role="alert"
                  className="mt-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
                >
                  {error}
                </div>
              )}

              <Button
                type="submit"
                size="lg"
                loading={submitting}
                disabled={!passwordOk}
                className="w-full mt-4"
              >
                {submitting ? 'Setting up…' : 'Set password & sign in'}
              </Button>
              <p className="text-[10px] text-silver/60 text-center mt-4">
                This link expires {new Date(invite.expiresAt).toLocaleString()}.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
