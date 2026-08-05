import { useEffect, useState } from 'react';
import { Cake, PartyPopper, Send } from 'lucide-react';
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
  ErrorBanner,
  FilterBar,
  PageHeader,
  SearchInput,
  SegmentedControl,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { fmtDate, parseYmd } from '@/lib/format';

const WINDOW_OPTIONS = [30, 60, 90] as const;

const keyOf = (c: CelebrationItem) => `${c.associateId}-${c.kind}-${c.date}`;

/**
 * Phase 107 — Birthdays + work anniversaries.
 *
 * Buckets the selected window (30/60/90 days) into "this week / next
 * week / this month / later". Click a row to send a quick congrats via
 * the in-app notification system.
 */
export function CelebrationsHome() {
  const [items, setItems] = useState<CelebrationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(60);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<CelebrationItem | null>(null);
  // Cards already high-fived this session — disabled so nobody
  // double-sends the same congrats.
  const [sentKeys, setSentKeys] = useState<Set<string>>(new Set());

  const load = (d: number) => {
    setItems(null);
    setError(null);
    listUpcomingCelebrations(d)
      .then((r) => setItems(r.items))
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? err.message
            : 'Failed to load celebrations.',
        ),
      );
  };
  useEffect(() => {
    load(days);
  }, [days]);

  const term = search.trim().toLowerCase();
  const filtered = items
    ? term
      ? items.filter((c) => c.associateName.toLowerCase().includes(term))
      : items
    : null;
  const buckets = filtered ? bucketize(filtered) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Celebrations"
        subtitle="Upcoming birthdays and work anniversaries across the team."
        breadcrumbs={[{ label: 'Celebrations' }]}
      />
      <FilterBar>
        <SegmentedControl<number>
          ariaLabel="Look-ahead window"
          options={WINDOW_OPTIONS.map((d) => ({ value: d, label: `Next ${d} days` }))}
          value={days}
          onChange={(d) => setDays(d)}
        />
        <SearchInput
          className="h-8 w-56 text-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name…"
          aria-label="Search by name"
        />
      </FilterBar>
      {error ? (
        <ErrorBanner>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => load(days)}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      ) : items === null ? (
        <Card><CardContent><SkeletonRows count={4} /></CardContent></Card>
      ) : !filtered || filtered.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={PartyPopper}
              title={
                term
                  ? 'No matches'
                  : `Nothing in the next ${days} days`
              }
              description={
                term
                  ? `No upcoming celebrations match “${search.trim()}”.`
                  : "Birthdays show up here once associates fill in their date of birth, and anniversaries appear once they've been on the team for a year."
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {buckets && Object.entries(buckets).map(([label, group]) =>
            group.length === 0 ? null : (
              <Card key={label}>
                <CardContent>
                  <div className="text-sm uppercase text-silver tracking-wider mb-3">{label}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {group.map((c) => {
                      const sent = sentKeys.has(keyOf(c));
                      return (
                        <button
                          key={keyOf(c)}
                          onClick={() => !sent && setTarget(c)}
                          disabled={sent}
                          className="flex items-center gap-3 p-3 rounded-md border border-navy-secondary hover:border-gold/40 hover:bg-navy-secondary/40 transition-colors text-left group disabled:opacity-70 disabled:hover:border-navy-secondary disabled:hover:bg-transparent disabled:cursor-default"
                        >
                          <div className={`h-10 w-10 rounded-full grid place-items-center ${
                            c.kind === 'BIRTHDAY'
                              ? 'bg-warning/20 text-warning'
                              : 'bg-gold/20 text-gold'
                          }`}>
                            {c.kind === 'BIRTHDAY' ? <Cake className="h-5 w-5" /> : <PartyPopper className="h-5 w-5" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-white truncate">{c.associateName}</div>
                            <div className="text-xs text-silver">
                              {fmtDate(parseYmd(c.date))}
                              {c.years != null && ` • ${c.years} year${c.years === 1 ? '' : 's'}`}
                            </div>
                          </div>
                          <Badge variant={c.kind === 'BIRTHDAY' ? 'pending' : 'accent'}>
                            {c.kind === 'BIRTHDAY' ? 'Birthday' : 'Anniversary'}
                          </Badge>
                          {sent ? (
                            <span className="text-xs text-success whitespace-nowrap">
                              Sent ✓
                            </span>
                          ) : (
                            <Send className="h-4 w-4 text-silver can-hover:opacity-60 group-hover:opacity-100 transition-opacity" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            ),
          )}
        </div>
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
    </div>
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
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
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

function bucketize(items: CelebrationItem[]): Record<string, CelebrationItem[]> {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const week = new Date(startOfToday);
  week.setDate(week.getDate() + 7);
  const twoWeeks = new Date(startOfToday);
  twoWeeks.setDate(twoWeeks.getDate() + 14);
  const month = new Date(startOfToday);
  month.setDate(month.getDate() + 30);
  const buckets: Record<string, CelebrationItem[]> = {
    'This week': [],
    'Next week': [],
    'This month': [],
    'Later': [],
  };
  for (const c of items) {
    // parseYmd, not new Date(): a date-only string parses as UTC
    // midnight and lands a day early west of Greenwich, shifting
    // celebrations into the wrong bucket.
    const d = parseYmd(c.date);
    if (!d) {
      buckets['Later'].push(c);
    } else if (d < week) buckets['This week'].push(c);
    else if (d < twoWeeks) buckets['Next week'].push(c);
    else if (d < month) buckets['This month'].push(c);
    else buckets['Later'].push(c);
  }
  return buckets;
}
