import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/roles';
import { MODULES } from '@/lib/modules';

const KPIS = [
  { label: 'Active associates', value: '—' },
  { label: 'Open shifts', value: '—' },
  { label: 'Fill rate (7d)', value: '—' },
  { label: 'Pending onboarding', value: '—' },
];

export function Dashboard() {
  const { role, can } = useAuth();
  const accessible = MODULES.filter((m) => can(m.requires));

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-8">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          Dashboard
        </h1>
        <p className="text-silver">
          Welcome back. You are signed in as{' '}
          <span className="text-gold">{role ? ROLE_LABELS[role] : ''}</span>.
        </p>
      </header>

      <section
        aria-label="Key performance indicators"
        className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-10"
      >
        {KPIS.map((kpi) => (
          <div
            key={kpi.label}
            className="bg-navy border border-navy-secondary rounded-lg p-4 md:p-5"
          >
            <div className="text-[10px] md:text-xs uppercase tracking-widest text-silver">
              {kpi.label}
            </div>
            <div className="font-display text-3xl md:text-4xl text-gold mt-2 leading-none">
              {kpi.value}
            </div>
          </div>
        ))}
      </section>

      <section>
        <h2 className="font-display text-2xl md:text-3xl text-white mb-4">
          Your modules
        </h2>
        {accessible.length === 0 ? (
          <p className="text-silver">
            No modules are accessible to your role.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {accessible.map((m) => (
              <Link
                key={m.key}
                to={m.path}
                className="block bg-navy border border-navy-secondary rounded-lg p-5 hover:border-gold/40 transition group"
              >
                <div className="font-display text-xl text-gold mb-1 group-hover:text-gold-bright transition">
                  {m.label}
                </div>
                <div className="text-sm text-silver leading-relaxed">
                  {m.description}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
