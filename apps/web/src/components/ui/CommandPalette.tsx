import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import {
  Banknote,
  Briefcase,
  Building2,
  CalendarPlus,
  ClipboardCheck,
  HelpCircle,
  Inbox,
  LogOut,
  Search,
  Sparkles,
  User,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { DASHBOARD_NAV, MODULES } from '@/lib/modules';
import { listClients } from '@/lib/clientsApi';
import { usePeopleSearch } from '@/lib/usePaletteSearch';
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
  group: 'Navigation' | 'Actions' | 'Account' | 'Help';
  perform: (ctx: PerformCtx) => Promise<void> | void;
}

interface PerformCtx {
  navigate: ReturnType<typeof useNavigate>;
  signOut: () => Promise<void> | void;
  close: () => void;
}

/** Shared row styling so entity rows look identical to static rows. */
const ITEM_CLASS = cn(
  'flex items-center gap-3 px-2.5 py-2 rounded-md text-sm cursor-pointer text-white',
  'data-[selected=true]:bg-navy-secondary data-[selected=true]:text-gold'
);

const GROUP_CLASS =
  'text-[10px] uppercase tracking-widest text-silver/80 px-2 pt-2 pb-1';

/**
 * App-wide command palette. Open with Cmd/Ctrl+K. Searches across module
 * routes, people (directory), clients, and quick actions. Built on cmdk so
 * the keyboard nav is native; filtering is manual (shouldFilter=false)
 * because People results come from the server and must not be re-filtered
 * by cmdk's fuzzy matcher (a hit on email would otherwise be hidden).
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

  const q = search.trim().toLowerCase();
  const entityQueryActive = q.length >= 2;

  // People — debounced server search, capability-gated. The hook ignores
  // out-of-order responses and returns at most 5 matches.
  const canSearchPeople = open && can('view:org');
  const { results: people, isSearching: peopleSearching } = usePeopleSearch(
    search,
    canSearchPeople
  );

  // Clients — reuse the app-wide cached list (same key + staleTime as the
  // Clients page / directory facet) and filter client-side. Only fetched
  // once the user actually types an entity-length query.
  const canSearchClients = can('view:clients');
  const { data: allClients = [] } = useQuery({
    queryKey: ['clients', 'list'],
    queryFn: async () => (await listClients()).clients,
    staleTime: 5 * 60_000,
    enabled: open && entityQueryActive && canSearchClients,
  });
  const clientMatches =
    entityQueryActive && canSearchClients
      ? allClients
          .filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              (c.industry ?? '').toLowerCase().includes(q)
          )
          .slice(0, 5)
      : [];

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
    // Quick actions — static, capability-gated navigations. Distinct icons
    // so they read as "do a thing", not "go to a page".
    ...(can('view:scheduling') && can('manage:scheduling')
      ? [
          {
            id: 'action-new-shift',
            label: 'New shift',
            hint: 'Open scheduling to create a shift',
            icon: CalendarPlus,
            keywords: 'create schedule add',
            group: 'Actions',
            perform: ({ navigate, close }: PerformCtx) => {
              navigate('/scheduling');
              close();
            },
          } satisfies PaletteItem,
        ]
      : []),
    ...(can('manage:time')
      ? [
          {
            id: 'action-review-timesheets',
            label: 'Review timesheets',
            hint: 'Open time & attendance approvals',
            icon: ClipboardCheck,
            keywords: 'approve time attendance punches',
            group: 'Actions',
            perform: ({ navigate, close }: PerformCtx) => {
              navigate('/time-attendance');
              close();
            },
          } satisfies PaletteItem,
        ]
      : []),
    ...(can('process:payroll')
      ? [
          {
            id: 'action-run-payroll',
            label: 'Run payroll',
            hint: 'Open payroll to start a run',
            icon: Banknote,
            keywords: 'pay disburse wages',
            group: 'Actions',
            perform: ({ navigate, close }: PerformCtx) => {
              navigate('/payroll');
              close();
            },
          } satisfies PaletteItem,
        ]
      : []),
    ...(can('manage:scheduling')
      ? [
          {
            id: 'action-approvals-inbox',
            label: 'Approvals inbox',
            hint: 'Swaps, pickups, time off, and timesheets waiting on you',
            icon: Inbox,
            keywords: 'pending requests decisions',
            group: 'Actions',
            perform: ({ navigate, close }: PerformCtx) => {
              navigate('/approvals');
              close();
            },
          } satisfies PaletteItem,
        ]
      : []),
    ...(can('manage:onboarding')
      ? [
          {
            id: 'action-invite-associate',
            label: 'Invite associate',
            hint: 'Open onboarding to send an application',
            icon: UserPlus,
            keywords: 'new hire application send',
            group: 'Actions',
            perform: ({ navigate, close }: PerformCtx) => {
              navigate('/onboarding');
              close();
            },
          } satisfies PaletteItem,
        ]
      : []),
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

  // Manual filtering (cmdk shouldFilter is off). Same fields the old
  // cmdk value string covered: label + keywords.
  const matchesQuery = (item: PaletteItem) =>
    q === '' || `${item.label} ${item.keywords ?? ''}`.toLowerCase().includes(q);
  const visibleItems = items.filter(matchesQuery);

  const showPeopleGroup =
    canSearchPeople && entityQueryActive && (people.length > 0 || peopleSearching);
  const showClientsGroup = clientMatches.length > 0;
  const hasAnyResult =
    visibleItems.length > 0 || people.length > 0 || showClientsGroup;

  const renderStaticGroup = (group: PaletteItem['group'], heading: string) => {
    const groupItems = visibleItems.filter((i) => i.group === group);
    if (groupItems.length === 0) return null;
    return (
      <Command.Group key={group} heading={heading} className={GROUP_CLASS}>
        {groupItems.map((item) => (
          <Command.Item
            key={item.id}
            value={item.id}
            onSelect={() => item.perform({ navigate, signOut, close })}
            className={ITEM_CLASS}
          >
            <item.icon className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="truncate">{item.label}</div>
              {item.hint && (
                <div className="text-[11px] text-silver/70 truncate">{item.hint}</div>
              )}
            </div>
          </Command.Item>
        ))}
      </Command.Group>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search to navigate, find people and clients, run quick actions, or
          access account controls.
        </DialogDescription>
        <Command label="Command palette" shouldFilter={false} className="bg-navy">
          <div className="flex items-center border-b border-navy-secondary px-3">
            <Search className="h-4 w-4 text-silver/70 mr-2 shrink-0" aria-hidden="true" />
            <Command.Input
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder="Search pages, people, clients…"
              className={cn(
                'flex h-12 w-full bg-transparent text-sm text-white placeholder:text-silver/70',
                'outline-none border-0 focus:ring-0'
              )}
            />
            <span className="ml-2 hidden sm:inline-flex items-center gap-1 text-[10px] text-silver/70 border border-navy-secondary rounded px-1.5 py-0.5 font-mono">
              ESC
            </span>
          </div>
          <Command.List className="max-h-[60vh] overflow-y-auto p-1">
            {/* Suppress "No results." while a people search is pending so
                the list shows only the Searching… row, not both. */}
            {!hasAnyResult && !peopleSearching && (
              <Command.Empty className="py-8 text-center text-sm text-silver">
                No results.
              </Command.Empty>
            )}

            {renderStaticGroup('Navigation', 'Pages')}

            {showPeopleGroup && (
              <Command.Group heading="People" className={GROUP_CLASS}>
                {people.map((p) => {
                  const fullName = `${p.firstName} ${p.lastName}`.trim();
                  const hint = [p.workplaceClientName, p.position]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <Command.Item
                      key={p.id}
                      value={`person-${p.id}`}
                      onSelect={() => {
                        navigate(`/people?q=${encodeURIComponent(fullName)}`);
                        close();
                      }}
                      className={ITEM_CLASS}
                    >
                      <User className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{fullName}</div>
                        {hint && (
                          <div className="text-[11px] text-silver/70 truncate">
                            {hint}
                          </div>
                        )}
                      </div>
                    </Command.Item>
                  );
                })}
                {/* Same height as an item row so results replacing it don't
                    shift the list. Only shown while nothing matched yet —
                    existing matches stay visible during refinement. */}
                {peopleSearching && people.length === 0 && (
                  <div
                    className="flex items-center gap-3 px-2.5 py-2 text-sm text-silver/70"
                    role="status"
                  >
                    <Search className="h-4 w-4 shrink-0 animate-pulse" aria-hidden="true" />
                    Searching…
                  </div>
                )}
              </Command.Group>
            )}

            {showClientsGroup && (
              <Command.Group heading="Clients" className={GROUP_CLASS}>
                {clientMatches.map((c) => (
                  <Command.Item
                    key={c.id}
                    value={`client-${c.id}`}
                    onSelect={() => {
                      navigate(`/clients/${c.id}`);
                      close();
                    }}
                    className={ITEM_CLASS}
                  >
                    <Building2 className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{c.name}</div>
                      {c.industry && (
                        <div className="text-[11px] text-silver/70 truncate">
                          {c.industry}
                        </div>
                      )}
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {renderStaticGroup('Actions', 'Actions')}
            {renderStaticGroup('Account', 'Account')}
            {renderStaticGroup('Help', 'Help')}
          </Command.List>
          <div className="flex items-center justify-between border-t border-navy-secondary px-3 py-2 text-[10px] text-silver/80">
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
