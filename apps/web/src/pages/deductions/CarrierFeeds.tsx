import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileText, Inbox, Plus, Send, Upload } from '@/components/ui/icons';
import {
  createCarrier,
  download834,
  linkCarrierPlans,
  list834,
  listCarrierAcks,
  listCarriers,
  make834,
  saveCarrierConnection,
  send834,
  updateCarrier,
  uploadCarrierAck,
  type Carrier,
  type CarrierAck,
  type CarrierAckError,
  type CarrierFeedHealth,
  type CarrierInput,
  type CarrierPlan,
  type Edi834File,
  type FileAnswer,
} from '@/lib/deductionsApi';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { ListTemplate } from '@/components/templates';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * Carrier feeds: each insurance carrier and the enrollment files (EDI 834)
 * sent to it. A full file lists everyone covered; a change file lists only
 * additions, ends and changes since the last one.
 *
 * The page leads with how each feed is doing — who is in it, what is
 * waiting for the next file, the last file, whether it was delivered and
 * what the carrier answered — and keeps the setup (IDs, the SFTP
 * connection and its answers folder) in the carrier's edit dialog, read
 * before edit.
 *
 * The carrier's answers (its 999 / TA1 acknowledgments) come in two ways:
 * "Upload acknowledgment" here, or a pickup from the carrier's SFTP answers
 * folder. Each file says where it stands — accepted, accepted with errors
 * (each error in words, with the member it is about), rejected, waiting
 * (in business days; after 3 the Inbox raises it) or no answer expected.
 */

const LINE_LABEL: Record<string, string> = { HLT: 'Medical', DEN: 'Dental', VIS: 'Vision', LIF: 'Life', LTD: 'Long-term disability', STD: 'Short-term disability', AG: 'Accidental death', ADD: 'AD&D' };

/** Editing a carrier, or adding one; `connection` opens straight onto its delivery settings. */
type Editing = { carrier: Carrier | null; connection?: boolean };

/** "Delivery: SFTP, not connected" — how files reach the carrier, in one read. */
export function deliveryWords(c: Pick<Carrier, 'transport' | 'connection'>): { text: string; needsSetup: boolean } {
  if (c.transport === 'DOWNLOAD') return { text: 'Delivery: download and upload by hand', needsSetup: false };
  const how = c.transport === 'SFTP' ? 'SFTP' : 'secure upload';
  if (!c.connection.hasSecret) return { text: `Delivery: ${how}, not connected`, needsSetup: true };
  const where = c.transport === 'SFTP' ? c.connection.host : c.connection.baseUrl;
  return { text: `Delivery: ${how}${where ? ` to ${where}` : ''}`, needsSetup: false };
}

/** The last file's delivery, plainly: sent, failed (with why), or made and not sent. */
export function deliveryResult(f: NonNullable<CarrierFeedHealth['lastFile']>): { label: string; tone: 'good' | 'alert' | 'warning' } {
  if (f.status === 'SENT') return { label: 'Sent', tone: 'good' };
  if (f.status === 'FAILED') return { label: 'Failed', tone: 'alert' };
  return { label: 'Made, not sent', tone: 'warning' };
}

type AnswerTone = 'good' | 'warning' | 'alert' | 'info' | 'neutral';
const ANSWER_BADGE: Record<AnswerTone, BadgeProps['variant']> = { good: 'success', warning: 'pending', alert: 'destructive', info: 'info', neutral: 'outline' };
const days = (n: number) => `${n} business ${n === 1 ? 'day' : 'days'}`;

/**
 * Where a file stands with the carrier, in words: accepted, with errors (n),
 * rejected, waiting (n business days, said under the badge so a phone never
 * cuts it off), or no answer expected (and why).
 */
export function answerWords(answer: FileAnswer | undefined, errorCount = 0): { label: string; tone: AnswerTone; hint?: string } {
  switch (answer?.state) {
    case 'ACCEPTED':
      return { label: 'Accepted', tone: 'good' };
    case 'ACCEPTED_WITH_ERRORS':
      return { label: `Accepted with errors (${errorCount})`, tone: 'warning' };
    case 'PARTIAL':
      return { label: `Partly accepted (${errorCount})`, tone: 'warning' };
    case 'REJECTED':
      return { label: 'Rejected', tone: 'alert' };
    case 'WAITING': {
      const n = answer.waitingDays ?? 0;
      return { label: 'Waiting for an answer', tone: answer.overdue ? 'warning' : 'info', hint: n === 0 ? 'Sent today.' : `${days(n)} so far${answer.overdue ? ': more than 3, so it’s in the Inbox' : ''}.` };
    }
    case 'NOT_EXPECTED':
      return { label: 'No answer expected', tone: 'neutral', hint: answer.why };
    default:
      return { label: '—', tone: 'neutral' };
  }
}

/** One answer's result: as a file's, or "Couldn’t read" for a picked-up file that wasn't an acknowledgment. */
export function ackResultWords(a: Pick<CarrierAck, 'status' | 'errorCount'>): { label: string; tone: AnswerTone } {
  if (a.status === 'UNREADABLE') return { label: 'Couldn’t read', tone: 'neutral' };
  return answerWords({ state: a.status }, a.errorCount);
}

