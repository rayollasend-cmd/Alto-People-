import { useCallback, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Briefcase,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  LogOut,
  Monitor,
  Moon,
  Rows3,
  Rows4,
  Sun,
  User,
  type LucideIcon,
} from 'lucide-react';
import {
  DASHBOARD_NAV,
  GROUP_LABEL,
  MODULES,
  type ModuleGroup,
  type ModuleNav,
} from '@/lib/modules';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { useDensity } from '@/lib/density';
import { ROLE_LABELS } from '@/lib/roles';
import { cn } from '@/lib/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';

const GROUP_ORDER: Array<Exclude<ModuleGroup, 'core'>> = [
  'workforce',
  'time-and-pay',
  'compliance',
  'insights',
];

const COLLAPSED_KEY = 'alto.sidebar.collapsedGroups';

function readCollapsed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    /* ignore — corrupt storage falls back to nothing collapsed */
  }
  return new Set();
}

function writeCollapsed(groups: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...groups]));
  } catch {
    /* persistence is best-effort */
  }
}

export function Sidebar() {
  const { can } = useAuth();
  const visible = MODULES.filter((m) => can(m.requires));

  const grouped: Partial<Record<ModuleGroup, ModuleNav[]>> = {};
  for (const m of visible) {
    (grouped[m.group] ??= []).push(m);
  }

  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed());

  const toggleGroup = useCallback((group: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      writeCollapsed(next);
      return next;
    });
  }, []);

  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col bg-navy border-r border-navy-secondary">
      <SidebarBrand />

      <nav className="flex-1 overflow-y-auto py-2" aria-label="Primary navigation">
        <SidebarLink
          to={DASHBOARD_NAV.path}
          end
          label={DASHBOARD_NAV.label}
          icon={DASHBOARD_NAV.icon}
        />

        {GROUP_ORDER.map((group) => {
          const items = grouped[group];
          if (!items || items.length === 0) return null;
          const isCollapsed = collapsed.has(group);
          return (
            <SidebarSection
              key={group}
              label={GROUP_LABEL[group]}
              collapsed={isCollapsed}
              onToggle={() => toggleGroup(group)}
            >
              {items.map((m) => (
                <SidebarLink key={m.key} to={m.path} label={m.label} icon={m.icon} />
              ))}
            </SidebarSection>
          );
        })}
      </nav>

      <SidebarAccount />
    </aside>
  );
}

function SidebarBrand() {
  return (
    <div className="px-4 h-14 flex items-center gap-2 border-b border-navy-secondary shrink-0">
      <div
        className="h-7 w-7 rounded-md bg-gold/15 border border-gold/40 grid place-items-center"
        aria-hidden="true"
      >
        <Briefcase className="h-3.5 w-3.5 text-gold" />
      </div>
      <span className="font-display text-lg text-white leading-none tracking-tight">
        Alto <span className="text-gold">People</span>
      </span>
    </div>
  );
}

interface SidebarSectionProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function SidebarSection({ label, collapsed, onToggle, children }: SidebarSectionProps) {
  return (
    <div className="mt-3 first:mt-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="w-full flex items-center justify-between px-4 py-1 text-[10px] font-semibold uppercase tracking-widest text-silver/60 hover:text-silver transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-md"
      >
        <span>{label}</span>
        {collapsed ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronUp className="h-3 w-3" aria-hidden="true" />
        )}
      </button>
      {!collapsed && <div className="mt-0.5">{children}</div>}
    </div>
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
          'mx-2 my-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
          isActive
            ? 'bg-navy-secondary text-white'
            : 'text-silver hover:text-white hover:bg-navy-secondary/50',
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

function SidebarAccount() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  // Phase 70 — render a compact "v0.1.0" footer when no user is loaded yet
  // (e.g., on the login page) so the sidebar still terminates cleanly.
  if (!user) {
    return (
      <div className="px-4 py-3 border-t border-navy-secondary text-[10px] uppercase tracking-widest text-silver/50">
        Alto Etho LLC · v0.1.0
      </div>
    );
  }

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
      navigate('/login', { replace: true });
    }
  };

  return (
    <div className="border-t border-navy-secondary p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-navy-secondary/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            aria-label="Account menu"
          >
            <div className="h-8 w-8 rounded-full bg-gold/15 border border-gold/30 grid place-items-center text-gold text-xs font-medium shrink-0">
              {initials(user.email)}
            </div>
            <div className="min-w-0 flex-1 text-left leading-tight">
              <div className="text-[10px] uppercase tracking-widest text-silver truncate">
                {ROLE_LABELS[user.role]}
              </div>
              <div className="text-sm text-white truncate">{user.email}</div>
            </div>
            <ChevronsUpDown className="h-3.5 w-3.5 text-silver/70 shrink-0" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-[15rem]">
          <DropdownMenuLabel>{ROLE_LABELS[user.role]}</DropdownMenuLabel>
          <div className="px-2 pb-2 text-sm text-white truncate">{user.email}</div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              navigate('/settings');
            }}
          >
            <User className="h-4 w-4" />
            Account settings
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {theme === 'dark' ? (
                <Moon className="h-4 w-4" />
              ) : (
                <Sun className="h-4 w-4" />
              )}
              Appearance
              <span className="ml-auto text-xs text-silver capitalize">{theme}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => setTheme('light')}>
                <Sun className="h-4 w-4" />
                Light
                {theme === 'light' && (
                  <span className="ml-auto text-[10px] uppercase tracking-widest text-gold">
                    Active
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTheme('dark')}>
                <Moon className="h-4 w-4" />
                Dark
                {theme === 'dark' && (
                  <span className="ml-auto text-[10px] uppercase tracking-widest text-gold">
                    Active
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled>
                <Monitor className="h-4 w-4" />
                System
                <span className="ml-auto text-[10px] text-silver/60">Soon</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {density === 'comfortable' ? (
                <Rows3 className="h-4 w-4" />
              ) : (
                <Rows4 className="h-4 w-4" />
              )}
              Density
              <span className="ml-auto text-xs text-silver capitalize">{density}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => setDensity('comfortable')}>
                <Rows3 className="h-4 w-4" />
                Comfortable
                {density === 'comfortable' && (
                  <span className="ml-auto text-[10px] uppercase tracking-widest text-gold">
                    Active
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDensity('compact')}>
                <Rows4 className="h-4 w-4" />
                Compact
                {density === 'compact' && (
                  <span className="ml-auto text-[10px] uppercase tracking-widest text-gold">
                    Active
                  </span>
                )}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            onSelect={(e) => {
              e.preventDefault();
              void handleSignOut();
            }}
            disabled={signingOut}
          >
            <LogOut className="h-4 w-4" />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function initials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

