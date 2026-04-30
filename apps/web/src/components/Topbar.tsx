import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, LogOut, Menu, Search, User, WifiOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/roles';
import { usePageBreadcrumbs, usePageTitle } from '@/lib/pageTitle';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
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
import { InstallAppButton } from './InstallAppButton';
import { Logo } from '@/components/Logo';

interface TopbarProps {
  onOpenMobileNav: () => void;
  onOpenCommandPalette: () => void;
}

export function Topbar({ onOpenMobileNav, onOpenCommandPalette }: TopbarProps) {
  const { user, signOut, isOffline } = useAuth();
  const navigate = useNavigate();
  const pageTitle = usePageTitle();
  const breadcrumbs = usePageBreadcrumbs();
  const [signingOut, setSigningOut] = useState(false);

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
    <header
      className="bg-navy border-b border-navy-secondary flex items-center gap-3 min-h-14 pt-[env(safe-area-inset-top)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:pl-[max(1.5rem,env(safe-area-inset-left))] md:pr-[max(1.5rem,env(safe-area-inset-right))]"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden -ml-1"
        onClick={onOpenMobileNav}
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <Logo size="xs" className="md:hidden" alt="Alto HR" />

      {/* Page title / breadcrumbs — sticks in chrome so wayfinding survives
          scroll. Prefer the breadcrumb trail when the page provided one;
          otherwise fall back to the title alone. Sourced from PageTitleProvider. */}
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1 min-w-0 text-sm overflow-hidden"
        >
          {breadcrumbs.map((seg, i) => {
            const isLast = i === breadcrumbs.length - 1;
            const segClasses = cn(
              'truncate',
              isLast
                ? 'font-display text-base md:text-lg text-white'
                : 'text-silver'
            );
            // On phones we collapse intermediate crumbs and only show the
            // current page (last segment). On sm+ the full trail renders.
            // Without this, six 4-character truncated crumbs eat the whole
            // header and nothing is readable.
            const hideOnMobile = !isLast;
            return (
              <span
                key={`${seg.label}-${i}`}
                className={cn(
                  'flex items-center gap-1 min-w-0',
                  hideOnMobile && 'hidden sm:inline-flex',
                )}
              >
                {seg.to && !isLast ? (
                  <Link
                    to={seg.to}
                    className={cn(segClasses, 'hover:text-white transition-colors')}
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
                    className="h-3.5 w-3.5 text-silver/60 shrink-0"
                    aria-hidden="true"
                  />
                )}
              </span>
            );
          })}
        </nav>
      ) : (
        <h2 className="font-display text-base md:text-lg text-white truncate min-w-0">
          {pageTitle ?? 'Alto People'}
        </h2>
      )}

      <div className="flex-1 min-w-0" />

      {/* Cmd-K trigger — desktop only, mobile users open it from the hamburger drawer. */}
      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="hidden md:inline-flex items-center gap-2 w-72 px-3 py-1.5 rounded-md border border-navy-secondary bg-navy-secondary/30 text-silver/80 hover:text-white hover:border-silver/40 transition-colors text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        aria-label="Open command palette"
      >
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="flex-1 text-left">Search or jump to…</span>
        <kbd className="hidden lg:inline-flex items-center gap-0.5 text-[10px] font-mono text-silver/60 border border-navy-secondary rounded px-1 py-0.5">
          ⌘K
        </kbd>
      </button>

      {isOffline && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex items-center gap-1.5 text-xs text-alert/90 px-2 py-1 rounded bg-alert/10 border border-alert/30"
              role="status"
            >
              <WifiOff className="h-3 w-3" aria-hidden="true" />
              <span className="hidden sm:inline">Reconnecting…</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Lost connection. Trying again.</TooltipContent>
        </Tooltip>
      )}

      {user && (
        <>
          <InstallAppButton />
          <NotificationsBell />

          {/* Mobile-only avatar fallback. The full account menu lives in the
              sidebar footer on desktop; on mobile the sidebar is hidden behind
              the hamburger so we keep a tappable shortcut to sign out / settings. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="md:hidden grid place-items-center h-11 w-11 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                aria-label="Account menu"
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
              <DropdownMenuLabel>{ROLE_LABELS[user.role]}</DropdownMenuLabel>
              <div className="px-2 pb-2 leading-tight">
                {(user.firstName || user.lastName) && (
                  <div className="text-sm text-white truncate">
                    {[user.firstName, user.lastName].filter(Boolean).join(' ')}
                  </div>
                )}
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
        </>
      )}
    </header>
  );
}

