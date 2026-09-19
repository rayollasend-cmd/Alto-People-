import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Clock,
  Download,
  FileText,
  Hand,
  Inbox,
  Paperclip,
  Send,
  SendHorizonal,
  X,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useOptimisticMutation } from '@/lib/optimistic';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDate, fmtDateTime, fmtRelativeDate } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  KIND_LABELS,
  STATUS_LABELS,
  WORK_DESKS,
  WORK_DESK_CHIP,
  WORK_DESK_LABELS,
  fileSize,
  uploadWorkFile,
  workApi,
  type DeskPerson,
  type RequestKind,
  type RequestStatus,
  type WorkDesk,
  type WorkFile,
  type WorkRequest,
} from './workTypes';

/**
 * REQUESTS — what one desk sends another.
 *
 * Ask HR a question, send Recruiting a document, hand Finance a task:
 * a subject, a message, whatever files belong with it, and (when it's
 * about someone) their record one click away. It lands on that desk —
 * anyone there can pick it up — and the thread keeps the answer where
 * the next person will look for it.
 */

const STATUS_VARIANT: Record<RequestStatus, 'default' | 'accent' | 'success' | 'pending'> = {
  OPEN: 'pending',
  IN_PROGRESS: 'accent',
  ANSWERED: 'success',
  CLOSED: 'default',
};

const KIND_ICON: Record<RequestKind, typeof Inbox> = { ASK: Inbox, SEND: SendHorizonal, TASK: Clock };

export function DeskChipW({ desk }: { desk: WorkDesk }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider', WORK_DESK_CHIP[desk])}>
      {WORK_DESK_LABELS[desk]}
    </span>
  );
}