const ACK_KIND: Record<CarrierAck['kind'], string> = { TA1: 'Envelope check (TA1)', '999': 'File check (999)', '997': 'File check (997)', UNKNOWN: 'Not an acknowledgment' };

/** How the carrier's answers reach this page, said plainly — including when they can't. */
export function pickupWords(c: Pick<Carrier, 'transport' | 'connection' | 'ackCheckedAt' | 'ackCheckError'>, sftpAvailable: boolean): { text: string; warn: boolean; setUp: boolean } {
  if (c.transport !== 'SFTP') return { text: 'Upload the carrier’s answer (999 or TA1) when it sends one.', warn: false, setUp: false };
  const dir = c.connection.inboundDir;
  if (!dir) return { text: 'Answers aren’t picked up from the carrier’s SFTP: add its answers folder, or upload each answer here.', warn: false, setUp: true };
  if (!sftpAvailable) return { text: `SFTP isn’t installed on this server, so answers can’t be picked up from ${dir}. Upload them here instead.`, warn: true, setUp: false };
  if (c.ackCheckError) return { text: `The last look in ${dir} failed${c.ackCheckedAt ? ` (${fmtDateTime(c.ackCheckedAt)})` : ''}: ${c.ackCheckError}`, warn: true, setUp: false };
  if (c.ackCheckedAt) return { text: `Answers are picked up from ${dir} · last looked ${fmtDateTime(c.ackCheckedAt)}.`, warn: false, setUp: false };
  return { text: `Answers will be picked up from ${dir}; the first look hasn’t run yet.`, warn: false, setUp: false };
}

function AnswerBadge({ words, size }: { words: { label: string; tone: AnswerTone }; size?: 'sm' }) {
  return (
    <Badge size={size} variant={ANSWER_BADGE[words.tone]}>
      {words.label}
    </Badge>
  );
}

/** An answer's errors in words, the member first when the segment points at one. */
function AckErrorList({ errors, total, limit, onAll, large }: { errors: CarrierAckError[]; total: number; limit?: number; onAll?: () => void; large?: boolean }) {
  const shown = limit ? errors.slice(0, limit) : errors;
  return (
    <ul className={large ? 'space-y-2 text-sm text-ink-muted' : 'space-y-1 text-xs text-ink-muted'}>
      {shown.map((e, i) => (
        <li key={`${e.code}-${i}`} className="break-words">
          {e.member && <span className="font-medium text-ink">{`${e.member}: `}</span>}
          {e.message}
        </li>
      ))}
      {onAll && total > shown.length && (
        <li>
          <button type="button" className="text-gold underline-offset-2 hover:underline" onClick={onAll}>
            {`All ${total} errors`}
          </button>
        </li>
      )}
    </ul>
  );
}

export function CarrierFeeds() {
  const q = useQuery({ queryKey: ['carriers'], queryFn: listCarriers });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [picked, setPicked] = useUrlParam<string>('carrier', '');
  const carriers = q.data?.carriers ?? [];
  const carrier = carriers.find((c) => c.id === picked) ?? carriers[0] ?? null;
  return (
    <ListTemplate
      title="Carrier feeds"
      subtitle="Enrollment files for each insurance carrier, made from benefit elections, covered dependents and life events."
      actions={[{ label: 'Add a carrier', icon: Plus, primary: carriers.length === 0, onSelect: () => setEditing({ carrier: null }) }]}
    >
      {q.isError ? (
        <QueryError what="carriers" query={q} />
      ) : q.isLoading ? (
        <SkeletonRows count={5} />
      ) : !carrier ? (
        <EmptyState icon={Send} title="No carriers yet" description="Add each insurer you send enrollments to, with the IDs from its EDI setup form." action={<Button onClick={() => setEditing({ carrier: null })}>Add a carrier</Button>} />
      ) : (
        <div className="space-y-4">
          {carriers.length > 1 && <FeedsGrid carriers={carriers} selectedId={carrier.id} onPick={(id) => setPicked(id === carriers[0]?.id ? '' : id)} />}
          <CarrierView carrier={carrier} allPlans={q.data?.plans ?? []} sftpAvailable={q.data?.sftpAvailable !== false} onEdit={(connection) => setEditing({ carrier, connection })} />
        </div>
      )}
      {editing && <CarrierDialog carrier={editing.carrier} focusConnection={!!editing.connection} sftpAvailable={q.data?.sftpAvailable !== false} onClose={() => setEditing(null)} />}
    </ListTemplate>
  );
}

