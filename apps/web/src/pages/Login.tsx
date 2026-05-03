import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Lock, Mail, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { ApiError, NetworkError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';

interface LocationState {
  from?: string;
}

const DEFAULT_DEV_EMAIL = import.meta.env.DEV ? 'admin@altohr.com' : '';

type Step = 'password' | 'mfa';

export function Login() {
  const { signIn, submitMfaChallenge } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(DEFAULT_DEV_EMAIL);
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<Step>('password');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const queryNext = new URLSearchParams(location.search).get('next');
  const safeNext =
    queryNext && queryNext.startsWith('/') && !queryNext.startsWith('//')
      ? queryNext
      : null;
  const from =
    (location.state as LocationState | null)?.from ?? safeNext ?? '/';

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await signIn(email.trim(), password);
      if (res.mfaRequired) {
        setStep('mfa');
        setCode('');
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof NetworkError) {
        setError('Network error — check your connection and try again.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many login attempts. Please wait a minute and try again.');
      } else {
        setError('Invalid email or password.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleMfaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await submitMfaChallenge({ code: code.trim() });
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof NetworkError) {
        setError('Network error — check your connection and try again.');
      } else if (err instanceof ApiError) {
        if (err.status === 429) {
          setError('Too many code attempts. Try again in a few minutes.');
        } else if (err.code === 'mfa_pending_missing' || err.code === 'mfa_state_invalid') {
          setError('Sign-in expired. Please start again.');
          setStep('password');
          setPassword('');
          setCode('');
        } else if (err.code === 'invalid_code') {
          setError('That code is incorrect or expired.');
        } else {
          setError('Could not verify code.');
        }
      } else {
        setError('Could not verify code.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmitPassword = !!email && password.length >= 12 && !submitting;
  const expectedCodeLength = useRecovery ? 11 : 6;
  const canSubmitMfa = code.trim().length === expectedCodeLength && !submitting;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-login-aurora">
      <div className="w-full max-w-md">
        {step === 'password' ? (
          <form
            onSubmit={handlePasswordSubmit}
            className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 shadow-2xl animate-zoom-in"
            noValidate
          >
            <h2 className="font-display text-2xl md:text-3xl text-white mb-1">
              Sign in
            </h2>
            <p className="text-silver text-sm mb-6">
              Use your Alto HR credentials.
            </p>

            <div className="space-y-4">
              <Field label="Email" required>
                {(p) => (
                  <div className="relative">
                    <Mail
                      className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/60 pointer-events-none"
                      aria-hidden="true"
                    />
                    <Input
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-9"
                      {...p}
                    />
                  </div>
                )}
              </Field>

              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor="login-password" required>
                    Password
                  </Label>
                  <Link
                    to="/forgot-password"
                    className="text-xs text-silver hover:text-gold-bright transition-colors"
                  >
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/60 pointer-events-none" />
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    minLength={12}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <FormHint>Minimum 12 characters.</FormHint>
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
              disabled={!canSubmitPassword}
              loading={submitting}
              className="w-full mt-6"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>

            <div className="mt-6 flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-widest text-silver/60">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              Secured by Alto HR
            </div>

            {import.meta.env.DEV && (
              <p className="text-center text-xs text-silver/60 mt-4">
                Dev seed: admin@altohr.com / alto-admin-dev
              </p>
            )}
          </form>
        ) : (
          <form
            onSubmit={handleMfaSubmit}
            className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 shadow-2xl animate-zoom-in"
            noValidate
          >
            <h2 className="font-display text-2xl md:text-3xl text-white mb-1">
              Two-step sign-in
            </h2>
            <p className="text-silver text-sm mb-6">
              {useRecovery
                ? 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each code works once.'
                : 'Enter the 6-digit code from your authenticator app.'}
            </p>

            <div>
              <Label htmlFor="login-mfa-code" required>
                {useRecovery ? 'Recovery code' : 'Authenticator code'}
              </Label>
              <Input
                id="login-mfa-code"
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={useRecovery ? 11 : 6}
                value={code}
                onChange={(e) => {
                  const v = useRecovery
                    ? e.target.value.toLowerCase()
                    : e.target.value.replace(/\D/g, '');
                  setCode(v);
                }}
                placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'}
                className="font-mono tracking-widest text-center"
              />
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
              disabled={!canSubmitMfa}
              loading={submitting}
              className="w-full mt-6"
            >
              {submitting ? 'Verifying…' : 'Verify and sign in'}
            </Button>

            <div className="mt-4 flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setCode('');
                  setError(null);
                }}
                className="text-silver hover:text-gold-bright transition-colors underline-offset-2 hover:underline"
              >
                {useRecovery ? 'Use authenticator code instead' : 'Use a recovery code instead'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep('password');
                  setPassword('');
                  setCode('');
                  setUseRecovery(false);
                  setError(null);
                }}
                className="text-silver hover:text-gold-bright transition-colors underline-offset-2 hover:underline"
              >
                Cancel
              </button>
            </div>

            <div className="mt-6 flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-widest text-silver/60">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              Secured by Alto HR
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
