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
  PageHeader,
  SkeletonRows,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

/**
 * Phase 107 — Birthdays + work anniversaries.
 *
 * Buckets the next 60 days into "this week / next week / this month /
 * later". Click a row to send a quick congrats via the in-app
 * notification system.
 */
export function CelebrationsHome() {
  const [items, setItems] = useState<CelebrationItem[] | null>(null);
  const [target, setTarget] = useState<CelebrationItem | null>(null);

  const refresh = () => {
    setItems(null);
    listUpcomingCelebrations(60)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const buckets = items ? bucketize(items) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Celebrations"
        subtitle="Upcoming birthdays and work anniversaries across the team."
        breadcrumbs={[{ label: 'Celebrations' }]}
      />
      {items === null ? (
        <Card><CardContent><SkeletonRows count={4} /></CardContent></Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={PartyPopper}
              title="Nothing in the next 60 days"
              description="Birthdays show up here once associates fill in their date of birth, and anniversaries appear once they've been on the team for a year."
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
                    {group.map((c) => (
                      <button
                        key={`${c.associateId}-${c.kind}-${c.date}`}
                        onClick={() => setTarget(c)}
                        className="flex items-center gap-3 p-3 rounded-md border border-navy-secondary hover:border-cyan-500/40 hover:bg-navy-secondary/40 transition text-left group"
                      >
                        <div className={`h-10 w-10 rounded-full grid place-items-center ${
                          c.kind === 'BIRTHDAY'
                            ? 'bg-pink-500/20 text-pink-300'
                            : 'bg-amber-500/20 text-amber-300'
                        }`}>
                          {c.kind === 'BIRTHDAY' ? <Cake className="h-5 w-5" /> : <PartyPopper className="h-5 w-5" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white truncate">{c.associateName}</div>
                          <div className="text-xs text-silver">
                            {new Date(c.date).toLocaleDateString('en-US', {
                              weekday: 'short',
                              month: 'short',
                              day: 'numeric',
                            })}
                            {c.years != null && ` • ${c.years} year${c.years === 1 ? '' : 's'}`}
                          </div>
                        </div>
                        <Badge variant={c.kind === 'BIRTHDAY' ? 'pending' : 'accent'}>
                          {c.kind === 'BIRTHDAY' ? 'Birthday' : 'Anniversary'}
                        </Badge>
                        <Send className="h-4 w-4 text-silver opacity-0 group-hover:opacity-100 transition" />
                      </button>
                    ))}
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
          onSent={() => setTarget(null)}
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
          <textarea
            className="mt-1 w-full h-32 rounded-md border border-navy-secondary bg-midnight p-3 text-white text-sm"
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
    const d = new Date(c.date);
    if (d < week) buckets['This week'].push(c);
    else if (d < twoWeeks) buckets['Next week'].push(c);
    else if (d < month) buckets['This month'].push(c);
    else buckets['Later'].push(c);
  }
  return buckets;
}