/** Every feed at once (two or more carriers): who's in it, what's waiting, the last file and its delivery. */
function FeedsGrid({ carriers, selectedId, onPick }: { carriers: Carrier[]; selectedId: string; onPick: (id: string) => void }) {
  return (
    <DataGrid<Carrier>
      id="carrier-feeds"
      caption="Feeds"
      rows={carriers}
      rowKey={(c) => c.id}
      noun={{ one: 'carrier', many: 'carriers' }}
      search={false}
      exportCsv={false}
      onRowClick={(c) => onPick(c.id)}
      rowActionLabel={(c) => `Open ${c.name}`}
      columns={[
        { key: 'name', header: 'Carrier', primary: true, sortable: true, accessor: (c) => c.name, cell: (c) => <span className={c.id === selectedId ? 'font-medium text-gold' : 'font-medium text-ink'}>{c.name}</span> },
        { key: 'people', header: 'People', align: 'right', searchable: false, className: 'tabular-nums', accessor: (c) => c.health?.people ?? 0 },
        { key: 'waiting', header: 'Changes waiting', align: 'right', searchable: false, className: 'tabular-nums', accessor: (c) => c.health?.changesWaiting ?? -1, cell: (c) => (c.health?.changesWaiting == null ? '—' : c.health.changesWaiting) },
        { key: 'last', header: 'Last file', cardMeta: true, accessor: (c) => c.health?.lastFile?.createdAt ?? '', cell: (c) => (c.health?.lastFile ? `${fmtDate(c.health.lastFile.createdAt)} · ${c.health.lastFile.mode === 'FULL' ? 'full' : 'changes'}` : 'None yet') },
        {
          key: 'delivery',
          header: 'Delivery',
          accessor: (c) => c.health?.lastFile?.status ?? '',
          cell: (c) => {
            const f = c.health?.lastFile;
            if (!f) return <span className="text-ink-muted">—</span>;
            const r = deliveryResult(f);
            return <Badge size="sm" variant={r.tone === 'good' ? 'success' : r.tone === 'alert' ? 'destructive' : 'pending'}>{r.label}</Badge>;
          },
        },
        {
          key: 'answer',
          header: 'Carrier’s answer',
          accessor: (c) => c.health?.lastAnswer?.status ?? c.health?.lastFile?.answer?.state ?? '',
          cell: (c) => {
            const a = c.health?.lastAnswer;
            if (a) return <AnswerBadge size="sm" words={answerWords({ state: a.status as FileAnswer['state'] }, a.errorCount)} />;
            const waiting = c.health?.lastFile?.answer;
            if (waiting?.state === 'WAITING') {
              const w = answerWords(waiting);
              return (
                <div className="space-y-0.5">
                  <AnswerBadge size="sm" words={{ ...w, label: 'Waiting' }} />
                  <p className="text-xs text-ink-muted">{waiting.waitingDays ? `${days(waiting.waitingDays)}, no answer` : 'Sent today'}</p>
                </div>
              );
            }
            return <span className="text-ink-muted">—</span>;
          },
        },
      ]}
    />
  );
}

