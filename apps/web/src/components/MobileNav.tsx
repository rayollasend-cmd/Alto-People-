import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Globe, Monitor, Moon, Search, Sun, X, type LucideIcon } from '@/components/ui/icons';
import {
  applyTerms,
  DASHBOARD_NAV,
  navShapeFor,
  roleNavLabels,
  useActiveNavPath,
  visibleModules,
  type ModuleNav,
  type NavDoorView,
} from '@/lib/modules';
import { DASHBOARD_ICON, DOOR_ICONS, MODULE_ICONS } from '@/lib/moduleIcons';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useOverlayBackButton } from '@/lib/useOverlayBackButton';
import { prefetchRoute } from '@/lib/prefetch';
import { useInbox } from '@/lib/inboxApi';
import { usePinnedModules, useRecentModules } from '@/lib/navPersonalization';
import { LANGS, LANG_LABELS, useI18n, type Lang } from '@/lib/i18n';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { tabBarHiddenFrom, tabSetFor } from '@/components/BottomTabBar';
import { useMediaQuery } from '@/lib/useViewport';
import { shortStoreName, useStoreScope } from '@/lib/storeScope';
import { matchClients } from '@/components/StoreScopeCombobox';
import { cn } from '@/lib/cn';


interface MobileNavProps {
  open: boolean;
  onClose: () => void;
  /** Opens the command palette (the mobile Topbar also has a one-tap
   *  search icon; this drawer entry keeps search discoverable here too). */
  onOpenCommandPalette?: () => void;
}

