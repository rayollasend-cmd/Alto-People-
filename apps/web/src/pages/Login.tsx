import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Building2, Eye, EyeOff, Fingerprint, Lock, Mail, ShieldCheck } from 'lucide-react';
import type { MfaEnrollStartResponse } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { safeNextPath } from '@/lib/safeNextPath';
import { passkeysSupported, signInWithPasskey } from '@/lib/webauthn';
import { useI18n } from '@/lib/i18n';
import { ApiError, NetworkError, apiFetch } from '@/lib/api';
import { confirmMfaEnrollment, startMfaEnrollment } from '@/lib/settingsApi';
import { useFocusFirstError } from '@/lib/useFocusFirstError';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';
import { Logo } from '@/components/Logo';
import { Skeleton } from '@/components/ui/Skeleton';

interface LocationState {
  from?: string;
}

const DEFAULT_DEV_EMAIL = import.meta.env.DEV ? 'admin@altohr.com' : '';

type Step = 'password' | 'mfa' | 'enroll';

interface SsoConfig {
  enabled: boolean;
  buttonLabel: string | null;
}

/**
 * The OIDC callback bounces failed sign-ins back here as
 * /login?error=sso_no_account | sso_failed. Deliberately coarse copy —
 * the server never distinguishes "no account" from "disabled" (no status
 * oracle), and the operational detail lives in the audit log.
 */
function ssoErrorMessage(search: string): string | null {
  const code = new URLSearchParams(search).get('error');
  if (code === 'sso_no_account') {
    return 'No Alto account matches your SSO identity — ask your admin to invite you.';
  }
  if (code === 'sso_failed') {
    return 'SSO sign-in failed — try again or use your password.';
  }
  return null;
}

