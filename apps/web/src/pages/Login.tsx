import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import {
  HUMAN_ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  type Role,
} from '@/lib/roles';
import { cn } from '@/lib/cn';

interface LocationState {
  from?: string;
}

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [selected, setSelected] = useState<Role | null>(null);

  const from = (location.state as LocationState | null)?.from ?? '/';

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    signIn(selected);
    navigate(from, { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-br from-midnight via-navy to-navy-secondary">
      <div className="w-full max-w-2xl">
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
        >
          <h2 className="font-display text-2xl md:text-3xl text-white mb-1">
            Choose your role
          </h2>
          <p className="text-silver text-sm mb-6">
            Phase 1 mock login — pick a role to preview the navigation it sees.
            Real authentication arrives in Phase 3.
          </p>

          <div className="grid sm:grid-cols-2 gap-3 mb-6">
            {HUMAN_ROLES.map((r) => {
              const isActive = selected === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setSelected(r)}
                  className={cn(
                    'text-left p-4 rounded border transition',
                    isActive
                      ? 'border-gold bg-gold/10 ring-1 ring-gold'
                      : 'border-navy-secondary hover:border-silver/40 bg-navy-secondary/40'
                  )}
                >
                  <div className="font-medium text-white">{ROLE_LABELS[r]}</div>
                  <div className="text-xs text-silver mt-1 leading-snug">
                    {ROLE_DESCRIPTIONS[r]}
                  </div>
                </button>
              );
            })}
          </div>

          <button
            type="submit"
            disabled={!selected}
            className={cn(
              'w-full py-3 rounded font-medium transition',
              selected
                ? 'bg-gold text-navy hover:bg-gold-bright'
                : 'bg-navy-secondary text-silver/50 cursor-not-allowed'
            )}
          >
            Continue
          </button>
        </form>

        <p className="text-center text-xs text-silver/60 mt-6">
          Alto Etho LLC d/b/a Alto HR · v0.1.0
        </p>
      </div>
    </div>
  );
}
