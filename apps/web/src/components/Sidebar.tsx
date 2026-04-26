import { NavLink } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { DASHBOARD_NAV, MODULES } from '@/lib/modules';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';

export function Sidebar() {
  const { can } = useAuth();
  const visible = MODULES.filter((m) => can(m.requires));

  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col bg-navy border-r border-navy-secondary">
      <div className="px-6 py-5 border-b border-navy-secondary">
        <h1 className="font-display text-2xl text-gold leading-none">Alto People</h1>
        <p className="text-xs text-silver mt-1 tracking-widest uppercase">
          Workforce Management
        </p>
      </div>

      <nav className="flex-1 overflow-y-auto py-3" aria-label="Primary navigation">
        <SidebarLink to={DASHBOARD_NAV.path} end label={DASHBOARD_NAV.label} icon={DASHBOARD_NAV.icon} />
        {visible.map((m) => (
          <SidebarLink key={m.key} to={m.path} label={m.label} icon={m.icon} />
        ))}
      </nav>

      <div className="px-6 py-4 border-t border-navy-secondary text-xs text-silver/70">
        Alto Etho LLC · v0.1.0
      </div>
    </aside>
  );
}

interface SidebarLinkProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

function SidebarLink({ to, label, icon: Icon, end }: SidebarLinkProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-6 py-2.5 text-sm border-l-2 transition-colors',
          isActive
            ? 'bg-navy-secondary text-gold border-gold'
            : 'border-transparent text-silver hover:text-white hover:bg-navy-secondary/60'
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </NavLink>
  );
}