export function Login() {
  const { t } = useI18n();
  const { signIn, submitMfaChallenge, refreshUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(DEFAULT_DEV_EMAIL);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState<Step>('password');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  // Seed the banner from the ?error= query the OIDC callback redirects with.
  const [error, setError] = useState<string | null>(() =>
    ssoErrorMessage(location.search),
  );
  const [submitting, setSubmitting] = useState(false);
  // Org-enforced MFA enrollment (mfaEnrollmentRequired login response).
  // Same building blocks as the Settings enrollment card, driven by the
  // short-lived mfa_enroll cookie instead of a session.
  const [enroll, setEnroll] = useState<MfaEnrollStartResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [enrollCode, setEnrollCode] = useState('');
  const [sso, setSso] = useState<SsoConfig | null>(null);

  // Feature probe alongside initial render. A failed fetch (offline, cold
  // API) just leaves the button hidden — it must never block password login.
  useEffect(() => {
    let cancelled = false;
    apiFetch<SsoConfig>('/auth/oidc/config')
      .then((cfg) => {
        if (!cancelled) setSso(cfg);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const queryNext = new URLSearchParams(location.search).get('next');
  const from = safeNextPath(
    (location.state as LocationState | null)?.from ?? queryNext,
  );

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
      if (res.mfaEnrollmentRequired) {
        setStep('enroll');
        await beginEnrollment();
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof NetworkError) {
        setError(t('login.errNetwork'));
      } else if (err instanceof ApiError && err.status === 429) {
        setError(t('login.errRateLimited'));
      } else if (err instanceof ApiError && err.status >= 500) {
        // Don't blame the user's credentials for a server-side fault — most
        // commonly a transient DB cold-start from Neon. Telling them their
        // password is wrong sends them to the reset flow for no reason.
        setError(t('login.errServer'));
      } else {
        setError(t('login.errInvalid'));
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
        } else if (err.status >= 500) {
          setError("We're having trouble verifying your code. Please try again in a moment.");
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

  // Org-enforced enrollment: fetch a fresh secret + recovery codes. The
  // mfa_enroll cookie set by /auth/login authorizes these two endpoints
  // (and nothing else) for 15 minutes.
  const beginEnrollment = async () => {
    setEnroll(null);
    setQrDataUrl(null);
    setAcknowledged(false);
    setEnrollCode('');
    try {
      const res = await startMfaEnrollment();
      setEnroll(res);
      // Lazy-load qrcode — only paid for by users actually enrolling.
      const { default: QRCode } = await import('qrcode');
      const dataUrl = await QRCode.toDataURL(res.provisioningUri, {
        margin: 1,
        width: 176,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Sign-in expired. Please start again.');
        setStep('password');
        setPassword('');
      } else {
        setError('Could not start setup. Try signing in again.');
        setStep('password');
      }
    }
  };

  const handleEnrollSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // On success the server issues the real session cookie (promotion
      // from the mfa_enroll token) — refreshUser picks it up.
      await confirmMfaEnrollment({ code: enrollCode.trim() });
      await refreshUser();
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof NetworkError) {
        setError('Network error — check your connection and try again.');
      } else if (err instanceof ApiError) {
        if (err.status === 429) {
          setError('Too many code attempts. Try again in a few minutes.');
        } else if (err.code === 'invalid_code') {
          setError('That code is incorrect or expired.');
        } else if (err.status === 401 || err.code === 'no_pending_enrollment') {
          setError('Sign-in expired. Please start again.');
          setStep('password');
          setPassword('');
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

  // Passkey sign-in: possession + on-device biometric in one gesture —
  // no password, no TOTP leg. Needs the email so the server can scope
  // the challenge to that account's registered credentials.
  const handlePasskey = async () => {
    if (submitting) return;
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter your email first, then use your passkey.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await signInWithPasskey(trimmed);
      await refreshUser();
      navigate(from, { replace: true });
    } catch (err) {
      // The user closing the system sheet isn't an error.
      if (err instanceof Error && err.name === 'NotAllowedError') return;
      if (err instanceof NetworkError) {
        setError(t('login.errNetwork'));
      } else {
        setError('Passkey sign-in failed — use your password instead.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmitPassword = !!email && password.length >= 12 && !submitting;
  const formRef = useFocusFirstError<HTMLFormElement>(error);
  const expectedCodeLength = useRecovery ? 11 : 6;
  const canSubmitMfa = code.trim().length === expectedCodeLength && !submitting;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-login-aurora">
      <div className="w-full max-w-md">
        {/* Brand lockup — the most-visited screen in the product was the
            only auth screen with no logo or wordmark. */}
        <div className="text-center mb-8 animate-fade-in">
          <Logo
            size="lg"
            className="mx-auto mb-4 rounded-xl ring-1 ring-gold/25 shadow-[0_8px_32px_rgba(217,185,103,0.15)]"
          />
          <div className="font-display text-4xl md:text-5xl text-white leading-none">
            Alto <span className="text-gold">People</span>
          </div>
          <p className="text-silver/70 text-xs2 tracking-[0.32em] uppercase mt-2">
            {t('login.brandTagline')}
          </p>
        </div>
        {step === 'password' ? (
          <form
            ref={formRef}
            onSubmit={handlePasswordSubmit}
            className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3 ring-1 ring-white/[0.06] animate-zoom-in"
            noValidate
          >
            <h2 className="font-display text-xl text-white mb-1">
              {t('login.title')}
            </h2>
            <p className="text-silver text-sm mb-6">
              {t('login.subtitle')}
            </p>

            <div className="space-y-4">
              <Field label={t('login.email')} required>
                {(p) => (
                  <div className="relative">
                    <Mail
                      className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/70 pointer-events-none"
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
                    {t('login.password')}
                  </Label>
                  <Link
                    to="/forgot-password"
                    className="text-xs text-silver hover:text-gold-bright transition-colors"
                  >
                    {t('login.forgot')}
                  </Link>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/70 pointer-events-none" />
                  <Input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    minLength={12}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 coarse:right-1 top-1/2 -translate-y-1/2 p-1 coarse:p-2.5 rounded text-silver/70 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <FormHint>{t('login.minChars')}</FormHint>
              </div>
            </div>

            {error && <ErrorBanner className="mt-4">{error}</ErrorBanner>}

            <Button
              type="submit"
              size="lg"
              disabled={!canSubmitPassword}
              loading={submitting}
              className="w-full mt-6"
            >
              {submitting ? t('login.signingIn') : t('login.signIn')}
            </Button>

            {(passkeysSupported() || sso?.enabled) && (
              <>
                <div className="my-4 flex items-center gap-3 text-2xs uppercase tracking-widest text-silver/50">
                  <span className="h-px flex-1 bg-navy-secondary" />
                  or
                  <span className="h-px flex-1 bg-navy-secondary" />
                </div>
                <div className="space-y-3">
                  {passkeysSupported() && (
                    /* "Use a passkey", not "Sign in with…": the e2e suite (and
                        anyone else) targets the primary button by /sign in/i,
                        and two matches is a strict-mode violation. */
                    <Button
                      type="button"
                      size="lg"
                      variant="outline"
                      onClick={() => void handlePasskey()}
                      disabled={submitting}
                      className="w-full"
                    >
                      <Fingerprint className="h-4 w-4" />
                      Use a passkey
                    </Button>
                  )}
                  {sso?.enabled && (
                    /* Full-page navigation, not fetch: /auth/oidc/start
                       answers a 302 to the IdP, and the browser must follow
                       it as a top-level document load so the flow cookie and
                       the eventual callback redirect work. */
                    <Button
                      type="button"
                      size="lg"
                      variant="outline"
                      onClick={() => window.location.assign('/api/auth/oidc/start')}
                      disabled={submitting}
                      className="w-full"
                    >
                      <Building2 className="h-4 w-4" />
                      {sso.buttonLabel ?? 'Sign in with SSO'}
                    </Button>
                  )}
                </div>
              </>
            )}

            <div className="mt-6 flex items-center justify-center gap-1.5 text-2xs uppercase tracking-widest text-silver/70">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              {t('login.securedBy')}
            </div>

            {import.meta.env.DEV && (
              <p className="text-center text-xs text-silver/70 mt-4">
                Dev seed: admin@altohr.com / alto-admin-dev
              </p>
            )}
          </form>
        ) : step === 'mfa' ? (
          <form
            onSubmit={handleMfaSubmit}
            className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3 ring-1 ring-white/[0.06] animate-zoom-in"
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
                className="h-14 text-2xl tracking-[0.5em] text-center font-mono"
              />
            </div>

            {error && <ErrorBanner className="mt-4">{error}</ErrorBanner>}

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

            <div className="mt-6 flex items-center justify-center gap-1.5 text-2xs uppercase tracking-widest text-silver/70">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              {t('login.securedBy')}
            </div>
          </form>
        ) : (
          <form
            onSubmit={handleEnrollSubmit}
            className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3 ring-1 ring-white/[0.06] animate-zoom-in"
            noValidate
          >
            <h2 className="font-display text-2xl md:text-3xl text-white mb-1">
              Set up two-step sign-in
            </h2>
            <p className="text-silver text-sm mb-6">
              Your organization requires two-step sign-in for this account.
              Scan the QR code with an authenticator app, save your recovery
              codes, and enter a code to finish signing in.
            </p>

            {enroll ? (
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-4">
                  <div className="shrink-0 self-center sm:self-start">
                    {qrDataUrl ? (
                      <img
                        src={qrDataUrl}
                        alt="Scan with your authenticator app"
                        className="rounded-md border border-navy-secondary bg-white p-2"
                        width={176}
                        height={176}
                      />
                    ) : (
                      <Skeleton className="h-44 w-44" />
                    )}
                  </div>
                  <div className="flex-1 space-y-3 min-w-0">
                    <div>
                      <Label>Manual entry secret</Label>
                      <code className="block rounded-md bg-navy-secondary/60 px-3 py-2 font-mono text-xs text-white break-all">
                        {enroll.secret}
                      </code>
                    </div>
                    <div>
                      <Label>Recovery codes — save these now</Label>
                      <ul className="grid grid-cols-2 gap-1.5 rounded-md bg-navy-secondary/60 p-3 font-mono text-xs text-white">
                        {enroll.recoveryCodes.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                      <FormHint>
                        Each code works once — they are the only way in if you
                        lose your phone.
                      </FormHint>
                    </div>
                  </div>
                </div>
                <label className="flex items-start gap-2 text-sm text-white">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  <span>I&apos;ve saved my recovery codes somewhere safe.</span>
                </label>
                <div>
                  <Label htmlFor="login-enroll-code" required>
                    6-digit code from your authenticator app
                  </Label>
                  <Input
                    id="login-enroll-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    maxLength={6}
                    value={enrollCode}
                    onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="123456"
                    className="font-mono tracking-widest text-center"
                  />
                </div>
              </div>
            ) : (
              <Skeleton className="h-44 w-full" />
            )}

            {error && <ErrorBanner className="mt-4">{error}</ErrorBanner>}

            <Button
              type="submit"
              size="lg"
              disabled={!enroll || !acknowledged || enrollCode.length !== 6 || submitting}
              loading={submitting}
              className="w-full mt-6"
            >
              {submitting ? 'Verifying…' : 'Turn on and sign in'}
            </Button>

            <div className="mt-4 text-right text-xs">
              <button
                type="button"
                onClick={() => {
                  setStep('password');
                  setPassword('');
                  setEnroll(null);
                  setQrDataUrl(null);
                  setEnrollCode('');
                  setAcknowledged(false);
                  setError(null);
                }}
                className="text-silver hover:text-gold-bright transition-colors underline-offset-2 hover:underline"
              >
                Cancel
              </button>
            </div>

            <div className="mt-6 flex items-center justify-center gap-1.5 text-2xs uppercase tracking-widest text-silver/70">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              {t('login.securedBy')}
            </div>
          </form>
        )}

        <p className="text-center text-xs text-silver/70 mt-6">
          Alto Etho LLC d/b/a Alto HR · v0.1.0
        </p>
      </div>
    </div>
  );
}
