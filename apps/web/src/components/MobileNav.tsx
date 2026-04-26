import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { MODULES } from '@/lib/modules';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

export function MobileNav({ open, onClose }: MobileNavProps) {
  const { can } = useAuth();
  const visible = MODULES.filter((m) => can(m.requires));

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Main navigation"
    >
      <div
        className="absolute inset-0 bg-midnight/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="absolute left-0 top-0 h-full w-72 bg-navy border-r border-navy-secondary flex flex-col">
        <div className="px-6 py-5 border-b border-navy-secondary flex items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl text-gold leading-none">Alto People</h1>
            <p className="text-xs text-silver mt-1 tracking-widest uppercase">
              Workforce Management
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-silver hover:text-white text-3xl leading-none -mt-1 -mr-2 px-2"
            aria-label="Close menu"
          >
            ×
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-3" onClick={onClose}>
          <MobileLink to="/" end label="Dashboard" />
          {visible.map((m) => (
            <MobileLink key={m.key} to={m.path} label={m.label} />
          ))}
        </nav>
      </aside>
    </div>
  );
}

interface MobileLinkProps {
  to: string;
  label: string;
  end?: boolean;
}

function MobileLink({ to, label, end }: MobileLinkProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'block px-6 py-3 text-sm border-l-2',
          isActive
            ? 'bg-navy-secondary text-gold border-gold'
            : 'border-transparent text-silver'
        )
      }
    >
      {label}
    </NavLink>
  );
}
