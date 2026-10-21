import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import {
  Banknote,
  BookOpen,
  Building2,
  CalendarDays,
  CalendarPlus,
  ClipboardCheck,
  Clock,
  CornerDownRight,
  FileText,
  HelpCircle,
  Inbox,
  LogOut,
  MapPin,
  Receipt,
  Search,
  Sparkles,
  User,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useOverlayBackButton } from '@/lib/useOverlayBackButton';
import { DASHBOARD_NAV, visibleModules, applyTerms, roleNavLabels } from '@/lib/modules';
import { useI18n } from '@/lib/i18n';
import { useRecentModules } from '@/lib/navPersonalization';
import { DASHBOARD_ICON, MODULE_ICONS } from '@/lib/moduleIcons';
import { useClients } from '@/lib/useClients';
import { usePeopleSearch, useUniversalSearch } from '@/lib/usePaletteSearch';
import type { SearchKind, TermKey } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { personPhotoUrl } from '@/lib/photoUrl';
import { Avatar } from './Avatar';
import { useAssistant } from '@/lib/assistantContext';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './Dialog';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Opens the KeyboardShortcutsDialog mounted alongside the palette (in
   * Layout). Lifted in as a prop so the "Keyboard shortcuts" item can
   * actually show the overlay rather than just closing the palette.
   */
  onShowKeyboardShortcuts?: () => void;
}

/** Icon per record kind the universal search returns. */
const RECORD_ICON: Record<SearchKind, LucideIcon> = {
  people: User,
  clients: Building2,
  locations: MapPin,
  applications: ClipboardCheck,
  shifts: CalendarDays,
  documents: FileText,
  statements: Receipt,
  help: BookOpen,
};

/**
 * Group heading per record kind. Clients and sites are the tenant's own
 * nouns (a hotel says "Properties", a staffing firm "Stores"), so those two
 * come from `useTerm` rather than a literal.
 */
function recordHeading(kind: SearchKind, term: (key: TermKey) => string): string {
  switch (kind) {
    case 'people':
      return 'People';
    case 'clients':
      return term('nav.clients');
    case 'locations':
      return term('sites');
    case 'applications':
      return 'Applications';
    case 'shifts':
      return 'Shifts';
    case 'documents':
      return 'Documents';
    case 'statements':
      return 'Statements';
    case 'help':
      return 'Help center';
  }
}

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  group: 'Recent' | 'Navigation' | 'Actions' | 'Account' | 'Help';
  perform: (ctx: PerformCtx) => Promise<void> | void;
}

interface PerformCtx {
  navigate: ReturnType<typeof useNavigate>;
  signOut: () => Promise<void> | void;
  close: () => void;
}

/** Shared row styling so entity rows look identical to static rows.
 *  `normal-case tracking-normal` are explicit guards: cmdk nests items
 *  inside the group wrapper, so without them a group-level text-transform
 *  would cascade into every label + description. */
const ITEM_CLASS = cn(
  'flex items-center gap-3 px-2.5 py-2 rounded-md text-sm cursor-pointer text-white',
  'normal-case tracking-normal',
  // Gold left rail marks the active row — reads at a glance even when the
  // background tint is subtle.
  'border-l-2 border-transparent',
  'data-[selected=true]:bg-navy-secondary data-[selected=true]:text-gold data-[selected=true]:border-gold'
);

// Style the cmdk heading child specifically — NOT the group wrapper.
// Putting `uppercase tracking-widest` on the wrapper (the old bug) made
// text-transform + letter-spacing inherit into every row, which rendered
// all labels/descriptions uppercase and widened them enough to clip both
// edges of the palette.
const GROUP_CLASS = cn(
  'px-1',
  '[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase',
  '[&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-silver/80',
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1',
  // Hairline between groups so Pages / People / Actions scan as sections.
  '[&:not(:first-of-type)]:mt-1 [&:not(:first-of-type)]:border-t [&:not(:first-of-type)]:border-navy-secondary/60'
);