export function MobileNav({ open, onClose, onOpenCommandPalette }: MobileNavProps) {
  const { can, user } = useAuth();
  const tenant = useTenant();
  const term = useTerm();
  const { lang, setLang, t } = useI18n();
  const { preference, setTheme } = useTheme();
  // The same counts the desktop rail shows, from the one inbox request.
  const inbox = useInbox();
  const countByPath = new Map<string, number>();
  for (const src of inbox.data?.sources ?? []) {
    // Another desk's queue (packages/shared queues.ts) badges nothing here — as on the Inbox.
    if (src.watching) continue;
    const path = src.path.split('?')[0] ?? src.path;
    countByPath.set(path, (countByPath.get(path) ?? 0) + src.count);
  }
  const badgeFor = (m: ModuleNav): number | null =>
    m.key === 'inbox' ? (inbox.data?.total ?? null) : (countByPath.get(m.path) ?? null);
  const { pinned } = usePinnedModules();
  const recents = useRecentModules();
  const visible = roleNavLabels(applyTerms(visibleModules(user?.role, can, { regionId: user?.regionId, modules: tenant.modules, tenantId: tenant.id }), term, tenant.modules), user?.role, t);
  const byKey = new Map(visible.map((m) => [m.key, m]));
  const pinnedModules = pinned
    .map((k) => byKey.get(k))
    .filter((m): m is ModuleNav => !!m);
  // Same recipe as Sidebar: the three most-recent modules that aren't
  // already pinned, restricted to what this user can actually see.
  const recentModules = recents
    .filter((k) => !pinned.includes(k))
    .map((k) => byKey.get(k))
    .filter((m): m is ModuleNav => !!m)
    .slice(0, 3);
  const activePath = useActiveNavPath();
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // The same shape as the desktop Sidebar (lib/modules.navShapeFor): the
  // always-on rows, then the doors as headed sections. The client portal
  // keeps its own chrome, and the portal / region keys belong to its
  // BottomTabBar, so its rows are left to that.
  const shape = navShapeFor(visible, user?.role, term);
  const coreItems = user?.role === 'CLIENT_PORTAL' ? [] : shape.rows;

  // Stay mounted through the closing animation. `if (!open) return null`
  // made the menu vanish between two frames — the one piece of chrome in
  // the app that blinked out instead of leaving.
  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;
    setExiting(true);
    const t = window.setTimeout(() => {
      setMounted(false);
      setExiting(false);
    }, 200); // matches slide-down-out
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Back closes the menu instead of leaving the page behind it.
  useOverlayBackButton(open, onClose);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  // Sections start closed (the one holding this page opens itself); a tap opens or closes one.
  const [openDoors, setOpenDoors] = useState<Set<string>>(new Set());
  const [closedDoors, setClosedDoors] = useState<Set<string>>(new Set());
  const toggleDoor = (key: string, isOpen: boolean) => {
    setOpenDoors((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(key);
      else next.add(key);
      return next;
    });
    setClosedDoors((prev) => {
      const next = new Set(prev);
      if (isOpen) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const tabBarShowing = useMediaQuery(tabBarHiddenFrom(user?.role) === 'lg' ? '(max-width: 1023.98px)' : '(max-width: 767.98px)');

  if (!mounted) return null;

  // What the tab bar already offers isn't repeated here while the tab bar is
  // on screen (phones); at tablet widths this sheet is the whole menu.
  const inTabBar = new Set(tabBarShowing ? tabSetFor(user, can).filter((x) => x.requires === null || can(x.requires)).slice(0, 4).map((x) => x.path) : []);
  const notInTabBar = (m: { path: string }) => !inTabBar.has(m.path);
  const rows = coreItems.filter(notInTabBar);
  const pinnedRows = pinnedModules.filter(notInTabBar);
  // Recent never repeats a row already on this sheet: an always-on row, or
  // a page inside the section that holds the page in view (it opens itself).
  const onSheet = new Set<string>(coreItems.map((m) => m.key));
  for (const d of [...shape.doors, ...(shape.folded?.doors ?? [])]) {
    const all = [d.target, ...d.children];
    if (!all.some((m) => m.path === activePath)) continue;
    for (const m of all) onSheet.add(m.key);
  }
  const recentRows = recentModules.filter((m) => notInTabBar(m) && !onSheet.has(m.key) && m.path !== activePath);
  const doors = user?.role !== 'CLIENT_PORTAL' ? shape.doors : [];
  // A manager's company-wide doors (ops 21): kept, under their own heading.
  const folded = user?.role !== 'CLIENT_PORTAL' ? shape.folded : undefined;

  const renderDoor = (door: NavDoorView) => {
            const single = door.flat || (door.children.length === 1 && door.target.key === door.children[0]!.key);
            if (single) {
              if (!notInTabBar(door.target)) return null;
              return <MobileLink key={door.key} to={door.target.path} active={activePath === door.target.path} label={door.label} icon={DOOR_ICONS[door.key]} badge={badgeFor(door.target)} />;
            }
            const items = (door.children.includes(door.target) ? door.children : [door.target, ...door.children]).filter(notInTabBar);
            if (items.length === 0) return null;
            const total = items.reduce((n, m) => n + (badgeFor(m) ?? 0), 0);
            const holdsActive = items.some((m) => m.path === activePath);
            const isOpen = openDoors.has(door.key) || (holdsActive && !closedDoors.has(door.key));
            return (
              <div key={door.key}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={(e) => {
                    // Opening a section doesn't close the sheet.
                    e.stopPropagation();
                    toggleDoor(door.key, isOpen);
                  }}
                  className={cn(
                    'mx-2 my-0.5 flex min-h-12 w-[calc(100%-1rem)] items-center gap-2.5 rounded-md px-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright',
                    holdsActive ? 'text-ink' : 'text-silver hover:text-ink hover:bg-navy-secondary/50',
                  )}
                >
                  {(() => {
                    const Icon = DOOR_ICONS[door.key];
                    return Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null;
                  })()}
                  <span className="truncate font-medium">{door.label}</span>
                  {!isOpen && total > 0 && <CountPill n={total} />}
                  <ChevronDown className={cn('h-4 w-4 shrink-0 text-silver/70 transition-transform', !isOpen || total > 0 ? 'ml-1' : 'ml-auto', isOpen && 'rotate-180', !(!isOpen && total > 0) && 'ml-auto')} aria-hidden="true" />
                </button>
                {isOpen && (
                  <div className="mb-1 ml-6 border-l border-navy-secondary pl-1">
                    {(door.groups ?? [{ key: 'all', label: '', children: items }]).map((g) => {
                      const shown = g.children.filter((m) => items.includes(m));
                      if (shown.length === 0) return null;
                      return (
                        <div key={g.key}>
                          {g.label && <div className="px-3 pt-2 pb-0.5 text-2xs font-semibold uppercase tracking-widest text-silver/60">{g.label}</div>}
                          {shown.map((m) => (
                            <MobileLink key={m.key} to={m.path} active={activePath === m.path} label={m.label} icon={MODULE_ICONS[m.key]} badge={badgeFor(m)} />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          };

  return (
    <div
      className={cn('fixed inset-0 z-40 lg:hidden', exiting ? 'pointer-events-none animate-fade-out' : 'animate-fade-in')}
      role="dialog"
      aria-modal="true"
      aria-label={t('nav.mainAria')}
    >
      <div className="absolute inset-0 bg-backdrop backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      {/* A sheet that rises from the tab bar the way a native "More" does,
          leaving the top of the page peeking above it. */}
      <aside
        ref={panelRef}
        className={cn(
          'absolute inset-x-0 bottom-0 top-[calc(env(safe-area-inset-top)+2.5rem)] mx-auto flex max-w-xl flex-col rounded-t-2xl border-t border-navy-secondary bg-navy shadow-2xl',
          'pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
          exiting ? 'animate-slide-down-out' : 'animate-slide-up-in',
        )}
      >
        <div className="flex justify-center pt-2" aria-hidden="true">
          <span className="h-1 w-10 rounded-full bg-silver/30" />
        </div>
        <div className="flex min-h-12 items-center justify-between gap-3 px-4">
          <span className="text-base font-semibold text-ink">{t('tabs.more')}</span>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="-mr-2 grid h-10 w-10 place-items-center rounded text-silver hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            aria-label={t('nav.closeMenu')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* Search stays on top while the list scrolls under it. */}
        {onOpenCommandPalette && (
          <div className="px-4 pb-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenCommandPalette();
              }}
              className="flex h-11 w-full items-center gap-2.5 rounded-lg border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-silver transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            >
              <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{t('nav.searchEverything')}</span>
            </button>
          </div>
        )}
        <StoreScopeChips onPicked={onClose} />

        <nav className="flex-1 overflow-y-auto overscroll-contain border-t border-navy-secondary py-2" onClick={onClose} aria-label={t('nav.mainAria')}>
          {!inTabBar.has(DASHBOARD_NAV.path) && (
            <MobileLink to={DASHBOARD_NAV.path} active={activePath === DASHBOARD_NAV.path} label={DASHBOARD_NAV.label} icon={DASHBOARD_ICON} />
          )}
          {rows.map((m) => (
            <MobileLink key={m.key} to={m.path} active={activePath === m.path} label={m.label} icon={MODULE_ICONS[m.key]} badge={badgeFor(m)} />
          ))}
          {pinnedRows.length > 0 && (
            <SheetGroup title={t('nav.pinned')}>
              {pinnedRows.map((m) => (
                <MobileLink key={`pin-${m.key}`} to={m.path} active={activePath === m.path} label={m.label} icon={MODULE_ICONS[m.key]} badge={badgeFor(m)} />
              ))}
            </SheetGroup>
          )}
          {recentRows.length > 0 && (
            <SheetGroup title={t('nav.recent')}>
              {recentRows.map((m) => (
                <MobileLink key={`recent-${m.key}`} to={m.path} active={activePath === m.path} label={m.label} icon={MODULE_ICONS[m.key]} badge={badgeFor(m)} />
              ))}
            </SheetGroup>
          )}
          {doors.length > 0 && <div className="mt-2" />}
          {doors.map(renderDoor)}
          {folded && folded.doors.length > 0 && (
            <SheetGroup title={folded.label}>
              {folded.doors.map(renderDoor)}
            </SheetGroup>
          )}
          <DisplayAndLanguage lang={lang} setLang={setLang} preference={preference} setTheme={setTheme} />
        </nav>
      </aside>
    </div>
  );
}

function SheetGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="px-4 py-1 text-2xs font-semibold uppercase tracking-widest text-silver/80">{title}</div>
      {children}
    </div>
  );
}

function CountPill({ n }: { n: number }) {
  return (
    <span className="ml-auto grid h-5 min-w-[1.25rem] shrink-0 place-items-center rounded-full border border-gold/40 bg-gold/15 px-1.5 text-2xs font-semibold tabular-nums text-gold" aria-label={`${n} pending`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

/** Above this many clients the phone's chips get a search field and wrap. */
const CHIPS_BEFORE_SEARCH = 6;
/** How many matches the searchable chips show before asking for more letters. */
const CHIPS_SHOWN = 24;

/**
 * The store scope on a phone: the same choice as the desktop top bar's
 * "All / client" control, as a row of chips that scrolls sideways. Past six
 * clients a sideways row is endless, so a search field sits above and the
 * chips wrap: "All clients" and the current one first, then what matches.
 */
function StoreScopeChips({ onPicked }: { onPicked: () => void }) {
  const { enabled, clients, clientId, setClientId: choose } = useStoreScope();
  // Choosing a scope applies it and shows the page it narrows (the top bar then names the client).
  const setClientId = (id: string) => {
    choose(id);
    onPicked();
  };
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  if (!enabled || clients.length < 2) return null;
  const chip = (active: boolean) =>
    cn(
      'h-8 shrink-0 rounded-full border px-3 text-xs whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
      active ? 'border-gold bg-gold text-on-accent font-semibold' : 'border-navy-secondary text-silver hover:text-ink',
    );
  if (clients.length > CHIPS_BEFORE_SEARCH) {
    const current = clients.find((c) => c.id === clientId);
    const matches = matchClients(clients, query).filter((c) => c.id !== clientId);
    const shown = matches.slice(0, CHIPS_SHOWN);
    return (
      <div className="space-y-2 px-4 pb-2" data-testid="store-scope-search">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-silver/70" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('nav.findClient')}
            placeholder={t('nav.findClient')}
            autoComplete="off"
            className="h-11 w-full rounded-lg border border-navy-secondary bg-navy-secondary/40 pl-9 pr-3 text-base text-ink placeholder:text-silver/70 focus:border-gold focus:outline-none"
          />
        </div>
        <div role="group" aria-label={t('nav.storeScope')} className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto overscroll-contain">
          <button type="button" className={chip(clientId === '')} aria-pressed={clientId === ''} onClick={() => setClientId('')}>
            {t('nav.allClients')}
          </button>
          {current && (
            <button type="button" className={chip(true)} aria-pressed onClick={() => setClientId(current.id)}>
              {shortStoreName(current.name)}
            </button>
          )}
          {shown.map((c) => (
            <button key={c.id} type="button" className={chip(false)} aria-pressed={false} onClick={() => setClientId(c.id)}>
              {shortStoreName(c.name)}
            </button>
          ))}
        </div>
        {matches.length === 0 && query.trim() !== '' && <p className="text-xs text-silver">{t('nav.noClientMatch')}</p>}
        {matches.length > shown.length && <p className="text-xs text-silver">{t('nav.moreClients', { n: matches.length - shown.length })}</p>}
      </div>
    );
  }
  return (
    <div className="px-4 pb-2">
      <div role="group" aria-label={t('nav.storeScope')} className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        <button type="button" className={chip(clientId === '')} aria-pressed={clientId === ''} onClick={() => setClientId('')}>
          {t('nav.allClients')}
        </button>
        {clients.map((c) => (
          <button key={c.id} type="button" className={chip(clientId === c.id)} aria-pressed={clientId === c.id} onClick={() => setClientId(c.id)}>
            {shortStoreName(c.name)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Language and theme: set once, so one quiet row at the end of the list that
 * opens in place — not a block pinned over half the menu.
 */
function DisplayAndLanguage({
  lang,
  setLang,
  preference,
  setTheme,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
  preference: ThemePreference;
  setTheme: (p: ThemePreference) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const themeLabel = preference === 'light' ? t('theme.light') : preference === 'dark' ? t('theme.dark') : t('theme.system');
  return (
    <div className="mt-3 border-t border-navy-secondary pt-2" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="mx-2 flex min-h-12 w-[calc(100%-1rem)] items-center gap-2.5 rounded-md px-3 text-sm text-silver transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright"
      >
        <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{t('nav.displayLanguage')}</span>
        <span className="ml-auto truncate text-xs text-silver/80">
          {LANG_LABELS[lang]} · {themeLabel}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-silver/70 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div className="space-y-3 px-5 pb-3 pt-1">
          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-widest text-silver/80">{t('common.language')}</span>
            <Select className="mt-1" value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t('common.language')}>
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {LANG_LABELS[l]}
                </option>
              ))}
            </Select>
          </label>
          <div>
            <span className="block text-2xs font-semibold uppercase tracking-widest text-silver/80">{t('nav.theme')}</span>
            <SegmentedControl<ThemePreference>
              className="mt-1"
              ariaLabel={t('nav.theme')}
              options={[
                { value: 'light', label: (<span className="inline-flex items-center gap-1.5"><Sun className="h-4 w-4" aria-hidden="true" />{t('theme.light')}</span>) },
                { value: 'dark', label: (<span className="inline-flex items-center gap-1.5"><Moon className="h-4 w-4" aria-hidden="true" />{t('theme.dark')}</span>) },
                { value: 'system', label: (<span className="inline-flex items-center gap-1.5"><Monitor className="h-4 w-4" aria-hidden="true" />{t('theme.system')}</span>) },
              ]}
              value={preference}
              onChange={setTheme}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface MobileLinkProps {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Computed by the parent via useActiveNavPath (longest-prefix wins) —
   *  see SidebarLink for why NavLink's own prefix matching is wrong here. */
  active: boolean;
  /** Pending count shown as a gold pill. null/0 renders nothing. */
  badge?: number | null;
}

function MobileLink({ to, label, icon: Icon, active, badge }: MobileLinkProps) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      // The phone is the slowest network in the fleet and was the only
      // navigator that fetched its chunk cold. A touch starts ~100ms before
      // the tap completes — enough to have the route in flight already.
      onTouchStart={() => prefetchRoute(to)}
      onMouseEnter={() => prefetchRoute(to)}
      className={cn(
        'relative mx-2 my-0.5 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors',
        'before:absolute before:left-0 before:top-2 before:bottom-2 before:w-0.5 before:rounded-r before:bg-gold before:opacity-0 before:transition-opacity',
        active
          ? 'bg-navy-secondary text-white before:opacity-100'
          : 'text-silver hover:text-white hover:bg-navy-secondary/50'
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', active && 'icon-active')} aria-hidden="true" />
      <span className="truncate">{label}</span>
      {!!badge && (
        <span
          className="ml-auto shrink-0 min-w-[1.25rem] h-5 px-1.5 grid place-items-center rounded-full bg-gold/15 border border-gold/40 text-gold text-2xs font-semibold tabular-nums"
          aria-label={`${badge} pending`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  );
}
