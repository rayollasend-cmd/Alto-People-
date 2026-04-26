import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { X, type LucideIcon } from 'lucide-react';
import { DASHBOARD_NAV, MODULES } from '@/lib/modules';
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
      className="fixed inset-0 z-40 md:hidden animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Main navigation"
    >
      <div
        className="absolute inset-0 bg-midnight/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="absolute left-0 top-0 h-full w-72 bg-navy border-r border-navy-secondary flex flex-col animate-slide-in-from-right">
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
            className="text-silver hover:text-white p-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-3" onClick={onClose}>
          <MobileLink to={DASHBOARD_NAV.path} end label={DASHBOARD_NAV.label} icon={DASHBOARD_NAV.icon} />
          {visible.map((m) => (
            <MobileLink key={m.key} to={m.path} label={m.label} icon={m.icon} />
          ))}
        </nav>
      </aside>
    </div>
  );
}

interface MobileLinkProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

function MobileLink({ to, label, icon: Icon, end }: MobileLinkProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-6 py-3 text-sm border-l-2',
          isActive
            ? 'bg-navy-secondary text-gold border-gold'
            : 'border-transparent text-silver'
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </NavLink>
  );
}
