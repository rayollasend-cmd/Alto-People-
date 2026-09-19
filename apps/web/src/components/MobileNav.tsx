import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Briefcase, Monitor, Moon, Search, Sun, X, type LucideIcon } from 'lucide-react';
import {
  DASHBOARD_NAV,
  GROUP_LABEL,
  visibleModules,
  useActiveNavPath,
  type ModuleGroup,
  type ModuleNav,
} from '@/lib/modules';
import { DASHBOARD_ICON, MODULE_ICONS } from '@/lib/moduleIcons';
import { useAuth } from '@/lib/auth';
import { useOverlayBackButton } from '@/lib/useOverlayBackButton';
import { prefetchRoute } from '@/lib/prefetch';
import { useApprovalsCount } from '@/lib/useApprovalsCount';
import { usePinnedModules, useRecentModules } from '@/lib/navPersonalization';
import { useI18n, type Lang } from '@/lib/i18n';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
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
  /** Opens the command palette (the mobile Topbar also has a one-tap
   *  search icon; this drawer entry keeps search discoverable here too). */
  onOpenCommandPalette?: () => void;
}

export function MobileNav({ open, onClose, onOpenCommandPalette }: MobileNavProps) {
  const { can, user } = useAuth();
  const { lang, setLang, t } = useI18n();
  const { preference, setTheme } = useTheme();
  const approvalsCount = useApprovalsCount();
  const { pinned } = usePinnedModules();
  const recents = useRecentModules();
  const visible = visibleModules(user?.role, can, { regionId: user?.regionId });
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

  const grouped: Partial<Record<ModuleGroup, ModuleNav[]>> = {};
  for (const m of visible) {
    (grouped[m.group] ??= []).push(m);
  }

  // Mirror the desktop Sidebar: the headerless 'core' group (My profile,
  // Messages, the relay) renders under the dashboard. The GROUP_ORDER loop
  // below skips 'core'. The client portal keeps its own chrome, and the
  // portal / region keys belong to its BottomTabBar, so both are excluded.
  const coreItems =
    user?.role === 'CLIENT_PORTAL'
      ? []
      : visible.filter(
          (m) => m.group === 'core' && !m.key.startsWith('portal') && m.key !== 'region',
        );

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
    }, 180); // matches slide-out-to-left
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

  if (!mounted) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-40 lg:hidden',
        exiting ? 'pointer-events-none animate-fade-out' : 'animate-fade-in',
      )}
      role="dialog"
      aria-modal="true"
      aria-label="Main navigation"
    >
      <div
        className="absolute inset-0 bg-backdrop backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        className={cn(
          'absolute left-0 top-0 h-full w-72 max-w-[calc(100vw-3rem)] bg-navy border-r border-navy-secondary flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]',
          exiting ? 'animate-slide-out-to-left' : 'animate-slide-in-from-left',
        )}
      >
        <div className="px-4 min-h-14 flex items-center justify-between gap-3 border-b border-navy-secondary">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="h-7 w-7 rounded-md bg-gold/15 border border-gold/40 grid place-items-center shrink-0"
              aria-hidden="true"
            >
              <Briefcase className="h-3.5 w-3.5 text-gold" />
            </div>
            <span className="text-lg text-white leading-none tracking-tight truncate">
              Alto <span className="text-gold">People</span>
            </span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="grid place-items-center h-10 w-10 -mr-2 text-silver hover:text-white rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-2" onClick={onClose}>
          {onOpenCommandPalette && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenCommandPalette();
              }}
              className="mx-2 my-0.5 flex w-[calc(100%-1rem)] items-center gap-2.5 rounded-md px-3 py-2.5 min-h-11 text-sm text-silver hover:text-white hover:bg-navy-secondary/50 active:bg-navy-secondary/60 transition-colors"
            >
              <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{t('common.search')}</span>
            </button>
          )}
          <MobileLink
            to={DASHBOARD_NAV.path}
            active={activePath === DASHBOARD_NAV.path}
            label={DASHBOARD_NAV.label}
            icon={DASHBOARD_ICON}
          />
          {coreItems.length > 0 && (
            <div className="mt-1">
              {coreItems.map((m) => (
                <MobileLink
                  key={m.key}
                  to={m.path}
                  active={activePath === m.path}
                  label={m.label}
                  icon={MODULE_ICONS[m.key]}
                  badge={m.key === 'approvals' ? approvalsCount : null}
                />
              ))}
            </div>
          )}
          {pinnedModules.length > 0 && (
            <div className="mt-3">
              <div className="px-4 py-1 text-2xs font-semibold uppercase tracking-widest text-silver/80">
                {t('nav.pinned')}
              </div>
              {pinnedModules.map((m) => (
                <MobileLink
                  key={`pin-${m.key}`}
                  to={m.path}
                  active={activePath === m.path}
                  label={m.label}
                  icon={MODULE_ICONS[m.key]}
                  badge={m.key === 'approvals' ? approvalsCount : null}
                />
              ))}
            </div>
          )}
          {recentModules.length > 0 && (
            <div className="mt-3">
              <div className="px-4 py-1 text-2xs font-semibold uppercase tracking-widest text-silver/80">
                Recent
              </div>
              {recentModules.map((m) => (
                <MobileLink
                  key={`recent-${m.key}`}
                  to={m.path}
                  active={activePath === m.path}
                  label={m.label}
                  icon={MODULE_ICONS[m.key]}
                  badge={m.key === 'approvals' ? approvalsCount : null}
                />
              ))}
            </div>
          )}
          {GROUP_ORDER.map((group) => {
            const items = grouped[group];
            if (!items || items.length === 0) return null;
            return (
              <div key={group} className="mt-3">
                <div className="px-4 py-1 text-2xs font-semibold uppercase tracking-widest text-silver/80">
                  {GROUP_LABEL[group]}
                </div>
                {items.map((m) => (
                  <MobileLink
                    key={m.key}
                    to={m.path}
                    active={activePath === m.path}
                    label={m.label}
                    icon={MODULE_ICONS[m.key]}
                    badge={m.key === 'approvals' ? approvalsCount : null}
                  />
                ))}
              </div>
            );
          })}
        </nav>

        {/* Language + theme switchers — the drawer is the one nav surface
            every phone user opens, so both toggles live here instead of
            buried in Settings. stopPropagation: the nav's onClick closes
            the drawer, and flipping a preference shouldn't. */}
        <div
          className="px-4 py-3 border-t border-navy-secondary space-y-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-2xs font-semibold uppercase tracking-widest text-silver/80">
              {t('common.language')}
            </span>
            <SegmentedControl<Lang>
              ariaLabel={t('common.language')}
              options={[
                { value: 'en', label: 'English' },
                { value: 'es', label: 'Español' },
              ]}
              value={lang}
              onChange={setLang}
            />
          </div>
          {/* Same Light / Dark / System choices (and setTheme mechanics) as
              the desktop Sidebar's Appearance menu — this drawer is the only
              chrome phones ever see, so without it mobile had no theme
              control at all. Icon pills keep the three options inside the
              288px drawer; sr-only text carries the Sidebar's labels. */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-2xs font-semibold uppercase tracking-widest text-silver/80">
              Theme
            </span>
            <SegmentedControl<ThemePreference>
              ariaLabel="Appearance"
              options={[
                {
                  value: 'light',
                  label: (
                    <>
                      <Sun className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">Light</span>
                    </>
                  ),
                },
                {
                  value: 'dark',
                  label: (
                    <>
                      <Moon className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">Dark</span>
                    </>
                  ),
                },
                {
                  value: 'system',
                  label: (
                    <>
                      <Monitor className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">System</span>
                    </>
                  ),
                },
              ]}
              value={preference}
              onChange={setTheme}
            />
          </div>
        </div>
      </aside>
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
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
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
