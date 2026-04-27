import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Menu, Search, User, WifiOff } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/roles';
import { usePageTitle } from '@/lib/pageTitle';
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
import { NotificationsBell } from './NotificationsBell';

interface TopbarProps {
  onOpenMobileNav: () => void;
  onOpenCommandPalette: () => void;
}

export function Topbar({ onOpenMobileNav, onOpenCommandPalette }: TopbarProps) {
  const { user, signOut, isOffline } = useAuth();
  const navigate = useNavigate();
  const pageTitle = usePageTitle();
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
    <header className="bg-navy border-b border-navy-secondary px-4 md:px-6 h-14 flex items-center gap-3">
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden -ml-1"
        onClick={onOpenMobileNav}
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* Page title — sticks in chrome so the page name stays visible after
          users scroll past the in-page PageHeader. Sourced from PageTitleProvider. */}
      <h2 className="font-display text-base md:text-lg text-white truncate min-w-0">
        {pageTitle ?? 'Alto People'}
      </h2>

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
          <NotificationsBell />

          {/* Mobile-only avatar fallback. The full account menu lives in the
              sidebar footer on desktop; on mobile the sidebar is hidden behind
              the hamburger so we keep a tappable shortcut to sign out / settings. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="md:hidden h-8 w-8 rounded-full bg-gold/15 border border-gold/30 grid place-items-center text-gold text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                aria-label="Account menu"
              >
                {initials(user.email)}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[14rem]">
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

function initials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}
