import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import {
  Briefcase,
  HelpCircle,
  LogOut,
  Search,
  Sparkles,
  User,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { DASHBOARD_NAV, MODULES } from '@/lib/modules';
import { cn } from '@/lib/cn';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './Dialog';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  group: 'Navigation' | 'Account' | 'Quick actions' | 'Help';
  perform: (ctx: PerformCtx) => Promise<void> | void;
}

interface PerformCtx {
  navigate: ReturnType<typeof useNavigate>;
  signOut: () => Promise<void> | void;
  close: () => void;
}

/**
 * App-wide command palette. Open with Cmd/Ctrl+K. Searches across module
 * routes, account actions, and quick actions. Built on cmdk so the
 * filtering and keyboard nav are native.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { signOut, can, user } = useAuth();
  const [search, setSearch] = useState('');

  // Reset search when reopening so the user always starts on a clean list.
  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  const close = () => onOpenChange(false);

  const items: PaletteItem[] = [
    {
      id: 'nav-dashboard',
      label: DASHBOARD_NAV.label,
      icon: DASHBOARD_NAV.icon,
      group: 'Navigation',
      perform: ({ navigate, close }) => {
        navigate(DASHBOARD_NAV.path);
        close();
      },
    },
    ...MODULES.filter((m) => can(m.requires)).map<PaletteItem>((m) => ({
      id: `nav-${m.key}`,
      label: m.label,
      hint: m.description,
      icon: m.icon,
      keywords: m.description,
      group: 'Navigation',
      perform: ({ navigate, close }) => {
        navigate(m.path);
        close();
      },
    })),
    {
      id: 'account-copy-email',
      label: 'Copy my email',
      icon: User,
      group: 'Account',
      perform: ({ close }) => {
        if (user?.email) {
          navigator.clipboard.writeText(user.email).catch(() => {});
        }
        close();
      },
    },
    {
      id: 'account-sign-out',
      label: 'Sign out',
      icon: LogOut,
      group: 'Account',
      perform: async ({ signOut, navigate, close }) => {
        close();
        await signOut();
        navigate('/login', { replace: true });
      },
    },
    {
      id: 'help-shortcuts',
      label: 'Keyboard shortcuts',
      hint: 'Open this palette with ⌘K / Ctrl+K',
      icon: HelpCircle,
      group: 'Help',
      perform: ({ close }) => close(),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search to navigate, run quick actions, or access account controls.
        </DialogDescription>
        <Command label="Command palette" className="bg-navy">
          <div className="flex items-center border-b border-navy-secondary px-3">
            <Search className="h-4 w-4 text-silver/60 mr-2 shrink-0" aria-hidden="true" />
            <Command.Input
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder="Type a command or search…"
              className={cn(
                'flex h-12 w-full bg-transparent text-sm text-white placeholder:text-silver/60',
                'outline-none border-0 focus:ring-0'
              )}
            />
            <span className="ml-2 hidden sm:inline-flex items-center gap-1 text-[10px] text-silver/60 border border-navy-secondary rounded px-1.5 py-0.5 font-mono">
              ESC
            </span>
          </div>
          <Command.List className="max-h-[60vh] overflow-y-auto p-1">
            <Command.Empty className="py-8 text-center text-sm text-silver">
              No results.
            </Command.Empty>

            {(['Navigation', 'Account', 'Quick actions', 'Help'] as const).map((group) => {
              const groupItems = items.filter((i) => i.group === group);
              if (groupItems.length === 0) return null;
              return (
                <Command.Group
                  key={group}
                  heading={group}
                  className="text-[10px] uppercase tracking-widest text-silver/60 px-2 pt-2 pb-1"
                >
                  {groupItems.map((item) => (
                    <Command.Item
                      key={item.id}
                      value={`${item.label} ${item.keywords ?? ''}`}
                      onSelect={() => item.perform({ navigate, signOut, close })}
                      className={cn(
                        'flex items-center gap-3 px-2.5 py-2 rounded-md text-sm cursor-pointer text-white',
                        'data-[selected=true]:bg-navy-secondary data-[selected=true]:text-gold'
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{item.label}</div>
                        {item.hint && (
                          <div className="text-[11px] text-silver/70 truncate">
                            {item.hint}
                          </div>
                        )}
                      </div>
                    </Command.Item>
                  ))}
                </Command.Group>
              );
            })}
          </Command.List>
          <div className="flex items-center justify-between border-t border-navy-secondary px-3 py-2 text-[10px] text-silver/60">
            <div className="inline-flex items-center gap-1.5">
              <Briefcase className="h-3 w-3" aria-hidden="true" />
              Alto People
            </div>
            <div className="inline-flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-gold" aria-hidden="true" />
              Cmd+K from anywhere
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Provider hook — listens for Cmd/Ctrl+K globally and toggles the palette.
 * Call once in Layout. Returns the open-state so the Topbar can render a
 * "⌘K" button that opens it on click.
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Cmd-K on macOS, Ctrl-K elsewhere.
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return { open, setOpen };
}
