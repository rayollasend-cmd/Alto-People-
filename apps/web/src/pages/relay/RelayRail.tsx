import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, AtSign, CheckCircle2, ClipboardList, Gavel, MessagesSquare, ThumbsDown, ThumbsUp } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtRelativeDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { DeskChip, SectionHead } from './RelayParts';
import { DESK_LABELS, relayApi, type ActivityNote, type AgendaItem, type Desk } from './relayTypes';

/**
 * The relay's right rail — where the desks talk:
 *
 *   The Monday pack   what's bleeding, ranked — writes itself
 *   Decisions         rulings one desk owes another, answered right here
 *                     when they're yours ("with receipts": approve or
 *                     decline, always with a reason)
 *   Latest            every thread's newest note — who said what about
 *                     whom, and which desk they called in
 */

export function MondayPack({ agenda, lens }: { agenda: AgendaItem[]; lens: Desk | 'ALL' }) {
  const items = agenda.filter((a) => lens === 'ALL' || a.desk === null || a.desk === lens);
  return (
    <section aria-labelledby="relay-monday">
      <SectionHead icon={ClipboardList} title="The Monday pack" meta="ranked by what’s bleeding" id="relay-monday" />
      <Card className="p-4">
        {items.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Nothing on the agenda. Silence means green.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {items.map((a, i) => (
              <li key={`${a.text}-${i}`} className="flex gap-2.5 text-sm">
                <span
                  aria-hidden="true"
                  className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', a.severity === 'red' ? 'bg-alert' : a.severity === 'amber' ? 'bg-warning' : 'bg-success/70')}
                />
                <span className="min-w-0 flex-1 text-silver">
                  {a.desk && <DeskChip desk={a.desk} className="mr-1.5 align-[1px]" />}
                  {a.text}
                  {a.link !== '/relay' && (
                    <Link to={a.link} className="ml-1 inline-flex items-center gap-0.5 whitespace-nowrap text-gold underline underline-offset-2 hover:text-gold-bright">
                      open
                      <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function age(iso: string) {
  return fmtRelativeDate(iso);
}

export function DecisionsPanel({
  decisions,
  loading,
  lens,
  myDesk,
  onOpen,
  onChanged,
}: {
  decisions: ActivityNote[];
  loading: boolean;
  lens: Desk | 'ALL';
  myDesk: Desk | null;
  onOpen: (associateId: string, name: string) => void;
  onChanged: () => void;
}) {
  const [ruling, setRuling] = useState<{ id: string; approve: boolean } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = decisions.filter((d) => lens === 'ALL' || d.decisionDesk === lens);

  const decide = async () => {
    if (!ruling || !note.trim()) return;
    setBusy(true);
    try {
      await relayApi.decide(ruling.id, ruling.approve, note.trim());
      toast.success(ruling.approve ? 'Approved — the receipt is on the record.' : 'Declined — the receipt is on the record.');
      setRuling(null);
      setNote('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the ruling.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="decisions">
      <SectionHead icon={Gavel} title="Decisions" meta={rows.length ? `${rows.length} owed` : undefined} id="decisions" />
      <Card className="overflow-hidden p-0">
        {loading ? (
          <Skeleton className="m-3 h-16" />
        ) : rows.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            No rulings owed{lens === 'ALL' ? '' : ` by ${DESK_LABELS[lens]}`}.
          </p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {rows.map((d) => {
              const mine = !!myDesk && d.decisionDesk === myDesk;
              const open = ruling?.id === d.id;
              return (
                <li key={d.id} className={cn('px-4 py-3', mine && 'bg-gold/[0.04]')}>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => onOpen(d.subject.associateId, d.subject.name)} className="truncate text-sm font-medium text-white hover:text-gold-bright">
                      {d.subject.name}
                    </button>
                    {d.decisionDesk && <DeskChip desk={d.decisionDesk} className="ml-auto" />}
                  </div>
                  <p className="mt-1 text-sm text-silver">{d.body}</p>
                  <p className="mt-1 text-2xs text-silver/60">
                    asked by {d.author?.name ?? 'someone'} · {age(d.createdAt)}
                  </p>
                  {mine ? (
                    open ? (
                      <div className="mt-2 space-y-2">
                        <Textarea
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          rows={2}
                          maxLength={2000}
                          placeholder={ruling.approve ? 'Approved because…' : 'Declined because…'}
                          aria-label="The reason — it stays on the record"
                          autoFocus
                        />
                        <div className="flex gap-2">
                          <Button size="xs" loading={busy} disabled={!note.trim()} onClick={() => void decide()} variant={ruling.approve ? 'primary' : 'destructive'}>
                            {ruling.approve ? 'Approve' : 'Decline'}
                          </Button>
                          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setRuling(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 flex gap-2">
                        <Button size="xs" variant="secondary" onClick={() => { setRuling({ id: d.id, approve: true }); setNote(''); }}>
                          <ThumbsUp className="h-3.5 w-3.5" />
                          Approve
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => { setRuling({ id: d.id, approve: false }); setNote(''); }}>
                          <ThumbsDown className="h-3.5 w-3.5" />
                          Decline
                        </Button>
                      </div>
                    )
                  ) : (
                    <p className="mt-1.5 text-xs text-warning">Waiting on {d.decisionDesk ? DESK_LABELS[d.decisionDesk] : 'a desk'}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}

export function ActivityFeed({
  notes,
  loading,
  lens,
  onOpen,
}: {
  notes: ActivityNote[];
  loading: boolean;
  lens: Desk | 'ALL';
  onOpen: (associateId: string, name: string) => void;
}) {
  const [all, setAll] = useState(false);
  const rows = notes.filter((n) => lens === 'ALL' || n.mentions.includes(lens) || n.decisionDesk === lens);
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <section aria-labelledby="relay-latest">
      <SectionHead icon={MessagesSquare} title="Latest on the relay" meta="two weeks" id="relay-latest" />
      <Card className="overflow-hidden p-0">
        {loading ? (
          <Skeleton className="m-3 h-24" />
        ) : rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-silver">
            {lens === 'ALL' ? 'No notes yet — open a lane and start the thread.' : `Nothing has called ${DESK_LABELS[lens]} in yet.`}
          </p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {shown.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onOpen(n.subject.associateId, n.subject.name)}
                  className="flex w-full gap-2.5 px-4 py-2.5 text-left hover:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright"
                >
                  <Avatar src={n.author?.photoUrl ?? null} name={n.author?.name ?? '?'} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1 text-xs">
                      <span className="truncate font-medium text-white">{n.author?.name ?? 'Someone'}</span>
                      <span className="shrink-0 text-silver/60">on</span>
                      <span className="truncate font-medium text-gold">{n.subject.name}</span>
                      <span className="ml-auto shrink-0 text-2xs text-silver/50">{age(n.createdAt)}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-sm text-silver">{n.body}</span>
                    {(n.mentions.length > 0 || n.decisionStatus) && (
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        {n.mentions.map((m) => (
                          <span key={m} className="inline-flex items-center gap-0.5">
                            <AtSign className="h-3 w-3 text-silver/60" aria-hidden="true" />
                            <DeskChip desk={m} />
                          </span>
                        ))}
                        {n.decisionStatus && (
                          <span
                            className={cn(
                              'rounded-full px-1.5 py-0.5 text-2xs font-medium',
                              n.decisionStatus === 'PENDING' ? 'bg-warning/15 text-warning' : n.decisionStatus === 'APPROVED' ? 'bg-success/15 text-success' : 'bg-alert/15 text-alert',
                            )}
                          >
                            {n.decisionStatus === 'PENDING'
                              ? `Ruling owed by ${n.decisionDesk ? DESK_LABELS[n.decisionDesk] : 'a desk'}`
                              : `${n.decisionStatus === 'APPROVED' ? 'Approved' : 'Declined'}${n.decidedByName ? ` by ${n.decidedByName}` : ''}`}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {rows.length > 8 && (
          <button type="button" onClick={() => setAll((v) => !v)} className="w-full border-t border-navy-secondary/60 px-4 py-2 text-xs text-gold hover:text-gold-bright">
            {all ? 'Show less' : `Show all ${rows.length}`}
          </button>
        )}
      </Card>
    </section>
  );
}
