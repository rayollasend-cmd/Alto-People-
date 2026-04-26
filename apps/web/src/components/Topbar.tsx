import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Menu, User, WifiOff } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/roles';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';

interface TopbarProps {
  onOpenMobileNav: () => void;
}

export function Topbar({ onOpenMobileNav }: TopbarProps) {
  const { user, signOut, isOffline } = useAuth();
  const navigate = useNavigate();
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
    <header className="bg-navy border-b border-navy-secondary px-4 md:px-6 py-3 flex items-center gap-3">
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden -ml-1"
        onClick={onOpenMobileNav}
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" />
      </Button>

      <div className="md:hidden font-display text-xl text-gold">Alto People</div>

      {isOffline && (
        <span
          className="hidden md:inline-flex items-center gap-1.5 text-xs text-alert/90 px-2 py-1 rounded bg-alert/10 border border-alert/30"
          role="status"
        >
          <WifiOff className="h-3 w-3" aria-hidden="true" />
          Reconnecting…
        </span>
      )}

      <div className="flex-1" />

      {user && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-navy-secondary/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
              aria-label="Account menu"
            >
              <div className="h-7 w-7 rounded-full bg-gold/15 border border-gold/30 grid place-items-center text-gold text-xs font-medium">
                {initials(user.email)}
              </div>
              <div className="hidden sm:block text-right leading-tight">
                <div className="text-[10px] uppercase tracking-widest text-silver">
                  {ROLE_LABELS[user.role]}
                </div>
                <div className="text-sm text-white truncate max-w-[16ch] md:max-w-[24ch]">
                  {user.email}
                </div>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[16rem]">
            <DropdownMenuLabel>{ROLE_LABELS[user.role]}</DropdownMenuLabel>
            <div className="px-2 pb-2 text-sm text-white truncate">{user.email}</div>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              <User className="h-4 w-4" />
              Account settings
              <span className="ml-auto text-[10px] text-silver/60">soon</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              destructive
              onSelect={(e) => {
                e.preventDefault();
                handleSignOut();
              }}
              disabled={signingOut}
            >
              <LogOut className="h-4 w-4" />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
