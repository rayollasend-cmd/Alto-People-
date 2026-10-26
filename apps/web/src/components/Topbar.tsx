import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CircleHelp, Globe, IdCard, LogOut, Search, Sparkles, User, WifiOff, X } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n';
import { Link } from 'react-router-dom';
import { useAuth, useRoleLabel } from '@/lib/auth';
import { shortStoreName, useStoreScope } from '@/lib/storeScope';
import { useHeroHidden, usePageBreadcrumbs, usePageTitle, usePageUp } from '@/lib/pageTitle';
import { useNavLabel } from '@/lib/navTrail';
import { offlineSessionSavedAt } from '@/lib/offlineSession';
import { displayZoneAbbrev, displayZoneDiffersFromDevice, fmtRelativeDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { StoreScopeCombobox } from './StoreScopeCombobox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/Tooltip';
import { Avatar } from '@/components/ui/Avatar';
import { NotificationsBell } from './NotificationsBell';
import { useAssistant } from '@/lib/assistantContext';
import { HugoMascot, isHugo } from '@/components/hugo/HugoMascot';
import { HugoBadge, useHugoBadgeLabel } from '@/components/assistant/HugoBadge';
import { InstallAppButton } from './InstallAppButton';
import { RoleSwitchItem, RoleSwitchSheet } from './RoleSwitcher';
import { Logo } from '@/components/Logo';
import { isSectionRoot } from './Layout';
import '@/lib/i18n/en/top';

interface TopbarProps {
  onOpenCommandPalette: () => void;
  onOpenHelp: () => void;
}

// One-click store scope — set once here, followed by Scheduling / Time /
// Labor / People. Segmented bar for the normal 4-store fleet; collapses to
// a select if the client list ever outgrows it. Hidden for bounded roles
// (their scope is pinned server-side) and on small screens (the per-page
// pickers still exist there).
function StoreScopeBar() {
  const { enabled, clients } = useStoreScope();
  if (!enabled || clients.length < 2) return null;
  return <StoreScopeControl />;
}

/** The segmented bar holds at most this many clients… */
const SEGMENT_MAX_CLIENTS = 6;
/** …and this many characters of short names between them. */
const SEGMENT_MAX_CHARS = 56;
const segmentChars = (clients: readonly { name: string }[]) =>
  clients.reduce((n, c) => n + shortStoreName(c.name).length, 0);

function StoreScopeControl() {
  const { clients, clientId, setClientId } = useStoreScope();
  const { t } = useI18n();

  // One picker. Below 1280px the segmented bar took ~510px of a 1024px
  // tablet and pushed Help and the bell off the right edge (role walk ops
  // 5), so it is the picker there; the segments come back at xl. The
  // picker searches (StoreScopeCombobox): a native select of 300 client
  // names was a scroll, not a choice.
  const dropdown = (className: string) => (
    <StoreScopeCombobox
      className={className}
      data-testid="store-scope-select"
      clients={clients}
      clientId={clientId}
      onChange={setClientId}
    />
  );

  // Segments only while they fit: up to six clients whose short names fit
  // the bar. Three long names ("Seaside Hospitality Group"…) took ~510px at
  // 1440 and squeezed the page's name in the bar down to "Clie… > Alto H…".
  if (clients.length > SEGMENT_MAX_CLIENTS || segmentChars(clients) > SEGMENT_MAX_CHARS) return dropdown('hidden lg:block');

  const seg = (active: boolean) =>
    cn(
      'px-2.5 h-7 rounded text-xs whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
      active
        ? 'bg-gold text-navy font-semibold'
        : 'text-silver hover:text-white hover:bg-navy-secondary/60',
    );
  return (
    <>
    {dropdown('hidden lg:block xl:hidden')}
    <div
      role="group"
      aria-label={t('top.storeScope')}
      className="hidden xl:inline-flex items-center gap-0.5 rounded-md border border-navy-secondary bg-navy-secondary/30 p-0.5"
      data-testid="store-scope-segments"
    >
      <button
        type="button"
        className={seg(clientId === '')}
        aria-pressed={clientId === ''}
        onClick={() => setClientId('')}
      >
        {t('top.all')}
      </button>
      {clients.map((c) => (
        <button
          key={c.id}
          type="button"
          className={seg(clientId === c.id)}
          aria-pressed={clientId === c.id}
          onClick={() => setClientId(c.id)}
          title={c.name}
        >
          {shortStoreName(c.name)}
        </button>
      ))}
    </div>
    </>
  );
}

export function Topbar({ onOpenCommandPalette, onOpenHelp }: TopbarProps) {
  const { t } = useI18n();
  const roleLabel = useRoleLabel();
  const { user, signOut, isOffline } = useAuth();
  const navigate = useNavigate();
  const pageTitle = usePageTitle();
  const breadcrumbs = usePageBreadcrumbs();
  const location = useLocation();

  /**
   * The phone's way back out of a detail screen.
   *
   * Shown only inside a section — at a root the top-left is the logo, as
   * before. The label prefers the parent breadcrumb ("Payroll") over a
   * bare "Back" because naming the destination is what makes it worth
   * tapping.
   */
  // An area shell (Settings & trust) holds pages at the top level too
  // (/audit, /trust): it names their "up", so the phone keeps a way back to
  // the area once the area's own rail is gone from the small screen.
  const up = usePageUp();
  const showBack = (!isSectionRoot(location.pathname) && location.pathname !== '/') || (!!up && up.to !== location.pathname);
  // The nearest crumb above this page that is a PLACE: a section heading
  // in a trail ("Settings & trust › Access & trust › Users") has no page
  // of its own, so Back names — and goes to — the one above it.
  const parentCrumb = backCrumbOf(breadcrumbs) ?? up;
  const backLabel = parentCrumb?.label ?? t('top.back');
  // A page that published no name is still somewhere the nav names
  // ("Assets", "Home") — never the wordmark on a page that has a name.
  const navLabel = useNavLabel();
  const assistant = useAssistant();

  const goBack = () => {
    // react-router stamps an index on each entry. Zero means this is the
    // first page of the session — someone followed a link from an email
    // straight into a detail — and history.back() would leave the app (or
    // in standalone, do nothing at all). Go UP a level instead, which is
    // always somewhere inside the product.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) {
      navigate(-1);
      return;
    }
    if (parentCrumb?.to) {
      navigate(parentCrumb.to);
      return;
    }
    const up = location.pathname.replace(/\/[^/]+\/?$/, '');
    navigate(up || '/');
  };
  const heroHidden = useHeroHidden();
  // When the last confirmed sync happened, so the offline pill can date
  // what's on screen rather than just apologise.
  const savedAt = isOffline ? offlineSessionSavedAt() : null;
  // Only a page that published a title has a hero to hand off from; the
  // wordmark fallback must never fade.
  const hasHero = !!pageTitle || !!(breadcrumbs && breadcrumbs.length > 0);
  const [signingOut, setSigningOut] = useState(false);
  const [switchingRole, setSwitchingRole] = useState(false);

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
    // relative z-30: the backdrop blur makes the bar its own stacking context,
    // and without a z-index <main> (later in the page) painted over anything
    // that opens out of the bar, such as the store-scope list.
    <header
      className="relative z-30 bg-navy/95 backdrop-blur elev-1 border-b border-navy-secondary flex items-center gap-2 md:gap-3 min-h-14 pt-[env(safe-area-inset-top)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:pl-[max(1.5rem,env(safe-area-inset-left))] md:pr-[max(1.5rem,env(safe-area-inset-right))]"
    >
      {/* No ☰ on phones: the tab bar's More opens the same menu, and two
          doors to one room read as a website, not an app.

          The top-left is the app's identity at a section root and a way
          BACK inside one — the iOS convention, and on a phone the only
          one available. Breadcrumbs are hidden below md (PageHeader), the
          tab bar only moves between sections rather than up out of a
          detail, and an installed PWA has no browser chrome at all: in
          standalone there was no way back from /payroll/compliance except
          a tab that threw away where you were. */}
      {showBack ? (
        <button
          type="button"
          onClick={goBack}
          aria-label={backLabel}
          className="md:hidden -ml-2 flex min-w-0 shrink items-center gap-0.5 rounded-md pl-1 pr-2 py-1 min-h-11 text-gold active:bg-navy-secondary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <ChevronLeft className="h-5 w-5 shrink-0" aria-hidden="true" />
          {/* Short: the page's own name, beside it, needs the room more. */}
          <span className="text-sm max-w-[4.5rem] truncate">{backLabel}</span>
        </button>
      ) : (
        <Logo size="sm" className="md:hidden" alt={t('top.logo')} />
      )}

      {/* Page title / breadcrumbs — sticks in chrome so wayfinding survives
          scroll. Prefer the breadcrumb trail when the page provided one;
          otherwise fall back to the title alone. Sourced from PageTitleProvider. */}
      <div
        // The handoff. While the page's own <h1> is on screen this block is
        // faded out but still occupies its space, so nothing reflows when it
        // arrives — and it's hidden from screen readers too, which would
        // otherwise meet the page's name twice in a row. A page with no hero
        // of its own (`hasHero` false) keeps its name here permanently.
        data-testid="topbar-title"
        aria-hidden={hasHero && !heroHidden}
        // Hidden from assistive tech AND from the tab order: a breadcrumb link
        // inside an aria-hidden block is a focus stop nobody can see.
        {...({ inert: hasHero && !heroHidden ? '' : undefined } as Record<string, unknown>)}
        className={cn(
          // On a phone the name gets the room (at least 40% of the bar): Back,
          // four icons and the avatar had squeezed it to "Peo…".
          'flex min-w-[40%] flex-1 items-center transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:min-w-0 md:flex-none',
          hasHero && !heroHidden
            ? 'pointer-events-none translate-y-1 opacity-0'
            : 'translate-y-0 opacity-100',
        )}
      >
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav
          aria-label={t('top.breadcrumb')}
          className="flex items-center gap-1 min-w-0 text-sm overflow-hidden"
        >
          {breadcrumbs.map((seg, i) => {
            const isLast = i === breadcrumbs.length - 1;
            const segClasses = cn(
              'truncate',
              isLast
                ? 'text-base md:text-lg text-white'
                : 'text-silver'
            );
            // The compact trail names the current page; the crumbs above it
            // come back only where the bar has room for them (2xl). Between,
            // the store scope and search leave ~230px, and "Clie… > Coastal
            // Resort Ho…" named neither — the page's own breadcrumb, a scroll
            // away, carries the full trail.
            const hideOnMobile = !isLast;
            return (
              <span
                key={`${seg.label}-${i}`}
                className={cn(
                  'flex items-center gap-1 min-w-0',
                  hideOnMobile && 'hidden 2xl:inline-flex',
                )}
              >
                {seg.to && !isLast ? (
                  <Link
                    to={seg.to}
                    className={cn(
                      segClasses,
                      'hover:text-white transition-colors rounded-sm px-0.5',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-navy',
                    )}
                  >
                    {seg.label}
                  </Link>
                ) : (
                  <span aria-current={isLast ? 'page' : undefined} className={segClasses}>
                    {seg.label}
                  </span>
                )}
                {!isLast && (
                  <ChevronRight
                    className="h-3.5 w-3.5 text-silver/70 shrink-0"
                    aria-hidden="true"
                  />
                )}
              </span>
            );
          })}
        </nav>
      ) : (
        <h2 className="text-base md:text-lg text-white truncate min-w-0">
          {pageTitle ?? navLabel ?? 'Alto People'}
        </h2>
      )}
      </div>

      <div className="hidden md:block flex-1 min-w-0" />

      <StoreScopeBar />

      {/* Cmd-K trigger — desktop gets the wide search box, mobile gets a
          one-tap icon (below) instead of a drawer detour. */}
      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="hidden md:inline-flex items-center gap-2 w-72 min-w-[9rem] shrink h-9 px-3 rounded-md border border-navy-secondary bg-navy-secondary/30 text-silver/80 hover:text-white hover:border-silver/40 transition-colors text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        aria-label={t('top.palette')}
        data-tour="search"
      >
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">{t('top.search')}</span>
        <kbd className="hidden lg:inline-flex items-center gap-0.5 h-5 px-1.5 rounded border border-navy-secondary bg-navy-secondary/40 font-mono text-3xs text-silver">
          ⌘K
        </kbd>
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        // With Back on a phone the bar holds Back, the page's name, the bell
        // and the account menu — search moves into that menu, so the name
        // keeps at least 40% of the bar (it read "Peo…" beside four icons).
        className={cn('shrink-0 md:hidden', showBack && 'hidden')}
        onClick={onOpenCommandPalette}
        aria-label={t('top.palette')}
      >
        <Search className="h-5 w-5" />
      </Button>

      {isOffline && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex items-center gap-1.5 text-xs text-alert/90 px-2 py-1 rounded bg-alert/10 border border-alert/30"
              role="status"
            >
              <WifiOff className="h-3 w-3" aria-hidden="true" />
              <span className="hidden sm:inline">{t('top.reconnecting')}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {/* Say what they're looking at, not just that something is wrong.
                Offline used to mean a wall of error banners; now the pages
                fill from the saved cache, and a number nobody can date is
                worse than a number labelled "from this morning". */}
            {savedAt
              ? t('top.offlineSaved', { when: fmtRelativeDate(new Date(savedAt)) })
              : t('top.offline')}
          </TooltipContent>
        </Tooltip>
      )}

      {user && (
        <>
          {/* Only when the person has chosen a zone that is not the device's
              own — the one case where a time on screen could be misread,
              and the one case where saying which zone earns its pixels. */}
          {displayZoneDiffersFromDevice() && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to="/settings"
                  className="hidden items-center gap-1 rounded-md border border-navy-secondary px-2 py-1 text-2xs uppercase tracking-wider text-silver hover:text-white sm:inline-flex"
                  aria-label={`Times are shown in ${displayZoneAbbrev()}. Change in settings.`}
                >
                  <Globe className="h-3 w-3 text-gold" aria-hidden="true" />
                  {displayZoneAbbrev()}
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                Times across the app are shown in {displayZoneAbbrev()}, your saved preference —
                not this device&rsquo;s clock.
              </TooltipContent>
            </Tooltip>
          )}
          <InstallAppButton />
          {/* Below md the assistant and help live in the account menu, so
              the page's name has the bar. */}
          <span className="hidden md:inline-flex">
            <AssistantButton />
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="hidden shrink-0 md:inline-flex"
            onClick={onOpenHelp}
            aria-label={t('top.help')}
            title={t('top.help')}
            data-tour="help"
          >
            <CircleHelp className="h-5 w-5" aria-hidden="true" />
          </Button>
          <span data-tour="bell" className="inline-flex shrink-0">
            <NotificationsBell />
          </span>

          {/* Mobile-only avatar fallback. The full account menu lives in the
              sidebar footer on desktop; on mobile the sidebar is hidden behind
              the hamburger so we keep a tappable shortcut to sign out / settings. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="md:hidden grid shrink-0 place-items-center h-11 w-11 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                aria-label={t('top.account')}
              >
                <Avatar
                  src={user.photoUrl}
                  name={[user.firstName, user.lastName].filter(Boolean).join(' ') || null}
                  email={user.email}
                  size="sm"
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[14rem]">
              <DropdownMenuLabel>{roleLabel(user.role)}</DropdownMenuLabel>
              <div className="px-2 pb-2 leading-tight">
                {(user.firstName || user.lastName) && (
                  <div className="text-sm text-white truncate">
                    {[user.firstName, user.lastName].filter(Boolean).join(' ')}
                  </div>
                )}
                <div className="text-xs text-silver truncate">{user.email}</div>
              </div>
              <DropdownMenuSeparator />
              {showBack && (
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    onOpenCommandPalette();
                  }}
                >
                  <Search className="h-4 w-4" />
                  {t('top.search')}
                </DropdownMenuItem>
              )}
              {assistant.available && assistant.me && (
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    assistant.toggle();
                  }}
                >
                  {isHugo(assistant.me.name) ? <HugoMascot pose="face" size={18} play="still" /> : <Sparkles className="h-4 w-4" />}
                  {t('top.askAssistant', { name: assistant.me.name })}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  onOpenHelp();
                }}
              >
                <CircleHelp className="h-4 w-4" />
                {t('top.help')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* Profile first — the page with the employee number,
                  emergency contacts, and tax docs was only reachable by
                  spelunking the More drawer. */}
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  navigate('/me');
                }}
              >
                <IdCard className="h-4 w-4" />
                {t('top.profile')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  navigate('/settings');
                }}
              >
                <User className="h-4 w-4" />
                {t('top.settings')}
              </DropdownMenuItem>
              {/* Only for the few accounts that do two jobs. On a phone the
                  choice opens as a sheet — a submenu beside this menu has no
                  room to open into. */}
              <RoleSwitchItem onOpen={() => setSwitchingRole(true)} />
              <DropdownMenuItem
                destructive
                onSelect={(e) => {
                  e.preventDefault();
                  void handleSignOut();
                }}
                disabled={signingOut}
              >
                <LogOut className="h-4 w-4" />
                {signingOut ? t('top.signingOut') : t('top.signOut')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Outside the menu, which unmounts as it closes. */}
          <RoleSwitchSheet open={switchingRole} onOpenChange={setSwitchingRole} />
        </>
      )}
    </header>
  );
}



