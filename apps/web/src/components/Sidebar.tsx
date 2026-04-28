import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Rows3,
  Rows4,
  Sun,
  User,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from '@/components/Logo';
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
import { Avatar } from '@/components/ui/Avatar';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/Tooltip';
import { openKeyboardShortcuts } from './KeyboardShortcutsDialog';

const GROUP_ORDER: Array<Exclude<ModuleGroup, 'core'>> = [
  'workforce',
  'time-and-pay',
  'compliance',
  'insights',
];

const COLLAPSED_GROUPS_KEY = 'alto.sidebar.collapsedGroups';
const RAIL_COLLAPSED_KEY = 'alto.sidebar.collapsed';

function readCollapsedGroups(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
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

function writeCollapsedGroups(groups: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    /* persistence is best-effort */
  }
}

function readRailCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeRailCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(RAIL_COLLAPSED_KEY, value ? '1' : '0');
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

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readCollapsedGroups());
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => readRailCollapsed());

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      writeCollapsedGroups(next);
      return next;
    });
  }, []);

  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      writeRailCollapsed(next);
      return next;
    });
  }, []);

  // Phase 70 — Cmd/Ctrl + \ toggles the rail. Power-user shortcut, mirrors
  // VS Code / Cursor / Linear.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleRail]);

  return (
    <aside
      className={cn(
        'hidden md:flex shrink-0 flex-col bg-navy border-r border-navy-secondary transition-[width] duration-200 ease-out',
        railCollapsed ? 'w-14' : 'w-64',
      )}
    >
      <SidebarBrand railCollapsed={railCollapsed} onToggleRail={toggleRail} />

      <nav className="flex-1 overflow-y-auto py-2" aria-label="Primary navigation">
        <SidebarLink
          to={DASHBOARD_NAV.path}
          end
          label={DASHBOARD_NAV.label}
          icon={DASHBOARD_NAV.icon}
          railCollapsed={railCollapsed}
        />

        {GROUP_ORDER.map((group) => {
          const items = grouped[group];
          if (!items || items.length === 0) return null;
          const isGroupCollapsed = collapsedGroups.has(group);
          return (
            <SidebarSection
              key={group}
              label={GROUP_LABEL[group]}
              collapsed={isGroupCollapsed}
              onToggle={() => toggleGroup(group)}
              railCollapsed={railCollapsed}
            >
              {items.map((m) => (
                <SidebarLink
                  key={m.key}
                  to={m.path}
                  label={m.label}
                  icon={m.icon}
                  railCollapsed={railCollapsed}
                />
              ))}
            </SidebarSection>
          );
        })}
      </nav>

      <SidebarAccount railCollapsed={railCollapsed} />
    </aside>
  );
}

interface SidebarBrandProps {
  railCollapsed: boolean;
  onToggleRail: () => void;
}

function SidebarBrand({ railCollapsed, onToggleRail }: SidebarBrandProps) {
  return (
    <div
      className={cn(
        'h-14 flex items-center border-b border-navy-secondary shrink-0',
        railCollapsed ? 'justify-center px-0' : 'gap-2 px-4',
      )}
    >
      {!railCollapsed && (
        <>
          <Logo size="sm" alt="Alto HR" />
          <span className="font-display text-lg text-white leading-none tracking-tight truncate">
            Alto <span className="text-gold">People</span>
          </span>
        </>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggleRail}
            aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!railCollapsed}
            aria-keyshortcuts="Control+\\ Meta+\\"
            className={cn(
              'p-1.5 rounded-md text-silver/70 hover:text-white hover:bg-navy-secondary/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
              !railCollapsed && 'ml-auto',
            )}
          >
            {railCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          <span className="ml-2 text-silver/60">⌘\</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

interface SidebarSectionProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  railCollapsed: boolean;
  children: React.ReactNode;
}

function SidebarSection({
  label,
  collapsed,
  onToggle,
  railCollapsed,
  children,
}: SidebarSectionProps) {
  // When the rail is collapsed we drop the section header entirely and just
  // render a thin separator between groups so the icon column stays clean.
  if (railCollapsed) {
    return (
      <div className="mt-2 pt-2 border-t border-navy-secondary/60 first:mt-1 first:pt-0 first:border-t-0">
        {children}
      </div>
    );
  }

  return (
    <div className="mt-3 first:mt-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="w-full flex items-center justify-between px-4 py-1 text-[10px] font-semibold uppercase tracking-widest text-silver/80 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-md"
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
  railCollapsed: boolean;
}

function SidebarLink({ to, label, icon: Icon, end, railCollapsed }: SidebarLinkProps) {
  const link = (
    <NavLink
      to={to}
      end={end}
      aria-label={railCollapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative my-0.5 flex items-center rounded-md text-sm transition-colors',
          // F500 cue: thin gold bar on the left of the active item.
          // Pseudo-element sits inside the link so it doesn't shift sibling layout.
          'before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-r before:bg-gold before:opacity-0 before:transition-opacity',
          railCollapsed
            ? 'mx-2 h-9 w-9 justify-center'
            : 'mx-2 gap-2.5 px-3 py-2',
          isActive
            ? 'bg-navy-secondary text-white before:opacity-100'
            : 'text-silver hover:text-white hover:bg-navy-secondary/50',
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!railCollapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );

  if (!railCollapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

interface SidebarAccountProps {
  railCollapsed: boolean;
}

function SidebarAccount({ railCollapsed }: SidebarAccountProps) {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  if (!user) {
    if (railCollapsed) {
      return <div className="h-12 border-t border-navy-secondary" />;
    }
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

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  const displayName = fullName || user.email;
  const avatar = (
    <Avatar
      src={user.photoUrl}
      name={fullName || null}
      email={user.email}
      size="sm"
    />
  );

  const trigger = railCollapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="grid place-items-center h-9 w-9 mx-auto rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            aria-label="Account menu"
          >
            {avatar}
          </button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent side="right">{displayName}</TooltipContent>
    </Tooltip>
  ) : (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-navy-secondary/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        aria-label="Account menu"
      >
        {avatar}
        <div className="min-w-0 flex-1 text-left leading-tight">
          <div className="text-[10px] uppercase tracking-widest text-silver truncate">
            {ROLE_LABELS[user.role]}
          </div>
          <div className="text-sm text-white truncate">{displayName}</div>
        </div>
        <ChevronsUpDown className="h-3.5 w-3.5 text-silver/70 shrink-0" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
  );

  return (
    <div className={cn('border-t border-navy-secondary', railCollapsed ? 'p-2' : 'p-2')}>
      <DropdownMenu>
        {trigger}
        <DropdownMenuContent side="top" align="start" className="min-w-[15rem]">
          <DropdownMenuLabel>{ROLE_LABELS[user.role]}</DropdownMenuLabel>
          <div className="px-2 pb-2 leading-tight">
            {fullName && <div className="text-sm text-white truncate">{fullName}</div>}
            <div className="text-xs text-silver truncate">{user.email}</div>
          </div>
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
            onSelect={(e) => {
              e.preventDefault();
              openKeyboardShortcuts();
            }}
          >
            <Keyboard className="h-4 w-4" />
            Keyboard shortcuts
            <span className="ml-auto text-[10px] font-mono text-silver/80 border border-navy-secondary rounded px-1">
              ?
            </span>
          </DropdownMenuItem>
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

