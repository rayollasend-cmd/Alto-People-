import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/roles';

interface TopbarProps {
  onOpenMobileNav: () => void;
}

export function Topbar({ onOpenMobileNav }: TopbarProps) {
  const { role, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = () => {
    signOut();
    navigate('/login', { replace: true });
  };

  return (
    <header className="bg-navy border-b border-navy-secondary px-4 md:px-6 py-3 flex items-center gap-3">
      <button
        type="button"
        onClick={onOpenMobileNav}
        className="md:hidden -ml-2 p-2 text-silver hover:text-white"
        aria-label="Open menu"
      >
        <span className="block w-6 h-0.5 bg-current mb-1.5" />
        <span className="block w-6 h-0.5 bg-current mb-1.5" />
        <span className="block w-6 h-0.5 bg-current" />
      </button>

      <div className="md:hidden font-display text-xl text-gold">Alto People</div>

      <div className="flex-1" />

      {role && (
        <>
          <div className="hidden sm:block text-right leading-tight">
            <div className="text-[10px] uppercase tracking-widest text-silver">
              Signed in as
            </div>
            <div className="text-sm text-white">{ROLE_LABELS[role]}</div>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className="text-sm text-silver hover:text-gold transition"
          >
            Sign out
          </button>
        </>
      )}
    </header>
  );
}