/**
 * Back goes to the nearest crumb above the page that has a destination.
 * Exported for the test that pins it.
 */
export function backCrumbOf(crumbs: { label: string; to?: string }[] | null): { label: string; to?: string } | null {
  if (!crumbs || crumbs.length < 2) return null;
  for (let i = crumbs.length - 2; i >= 0; i -= 1) if (crumbs[i]!.to) return crumbs[i]!;
  return crumbs[crumbs.length - 2]!;
}

/**
 * The way in to the assistant from the chrome — the same pane the home
 * seat, ⌘J, the phone menu and the palette open. Hidden for an account
 * the assistant has nothing for (the provider asked the API once).
 */
function AssistantButton() {
  const { available, me, open, toggle } = useAssistant();
  const label = useHugoBadgeLabel(`Ask ${me?.name ?? ''}`);
  if (!available || !me) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggle}
          aria-label={label}
          aria-pressed={open}
          aria-keyshortcuts="Meta+J Control+J"
          data-tour="assistant"
          className={open ? 'text-accent' : undefined}
        >
          <span className="relative grid h-7 w-7 place-items-center">
            {isHugo(me.name) ? (
              // On a soft gold disc: navy on the navy bar needs the lift.
              <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-fill/20">
                <HugoMascot pose="face" size={24} play="still" />
              </span>
            ) : (
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            )}
            {/* What he has for you, and a soft ring while he works in the background. */}
            <HugoBadge />
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Ask {me.name}
        <span className="ml-2 text-silver/70">⌘J</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Below desktop width the scope is chosen in the phone menu; when one client
 * is chosen, a strip under the top bar says so (and clears it) so nobody reads a filtered
 * page as the whole company.
 */
export function StoreScopeStrip() {
  const { clients, clientId, setClientId } = useStoreScope();
  const { t } = useI18n();
  const chosen = clients.find((c) => c.id === clientId);
  if (!chosen) return null;
  // A slim strip under the top bar (the bar itself has no room on a phone).
  return (
    <div className="lg:hidden flex min-h-8 items-center gap-2 border-b border-gold/30 bg-gold/10 px-4 text-xs text-gold" role="status">
      <span className="min-w-0 flex-1 truncate">
        {t('nav.viewingClient')} <span className="font-semibold">{chosen.name}</span>
      </span>
      <button
        type="button"
        onClick={() => setClientId('')}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full hover:bg-gold/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        aria-label={`${t('nav.allClients')}: ${shortStoreName(chosen.name)}`}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