/** A file on a thread, or in the library. */
export function FileChip({ file, onRemove }: { file: WorkFile; onRemove?: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-navy-secondary bg-navy px-2 py-1 text-xs">
      <FileText className="h-3.5 w-3.5 shrink-0 text-gold" aria-hidden="true" />
      <a href={file.url} target="_blank" rel="noreferrer noopener" className="truncate text-white hover:text-gold-bright hover:underline" title={file.name}>
        {file.name}
      </a>
      <span className="shrink-0 tabular-nums text-silver/60">{fileSize(file.size)}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Take ${file.name} off`} className="shrink-0 text-silver/60 hover:text-alert">
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        <a href={file.url} download aria-label={`Download ${file.name}`} className="shrink-0 text-silver/60 hover:text-gold">
          <Download className="h-3.5 w-3.5" />
        </a>
      )}
    </span>
  );
}

/** Pick files from the disk and upload them right away. */
function AttachButton({ onUploaded, busy, setBusy }: { onUploaded: (f: WorkFile) => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        aria-label="Attach files"
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length === 0) return;
          setBusy(true);
          try {
            for (const f of files) onUploaded(await uploadWorkFile(f));
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not attach that.');
          } finally {
            setBusy(false);
            if (input.current) input.current.value = '';
          }
        }}
      />
      <Button type="button" variant="ghost" size="sm" loading={busy} onClick={() => input.current?.click()}>
        <Paperclip className="h-3.5 w-3.5" />
        Attach
      </Button>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The composer                                                        */
/* ------------------------------------------------------------------ */

export function NewRequestDialog({
  open,
  onClose,
  desks,
  defaultDesk,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  desks: Record<string, DeskPerson[]> | undefined;
  defaultDesk?: WorkDesk | null;
  onSent: (id: string) => void;
}) {
  const [kind, setKind] = useState<RequestKind>('ASK');
  const [toDesk, setToDesk] = useState<WorkDesk>(defaultDesk ?? 'HR');
  const [toUserId, setToUserId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [about, setAbout] = useState<PickedAssociate | null>(null);
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [busy, setBusy] = useState(false);
  const people = (desks?.[toDesk] ?? []) as DeskPerson[];

  const reset = () => {
    setKind('ASK');
    setSubject('');
    setBody('');
    setDueAt('');
    setAbout(null);
    setFiles([]);
    setToUserId('');
  };

  const send = useMutation({
    mutationFn: () =>
      workApi.create({
        kind,
        toDesk,
        toUserId: toUserId || undefined,
        subject: subject.trim(),
        body: body.trim(),
        dueAt: dueAt ? new Date(`${dueAt}T17:00:00`).toISOString() : undefined,
        aboutAssociateId: about?.id,
        fileIds: files.map((f) => f.id),
      }),
    onSuccess: (r) => {
      toast.success(`Sent to ${WORK_DESK_LABELS[toDesk]}.`);
      reset();
      onSent(r.request.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send it.'),
  });

  const valid = subject.trim().length >= 3 && body.trim().length >= 2;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !send.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Send to another desk</DialogTitle>
          <DialogDescription>A question, a document, or a task — it lands on that desk and anyone there can pick it up.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <SegmentedControl<RequestKind>
            ariaLabel="What is it"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'ASK', label: 'Ask a question' },
              { value: 'SEND', label: 'Send a document' },
              { value: 'TASK', label: 'Hand off a task' },
            ]}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-silver">To which desk</span>
              <Select
                value={toDesk}
                onChange={(e) => {
                  setToDesk(e.target.value as WorkDesk);
                  setToUserId('');
                }}
              >
                {WORK_DESKS.map((d) => (
                  <option key={d} value={d}>
                    {WORK_DESK_LABELS[d]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-silver">Anyone there, or someone in particular</span>
              <Select value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
                <option value="">Anyone on the desk</option>
                {people.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-silver">Subject</span>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="What it's about, in a line" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-silver">{kind === 'ASK' ? 'Your question' : kind === 'SEND' ? 'What you’re sending, and why' : 'What needs doing'}</span>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={4000} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-silver">About someone (optional)</span>
              <AssociatePicker value={about} onChange={setAbout} placeholder="Search a person…" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-silver">Needed by (optional)</span>
              <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </label>
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm text-silver">Files</span>
              <AttachButton busy={busy} setBusy={setBusy} onUploaded={(f) => setFiles((x) => [...x, f])} />
            </div>
            {files.length === 0 ? (
              <p className="text-xs text-silver/60">Anything they’ll need to answer — a form, a photo, a spreadsheet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {files.map((f) => (
                  <FileChip key={f.id} file={f} onRemove={() => setFiles((x) => x.filter((y) => y.id !== f.id))} />
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={send.isPending}>
            Cancel
          </Button>
          <Button onClick={() => send.mutate()} loading={send.isPending} disabled={!valid || send.isPending || busy}>
            <Send className="h-4 w-4" />
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

function RequestRow({ r, onOpen }: { r: WorkRequest; onOpen: (id: string) => void }) {
  const Icon = KIND_ICON[r.kind];
  const late = r.dueAt && r.status !== 'CLOSED' && r.status !== 'ANSWERED' && Date.parse(r.dueAt) < Date.now();
  return (
    <li className={cn(r.mine && r.status === 'OPEN' && 'bg-gold/[0.04]')}>
      <button
        type="button"
        onClick={() => onOpen(r.id)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright"
      >
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', r.status === 'ANSWERED' ? 'text-success' : r.mine ? 'text-gold' : 'text-silver')} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-white">{r.subject}</span>
            <Badge variant={STATUS_VARIANT[r.status]} size="sm">
              {STATUS_LABELS[r.status]}
            </Badge>
            <DeskChipW desk={r.toDesk} />
            {r.files.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-2xs text-silver/70">
                <Paperclip className="h-3 w-3" aria-hidden="true" />
                {r.files.length}
              </span>
            )}
          </span>
          <span className="mt-0.5 line-clamp-1 block text-xs text-silver">{r.body}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 text-2xs text-silver/60">
            <span>
              {KIND_LABELS[r.kind]} · from {r.from?.name ?? 'someone'}
              {r.toUser && ` · for ${r.toUser.name}`}
            </span>
            {r.about && <span className="text-gold/80">about {r.about.name}</span>}
            {r.replies > 0 && <span>{r.replies === 1 ? '1 reply' : `${r.replies} replies`}</span>}
            <span className={cn(late && 'font-medium text-alert')}>{late ? `due ${fmtDate(r.dueAt!)}` : fmtRelativeDate(r.updatedAt)}</span>
            {r.claimedBy && <span className="text-silver/80">· {r.claimedBy.name} has it</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

export function RelayRequests({
  desks,
  myDesk,
  openId,
  onOpen,
}: {
  desks: Record<string, DeskPerson[]> | undefined;
  myDesk: WorkDesk | null;
  openId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const [box, setBox] = useState<'inbox' | 'sent' | 'all'>('inbox');
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [composing, setComposing] = useState(false);
  const q = useQuery({ queryKey: ['relay', 'requests', box, status], queryFn: () => workApi.requests(box, status), refetchInterval: 60_000 });
  const counts = q.data?.counts;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<'inbox' | 'sent' | 'all'>
          ariaLabel="Which requests"
          value={box}
          onChange={setBox}
          options={[
            { value: 'inbox', label: `On my desk${counts?.inbox ? ` (${counts.inbox})` : ''}` },
            { value: 'sent', label: `I sent${counts?.sent ? ` (${counts.sent})` : ''}` },
            { value: 'all', label: 'Everything' },
          ]}
        />
        <SegmentedControl<'open' | 'all'>
          ariaLabel="Open or everything"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'Closed too' },
          ]}
        />
        <Button size="sm" className="ml-auto" onClick={() => setComposing(true)}>
          <Send className="h-3.5 w-3.5" />
          Send to a desk
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        {q.isLoading ? (
          <Skeleton className="m-3 h-24" />
        ) : (q.data?.requests.length ?? 0) === 0 ? (
          <EmptyState
            icon={Inbox}
            title={box === 'inbox' ? 'Nothing on your desk' : box === 'sent' ? 'You haven’t sent anything yet' : 'No requests yet'}
            description="Ask another desk a question, send them a document, or hand off a task — it lands here with the answer attached."
          />
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {q.data!.requests.map((r) => (
              <RequestRow key={r.id} r={r} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </Card>

      <NewRequestDialog
        open={composing}
        onClose={() => setComposing(false)}
        desks={desks}
        defaultDesk={myDesk && myDesk !== 'HR' ? 'HR' : 'RECRUITING'}
        onSent={(id) => {
          setComposing(false);
          void q.refetch();
          onOpen(id);
        }}
      />
      <RequestThread id={openId} onClose={() => onOpen(null)} myDesk={myDesk} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The thread                                                          */
/* ------------------------------------------------------------------ */

export function RequestThread({ id, onClose, myDesk }: { id: string | null; onClose: () => void; myDesk: WorkDesk | null }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['relay', 'request', id], queryFn: () => workApi.request(id!), enabled: !!id });
  const r = q.data?.request;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['relay', 'request', id] });
    void queryClient.invalidateQueries({ queryKey: ['relay', 'requests'] });
  };

  const send = useMutation({
    mutationFn: () => workApi.reply(id!, { body: reply.trim(), fileIds: files.map((f) => f.id) }),
    onSuccess: () => {
      setReply('');
      setFiles([]);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send that.'),
  });
  // Picking a request up, answering it, closing it — the desk saying what
  // happened. The chip and the button should change on the tap, not after
  // the round-trip; the settle invalidation reconciles whatever the server
  // decided (who really holds it, the answeredAt stamp).
  const setStatus = useOptimisticMutation({
    mutationFn: (body: { status?: RequestStatus; claim?: boolean }) => workApi.update(id!, body),
    keys: [['relay', 'request', id], ['relay', 'requests']],
    errorMessage: 'Could not update it.',
    apply: (body, c) => {
      const mine = user ? { userId: user.id, name: user.email, photoUrl: null } : null;
      const patch = (req: WorkRequest): WorkRequest => ({
        ...req,
        ...(body.status ? { status: body.status } : null),
        // A claim both assigns it and moves it out of OPEN, which is what
        // the server does too.
        ...(body.claim === true ? { status: 'IN_PROGRESS' as RequestStatus, claimedBy: mine } : null),
        ...(body.claim === false ? { claimedBy: null } : null),
      });
      c.setQueryData(['relay', 'request', id], (prev: { request: WorkRequest } | undefined) =>
        prev ? { ...prev, request: patch(prev.request) } : prev,
      );
      for (const [key, data] of c.getQueriesData({ queryKey: ['relay', 'requests'] })) {
        const list = data as { requests?: WorkRequest[] } | undefined;
        if (!list?.requests) continue;
        c.setQueryData(key, {
          ...list,
          requests: list.requests.map((row) => (row.id === id ? patch(row) : row)),
        });
      }
    },
  });

  const onDesk = !!r && (r.toDesk === myDesk || r.toUser?.userId === user?.id);
  return (
    <Drawer open={!!id} onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      {r && (
        <>
          <DrawerHeader>
            <DrawerTitle className="truncate">{r.subject}</DrawerTitle>
            <DrawerDescription>
              {KIND_LABELS[r.kind]} · {r.from?.name ?? 'someone'} → {WORK_DESK_LABELS[r.toDesk]}
              {r.toUser && ` (${r.toUser.name})`} · {fmtDateTime(r.createdAt)}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerBody>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABELS[r.status]}</Badge>
                {r.dueAt && <span className="text-xs text-silver">needed by {fmtDate(r.dueAt)}</span>}
                {r.claimedBy && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-white">
                    <Avatar src={r.claimedBy.photoUrl} name={r.claimedBy.name} size="xs" />
                    {r.claimedBy.name} has it
                  </span>
                )}
                {r.about && (
                  <Link to={`/people?associateId=${r.about.associateId}&return=${encodeURIComponent('/relay?tab=requests')}`} className="ml-auto text-xs text-gold hover:underline">
                    About {r.about.name} →
                  </Link>
                )}
              </div>

              <div className="rounded-lg border border-navy-secondary p-3">
                <div className="flex items-center gap-2">
                  <Avatar src={r.from?.photoUrl ?? null} name={r.from?.name ?? '?'} size="sm" />
                  <span className="text-sm font-medium text-white">{r.from?.name ?? 'Someone'}</span>
                  <span className="ml-auto text-2xs text-silver/60">{fmtRelativeDate(r.createdAt)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-silver">{r.body}</p>
                {r.files.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.files.map((f) => (
                      <FileChip key={f.id} file={f} />
                    ))}
                  </div>
                )}
              </div>

              {(r.messages ?? []).map((m) => (
                <div key={m.id} className="rounded-lg border border-navy-secondary/60 bg-navy/40 p-3">
                  <div className="flex items-center gap-2">
                    <Avatar src={m.author?.photoUrl ?? null} name={m.author?.name ?? '?'} size="sm" />
                    <span className="text-sm font-medium text-white">{m.author?.name ?? 'Someone'}</span>
                    <span className="ml-auto text-2xs text-silver/60">{fmtRelativeDate(m.createdAt)}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-silver">{m.body}</p>
                  {m.files.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.files.map((f) => (
                        <FileChip key={f.id} file={f} />
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {r.status !== 'CLOSED' && (
                <div className="space-y-2">
                  <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} maxLength={4000} placeholder="Answer, or add what you found…" aria-label="Your reply" />
                  {files.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {files.map((f) => (
                        <FileChip key={f.id} file={f} onRemove={() => setFiles((x) => x.filter((y) => y.id !== f.id))} />
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <AttachButton busy={busy} setBusy={setBusy} onUploaded={(f) => setFiles((x) => [...x, f])} />
                    <Button size="sm" loading={send.isPending} disabled={!reply.trim() || send.isPending} onClick={() => send.mutate()}>
                      <Send className="h-3.5 w-3.5" />
                      Reply
                    </Button>
                    <span className="ml-auto flex flex-wrap gap-2">
                      {onDesk && !r.claimedBy && (
                        <Button size="sm" variant="secondary" onClick={() => setStatus.mutate({ claim: true })} loading={setStatus.isPending}>
                          <Hand className="h-3.5 w-3.5" />
                          I’ve got it
                        </Button>
                      )}
                      {onDesk && r.status !== 'ANSWERED' && (
                        <Button size="sm" variant="secondary" onClick={() => setStatus.mutate({ status: 'ANSWERED' })} loading={setStatus.isPending}>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Mark answered
                        </Button>
                      )}
                      {r.from?.userId === user?.id && (
                        <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ status: 'CLOSED' })} loading={setStatus.isPending}>
                          Close
                        </Button>
                      )}
                    </span>
                  </div>
                </div>
              )}
              {r.status === 'CLOSED' && (
                <p className="flex items-center gap-2 text-sm text-silver">
                  <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                  Closed. Everything said about it stays here.
                  <Button size="xs" variant="ghost" onClick={() => setStatus.mutate({ status: 'OPEN' })}>
                    Reopen
                  </Button>
                </p>
              )}
            </div>
          </DrawerBody>
        </>
      )}
      {!r && (
        <>
          <DrawerHeader>
            <DrawerTitle>Opening the thread…</DrawerTitle>
            <DrawerDescription>Fetching the ask, the replies and anything that came with them.</DrawerDescription>
          </DrawerHeader>
          <DrawerBody>
            <Skeleton className="h-40" />
          </DrawerBody>
        </>
      )}
    </Drawer>
  );
}