function CarrierView({ carrier, allPlans, sftpAvailable, onEdit }: { carrier: Carrier; allPlans: CarrierPlan[]; sftpAvailable: boolean; onEdit: (connection?: boolean) => void }) {
  const qc = useQueryClient();
  const files = useQuery({ queryKey: ['carriers', 'files', carrier.id], queryFn: () => list834(carrier.id) });
  const acks = useQuery({ queryKey: ['carriers', 'acks', carrier.id], queryFn: () => listCarrierAcks(carrier.id) });
  const [linking, setLinking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorsOf, setErrorsOf] = useState<{ title: string; ack: CarrierAck } | null>(null);
  const pickup = pickupWords(carrier, sftpAvailable);
  const [excluded, setExcluded] = useState<string[]>([]);
  const make = useMutation({
    mutationFn: (mode: 'FULL' | 'CHANGE') => make834(carrier.id, mode),
    onSuccess: (r) => {
      setExcluded(r.excluded);
      if (r.file) toast.success(`${r.file.mode === 'FULL' ? 'Full' : 'Change'} enrollment file made with ${r.file.memberCount} ${r.file.memberCount === 1 ? 'member' : 'members'}.`);
      else toast.success(r.message ?? 'Nothing to send.');
      void qc.invalidateQueries({ queryKey: ['carriers'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const send = useMutation({
    mutationFn: send834,
    onSuccess: () => {
      toast.success('Sent to the carrier.');
      void qc.invalidateQueries({ queryKey: ['carriers'] });
    },
    onError: (e: Error) => {
      toast.error(e.message);
      void qc.invalidateQueries({ queryKey: ['carriers', 'files', carrier.id] });
    },
  });
  const delivery = deliveryWords(carrier);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {carrier.name}
              <Badge variant={carrier.usageIndicator === 'P' ? 'success' : 'pending'}>{carrier.usageIndicator === 'P' ? 'Production' : 'Testing'}</Badge>
            </CardTitle>
            <CardDescription>
              {carrier.policyNumber ? `Group ${carrier.policyNumber} · ` : ''}
              {delivery.text}
              {delivery.needsSetup && (
                <>
                  {' · '}
                  <button type="button" className="text-gold underline-offset-2 hover:underline" onClick={() => onEdit(true)}>
                    Set up
                  </button>
                </>
              )}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => onEdit()}>Edit carrier</Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <FeedHealthStrip health={carrier.health} />
          <p className={pickup.warn ? 'text-xs text-warning' : 'text-xs text-ink-muted'}>
            {pickup.text}
            {pickup.setUp && (
              <>
                {' '}
                <button type="button" className="text-gold underline-offset-2 hover:underline" onClick={() => onEdit(true)}>
                  Add the answers folder
                </button>
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-ink">Plans in this feed</p>
            <Button size="sm" variant="ghost" onClick={() => setLinking(true)}>Choose plans</Button>
          </div>
          {carrier.plans.length === 0 ? (
            <p className="text-sm text-ink-muted">No plans yet. Choose which benefit plans this carrier insures.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {carrier.plans.map((p) => (
                <li key={p.id}>
                  <Badge variant="outline">{`${p.name} · ${LINE_LABEL[p.insuranceLineCode ?? ''] ?? p.insuranceLineCode ?? 'Medical'}${p.carrierPlanCode ? ` · ${p.carrierPlanCode}` : ''}`}</Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={() => make.mutate('CHANGE')} loading={make.isPending && make.variables === 'CHANGE'} disabled={!carrier.plans.length}>Make a change file</Button>
            <Button variant="outline" onClick={() => make.mutate('FULL')} loading={make.isPending && make.variables === 'FULL'} disabled={!carrier.plans.length}>Make a full file</Button>
          </div>
          <p className="text-xs text-ink-muted">{carrier.lastFile ? `Last file ${fmtDate(carrier.lastFile.createdAt)}. A change file covers what changed since then.` : 'Start with a full file; after that, change files carry only what changed.'}</p>
          {excluded.length > 0 && (
            <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm">
              <p className="font-medium text-ink">{`${excluded.length} left out of the file`}</p>
              <ul className="mt-1 list-disc pl-5 text-ink-muted">
                {excluded.slice(0, 8).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Send log</CardTitle>
            <CardDescription>Every enrollment file made for this carrier, with its control number and the carrier’s answer.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setUploading(true)}>
            <Upload className="h-4 w-4" aria-hidden />
            Upload acknowledgment
          </Button>
        </CardHeader>
        <CardContent>
          {files.isError ? (
            <QueryError what="files" query={files} />
          ) : (
            <DataGrid<Edi834File>
              id="carrier-files"
              caption="Enrollment files"
              rows={files.data?.files}
              loading={files.isLoading}
              rowKey={(f) => f.id}
              noun={{ one: 'file', many: 'files' }}
              search={false}
              columns={[
                { key: 'made', header: 'Made', primary: true, sortable: true, accessor: (f) => f.createdAt, cell: (f) => <div><p className="font-medium text-ink">{f.mode === 'FULL' ? 'Full file' : 'Change file'}</p><p className="text-xs text-ink-muted">{`${fmtDate(f.createdAt)} · control ${f.controlNumber}`}</p></div> },
                { key: 'members', header: 'Members', align: 'right', searchable: false, accessor: (f) => f.memberCount, className: 'tabular-nums' },
                {
                  key: 'status',
                  header: 'Status',
                  cardMeta: true,
                  accessor: (f) => f.status,
                  cell: (f) => (
                    <div>
                      <Badge variant={f.status === 'SENT' ? 'success' : f.status === 'FAILED' ? 'destructive' : 'pending'}>{f.status === 'SENT' ? `Sent ${f.sentAt ? fmtDate(f.sentAt) : ''}`.trim() : f.status === 'FAILED' ? 'Not sent' : 'Ready'}</Badge>
                      {f.error && <p className="mt-1 max-w-xs text-xs text-ink-muted">{f.error}</p>}
                    </div>
                  ),
                },
                {
                  key: 'answer',
                  header: 'Carrier’s answer',
                  // On a phone, under the file's name at full width: the errors need the room.
                  cardMeta: true,
                  accessor: (f) => f.answer?.state ?? '',
                  cell: (f) => {
                    const words = answerWords(f.answer, f.ack?.errorCount ?? 0);
                    return (
                      <div className="min-w-0 max-w-md space-y-1">
                        <AnswerBadge words={words} />
                        {words.hint && <p className="text-xs text-ink-muted">{words.hint}</p>}
                        {f.ack?.kind === 'TA1' && f.ack.status !== 'REJECTED' && <p className="text-xs text-ink-muted">From the envelope check (TA1); the carrier’s file check (999) hasn’t come.</p>}
                        {f.ack && f.ack.errors.length > 0 && (
                          <AckErrorList errors={f.ack.errors} total={f.ack.errorCount} limit={2} onAll={() => setErrorsOf({ title: `Errors in control ${f.controlNumber}`, ack: f.ack! })} />
                        )}
                      </div>
                    );
                  },
                },
                {
                  key: 'actions',
                  header: '',
                  searchable: false,
                  stopRowClick: true,
                  accessor: () => '',
                  cell: (f) => (
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" aria-label="Download the enrollment file" onClick={() => void download834(f.id).catch((e: Error) => toast.error(e.message))}>
                        <Download className="h-4 w-4" aria-hidden />
                      </Button>
                      {f.status !== 'SENT' && carrier.transport !== 'DOWNLOAD' && (
                        <Button size="sm" variant="outline" onClick={() => send.mutate(f.id)} loading={send.isPending && send.variables === f.id}>
                          <Send className="h-4 w-4" aria-hidden />
                          Send
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
              empty={{ icon: FileText, title: 'No files yet', description: 'Make a full file to start the feed.' }}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Answers from the carrier</CardTitle>
          <CardDescription>Every acknowledgment received, uploaded or picked up, and the file it answers.</CardDescription>
        </CardHeader>
        <CardContent>
          {acks.isError ? (
            <QueryError what="answers" query={acks} />
          ) : (
            <DataGrid<CarrierAck>
              id="carrier-acks"
              caption="Carrier answers"
              rows={acks.data?.acks}
              loading={acks.isLoading}
              rowKey={(a) => a.id}
              noun={{ one: 'answer', many: 'answers' }}
              search={false}
              exportCsv={false}
              columns={[
                {
                  key: 'received',
                  header: 'Received',
                  primary: true,
                  sortable: true,
                  accessor: (a) => a.receivedAt,
                  cell: (a) => (
                    <div>
                      <p className="font-medium text-ink">{ACK_KIND[a.kind]}</p>
                      <p className="text-xs text-ink-muted">{`${fmtDateTime(a.receivedAt)} · ${a.source === 'SFTP' ? 'picked up' : 'uploaded'}`}</p>
                    </div>
                  ),
                },
                {
                  key: 'file',
                  header: 'Answers',
                  cardMeta: true,
                  accessor: (a) => a.controlNumber ?? '',
                  cell: (a) =>
                    a.file ? (
                      <span>{`Control ${a.file.controlNumber} · ${a.file.mode === 'FULL' ? 'full file' : 'change file'} of ${fmtDate(a.file.createdAt)}`}</span>
                    ) : a.status === 'UNREADABLE' ? (
                      <span className="text-ink-muted">Not read, so not matched</span>
                    ) : (
                      <span className="text-warning">{`Didn’t match a file we sent${a.controlNumber !== null ? ` (control ${a.controlNumber})` : ''}`}</span>
                    ),
                },
                {
                  key: 'result',
                  header: 'Result',
                  cardMeta: true,
                  accessor: (a) => a.status,
                  cell: (a) => (
                    <div className="min-w-0 max-w-md space-y-1">
                      <AnswerBadge words={ackResultWords(a)} />
                      {a.errors.length > 0 && <AckErrorList errors={a.errors} total={a.errorCount} limit={2} onAll={() => setErrorsOf({ title: a.file ? `Errors in control ${a.file.controlNumber}` : 'Errors in this answer', ack: a })} />}
                    </div>
                  ),
                },
              ]}
              empty={{ icon: Inbox, title: 'No answers yet', description: carrier.transport === 'SFTP' && carrier.connection.inboundDir ? 'Answers from the carrier’s folder show here once picked up; you can also upload one.' : 'Upload the carrier’s 999 or TA1 when it sends one.' }}
            />
          )}
        </CardContent>
      </Card>

      {linking && <LinkPlansDialog carrier={carrier} allPlans={allPlans} onClose={() => setLinking(false)} />}
      {uploading && <UploadAckDialog carrier={carrier} onClose={() => setUploading(false)} />}
      {errorsOf && (
        <Dialog open onOpenChange={(o) => !o && setErrorsOf(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{errorsOf.title}</DialogTitle>
              <DialogDescription>{`${ACK_KIND[errorsOf.ack.kind]} received ${fmtDateTime(errorsOf.ack.receivedAt)}: ${ackResultWords(errorsOf.ack).label}.`}</DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto pr-1 text-sm">
              <AckErrorList errors={errorsOf.ack.errors} total={errorsOf.ack.errorCount} large />
              {errorsOf.ack.errorCount > errorsOf.ack.errors.length && <p className="mt-2 text-xs text-ink-muted">{`The first ${errorsOf.ack.errors.length} of ${errorsOf.ack.errorCount} errors.`}</p>}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setErrorsOf(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** "Upload acknowledgment": a 999 or TA1 as a file or pasted, and what it answered, in words. */
function UploadAckDialog({ carrier, onClose }: { carrier: Carrier; onClose: () => void }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => uploadCarrierAck(carrier.id, text),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      if (r.duplicate) toast.success('This answer was already received; nothing changed.');
      else toast.success(r.acks.length === 1 ? 'Answer received.' : `${r.acks.length} answers received.`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{`Upload ${carrier.name}’s acknowledgment`}</DialogTitle>
          <DialogDescription>The 999 or TA1 the carrier sent back, as a file or pasted. It is matched to the file it answers by control number.</DialogDescription>
        </DialogHeader>
        {m.data ? (
          <div className="space-y-3">
            {m.data.duplicate && <p className="text-sm text-ink-muted">This exact answer was already received. It’s shown as it was kept.</p>}
            <ul className="space-y-3">
              {m.data.acks.map((a) => (
                <li key={a.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">
                      {a.file ? `Control ${a.file.controlNumber} · ${a.file.mode === 'FULL' ? 'full file' : 'change file'} of ${fmtDate(a.file.createdAt)}` : `Didn’t match a file we sent${a.controlNumber !== null ? ` (control ${a.controlNumber})` : ''}`}
                    </p>
                    <AnswerBadge words={ackResultWords(a)} />
                  </div>
                  <p className="text-xs text-ink-muted">{ACK_KIND[a.kind]}</p>
                  {a.errors.length > 0 && (
                    <div className="mt-2 max-h-48 overflow-y-auto">
                      <AckErrorList errors={a.errors} total={a.errorCount} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              ref={ref}
              type="file"
              accept=".txt,.edi,.x12,.999,.ta1,.dat,text/plain"
              className="sr-only"
              aria-label="Choose the acknowledgment file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setFileName(file.name);
                  void file.text().then(setText);
                }
                e.target.value = '';
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => ref.current?.click()}>
                <Upload className="h-4 w-4" aria-hidden />
                Choose a file
              </Button>
              {fileName && <span className="min-w-0 truncate text-sm text-ink-muted">{fileName}</span>}
            </div>
            <Field label="Or paste the text">
              {(p) => <Textarea {...p} rows={8} className="font-mono text-xs" value={text} placeholder="ISA*00*…" onChange={(e) => { setText(e.target.value); setFileName(null); }} />}
            </Field>
          </div>
        )}
        <DialogFooter>
          {m.data ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!text.trim()}>Read the answer</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * How the feed is doing, from the send log and the carrier's answers. There
 * is no carrier schedule in the data, so no "due" date is invented; what's
 * waiting is the real count of people whose enrollment changed since the
 * last file the carrier didn't reject.
 */
function FeedHealthStrip({ health }: { health: CarrierFeedHealth | undefined }) {
  if (!health) return null;
  const f = health.lastFile;
  const result = f ? deliveryResult(f) : null;
  const a = health.lastAnswer ?? null;
  const answer = a ? answerWords({ state: a.status as FileAnswer['state'] }, a.errorCount) : null;
  const lastWaiting = f?.answer?.state === 'WAITING' ? answerWords(f.answer) : null;
  return (
    <div className="space-y-2">
      <MetricStrip
        label="Feed health"
        // A feed with no one in it and no file yet has nothing to report: no
        // row of four empty tiles (the plans section below says what to do).
        empty={health.people === 0 && !f}
      >
        <MetricCard label="People in the feed" value={health.people} tone="neutral" hint="Everyone a full file would carry" nothing={health.people === 0 ? 'No one enrolled in these plans' : undefined} />
        <MetricCard
          label="Waiting for the next file"
          value={health.changesWaiting ?? 0}
          tone={health.changesWaiting ? 'warning' : 'default'}
          hint={health.changesWaiting ? `${health.changesWaiting === 1 ? 'person' : 'people'} changed since the last file` : undefined}
          nothing={health.changesWaiting === null ? 'First file: make a full one' : health.changesWaiting === 0 ? 'Nothing changed since the last file' : undefined}
        />
        <MetricCard
          label="Last file"
          value={f ? fmtDate(f.createdAt) : '—'}
          tone="neutral"
          hint={f ? `${f.mode === 'FULL' ? 'Full' : 'Changes'} · control ${f.controlNumber} · ${f.memberCount} ${f.memberCount === 1 ? 'member' : 'members'}` : undefined}
          nothing={f ? undefined : 'No file made yet'}
        />
        <MetricCard
          label="Delivery"
          value={result?.label ?? '—'}
          tone={result?.tone}
          hint={f?.status === 'SENT' && f.sentAt ? `Sent ${fmtDate(f.sentAt)}${lastWaiting ? ` · no answer, ${f.answer?.waitingDays ? days(f.answer.waitingDays) : 'sent today'}` : ''}` : f?.error ?? undefined}
          nothing={f ? undefined : 'Nothing sent yet'}
        />
        <MetricCard
          label="Carrier’s answer"
          value={answer?.label ?? '—'}
          tone={answer ? (answer.tone === 'alert' ? 'alert' : answer.tone === 'warning' ? 'warning' : answer.tone === 'good' ? 'good' : 'neutral') : undefined}
          hint={a ? `${a.kind} · ${a.matched ? `control ${a.controlNumber}` : 'didn’t match a file we sent'} · ${fmtDate(a.receivedAt)}` : undefined}
          nothing={a ? undefined : 'No answer received yet'}
        />
      </MetricStrip>
    </div>
  );
}

function CarrierDialog({ carrier, focusConnection, sftpAvailable = true, onClose }: { carrier: Carrier | null; focusConnection: boolean; sftpAvailable?: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<CarrierInput>(
    carrier
      ? { name: carrier.name, receiverId: carrier.receiverId, receiverQualifier: carrier.receiverQualifier, senderId: carrier.senderId, senderQualifier: carrier.senderQualifier, sponsorTaxId: carrier.sponsorTaxId, policyNumber: carrier.policyNumber, usageIndicator: carrier.usageIndicator, transport: carrier.transport, active: carrier.active }
      : { name: '', receiverId: '', receiverQualifier: 'ZZ', senderId: '', senderQualifier: 'ZZ', sponsorTaxId: null, policyNumber: null, usageIndicator: 'T', transport: 'DOWNLOAD' },
  );
  // The delivery settings live here now, read before edit — not as an always-open form under the log.
  const [conn, setConn] = useState({
    baseUrl: carrier?.connection.baseUrl ?? '',
    apiKey: '',
    host: carrier?.connection.host ?? '',
    port: '22',
    username: carrier?.connection.username ?? '',
    password: '',
    privateKey: '',
    remoteDir: carrier?.connection.remoteDir ?? '',
    inboundDir: carrier?.connection.inboundDir ?? '',
  });
  const hasSecret = carrier?.connection.hasSecret ?? false;
  const connTouched =
    conn.apiKey !== '' ||
    conn.password !== '' ||
    conn.privateKey !== '' ||
    conn.baseUrl !== (carrier?.connection.baseUrl ?? '') ||
    conn.host !== (carrier?.connection.host ?? '') ||
    conn.username !== (carrier?.connection.username ?? '') ||
    conn.remoteDir !== (carrier?.connection.remoteDir ?? '') ||
    conn.inboundDir !== (carrier?.connection.inboundDir ?? '') ||
    conn.port !== '22';
  const m = useMutation({
    mutationFn: async () => {
      const saved = carrier ? await updateCarrier(carrier.id, f) : await createCarrier(f);
      if (f.transport !== 'DOWNLOAD' && connTouched) {
        await saveCarrierConnection(
          saved.carrier.id,
          f.transport === 'SFTP'
            ? { host: conn.host || undefined, port: Number(conn.port) || 22, username: conn.username || undefined, password: conn.password || undefined, privateKey: conn.privateKey || undefined, remoteDir: conn.remoteDir || undefined, inboundDir: conn.inboundDir.trim() }
            : { baseUrl: conn.baseUrl || undefined, apiKey: conn.apiKey || undefined },
        );
      }
      return saved;
    },
    onSuccess: () => {
      toast.success(carrier ? 'Carrier saved.' : 'Carrier added. Choose the plans it insures next.');
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const valid = f.name.trim().length >= 2 && f.receiverId.trim().length >= 2 && f.senderId.trim().length >= 2;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{carrier ? `Edit ${carrier.name}` : 'Add a carrier'}</DialogTitle>
          <DialogDescription>The IDs come from the carrier’s EDI enrollment setup form or companion guide.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Carrier name" required className="sm:col-span-2">{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Carrier’s receiver ID" required hint="ISA08">{(p) => <Input {...p} value={f.receiverId} maxLength={15} onChange={(e) => setF({ ...f, receiverId: e.target.value })} />}</Field>
          <Field label="Receiver ID type" hint="ISA07, usually ZZ">{(p) => <Input {...p} value={f.receiverQualifier} maxLength={2} onChange={(e) => setF({ ...f, receiverQualifier: e.target.value.toUpperCase() })} />}</Field>
          <Field label="Your sender ID" required hint="ISA06, assigned by the carrier">{(p) => <Input {...p} value={f.senderId} maxLength={15} onChange={(e) => setF({ ...f, senderId: e.target.value })} />}</Field>
          <Field label="Sender ID type" hint="ISA05, usually ZZ">{(p) => <Input {...p} value={f.senderQualifier} maxLength={2} onChange={(e) => setF({ ...f, senderQualifier: e.target.value.toUpperCase() })} />}</Field>
          <Field label="Group policy number">{(p) => <Input {...p} value={f.policyNumber ?? ''} onChange={(e) => setF({ ...f, policyNumber: e.target.value || null })} />}</Field>
          <Field label="Your EIN" hint="9 digits; defaults to the company’s">{(p) => <Input {...p} inputMode="numeric" value={f.sponsorTaxId ?? ''} maxLength={9} onChange={(e) => setF({ ...f, sponsorTaxId: e.target.value.replace(/\D/g, '') || null })} />}</Field>
          <Field label="Mode">
            {(p) => (
              <Select {...p} value={f.usageIndicator} onChange={(e) => setF({ ...f, usageIndicator: e.target.value as 'T' | 'P' })}>
                <option value="T">Testing</option>
                <option value="P">Production</option>
              </Select>
            )}
          </Field>
          <Field label="How files reach the carrier">
            {(p) => (
              <Select {...p} value={f.transport} onChange={(e) => setF({ ...f, transport: e.target.value as CarrierInput['transport'] })}>
                <option value="DOWNLOAD">Download and upload by hand</option>
                <option value="SFTP">SFTP</option>
                <option value="HTTPS">Secure upload (HTTPS)</option>
              </Select>
            )}
          </Field>
        </div>
        {f.transport !== 'DOWNLOAD' && (
          <section aria-labelledby="carrier-delivery" className="space-y-3 rounded-lg border border-line p-3">
            <div>
              <h3 id="carrier-delivery" className="text-sm font-medium text-ink">
                {f.transport === 'SFTP' ? 'SFTP connection' : 'Secure upload'}
              </h3>
              <p className="text-xs text-ink-muted">{hasSecret ? 'Connected. Leave a secret blank to keep the one saved; secrets are stored encrypted.' : 'Fill this in to send files from here. Secrets are stored encrypted.'}</p>
              {f.transport === 'SFTP' && !sftpAvailable && <p className="mt-1 text-xs text-warning">SFTP isn’t installed on this server yet: files can’t be sent or answers picked up over SFTP until it is. Download and upload by hand meanwhile.</p>}
            </div>
            {f.transport === 'SFTP' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="SFTP host">{(p) => <Input {...p} autoFocus={focusConnection} value={conn.host} onChange={(e) => setConn({ ...conn, host: e.target.value })} />}</Field>
                <Field label="Port">{(p) => <Input {...p} type="number" value={conn.port} onChange={(e) => setConn({ ...conn, port: e.target.value })} />}</Field>
                <Field label="User name">{(p) => <Input {...p} autoComplete="off" value={conn.username} onChange={(e) => setConn({ ...conn, username: e.target.value })} />}</Field>
                <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="new-password" value={conn.password} placeholder={hasSecret ? 'Saved' : ''} onChange={(e) => setConn({ ...conn, password: e.target.value })} />}</Field>
                <Field label="Folder">{(p) => <Input {...p} value={conn.remoteDir} placeholder="/inbound" onChange={(e) => setConn({ ...conn, remoteDir: e.target.value })} />}</Field>
                <Field label="Answers folder" hint="Where the carrier leaves its 999 and TA1 files; they’re picked up from here. Blank: upload them by hand.">{(p) => <Input {...p} value={conn.inboundDir} placeholder="/outbound" onChange={(e) => setConn({ ...conn, inboundDir: e.target.value })} />}</Field>
                <Field label="Private key, instead of a password" className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} value={conn.privateKey} placeholder={hasSecret ? 'Saved' : ''} onChange={(e) => setConn({ ...conn, privateKey: e.target.value })} />}</Field>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Upload address" hint="Starts with https://">{(p) => <Input {...p} autoFocus={focusConnection} value={conn.baseUrl} onChange={(e) => setConn({ ...conn, baseUrl: e.target.value })} />}</Field>
                <Field label="API key">{(p) => <Input {...p} type="password" autoComplete="new-password" value={conn.apiKey} placeholder={hasSecret ? 'Saved' : ''} onChange={(e) => setConn({ ...conn, apiKey: e.target.value })} />}</Field>
              </div>
            )}
          </section>
        )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!valid}>{carrier ? 'Save carrier' : 'Add carrier'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkPlansDialog({ carrier, allPlans, onClose }: { carrier: Carrier; allPlans: CarrierPlan[]; onClose: () => void }) {
  const qc = useQueryClient();
  const eligible = allPlans.filter((p) => !p.carrierId || p.carrierId === carrier.id);
  const [chosen, setChosen] = useState<Record<string, { on: boolean; line: string; code: string }>>(() =>
    Object.fromEntries(eligible.map((p) => [p.id, { on: p.carrierId === carrier.id, line: p.insuranceLineCode ?? p.defaultLine ?? '', code: p.carrierPlanCode ?? '' }])),
  );
  const m = useMutation({
    mutationFn: () => linkCarrierPlans(carrier.id, Object.entries(chosen).filter(([, v]) => v.on).map(([planId, v]) => ({ planId, insuranceLineCode: v.line || null, carrierPlanCode: v.code || null }))),
    onSuccess: () => {
      toast.success('Plans saved.');
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{`Plans ${carrier.name} insures`}</DialogTitle>
          <DialogDescription>Use the carrier’s own plan code where it gives one. A plan can belong to one carrier.</DialogDescription>
        </DialogHeader>
        {eligible.length === 0 ? (
          <p className="text-sm text-ink-muted">No benefit plans are free to add. Create plans on the Benefits page first.</p>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-navy-secondary overflow-y-auto">
            {eligible.map((p) => {
              const v = chosen[p.id]!;
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink">
                    <input type="checkbox" className="h-4 w-4 accent-gold" checked={v.on} onChange={(e) => setChosen({ ...chosen, [p.id]: { ...v, on: e.target.checked } })} />
                    <span className="truncate">{p.name}</span>
                  </label>
                  {v.on && (
                    <>
                      <Select size="sm" aria-label={`${p.name} coverage line`} className="w-40" value={v.line} onChange={(e) => setChosen({ ...chosen, [p.id]: { ...v, line: e.target.value } })}>
                        <option value="">Choose a line…</option>
                        {Object.entries(LINE_LABEL).map(([k, l]) => (
                          <option key={k} value={k}>{l}</option>
                        ))}
                      </Select>
                      <Input aria-label={`${p.name} carrier plan code`} className="h-8 w-36" placeholder="Plan code" value={v.code} onChange={(e) => setChosen({ ...chosen, [p.id]: { ...v, code: e.target.value } })} />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending}>Save plans</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
