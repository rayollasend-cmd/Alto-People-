import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Rows3,
  Rows4,
  Star,
  Sun,
  User,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from '@/components/Logo';
import { useI18n } from '@/lib/i18n';
import {
  allDoors,
  applyTerms,
  DASHBOARD_NAV,
  PORTAL_HOME_KEYS,
  doorKeyForPath,
  navShapeFor,
  roleNavLabels,
  visibleModules,
  useActiveNavPath,
  type ModuleNav,
  type NavDoorView,
} from '@/lib/modules';
import { DASHBOARD_ICON, DOOR_ICONS, MODULE_ICONS } from '@/lib/moduleIcons';
import { useAuth, useTenant, useTerm, useRoleLabel } from '@/lib/auth';
import { useInbox } from '@/lib/inboxApi';
import { usePinnedModules, useRecentModules } from '@/lib/navPersonalization';
import { useTheme } from '@/lib/theme';
import { useDensity } from '@/lib/density';
import { prefetchRoute } from '@/lib/prefetch';
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
import { RoleSwitcher } from './RoleSwitcher';

/**
 * The sidebar: a dozen rows, not a hundred.
 *
 *   Home · Inbox · Messages · Relay        the always-on rows
 *   Pinned · Recent                        the person's own shortcuts
 *   Me · People · Hiring · Time … · Settings & trust
 *                                          the DOORS — one row each, which
 *                                          open to the modules behind them
 *
 * lib/modules.navShapeFor decides the shape per role; this file only draws
 * it. A door opens when the page inside it is the current one, and stays
 * the way the person last left it. In the icon rail a door is one icon that
 * opens a menu of its pages.
 */

const SECTIONS_KEY = 'alto.sidebar.collapsedGroups';
/** In the collapsed-sections set: the folded doors' group is open (it starts closed). */
const FOLD_OPEN = '__fold:open';
const OPEN_DOORS_KEY = 'alto.sidebar.openDoors';
const RAIL_COLLAPSED_KEY = 'alto.sidebar.collapsed';

function readStringSet(key: string): Set<string> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    /* ignore — corrupt storage falls back to the default */
  }
  return null;
}

function writeStringSet(key: string, value: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    /* persistence is best-effort */
  }
}

function readRailCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(RAIL_COLLAPSED_KEY);
    // Explicit user choice always wins (the toggle writes '1'/'0').
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    /* fall through to the viewport default */
  }
  // No stored preference: on md–lg (iPad portrait) the expanded rail eats
  // 256px of a 768px screen — a third of the width — so default to the
  // icon rail there and to expanded on true desktops.
  try {
    return !window.matchMedia('(min-width: 1024px)').matches;
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
  const { can, user } = useAuth();
  const tenant = useTenant();
  const term = useTerm();
  const { t: tr } = useI18n();
  const visible = roleNavLabels(
    applyTerms(visibleModules(user?.role, can, { regionId: user?.regionId, modules: tenant.modules, tenantId: tenant.id }), term, tenant.modules),
    user?.role,
    tr,
  );
  const shape = useMemo(() => navShapeFor(visible, user?.role, term), [visible, user?.role, term]);
  const portalHomePaths = useMemo(() => new Set(visible.filter((m) => PORTAL_HOME_KEYS.has(m.key)).map((m) => m.path)), [visible]);
  const activePath = useActiveNavPath();
  const location = useLocation();

  // One request carries every count the rail shows: the Inbox total and,
  // beside each page, what waits there (messages unread, punches to review,
  // applications to approve…). Keyed by the page's path.
  const inbox = useInbox();
  const countByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of inbox.data?.sources ?? []) {
      // Another desk's queue (packages/shared queues.ts) badges nothing here — as on the Inbox.
      if (s.watching) continue;
      const path = s.path.split('?')[0] ?? s.path;
      m.set(path, (m.get(path) ?? 0) + s.count);
    }
    return m;
  }, [inbox.data]);
  const badgeFor = (m: ModuleNav): number | null =>
    m.key === 'inbox' ? (inbox.data?.total ?? null) : (countByPath.get(m.path) ?? null);

  const { pinned, isPinned, togglePin } = usePinnedModules();
  const recents = useRecentModules();

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => readStringSet(SECTIONS_KEY) ?? new Set());
  const toggleSection = useCallback((section: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      writeStringSet(SECTIONS_KEY, next);
      return next;
    });
  }, []);

  // Doors: the one holding the current page is open; the rest are the way
  // the person last left them. A route change into another door opens it
  // without closing the others — moving around should not fold the menu.
  const activeDoor = doorKeyForPath(shape, location.pathname);
  const [openDoors, setOpenDoors] = useState<Set<string>>(
    () => readStringSet(OPEN_DOORS_KEY) ?? new Set(activeDoor ? [activeDoor] : []),
  );
  useEffect(() => {
    if (!activeDoor) return;
    setOpenDoors((prev) => (prev.has(activeDoor) ? prev : new Set([...prev, activeDoor])));
  }, [activeDoor]);
  // Personalized shortcuts above the doors: explicit pins first, then the
  // three most-recent modules a person can't already see on screen — not
  // pinned, not an always-on row, not inside a door that is open, and not
  // the page they are on (it is highlighted in its own place). "Recent"
  // repeated Inbox and Messages and the open Me door's rows (F500 G5).
  const byKey = new Map(visible.map((m) => [m.key, m]));
  const pinnedModules = pinned.map((k) => byKey.get(k)).filter((m): m is ModuleNav => !!m);
  const onScreen = new Set<string>(shape.rows.map((m) => m.key));
  for (const d of allDoors(shape)) {
    if (!openDoors.has(d.key) && d.key !== activeDoor) continue;
    onScreen.add(d.target.key);
    for (const c of d.children) onScreen.add(c.key);
  }
  const recentModules = recents
    .filter((k) => !pinned.includes(k) && !onScreen.has(k))
    .map((k) => byKey.get(k))
    .filter((m): m is ModuleNav => !!m && m.path !== location.pathname && m.path !== activePath)
    .slice(0, 3);

  const toggleDoor = useCallback((key: string) => {
    setOpenDoors((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeStringSet(OPEN_DOORS_KEY, next);
      return next;
    });
  }, []);
  const openDoor = useCallback((key: string) => {
    setOpenDoors((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set([...prev, key]);
      writeStringSet(OPEN_DOORS_KEY, next);
      return next;
    });
  }, []);

  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => readRailCollapsed());
  // The rail default is read once at mount; an iPad rotating landscape →
  // portrait would keep a 256px rail on a 768px screen. Follow the
  // breakpoint: collapse below lg, restore the stored choice above it.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setRailCollapsed(mq.matches ? readRailCollapsed() : true);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
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
        // pt-safe so the brand row aligns with the Topbar (which carries the
        // same env(safe-area-inset-top) padding) on iPad portrait under a notch.
        // pl-safe handles landscape with the notch on the left.
        'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]',
        railCollapsed ? 'w-14' : 'w-64',
      )}
    >
      <SidebarBrand railCollapsed={railCollapsed} onToggleRail={toggleRail} />

      <nav className="flex-1 overflow-y-auto overscroll-contain py-2" aria-label={tr('nav.primaryAria')} data-tour="nav">
        <SidebarLink
          to={DASHBOARD_NAV.path}
          // A store or region account's home IS "My store" / "Command
          // center" (one page, listed once): Home lights there too.
          active={activePath === DASHBOARD_NAV.path || (user?.role === 'CLIENT_PORTAL' && portalHomePaths.has(activePath ?? ''))}
          label={DASHBOARD_NAV.label}
          icon={DASHBOARD_ICON}
          railCollapsed={railCollapsed}
        />

        {shape.rows.map((m) => (
          <PinnableRow
            key={m.key}
            module={m}
            active={activePath === m.path}
            railCollapsed={railCollapsed}
            badge={badgeFor(m)}
            pinned={isPinned(m.key)}
            onTogglePin={togglePin}
          />
        ))}

        {pinnedModules.length > 0 && (
          <SidebarSection
            label={tr('nav.pinned')}
            collapsed={collapsedSections.has('__pinned')}
            onToggle={() => toggleSection('__pinned')}
            railCollapsed={railCollapsed}
          >
            {pinnedModules.map((m) => (
              <PinnableRow
                key={m.key}
                module={m}
                active={activePath === m.path}
                railCollapsed={railCollapsed}
                badge={badgeFor(m)}
                pinned
                onTogglePin={togglePin}
              />
            ))}
          </SidebarSection>
        )}

        {recentModules.length > 0 && (
          <SidebarSection
            label={tr('nav.recent')}
            collapsed={collapsedSections.has('__recent')}
            onToggle={() => toggleSection('__recent')}
            railCollapsed={railCollapsed}
          >
            {recentModules.map((m) => (
              <PinnableRow
                key={m.key}
                module={m}
                active={activePath === m.path}
                railCollapsed={railCollapsed}
                badge={badgeFor(m)}
                pinned={false}
                onTogglePin={togglePin}
              />
            ))}
          </SidebarSection>
        )}

        {shape.doors.length > 0 && (
          <div className={cn(railCollapsed ? 'mt-2 pt-2 border-t border-navy-secondary/60' : 'mt-3')}>
            {shape.doors.map((door) => (
              <DoorRow
                key={door.key}
                door={door}
                open={openDoors.has(door.key)}
                active={activeDoor === door.key}
                activePath={activePath}
                railCollapsed={railCollapsed}
                badgeFor={badgeFor}
                isPinned={isPinned}
                onTogglePin={togglePin}
                onToggle={() => toggleDoor(door.key)}
                onOpen={() => openDoor(door.key)}
              />
            ))}
          </div>
        )}

        {/* A manager's company-wide doors, kept whole but folded (ops 21):
            closed until opened, or until the page in view is behind one. */}
        {shape.folded && (
          <SidebarSection
            label={shape.folded.label}
            collapsed={!collapsedSections.has(FOLD_OPEN) && !shape.folded.doors.some((d) => d.key === activeDoor)}
            onToggle={() => toggleSection(FOLD_OPEN)}
            railCollapsed={railCollapsed}
          >
            {shape.folded.doors.map((door) => (
              <DoorRow
                key={door.key}
                door={door}
                open={openDoors.has(door.key)}
                active={activeDoor === door.key}
                activePath={activePath}
                railCollapsed={railCollapsed}
                badgeFor={badgeFor}
                isPinned={isPinned}
                onTogglePin={togglePin}
                onToggle={() => toggleDoor(door.key)}
                onOpen={() => openDoor(door.key)}
              />
            ))}
          </SidebarSection>
        )}
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
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'h-14 flex items-center border-b border-navy-secondary shrink-0',
        railCollapsed ? 'justify-center px-0' : 'gap-2 px-4',
      )}
    >
      {!railCollapsed && (
        <>
          <Logo size="sm" alt={t('top.logo')} />
          <span className="text-lg text-ink leading-none tracking-tight truncate">
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
              'p-2.5 rounded-md text-silver/70 hover:text-ink hover:bg-navy-secondary/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
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
          <span className="ml-2 text-silver/70">⌘\</span>
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

/** Pinned and Recent — the person's own shortcuts, under a small heading. */
function SidebarSection({ label, collapsed, onToggle, railCollapsed, children }: SidebarSectionProps) {
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
        className="w-full flex items-center justify-between px-4 py-1 text-2xs font-semibold uppercase tracking-widest text-silver/80 hover:text-ink transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-md"
      >
        <span>{label}</span>
        {collapsed ? (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        )}
      </button>
      {!collapsed && <div className="mt-0.5">{children}</div>}
    </div>
  );
}

interface DoorRowProps {
  door: NavDoorView;
  open: boolean;
  /** The current page is behind this door. */
  active: boolean;
  activePath: string | null;
  railCollapsed: boolean;
  badgeFor: (m: ModuleNav) => number | null;
  isPinned: (key: ModuleNav['key']) => boolean;
  onTogglePin: (key: ModuleNav['key']) => void;
  onToggle: () => void;
  onOpen: () => void;
}

/**
 * A door: one row that opens to the pages behind it. The label goes to the
 * door's own page (its hub, or its first page) and opens the door; the
 * chevron only opens or closes it. A door with one page behind it and no
 * hub is drawn as that page's row — nothing to open.
 */
function DoorRow({ door, open, active, activePath, railCollapsed, badgeFor, isPinned, onTogglePin, onToggle, onOpen }: DoorRowProps) {
  const Icon = DOOR_ICONS[door.key];
  const single = door.flat || (door.children.length === 1 && door.target.key === door.children[0]!.key);
  const waiting = door.children.reduce((n, c) => n + (badgeFor(c) ?? 0), 0) + (door.children.includes(door.target) ? 0 : (badgeFor(door.target) ?? 0));

  if (single) {
    return (
      <PinnableRow
        module={{ ...door.target, label: door.label }}
        icon={Icon}
        active={door.flat ? active : activePath === door.target.path}
        railCollapsed={railCollapsed}
        badge={badgeFor(door.target)}
        pinned={isPinned(door.target.key)}
        onTogglePin={onTogglePin}
      />
    );
  }

  if (railCollapsed) {
    // One icon, a menu of its pages. The hub (when the door has one) leads.
    const items = door.children.includes(door.target) ? door.children : [door.target, ...door.children];
    const trigger = (
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={door.label}
          aria-haspopup="menu"
          className={cn(
            'group relative my-0.5 mx-2 h-9 w-9 coarse:h-11 coarse:w-11 flex items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
            'before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-r before:bg-gold before:opacity-0 before:transition-opacity',
            active ? 'bg-navy-secondary text-ink before:opacity-100' : 'text-silver hover:text-ink hover:bg-navy-secondary/50',
          )}
        >
          <Icon className={cn('h-4 w-4', active && 'icon-active')} aria-hidden="true" />
          {waiting > 0 && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-gold" aria-label={`${waiting} pending`} />}
        </button>
      </DropdownMenuTrigger>
    );
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right">{door.label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="right" align="start" className="min-w-[14rem]">
          <DropdownMenuLabel>{door.label}</DropdownMenuLabel>
          {(door.groups ?? [{ key: 'all', label: '', children: items }]).map((g) => (
            <div key={g.key}>
              {g.label && <DropdownMenuLabel className="pt-2 text-2xs font-semibold uppercase tracking-widest text-silver/70">{g.label}</DropdownMenuLabel>}
              {g.children.map((m) => {
                const n = badgeFor(m);
                return (
                  <DropdownMenuItem key={m.key} asChild>
                    <Link to={m.path} onMouseEnter={() => prefetchRoute(m.path)} onFocus={() => prefetchRoute(m.path)}>
                      <span className="flex-1 truncate">{m.key === door.target.key && door.target.key !== door.children[0]?.key ? `${m.label} — overview` : m.label}</span>
                      {!!n && <span className="ml-2 text-2xs text-gold tabular-nums">{n > 99 ? '99+' : n}</span>}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div className="mt-0.5">
      <div className="relative group/door">
        <Link
          to={door.target.path}
          onClick={onOpen}
          onMouseEnter={() => prefetchRoute(door.target.path)}
          onFocus={() => prefetchRoute(door.target.path)}
          aria-current={active && !open ? 'location' : undefined}
          className={cn(
            'group relative my-0.5 mx-2 flex items-center gap-2.5 rounded-md pl-3 pr-10 py-[var(--d-nav-y)] coarse:py-2.5 text-sm transition-colors',
            'before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-r before:bg-gold before:opacity-0 before:transition-opacity',
            active && !open
              ? 'bg-navy-secondary text-ink before:opacity-100'
              : active
                ? 'text-ink'
                : 'text-silver hover:text-ink hover:bg-navy-secondary/50',
          )}
        >
          <Icon className={cn('h-4 w-4 shrink-0', active && 'icon-active')} aria-hidden="true" />
          <span className="min-w-0 line-clamp-2 break-words" title={door.label}>{door.label}</span>
          {!open && waiting > 0 && (
            <span
              className="ml-auto shrink-0 min-w-[1.25rem] h-5 px-1.5 grid place-items-center rounded-full bg-gold/15 border border-gold/40 text-gold text-2xs font-semibold tabular-nums"
              aria-label={`${waiting} pending`}
            >
              {waiting > 99 ? '99+' : waiting}
            </span>
          )}
        </Link>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `Hide ${door.label} pages` : `Show ${door.label} pages`}
          className="absolute right-3 top-1/2 -translate-y-1/2 grid h-6 w-6 place-items-center rounded text-silver/70 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </div>
      {open && (
        <div className="mb-1">
          {(door.groups ?? [{ key: 'all', label: '', children: door.children }]).map((g) => (
            <div key={g.key} role={g.label ? 'group' : undefined} aria-label={g.label || undefined}>
              {g.label && (
                <div className="ml-9 mr-2 mt-2 mb-0.5 text-2xs font-semibold uppercase tracking-widest text-silver/60">{g.label}</div>
              )}
              {g.children.map((m) => (
                <PinnableRow
                  key={m.key}
                  module={m}
                  indent
                  active={activePath === m.path}
                  railCollapsed={false}
                  badge={badgeFor(m)}
                  pinned={isPinned(m.key)}
                  onTogglePin={onTogglePin}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface PinnableRowProps {
  module: ModuleNav;
  /** Override the module's icon (a door drawn as its one page). */
  icon?: LucideIcon;
  /** A page inside an open door: indented, no icon. */
  indent?: boolean;
  active: boolean;
  railCollapsed: boolean;
  badge?: number | null;
  pinned: boolean;
  onTogglePin: (key: ModuleNav['key']) => void;
}

/**
 * A module row with a star-to-pin affordance. The star is a SIBLING of
 * the link (absolutely positioned) — nesting a button inside the <a>
 * would be invalid HTML and break AT. Hover-revealed on pointer devices;
 * always visible on touch (there's no hover to reveal it with), and when
 * already pinned so it can be unpinned.
 */
function PinnableRow({ module: m, icon, indent, active, railCollapsed, badge, pinned, onTogglePin }: PinnableRowProps) {
  if (railCollapsed) {
    // Collapsed rail is icon-only — no room for the star; pin management
    // happens with the rail expanded.
    return (
      <SidebarLink
        to={m.path}
        active={active}
        label={m.label}
        icon={icon ?? MODULE_ICONS[m.key]}
        railCollapsed
        badge={badge}
      />
    );
  }
  return (
    <div className="relative group/pin">
      <SidebarLink
        to={m.path}
        active={active}
        label={m.label}
        icon={icon ?? MODULE_ICONS[m.key]}
        indent={indent}
        railCollapsed={false}
        badge={badge}
      />
      <button
        type="button"
        onClick={() => onTogglePin(m.key)}
        aria-label={pinned ? `Unpin ${m.label}` : `Pin ${m.label}`}
        aria-pressed={pinned}
        className={cn(
          'absolute right-3 top-1/2 -translate-y-1/2 grid h-6 w-6 place-items-center rounded transition-opacity',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:opacity-100',
          pinned
            ? 'text-gold opacity-100'
            : 'text-silver/70 hover:text-gold opacity-100 can-hover:opacity-0 can-hover:group-hover/pin:opacity-100',
        )}
      >
        <Star className={cn('h-3.5 w-3.5', pinned && 'fill-gold')} aria-hidden="true" />
      </button>
    </div>
  );
}

interface SidebarLinkProps {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Computed by the parent via useActiveNavPath (longest-prefix wins).
   *  NavLink's own prefix matching would light up BOTH "Time &
   *  Attendance" and "Kiosk" on /time-attendance/kiosk. */
  active: boolean;
  railCollapsed: boolean;
  /** A page inside an open door: indented under the door, no icon. */
  indent?: boolean;
  /** Pending count shown as a gold pill (dot when the rail is collapsed).
   *  null/0 renders nothing. */
  badge?: number | null;
}

function SidebarLink({ to, label, icon: Icon, active, railCollapsed, indent, badge }: SidebarLinkProps) {
  // Hover + focus prefetch — by the time the user actually clicks, the
  // page's lazy chunk is already warm. onTouchStart covers touch, which
  // fires before the synthetic click.
  const preload = () => prefetchRoute(to);

  const link = (
    <Link
      to={to}
      aria-label={railCollapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      onMouseEnter={preload}
      onFocus={preload}
      onTouchStart={preload}
      className={cn(
        'group relative my-0.5 flex items-center rounded-md text-sm transition-colors',
        // F500 cue: thin gold bar on the left of the active item.
        // Pseudo-element sits inside the link so it doesn't shift sibling layout.
        'before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-r before:bg-gold before:opacity-0 before:transition-opacity',
        // coarse: taller rows — the sidebar IS the primary nav on iPads.
        railCollapsed
          ? 'mx-2 h-9 w-9 coarse:h-11 coarse:w-11 justify-center'
          : indent
            ? 'mx-2 gap-2.5 pl-[2.6rem] pr-9 py-[calc(var(--d-nav-y)-1px)] coarse:py-2'
            : 'mx-2 gap-2.5 px-3 py-[var(--d-nav-y)] coarse:py-2.5',
        active
          ? 'bg-navy-secondary text-ink before:opacity-100'
          : 'text-silver hover:text-ink hover:bg-navy-secondary/50',
      )}
    >
      {!indent && <Icon className={cn('h-4 w-4 shrink-0', active && 'icon-active')} aria-hidden="true" />}
      {/* Two lines before an ellipsis, and the whole name on hover: at 1440
          "Departments & job profi…" and "Unemployment cla…" were cut. */}
      {!railCollapsed && <span className="min-w-0 line-clamp-2 break-words leading-snug" title={label}>{label}</span>}
      {!!badge && !railCollapsed && (
        <span
          className="ml-auto shrink-0 min-w-[1.25rem] h-5 px-1.5 grid place-items-center rounded-full bg-gold/15 border border-gold/40 text-gold text-2xs font-semibold tabular-nums"
          aria-label={`${badge} pending`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {!!badge && railCollapsed && (
        <span
          className="absolute top-1 right-1 h-2 w-2 rounded-full bg-gold"
          aria-label={`${badge} pending`}
        />
      )}
    </Link>
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
  const { t } = useI18n();
  const roleLabel = useRoleLabel();
  const { user, signOut } = useAuth();
  const { preference, theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  if (!user) {
    if (railCollapsed) {
      return <div className="h-12 border-t border-navy-secondary" />;
    }
    return (
      <div className="px-4 py-3 border-t border-navy-secondary text-2xs uppercase tracking-widest text-silver/70">
        © {new Date().getFullYear()} Alto Etho LLC
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
            aria-label={t('top.account')}
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
        aria-label={t('top.account')}
      >
        {avatar}
        <div className="min-w-0 flex-1 text-left leading-tight">
          <div className="text-2xs uppercase tracking-widest text-silver truncate">
            {roleLabel(user.role)}
          </div>
          <div className="text-sm text-ink truncate">{displayName}</div>
        </div>
        <ChevronsUpDown className="h-3.5 w-3.5 text-silver/70 shrink-0" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
  );

  return (
    <div className="border-t border-navy-secondary p-2">
      <DropdownMenu>
        {trigger}
        <DropdownMenuContent side="top" align="start" className="min-w-[15rem]">
          <DropdownMenuLabel>{roleLabel(user.role)}</DropdownMenuLabel>
          <div className="px-2 pb-2 leading-tight">
            {fullName && <div className="text-sm text-ink truncate">{fullName}</div>}
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
          {/* Only for the few accounts that do two jobs. */}
          <RoleSwitcher />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {preference === 'system' ? (
                <Monitor className="h-4 w-4" />
              ) : theme === 'dark' ? (
                <Moon className="h-4 w-4" />
              ) : (
                <Sun className="h-4 w-4" />
              )}
              Appearance
              <span className="ml-auto text-xs text-silver capitalize">
                {preference}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => setTheme('light')}>
                <Sun className="h-4 w-4" />
                Light
                {preference === 'light' && (
                  <span className="ml-auto text-2xs uppercase tracking-widest text-gold">
                    Active
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTheme('dark')}>
                <Moon className="h-4 w-4" />
                Dark
                {preference === 'dark' && (
                  <span className="ml-auto text-2xs uppercase tracking-widest text-gold">
                    Active
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setTheme('system')}>
                <Monitor className="h-4 w-4" />
                System
                {preference === 'system' ? (
                  <span className="ml-auto text-2xs uppercase tracking-widest text-gold">
                    Active
                  </span>
                ) : (
                  <span className="ml-auto text-2xs text-silver/70 capitalize">
                    {theme}
                  </span>
                )}
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
                  <span className="ml-auto text-2xs uppercase tracking-widest text-gold">
                    Active
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDensity('compact')}>
                <Rows4 className="h-4 w-4" />
                Compact
                {density === 'compact' && (
                  <span className="ml-auto text-2xs uppercase tracking-widest text-gold">
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
            <span className="ml-auto text-2xs font-mono text-silver/80 border border-navy-secondary rounded px-1">
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
