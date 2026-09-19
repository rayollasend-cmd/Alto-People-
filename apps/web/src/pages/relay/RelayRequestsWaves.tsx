import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Store, Target } from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input, Textarea } from '@/components/ui/Input';
import { DeskChip, OwnerControl, SectionHead } from './RelayParts';
import { DESK_LABELS, claimKey, type Claim, type ClientRequestRow, type CohortSummary, type Desk, type DeskPerson } from './relayTypes';

/**
 * The client in the loop — asks the customer is watching move in their
 * own portal — and the waves: hiring pushes racing a landing date.
 */

const REQ_KIND_LABEL: Record<ClientRequestRow['kind'], string> = {
  STAFFING: 'Staffing',
  FEEDBACK: 'Feedback',
  ISSUE: 'Issue',
  BILLING: 'Billing',
};

export function ClientRequestsSection({
  rows,
  lens,
  canWork,
  claims,
  desks,
  meId,
  onChanged,
}: {
  rows: ClientRequestRow[];
  lens: Desk | 'ALL';
  canWork: boolean;
  claims: Record<string, Claim>;
  desks: Record<Desk, DeskPerson[]> | undefined;
  meId: string | undefined;
  onChanged: () => void;
}) {
  const [resolving, setResolving] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = rows.filter((r) => lens === 'ALL' || r.desk === lens);

  const patch = async (id: string, body: { status: string; resolution?: string }) => {
    setBusy(true);
    try {
      await apiFetch(`/client-requests/${id}`, { method: 'PATCH', body });
      setResolving(null);
      setReply('');
      onChanged();
      if (body.status === 'RESOLVED') toast.success('Resolved — the client sees your reply.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="client-requests">
      <SectionHead icon={Store} title="Client requests" meta="the customer is watching" id="client-requests" />
      <Card className="overflow-hidden p-0">
        {shown.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {rows.length === 0 ? (
              'No open client requests. Silence means green.'
            ) : (
              <span>
                None for {DESK_LABELS[lens as Desk]}.{' '}
                <span className="text-silver">
                  {rows.length} on {rows.length === 1 ? 'another desk' : 'other desks'} — see all desks.
                </span>
              </span>
            )}
          </p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {shown.map((r) => (
              <li key={r.id} className={cn('px-4 py-3', r.overdue && 'bg-alert/[0.04]')}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold text-white">{r.clientName}</span>
                  <Badge variant={r.kind === 'ISSUE' ? 'destructive' : 'outline'} size="sm">
                    {REQ_KIND_LABEL[r.kind]}
                  </Badge>
                  {lens === 'ALL' && <DeskChip desk={r.desk} />}
                  {r.status === 'IN_PROGRESS' && <Badge variant="accent" size="sm">In progress</Badge>}
                  {r.overdue && <Badge variant="destructive" size="sm">Past due</Badge>}
                  <span className="ml-auto">
                    <OwnerControl
                      subjectType="REQUEST"
                      subjectKey={r.id}
                      what={`${r.clientName}’s request`}
                      claim={claims[claimKey('REQUEST', r.id)]}
                      desks={desks}
                      meId={meId}
                      onChanged={onChanged}
                      compact
                    />
                  </span>
                </div>
                <div className="mt-1 text-sm text-white">{r.subject}</div>
                <p className="mt-0.5 text-xs text-silver/70">{r.body}</p>
                <p className="mt-1 text-2xs tabular-nums text-silver/50">
                  {r.associateName && <>about {r.associateName} · </>}
                  {fmtDate(r.createdAt)}
                  {r.dueAt && !r.overdue && ` · due ${fmtDate(r.dueAt)}`}
                </p>
                {canWork && (
                  <div className="mt-2">
                    {resolving === r.id ? (
                      <div className="space-y-2">
                        <Textarea
                          value={reply}
                          onChange={(e) => setReply(e.target.value)}
                          placeholder="The reply the client will read in their portal…"
                          aria-label="Reply to the client"
                          rows={2}
                          maxLength={2000}
                        />
                        <div className="flex gap-2">
                          <Button size="xs" loading={busy} disabled={!reply.trim()} onClick={() => void patch(r.id, { status: 'RESOLVED', resolution: reply.trim() })}>
                            Send &amp; resolve
                          </Button>
                          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setResolving(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        {r.status === 'RECEIVED' && (
                          <Button size="xs" variant="secondary" disabled={busy} onClick={() => void patch(r.id, { status: 'IN_PROGRESS' })}>
                            Start
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            setResolving(r.id);
                            setReply('');
                          }}
                        >
                          Resolve
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

/** "New wave" — name, headcount, landing date. */
function NewCohortButton({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [landBy, setLandBy] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length >= 3 && Number(target) >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(landBy);

  const create = async () => {
    setBusy(true);
    try {
      await apiFetch('/cohorts', { method: 'POST', body: { name: name.trim(), targetHeadcount: Number(target), landByDate: landBy } });
      setOpen(false);
      setName('');
      setTarget('');
      setLandBy('');
      onCreated();
      toast.success('Wave created — put lanes in it from each lane.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the wave.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        New wave
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New wave</DialogTitle>
            <DialogDescription>A hiring push with a headcount and a landing date — its lanes group under one banner with a readiness bar.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='Name — e.g. "Peak season — Walmart DC"' aria-label="Wave name" maxLength={120} />
            <Input type="number" min={1} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target headcount" aria-label="Target headcount" />
            <Input type="date" value={landBy} onChange={(e) => setLandBy(e.target.value)} aria-label="Land by date" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void create()} loading={busy} disabled={!valid}>
              Create wave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function WavesSection({ cohorts, canManage, onChanged }: { cohorts: CohortSummary[]; canManage: boolean; onChanged: () => void }) {
  if (cohorts.length === 0 && !canManage) return null;
  return (
    <section aria-labelledby="relay-waves">
      <SectionHead icon={Target} title="Waves" meta={cohorts.length ? `${cohorts.length} racing a date` : undefined} id="relay-waves">
        {canManage && <NewCohortButton onCreated={onChanged} />}
      </SectionHead>
      {cohorts.length === 0 ? (
        <p className="text-xs text-silver/60">No waves yet. A wave groups a hiring push — “40 heads by Nov 1” — so every desk staffs it against the same clock.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cohorts.map((c) => {
            const pct = Math.min(100, Math.round((c.completed / Math.max(1, c.targetHeadcount)) * 100));
            const hot = c.stalled > 0 || (c.daysLeft <= 7 && c.completed < c.targetHeadcount);
            return (
              <Card key={c.id} className={cn('border-l-2', hot ? 'border-l-alert' : 'border-l-gold/40')}>
                <CardContent className="p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-white">
                      {c.name}
                      {c.clientName && <span className="font-normal text-silver/60"> · {c.clientName}</span>}
                    </span>
                    <span className={cn('shrink-0 text-xs tabular-nums', c.daysLeft <= 7 ? 'text-alert' : 'text-silver/60')}>
                      {c.daysLeft >= 0 ? `${c.daysLeft}d to landing` : `${-c.daysLeft}d past landing`}
                    </span>
                  </div>
                  <div className="mt-2 flex items-baseline gap-2 text-sm tabular-nums">
                    <span className="font-display text-2xl leading-none text-gold-bright">{c.completed}</span>
                    <span className="text-silver/60">/ {c.targetHeadcount} ready</span>
                    <span className="text-silver/40">
                      · {c.inFlight} in flight
                      {c.stalled > 0 && <span className="text-alert"> · {c.stalled} stalled</span>}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-navy-secondary/50">
                    <div className={cn('h-full rounded-full', hot ? 'bg-alert/80' : 'bg-gold/70')} style={{ width: `${Math.max(3, pct)}%` }} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
