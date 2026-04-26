import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  AcceptInviteResponse,
  InviteSummary,
} from '@alto-people/shared';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';

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
          <h1 className="font-display text-5xl md:text-6xl text-gold mb-2 leading-none">
            Alto People
          </h1>
          <p className="text-silver text-xs md:text-sm tracking-[0.3em] uppercase">
            Welcome aboard
          </p>
        </div>

        <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 shadow-2xl">
          {loading && <p className="text-silver">Loading invitation…</p>}

          {!loading && error && !invite && (
            <>
              <h2 className="font-display text-2xl md:text-3xl text-white mb-3">
                Invitation problem
              </h2>
              <p role="alert" className="text-sm text-alert mb-4">
                {error}
              </p>
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="text-sm text-silver hover:text-gold underline"
              >
                Go to sign in
              </button>
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

              <label className="block mb-4">
                <span className="block text-xs uppercase tracking-widest text-silver mb-1.5">
                  Password
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2.5 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white"
                />
                <span className="block text-[10px] text-silver/60 mt-1">
                  Minimum 12 characters.
                </span>
              </label>

              <label className="block mb-2">
                <span className="block text-xs uppercase tracking-widest text-silver mb-1.5">
                  Confirm password
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full px-3 py-2.5 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white"
                />
                {confirm && password !== confirm && (
                  <span className="block text-[10px] text-alert mt-1">
                    Passwords don't match.
                  </span>
                )}
              </label>

              {error && (
                <p role="alert" className="text-sm text-alert mt-4 mb-2">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting || !passwordOk}
                className={cn(
                  'w-full py-3 mt-4 rounded font-medium transition',
                  submitting || !passwordOk
                    ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
                    : 'bg-gold text-navy hover:bg-gold-bright'
                )}
              >
                {submitting ? 'Setting up…' : 'Set password & sign in'}
              </button>
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
