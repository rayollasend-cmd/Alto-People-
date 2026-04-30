import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Lock, Mail, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { ApiError, NetworkError } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';

interface LocationState {
  from?: string;
}

const DEFAULT_DEV_EMAIL = import.meta.env.DEV ? 'admin@altohr.com' : '';

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(DEFAULT_DEV_EMAIL);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const from = (location.state as LocationState | null)?.from ?? '/';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
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

  const canSubmit = !!email && password.length >= 12 && !submitting;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-login-aurora">
      <div className="w-full max-w-md">
        <div className="text-center mb-8 animate-fade-in">
          <Logo size="xl" className="mx-auto mb-4 rounded-xl" alt="Alto People" />
          <h1 className="font-display text-5xl md:text-6xl text-gold mb-2 leading-none">
            Alto People
          </h1>
          <p className="text-silver text-xs md:text-sm tracking-[0.3em] uppercase">
            Workforce Management Platform
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
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
            <div>
              <Label htmlFor="login-email" required>
                Email
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/60 pointer-events-none" />
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="login-password" required>
                Password
              </Label>
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
            <div className="mt-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm" role="alert">
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

        <p className="text-center text-xs text-silver/60 mt-6">
          Alto Etho LLC d/b/a Alto HR · v0.1.0
        </p>
      </div>
    </div>
  );
}
