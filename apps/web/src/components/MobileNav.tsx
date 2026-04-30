import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { Briefcase, X, type LucideIcon } from 'lucide-react';
import {
  DASHBOARD_NAV,
  GROUP_LABEL,
  MODULES,
  type ModuleGroup,
  type ModuleNav,
} from '@/lib/modules';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';

const GROUP_ORDER: Array<Exclude<ModuleGroup, 'core'>> = [
  'workforce',
  'time-and-pay',
  'compliance',
  'insights',
];

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

export function MobileNav({ open, onClose }: MobileNavProps) {
  const { can } = useAuth();
  const visible = MODULES.filter((m) => can(m.requires));

  const grouped: Partial<Record<ModuleGroup, ModuleNav[]>> = {};
  for (const m of visible) {
    (grouped[m.group] ??= []).push(m);
  }

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
        className="absolute inset-0 bg-backdrop backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="absolute left-0 top-0 h-full w-72 bg-navy border-r border-navy-secondary flex flex-col animate-slide-in-from-right">
        <div className="px-4 h-14 flex items-center justify-between gap-3 border-b border-navy-secondary">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="h-7 w-7 rounded-md bg-gold/15 border border-gold/40 grid place-items-center shrink-0"
              aria-hidden="true"
            >
              <Briefcase className="h-3.5 w-3.5 text-gold" />
            </div>
            <span className="font-display text-lg text-white leading-none tracking-tight truncate">
              Alto <span className="text-gold">People</span>
            </span>
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

        <nav className="flex-1 overflow-y-auto py-2" onClick={onClose}>
          <MobileLink to={DASHBOARD_NAV.path} end label={DASHBOARD_NAV.label} icon={DASHBOARD_NAV.icon} />
          {GROUP_ORDER.map((group) => {
            const items = grouped[group];
            if (!items || items.length === 0) return null;
            return (
              <div key={group} className="mt-3">
                <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-widest text-silver/60">
                  {GROUP_LABEL[group]}
                </div>
                {items.map((m) => (
                  <MobileLink key={m.key} to={m.path} label={m.label} icon={m.icon} />
                ))}
              </div>
            );
          })}
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
          'relative mx-2 my-0.5 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors',
          'before:absolute before:left-0 before:top-2 before:bottom-2 before:w-0.5 before:rounded-r before:bg-gold before:opacity-0 before:transition-opacity',
          isActive
            ? 'bg-navy-secondary text-white before:opacity-100'
            : 'text-silver hover:text-white hover:bg-navy-secondary/50'
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}
