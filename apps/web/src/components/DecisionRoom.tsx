import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Flag, Send } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtDate, fmtMoney, fmtRelativeDate } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import {
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from '@/components/ui/Drawer';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Input';

/**
 * Room 2.0 — the item's workspace, organized like a flight director
 * would run it:
 *   · STATUS BOARD: severity / stakes / age / holder as a fact grid
 *   · NEXT STEP: the one agreed action, with an owner and a day —
 *     pinned, editable by anyone in the room, echoed onto queue rows
 *   · FACTS: the item's own evidence, computed server-side per type
 *     (statement numbers, who's waiting at the kiosk, risky shifts…)
 *   · ONE STREAM: messages and system events interleaved in true order
 * Opened from any decision queue on any dashboard.
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
  severity: string | null;
  stakes: number | null;
  ageDays: number | null;
  claimedBy: Person | null;
  participants: Person[];
  nextStep: { text: string; owner: Person | null; dueDay: string | null } | null;
  facts: Array<{ label: string; value: string }>;
  factList: string[];
  thread: Array<{ id: string; author: Person; body: string; at: string }>;
  timeline: Array<{ action: string; actor: Person | null; note: string | null; at: string }>;
}
interface Colleague {
  id: string;
  name: string;
  roleLabel: string;
}
type StreamEntry =
  | { type: 'comment'; at: string; author: Person; body: string; id: string }
  | { type: 'event'; at: string; actor: Person | null; action: string; note: string | null };

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
  const [editingStep, setEditingStep] = useState(false);
  const [stepText, setStepText] = useState('');
  const [stepOwner, setStepOwner] = useState('');
  const [stepDue, setStepDue] = useState('');
  const [savingStep, setSavingStep] = useState(false);

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
    setEditingStep(false);
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

  const openStepEditor = () => {
    setStepText(room?.nextStep?.text ?? '');
    setStepOwner(room?.nextStep?.owner?.id ?? '');
    setStepDue(room?.nextStep?.dueDay ?? '');
    setEditingStep(true);
  };
  const saveStep = async (clear: boolean) => {
    if (savingStep || !itemKey) return;
    if (!clear && stepText.trim().length === 0) return;
    setSavingStep(true);
    try {
      await apiFetch('/me/decisions/next-step', {
        method: 'POST',
        body: {
          key: itemKey,
          text: clear ? null : stepText.trim(),
          ownerUserId: clear ? null : stepOwner || null,
          dueDay: clear ? null : stepDue || null,
        },
      });
      toast.success(clear ? 'Next step cleared.' : 'Next step set — the room has a direction.');
      setEditingStep(false);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the next step.');
    } finally {
      setSavingStep(false);
    }
  };

  if (!itemKey) return null;

  const stream: StreamEntry[] = room
    ? [
        ...room.thread.map<StreamEntry>((c) => ({
          type: 'comment',
          at: c.at,
          author: c.author,
          body: c.body,
          id: c.id,
        })),
        ...room.timeline.map<StreamEntry>((t) => ({
          type: 'event',
          at: t.at,
          actor: t.actor,
          action: t.action,
          note: t.note,
        })),
      ].sort((a, b) => a.at.localeCompare(b.at))
    : [];

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
            {/* STATUS BOARD — where the item stands, at a glance. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {room.severity && (
                <div className="rounded-md bg-navy-secondary/50 p-2 text-center">
                  <div
                    className={`text-sm font-semibold uppercase ${
                      room.severity === 'critical'
                        ? 'text-alert'
                        : room.severity === 'high'
                          ? 'text-warning'
                          : 'text-silver'
                    }`}
                  >
                    {room.severity}
                  </div>
                  <div className="text-2xs text-silver/70">severity</div>
                </div>
              )}
              {room.stakes !== null && (
                <div className="rounded-md bg-navy-secondary/50 p-2 text-center">
                  <div className="text-sm font-semibold tabular-nums text-white">
                    {fmtMoney(room.stakes)}
                  </div>
                  <div className="text-2xs text-silver/70">at stake</div>
                </div>
              )}
              {room.ageDays !== null && room.ageDays > 0 && (
                <div className="rounded-md bg-navy-secondary/50 p-2 text-center">
                  <div
                    className={`text-sm font-semibold tabular-nums ${room.ageDays >= 14 ? 'text-alert' : room.ageDays >= 7 ? 'text-warning' : 'text-white'}`}
                  >
                    {room.ageDays}d
                  </div>
                  <div className="text-2xs text-silver/70">waiting</div>
                </div>
              )}
              <div className="rounded-md bg-navy-secondary/50 p-2 text-center">
                {room.claimedBy ? (
                  <div className="flex items-center justify-center gap-1.5">
                    <Avatar src={room.claimedBy.photoUrl} name={room.claimedBy.name} size="xs" />
                    <span className="truncate text-sm font-medium text-white">
                      {room.claimedBy.name.split(' ')[0]}
                    </span>
                  </div>
                ) : (
                  <div className="text-sm text-silver">unclaimed</div>
                )}
                <div className="text-2xs text-silver/70">holder</div>
              </div>
            </div>

            {/* NEXT STEP — the flight-director rule. */}
            <div
              className={`rounded-md border p-3 ${room.nextStep ? 'border-gold/30 bg-gold/[0.05]' : 'border-navy-secondary bg-navy-secondary/30'}`}
            >
              {!editingStep ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {room.nextStep ? (
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <Flag className="h-3.5 w-3.5 shrink-0 text-gold" aria-hidden="true" />
                      <span className="min-w-0 text-white">
                        {room.nextStep.text}
                        <span className="text-silver">
                          {room.nextStep.owner ? ` — ${room.nextStep.owner.name}` : ''}
                          {room.nextStep.dueDay ? `, by ${fmtDate(room.nextStep.dueDay)}` : ''}
                        </span>
                      </span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 text-sm text-silver">
                      <Flag className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      No next step agreed yet — a room without one is just talk.
                    </span>
                  )}
                  <Button size="xs" variant="ghost" onClick={openStepEditor}>
                    {room.nextStep ? 'Update' : 'Set next step'}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Input
                    value={stepText}
                    onChange={(e) => setStepText(e.target.value)}
                    maxLength={200}
                    placeholder='e.g. "Call Walmart AP about the missing check"'
                    className="h-8 text-sm"
                    autoFocus
                    aria-label="Next step"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      size="sm"
                      className="w-auto"
                      value={stepOwner}
                      onChange={(e) => setStepOwner(e.target.value)}
                      aria-label="Owner"
                    >
                      <option value="">Owner: me</option>
                      {(colleagues ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                    <input
                      type="date"
                      value={stepDue}
                      onChange={(e) => setStepDue(e.target.value)}
                      className="h-8 rounded border border-navy-secondary bg-navy-secondary/60 px-2 text-xs text-white focus:border-gold focus:outline-none"
                      aria-label="Due day"
                    />
                    <Button
                      size="xs"
                      loading={savingStep}
                      disabled={savingStep || stepText.trim().length === 0}
                      onClick={() => void saveStep(false)}
                    >
                      Save
                    </Button>
                    {room.nextStep && (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={savingStep}
                        onClick={() => void saveStep(true)}
                      >
                        Clear
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={savingStep}
                      onClick={() => setEditingStep(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {actions && <div>{actions}</div>}

            {/* FACTS — the item's own evidence. */}
            {(room.facts.length > 0 || room.factList.length > 0) && (
              <div className="rounded-md bg-navy-secondary/30 p-3">
                <div className="mb-1.5 text-2xs uppercase tracking-wider text-silver/60">
                  The facts
                </div>
                {room.facts.length > 0 && (
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                    {room.facts.map((f) => (
                      <div key={f.label} className="flex justify-between gap-2 text-sm">
                        <dt className="text-silver">{f.label}</dt>
                        <dd className="text-right tabular-nums text-white">{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {room.factList.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {room.factList.map((line, i) => (
                      <li key={i} className="text-sm text-white">
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Who's in the room. */}
            {room.participants.length > 0 && (
              <ul className="flex flex-wrap gap-3">
                {room.participants.map((p) => (
                  <li key={p.id} className="flex items-center gap-1.5">
                    <Avatar src={p.photoUrl} name={p.name} size="sm" />
                    <span className="text-xs text-white">{p.name}</span>
                    <RoleBadge p={p} />
                  </li>
                ))}
              </ul>
            )}

            {/* ONE STREAM — the whole story, in order. */}
            <div>
              <div className="mb-1.5 text-2xs uppercase tracking-wider text-silver/60">
                Activity
              </div>
              {stream.length === 0 ? (
                <p className="text-sm text-silver">
                  Nothing yet — start the conversation below.
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {stream.map((e, i) =>
                    e.type === 'comment' ? (
                      <li key={e.id} className="flex gap-2.5">
                        <Avatar src={e.author.photoUrl} name={e.author.name} size="sm" />
                        <div className="min-w-0 flex-1 rounded-md bg-navy-secondary/40 px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-medium text-white">
                              {e.author.name}
                            </span>
                            <RoleBadge p={e.author} />
                            <span className="text-2xs text-silver/60">
                              {fmtRelativeDate(e.at)}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap text-sm text-silver">{e.body}</p>
                        </div>
                      </li>
                    ) : (
                      <li
                        key={`ev-${i}`}
                        className="flex items-center gap-2 pl-2 text-xs text-silver/70"
                      >
                        <span className="h-px w-4 bg-navy-secondary" aria-hidden="true" />
                        <span>
                          <span className="text-silver">{e.actor?.name ?? 'System'}</span>{' '}
                          {e.action}
                          {e.note && <span className="text-silver/60"> — “{e.note}”</span>}
                          <span className="text-silver/50"> · {fmtRelativeDate(e.at)}</span>
                        </span>
                      </li>
                    ),
                  )}
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
          </>
        )}
      </DrawerBody>
    </Drawer>
  );
}
