import { useMemo, useState } from 'react';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Cake, PartyPopper, Send } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  listUpcomingCelebrations,
  sendHighFive,
  type CelebrationItem,
} from '@/lib/celebrations107Api';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  FilterBar,
  SearchInput,
  SegmentedControl,
  SkeletonRows,
  Textarea,
  Select,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { Avatar } from '@/components/ui/Avatar';
import { personPhotoUrl } from '@/lib/photoUrl';
import { ListTemplate } from '@/components/templates';
import { fmtDateOnly, parseYmd } from '@/lib/format';
import { workweekBounds } from '@/lib/workweek';
import { QueryError } from '@/components/ui/QueryError';
import { urlNumber, useUrlParam, useUrlState } from '@/lib/useUrlState';

const WINDOW_OPTIONS = [30, 60, 90] as const;
const DAYS_CODEC = urlNumber({ integer: true, min: 30, max: 90 });

const keyOf = (c: CelebrationItem) => `${c.associateId}-${c.kind}-${c.date}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Phase 107 — Birthdays + work anniversaries.
 *
 * One list at full width, today first, then the rest of this week, next
 * week, this month and later — each row the date, the person, the occasion
 * and a note to send. The window (30/60/90 days) and the client/store
 * filters live in the URL.
 */
export function CelebrationsHome() {
  const [daysRaw, setDays] = useUrlState<number>('days', 60, DAYS_CODEC);
  const days = (WINDOW_OPTIONS as readonly number[]).includes(daysRaw) ? daysRaw : 60;
  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useUrlParam<string>('client', '');
  const [storeFilter, setStoreFilter] = useUrlParam<string>('store', '');
  const termWord = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  // A shift supervisor's list is already their crew (the server clamps it).
  const isCrewLead = useAuth().user?.role === 'SHIFT_SUPERVISOR';
  const [target, setTarget] = useState<CelebrationItem | null>(null);
  // Cards already high-fived this session — disabled so nobody
  // double-sends the same congrats.
  const [sentKeys, setSentKeys] = useState<Set<string>>(new Set());

  const itemsQuery = useQuery({
    queryKey: ['CelebrationsHome', 'items', days],
    queryFn: () => listUpcomingCelebrations(days),
  });
  const items = itemsQuery.data?.items ?? null;

  const term = search.trim().toLowerCase();
  // Where people work, from the items themselves — the filters only offer
  // places that have someone to celebrate.
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of items ?? []) if (c.clientId && c.clientName) m.set(c.clientId, c.clientName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);
  const storeOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of items ?? []) if (c.locationId && c.siteName && (!clientFilter || c.clientId === clientFilter)) m.set(c.locationId, c.siteName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items, clientFilter]);
  const filtered = items
    ? items.filter(
        (c) =>
          (!term || c.associateName.toLowerCase().includes(term)) &&
          (!clientFilter || c.clientId === clientFilter) &&
          (!storeFilter || c.locationId === storeFilter),
      )
    : null;
  const buckets = filtered ? bucketize(filtered) : null;
  const week = buckets ? [...buckets.Today, ...buckets['This week']] : [];
  const weekBirthdays = week.filter((c) => c.kind === 'BIRTHDAY').length;
  const weekAnniversaries = week.length - weekBirthdays;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title="Celebrations"
      subtitle={isCrewLead ? 'Your crew’s upcoming birthdays and work anniversaries.' : 'Upcoming birthdays and work anniversaries, by where people work.'}
    >
      <FilterBar
        bare
        search={
          <SearchInput
            className="h-8 w-full text-xs sm:w-56"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name…"
            aria-label="Search by name"
          />
        }
        urlKey={['days', 'client', 'store']}
      >
        <SegmentedControl<number>
          ariaLabel="Look-ahead window"
          options={WINDOW_OPTIONS.map((d) => ({ value: d, label: `Next ${d} days` }))}
          value={days}
          onChange={(d) => setDays(d)}
        />
        {hasClients && clientOptions.length > 1 && (
          <Select
            size="sm"
            aria-label={termWord('label.client')}
            value={clientFilter}
            onChange={(e) => {
              setClientFilter(e.target.value);
              setStoreFilter('');
            }}
          >
            <option value="">All {termWord('label.clients').toLowerCase()}</option>
            {clientOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        )}
        {storeOptions.length > 1 && (
          <Select size="sm" aria-label={termWord('label.store')} value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}>
            <option value="">All {termWord('label.stores').toLowerCase()}</option>
            {storeOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </FilterBar>

      {filtered && filtered.length > 0 && (
        <p className="text-sm text-silver" data-testid="celebrations-week">
          {week.length === 0
            ? 'Nothing this week.'
            : `This week: ${[weekBirthdays > 0 ? plural(weekBirthdays, 'birthday', 'birthdays') : null, weekAnniversaries > 0 ? plural(weekAnniversaries, 'anniversary', 'anniversaries') : null].filter(Boolean).join(' · ')}`}
        </p>
      )}

      {itemsQuery.error ? (
        <QueryError what="celebrations" query={itemsQuery} />
      ) : items === null ? (
        <Card><CardContent><SkeletonRows count={4} /></CardContent></Card>
      ) : !filtered || filtered.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={PartyPopper}
              title={term ? 'No matches' : `Nothing in the next ${days} days`}
              description={
                term
                  ? `No upcoming celebrations match “${search.trim()}”.`
                  : `Birthdays show up here once ${termWord('workers').toLowerCase()} fill in their date of birth, and anniversaries once they've been on the team for a year.`
              }
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {buckets &&
              Object.entries(buckets).map(([label, group]) =>
                group.length === 0 ? null : (
                  <section key={label} aria-label={label}>
                    {/* The week heading stays on screen while its rows scroll by. */}
                    <div role="heading" aria-level={2} className="sticky top-0 z-10 border-b border-navy-secondary bg-navy px-4 py-2 text-xs font-medium uppercase tracking-wider text-silver">
                      {label} <span className="font-normal normal-case tracking-normal text-silver/70">· {group.length}</span>
                    </div>
                    <ul className="divide-y divide-navy-secondary">
                      {group.map((c) => {
                        const sent = sentKeys.has(keyOf(c));
                        return (
                          <li key={keyOf(c)} className="flex items-center gap-3 px-4 py-2.5">
                            <span className="hidden w-28 shrink-0 text-sm tabular-nums text-silver sm:block">{fmtDateOnly(c.date, { weekday: true, year: false })}</span>
                            <Avatar src={personPhotoUrl(c)} name={c.associateName} email={c.email} size="sm" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-ink">
                                <AssociateLink associateId={c.associateId}>{c.associateName}</AssociateLink>
                              </div>
                              {/* On a phone the date rides under the name, so the name keeps its room. */}
                              <div className="truncate text-xs text-silver">
                                <span className="sm:hidden">{fmtDateOnly(c.date, { weekday: true, year: false })}{c.siteName || c.clientName ? ' · ' : ''}</span>
                                {c.siteName ?? c.clientName ?? ''}
                              </div>
                            </div>
                            <Badge variant={c.kind === 'BIRTHDAY' ? 'pending' : 'accent'} className="shrink-0">
                              {c.kind === 'BIRTHDAY' ? (
                                <>
                                  <Cake className="mr-1 h-3 w-3" aria-hidden="true" /> Birthday
                                </>
                              ) : (
                                <>
                                  <PartyPopper className="mr-1 h-3 w-3" aria-hidden="true" />
                                  {c.years != null ? plural(c.years, 'year', 'years') : 'Anniversary'}
                                </>
                              )}
                            </Badge>
                            {sent ? (
                              <span className="w-24 shrink-0 text-right text-xs text-success">Sent ✓</span>
                            ) : (
                              <Button size="sm" variant="outline" className="shrink-0" onClick={() => setTarget(c)} aria-label={`Send a note to ${c.associateName}`}>
                                <Send className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden="true" />
                                <span className="hidden sm:inline">Send note</span>
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ),
              )}
          </CardContent>
        </Card>
      )}
      {target && (
        <HighFiveDrawer
          target={target}
          onClose={() => setTarget(null)}
          onSent={() => {
            setSentKeys((prev) => {
              const next = new Set(prev);
              next.add(keyOf(target));
              return next;
            });
            setTarget(null);
          }}
        />
      )}
    </ListTemplate>
  );
}

function HighFiveDrawer({
  target,
  onClose,
  onSent,
}: {
  target: CelebrationItem;
  onClose: () => void;
  onSent: () => void;
}) {
  const defaultMsg =
    target.kind === 'BIRTHDAY'
      ? `Happy birthday, ${target.associateName.split(' ')[0]}! 🎂`
      : `Happy ${target.years}-year anniversary, ${target.associateName.split(' ')[0]}! 🎉 Thank you for everything you bring to the team.`;
  const [msg, setMsg] = useState(defaultMsg);
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (!msg.trim()) {
      toast.error('Please write a message.');
      return;
    }
    setSending(true);
    try {
      await sendHighFive({
        associateId: target.associateId,
        kind: target.kind,
        message: msg.trim(),
      });
      toast.success('Message sent.');
      onSent();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Drawer
      open={true}
      onOpenChange={(o) => !o && onClose()}
      // Only guard once the message has been personalized — losing the
      // untouched default costs nothing.
      confirmDiscard={() => msg !== defaultMsg}
    >
      <DrawerHeader>
        <DrawerTitle>
          High-five {target.associateName}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          Send a quick in-app message. They'll see it in their inbox.
        </div>
        <div>
          <Label>Message</Label>
          <Textarea
            className="mt-1 h-32"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            maxLength={500}
          />
          <div className="text-xs text-silver mt-1 text-right">
            {msg.length}/500
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={sending}>
          {sending ? 'Sending…' : <><Send className="mr-2 h-4 w-4" /> Send</>}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

export function bucketize(items: CelebrationItem[], now = new Date()): Record<string, CelebrationItem[]> {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(startOfToday);
  tomorrow.setDate(tomorrow.getDate() + 1);
  // "This week" and "Next week" are the company's workweeks, Saturday →
  // Friday (FLOOR-24: a rolling seven days put a Monday Nov 2 birthday in
  // "This week" on Thursday Oct 29, when the week ends Friday Oct 30).
  const week = workweekBounds(now).end;
  const twoWeeks = workweekBounds(now, 1).end;
  const month = new Date(startOfToday);
  month.setDate(month.getDate() + 30);
  const buckets: Record<string, CelebrationItem[]> = {
    Today: [],
    'This week': [],
    'Next week': [],
    'This month': [],
    Later: [],
  };
  for (const c of items) {
    // parseYmd, not new Date(): a date-only string parses as UTC
    // midnight and lands a day early west of Greenwich, shifting
    // celebrations into the wrong bucket.
    const d = parseYmd(c.date);
    if (!d) buckets.Later.push(c);
    else if (d < tomorrow) buckets.Today.push(c);
    else if (d < week) buckets['This week'].push(c);
    else if (d < twoWeeks) buckets['Next week'].push(c);
    else if (d < month) buckets['This month'].push(c);
    else buckets.Later.push(c);
  }
  return buckets;
}