/** Chromed key hint used in the palette footer. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded border border-navy-secondary bg-navy-secondary/40 font-mono text-3xs text-silver">
      {children}
    </kbd>
  );
}

/**
 * App-wide command palette. Open with Cmd/Ctrl+K. Searches across module
 * routes, people (directory), clients, and quick actions. Built on cmdk so
 * the keyboard nav is native; filtering is manual (shouldFilter=false)
 * because People results come from the server and must not be re-filtered
 * by cmdk's fuzzy matcher (a hit on email would otherwise be hidden).
 */
export function CommandPalette({
  open,
  onOpenChange,
  onShowKeyboardShortcuts,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const { signOut, can, user } = useAuth();
  // Where a person result goes next, by what this login may open there.
  const personActions = (id: string): Array<{ key: string; label: string; to: string; icon: LucideIcon }> => [
    ...(can('manage:time') ? [{ key: 'time', label: 'Timesheet', to: `/people/${id}?tab=time`, icon: Clock }] : []),
    ...(can('manage:scheduling') || can('view:scheduling') ? [{ key: 'schedule', label: 'Schedule', to: `/scheduling?view=week&associate=${id}`, icon: CalendarDays }] : []),
    ...(can('view:comp') ? [{ key: 'pay', label: 'Change pay', to: `/people/${id}?tab=pay`, icon: Banknote }] : []),
    { key: 'documents', label: 'Documents', to: `/people/${id}?tab=documents`, icon: FileText },
  ];
  const assistant = useAssistant();
  const tenant = useTenant();
  const term = useTerm();
  const [search, setSearch] = useState('');

  // Reset search when reopening so the user always starts on a clean list.
  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  const close = () => onOpenChange(false);
  // Back dismisses the palette rather than the page it's floating over.
  useOverlayBackButton(open, close);

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
  const { clients: allClients } = useClients({
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

  // Static portion of the palette. The 60+ item objects (and the
  // MODULES.filter().map() behind them) only depend on the signed-in
  // user's capability set — memoize so they aren't rebuilt on every
  // keystroke. Search-dependent results (people/clients) stay outside.
  // Design system §4.1: the pages this person opened last come first, so the
  // palette is a way back as much as a way in (the sidebar already shows them).
  const recentKeys = useRecentModules();
  const { t: tr } = useI18n();
  const nav = useMemo(
    () => roleNavLabels(applyTerms(visibleModules(user?.role, can, { regionId: user?.regionId, modules: tenant.modules, tenantId: tenant.id }), term, tenant.modules), user?.role, tr),
    [user?.role, user?.regionId, can, tenant.modules, tenant.id, term, tr],
  );
  const items: PaletteItem[] = useMemo(() => [
    ...recentKeys.slice(0, 5).flatMap<PaletteItem>((key) => {
      const m = nav.find((x) => x.key === key);
      return m
        ? [{
            id: `recent-${m.key}`,
            label: m.label,
            hint: m.description,
            icon: MODULE_ICONS[m.key],
            keywords: m.description,
            group: 'Recent' as const,
            perform: ({ navigate, close }) => {
              navigate(m.path);
              close();
            },
          }]
        : [];
    }),
    {
      id: 'nav-dashboard',
      label: DASHBOARD_NAV.label,
      icon: DASHBOARD_ICON,
      group: 'Navigation',
      perform: ({ navigate, close }) => {
        navigate(DASHBOARD_NAV.path);
        close();
      },
    },
    // visibleModules, not a raw capability slice — the palette must offer
    // the same curated nav the sidebar shows (an associate was getting all
    // 25 HR modules here while their sidebar showed 14).
    ...nav.map<PaletteItem>((m) => ({
      id: `nav-${m.key}`,
      label: m.label,
      hint: m.description,
      icon: MODULE_ICONS[m.key],
      keywords: m.description,
      group: 'Navigation',
      perform: ({ navigate, close }) => {
        navigate(m.path);
        close();
      },
    })),
    // The assistant, when this account has one: opens the pane, with the
    // palette's words as the question.
    ...(assistant.available && assistant.me
      ? [
          {
            id: 'action-ask-assistant',
            label: `Ask ${assistant.me.name}`,
            hint: 'AI assistant — answers from your records',
            icon: Sparkles,
            keywords: 'ask assistant help ai question',
            group: 'Actions',
            perform: ({ close }: PerformCtx) => {
              close();
              assistant.setOpen(true);
            },
          } satisfies PaletteItem,
        ]
      : []),
    // Quick actions — static, capability-gated navigations. Distinct icons
    // so they read as "do a thing", not "go to a page".
    ...(can('view:scheduling') && can('manage:scheduling')
      ? [
          {
            id: 'action-new-shift',
            label: 'New shift',
            hint: 'Create a shift',
            icon: CalendarPlus,
            keywords: 'create schedule add',
            group: 'Actions',
            perform: ({ navigate, close }: PerformCtx) => {
              // ?new=shift → scheduling opens its create-shift dialog directly.
              navigate('/scheduling?new=shift');
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
              navigate('/time-attendance?tab=queue');
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
              navigate('/payroll?new=run');
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
    ...(can('invite:onboarding')
      ? [
          {
            id: 'action-invite-associate',
            label: 'Invite associate',
            hint: 'Send an onboarding application',
            icon: UserPlus,
            keywords: 'new hire application send',
            group: 'Actions',
            perform: ({ navigate, close }: PerformCtx) => {
              // ?new=invite → onboarding opens its invite dialog directly.
              navigate('/onboarding?new=invite');
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
      hint: 'See every shortcut (also: press ?)',
      icon: HelpCircle,
      group: 'Help',
      perform: ({ close }) => {
        close();
        onShowKeyboardShortcuts?.();
      },
    },
  ], [can, user, onShowKeyboardShortcuts, tenant.modules, tenant.id, term, nav, recentKeys, assistant]);

  // Manual filtering (cmdk shouldFilter is off). Same fields the old
  // cmdk value string covered: label + keywords.
  const matchesQuery = (item: PaletteItem) =>
    q === '' || `${item.label} ${item.keywords ?? ''}`.toLowerCase().includes(q);
  const visibleItems = items.filter(matchesQuery);

  const showPeopleGroup =
    canSearchPeople && entityQueryActive && (people.length > 0 || peopleSearching);
  const showClientsGroup = clientMatches.length > 0;
  // Everything else — applications, shifts, documents, statements, stores,
  // help articles — from one request; people and clients above keep their
  // own (cached, instant) paths, so those two groups are skipped here.
  const { groups: recordGroups } = useUniversalSearch(search, open && entityQueryActive);
  const extraGroups = recordGroups.filter((g) => g.kind !== 'people' && g.kind !== 'clients');
  const hasAnyResult =
    visibleItems.length > 0 || people.length > 0 || showClientsGroup || extraGroups.length > 0;

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
                <div className="text-xs2 text-silver/70 truncate">{item.hint}</div>
              )}
            </div>
          </Command.Item>
        ))}
      </Command.Group>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 overflow-hidden gap-0 rounded-xl elev-3 ring-1 ring-white/[0.06]">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search to navigate, find people{tenant.moduleOn('clientPortal') ? ` and ${term('label.clients').toLowerCase()}` : ''}, run quick actions, or
          access account controls.
        </DialogDescription>
        <Command
          label="Command palette"
          shouldFilter={false}
          className="bg-navy w-full min-w-0 overflow-hidden"
        >
          <div className="flex items-center border-b border-navy-secondary px-3">
            <Search className="h-4 w-4 text-silver/70 mr-2 shrink-0" aria-hidden="true" />
            <Command.Input
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder={tenant.moduleOn('clientPortal') ? `Search pages, people, ${term('label.clients').toLowerCase()}, shifts, documents…` : 'Search pages, people, shifts, documents…'}
              className={cn(
                'flex h-12 w-full bg-transparent text-sm text-white placeholder:text-silver/70',
                'outline-none border-0 focus:ring-0'
              )}
            />
          </div>
          <Command.List className="max-h-[60dvh] w-full overflow-y-auto overflow-x-hidden p-1 [&_[cmdk-list-sizer]]:w-full [&_[cmdk-list-sizer]]:min-w-0">
            {/* Suppress "No results." while a people search is pending so
                the list shows only the Searching… row, not both. */}
            {!hasAnyResult && !peopleSearching && (
              <Command.Empty className="py-8 text-center text-sm text-silver">
                No results.
              </Command.Empty>
            )}

            {renderStaticGroup('Recent', 'Recent')}
            {renderStaticGroup('Navigation', 'Pages')}

            {showPeopleGroup && (
              <Command.Group heading="People" className={GROUP_CLASS}>
                {people.map((p, i) => {
                  const fullName = `${p.firstName} ${p.lastName}`.trim();
                  const hint = [p.workplaceClientName, p.position]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <Fragment key={p.id}>
                    <Command.Item
                      value={`person-${p.id}`}
                      onSelect={() => {
                        // Straight to their profile drawer — landing on a
                        // name-filtered list was one click short, and wrong
                        // for duplicate names.
                        navigate(`/people?associateId=${p.id}`);
                        close();
                      }}
                      className={ITEM_CLASS}
                    >
                      <Avatar
                        src={personPhotoUrl({ photoUrl: p.photoUrl, associateId: p.id })}
                        name={fullName}
                        email={p.email}
                        size="xs"
                        className="-my-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{fullName}</div>
                        {hint && (
                          <div className="text-xs2 text-silver/70 truncate">
                            {hint}
                          </div>
                        )}
                      </div>
                    </Command.Item>
                    {/* The best match also offers where people usually go next. */}
                    {i === 0 &&
                      personActions(p.id).map((act) => (
                        <Command.Item
                          key={act.key}
                          value={`person-${p.id}-${act.key}`}
                          keywords={[fullName, act.label]}
                          onSelect={() => {
                            navigate(act.to);
                            close();
                          }}
                          className={cn(ITEM_CLASS, 'pl-8')}
                        >
                          <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-silver/60" aria-hidden="true" />
                          <act.icon className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
                          <span className="flex-1 truncate">
                            {act.label}
                            <span className="text-silver/60"> · {fullName}</span>
                          </span>
                        </Command.Item>
                      ))}
                    </Fragment>
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
              <Command.Group heading={term('nav.clients')} className={GROUP_CLASS}>
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
                        <div className="text-xs2 text-silver/70 truncate">
                          {c.industry}
                        </div>
                      )}
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {extraGroups.map((g) => (
              <Command.Group key={g.kind} heading={recordHeading(g.kind, term)} className={GROUP_CLASS}>
                {g.hits.map((hit) => {
                  const Icon = RECORD_ICON[g.kind];
                  return (
                    <Command.Item
                      key={`${g.kind}-${hit.id}`}
                      value={`${g.kind}-${hit.id}`}
                      onSelect={() => {
                        navigate(hit.href);
                        close();
                      }}
                      className={ITEM_CLASS}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{hit.title}</div>
                        {hit.hint && <div className="text-xs2 text-silver/70 truncate">{hit.hint}</div>}
                      </div>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            ))}

            {renderStaticGroup('Actions', 'Actions')}
            {renderStaticGroup('Account', 'Account')}
            {renderStaticGroup('Help', 'Help')}
          </Command.List>
          <div className="flex items-center justify-between border-t border-navy-secondary px-3 py-2 text-2xs text-silver/80">
            <div className="inline-flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-gold" aria-hidden="true" />
              Alto People
            </div>
            <div className="hidden sm:inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>↵</Kbd> select
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>esc</Kbd> close
              </span>
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
