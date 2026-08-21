import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Send } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtRelativeDate } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import {
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from '@/components/ui/Drawer';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Input';

/**
 * The item's room — where cross-functional collaboration actually lives.
 * One decision key, one room: the story at top, the participants as
 * faces with function-colored role badges, the thread (visible to Ops,
 * Finance, and the chairman alike), and the auto-written timeline of
 * every claim / assignment / escalation. Opened from any decision queue.
 */

interface Person {
  id: string;
  name: string;
  photoUrl: string | null;
  roleLabel: string;
  role: string;
}
interface RoomData {
  key: string;
  label: string;
  detail: string;
  linkUrl: string;
  claimedBy: Person | null;
  participants: Person[];
  thread: Array<{ id: string; author: Person; body: string; at: string }>;
  timeline: Array<{ action: string; actor: Person | null; note: string | null; at: string }>;
}
interface Colleague {
  id: string;
  name: string;
  roleLabel: string;
}

/** Function-colored role badges: Executive gold, Finance green, site
 *  operations steel, HR/admin accent. */
function roleTone(role: string): string {
  if (role === 'EXECUTIVE_CHAIRMAN') return 'bg-gold/15 text-gold';
  if (role === 'FINANCE_ACCOUNTANT') return 'bg-success/15 text-success';
  if (role === 'SHIFT_SUPERVISOR') return 'bg-steel/25 text-white';
  if (role === 'ASSOCIATE') return 'bg-navy-secondary/80 text-silver';
  return 'bg-accent/15 text-accent';
}

function RoleBadge({ p }: { p: Person }) {
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-2xs ${roleTone(p.role)}`}>
      {p.roleLabel}
    </span>
  );
}

export function DecisionRoom({
  itemKey,
  onClose,
  actions,
}: {
  itemKey: string | null;
  onClose: () => void;
  /** The action bar the opener renders into the room — claim/assign/
   *  tag/postpone/plan/escalate live HERE, next to the context. */
  actions?: React.ReactNode;
}) {
  const [room, setRoom] = useState<RoomData | null>(null);
  const [failed, setFailed] = useState(false);
  const [colleagues, setColleagues] = useState<Colleague[] | null>(null);
  const [body, setBody] = useState('');
  const [mention, setMention] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    if (!itemKey) return;
    setFailed(false);
    apiFetch<RoomData>(`/me/decisions/item?key=${encodeURIComponent(itemKey)}`)
      .then(setRoom)
      .catch(() => setFailed(true));
  }, [itemKey]);
  useEffect(() => {
    setRoom(null);
    setBody('');
    setMention('');
    load();
    if (itemKey) {
      apiFetch<{ colleagues: Colleague[] }>('/me/colleagues')
        .then((r) => setColleagues(r.colleagues))
        .catch(() => setColleagues([]));
    }
  }, [itemKey, load]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending || !itemKey || body.trim().length === 0) return;
    setSending(true);
    try {
      await apiFetch('/me/decisions/comment', {
        method: 'POST',
        body: {
          key: itemKey,
          body: body.trim(),
          ...(mention ? { mentionUserId: mention } : {}),
        },
      });
      setBody('');
      setMention('');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not post the comment.');
    } finally {
      setSending(false);
    }
  };

  if (!itemKey) return null;

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle className="pr-8">{room?.label ?? 'Loading…'}</DrawerTitle>
        {room && (
          <DrawerDescription className="flex flex-wrap items-center gap-2">
            <span className="min-w-0">{room.detail}</span>
            <Link
              to={room.linkUrl}
              onClick={onClose}
              className="inline-flex shrink-0 items-center gap-1 text-gold hover:text-gold-bright"
            >
              Open page <ExternalLink className="h-3 w-3" />
            </Link>
          </DrawerDescription>
        )}
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {failed && (
          <p className="text-sm text-silver">
            Could not open this item&apos;s room —{' '}
            <button type="button" className="text-gold hover:text-gold-bright" onClick={load}>
              retry
            </button>
            .
          </p>
        )}
        {!room && !failed && <Skeleton className="h-40" />}
        {room && (
          <>
            {actions && (
              <div>
                <div className="mb-1.5 text-2xs uppercase tracking-wider text-silver/60">
                  Actions
                </div>
                {actions}
              </div>
            )}
            {/* Who's in the room. */}
            {room.participants.length > 0 && (
              <div>
                <div className="mb-1.5 text-2xs uppercase tracking-wider text-silver/60">
                  In this room
                </div>
                <ul className="flex flex-wrap gap-3">
                  {room.participants.map((p) => (
                    <li key={p.id} className="flex items-center gap-1.5">
                      <Avatar src={p.photoUrl} name={p.name} size="sm" />
                      <span className="text-xs text-white">{p.name}</span>
                      <RoleBadge p={p} />
                      {room.claimedBy?.id === p.id && (
                        <span className="text-2xs text-gold">· on it</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* The thread. */}
            <div>
              <div className="mb-1.5 text-2xs uppercase tracking-wider text-silver/60">
                Thread
              </div>
              {room.thread.length === 0 ? (
                <p className="text-sm text-silver">
                  No messages yet — start the conversation below.
                </p>
              ) : (
                <ul className="space-y-3">
                  {room.thread.map((c) => (
                    <li key={c.id} className="flex gap-2.5">
                      <Avatar src={c.author.photoUrl} name={c.author.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium text-white">
                            {c.author.name}
                          </span>
                          <RoleBadge p={c.author} />
                          <span className="text-2xs text-silver/60">
                            {fmtRelativeDate(c.at)}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm text-silver">{c.body}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={send} className="mt-3 space-y-2">
                <Textarea
                  rows={2}
                  maxLength={1000}
                  value={body}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setBody(e.target.value)
                  }
                  placeholder="Write to the room…"
                  aria-label="Comment"
                />
                <div className="flex items-center gap-2">
                  <Select
                    size="sm"
                    className="w-auto"
                    value={mention}
                    onChange={(e) => setMention(e.target.value)}
                    aria-label="Notify a colleague"
                  >
                    <option value="">Notify: holder only</option>
                    {(colleagues ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        Also ping {c.name}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="submit"
                    size="sm"
                    loading={sending}
                    disabled={sending || body.trim().length === 0}
                  >
                    <Send className="mr-1.5 h-3.5 w-3.5" />
                    Send
                  </Button>
                </div>
              </form>
            </div>

            {/* The item's life story. */}
            {room.timeline.length > 0 && (
              <div>
                <div className="mb-1.5 text-2xs uppercase tracking-wider text-silver/60">
                  Timeline
                </div>
                <ul className="space-y-1.5 border-l border-navy-secondary pl-3">
                  {room.timeline.map((t, i) => (
                    <li key={i} className="text-xs text-silver">
                      <span className="text-white">{t.actor?.name ?? 'System'}</span>{' '}
                      {t.action}
                      {t.note && <span className="text-silver/70"> — “{t.note}”</span>}
                      <span className="text-silver/50"> · {fmtRelativeDate(t.at)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </DrawerBody>
    </Drawer>
  );
}
