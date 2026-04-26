import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ApiError, NetworkError } from '@/lib/api';
import { cn } from '@/lib/cn';

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

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-br from-midnight via-navy to-navy-secondary">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="font-display text-5xl md:text-6xl text-gold mb-2 leading-none">
            Alto People
          </h1>
          <p className="text-silver text-xs md:text-sm tracking-[0.3em] uppercase">
            Workforce Management Platform
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 shadow-2xl"
          noValidate
        >
          <h2 className="font-display text-2xl md:text-3xl text-white mb-1">
            Sign in
          </h2>
          <p className="text-silver text-sm mb-6">
            Use your Alto HR credentials.
          </p>

          <label className="block mb-4">
            <span className="block text-xs uppercase tracking-widest text-silver mb-1.5">
              Email
            </span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2.5 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white"
            />
          </label>

          <label className="block mb-2">
            <span className="block text-xs uppercase tracking-widest text-silver mb-1.5">
              Password
            </span>
            <input
              type="password"
              autoComplete="current-password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white"
            />
          </label>

          {error && (
            <p
              role="alert"
              className="text-sm text-alert mt-4 mb-2"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !email || password.length < 12}
            className={cn(
              'w-full py-3 mt-4 rounded font-medium transition',
              submitting || !email || password.length < 12
                ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
                : 'bg-gold text-navy hover:bg-gold-bright'
            )}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          {import.meta.env.DEV && (
            <p className="text-center text-xs text-silver/60 mt-6">
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
