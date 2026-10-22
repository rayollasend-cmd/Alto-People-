import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Coffee, FileSignature } from 'lucide-react';
import { useTerm } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, parseYmd } from '@/lib/format';
import { fmtPunchDateTime } from './punchFormat';
import { acknowledgeBreakFlag, decideCorrection, listBreakFlags, listCorrections, type BreakFlag, type CorrectionKind, type CorrectionRequest, type CorrectionStatus } from '@/lib/laborLiveApi';
import { AssociateLink } from '@/components/ui/AssociateLink';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  SegmentedControl,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Punch corrections workers asked for (each with their signed attestation),
 * decided here: approve applies the times under your name with the before
 * and after kept; deny needs a reason the worker sees. Beside it, the missed
 * breaks workers reported at clock-out where the labor rules aren't paid live.
 */

export const KIND_LABEL: Record<CorrectionKind, string> = {
  MISSED_CLOCK_IN: 'Missed clock-in',
  MISSED_CLOCK_OUT: 'Missed clock-out',
  WRONG_TIME: 'Wrong time',
  NEW_ENTRY: 'Shift not punched',
};

const STATUS_LABEL: Record<CorrectionStatus, string> = {
  PROMPTED: 'Waiting on the worker',
  SUBMITTED: 'Waiting on you',
  APPROVED: 'Approved',
  DENIED: 'Not approved',
  WITHDRAWN: 'Withdrawn',
};

/** A punch on its site's clock (one punch, one time). */
const t = (iso: string | null | undefined, tz?: string | null) => (iso ? fmtPunchDateTime(iso, tz) : '—');

function TimesRow({ label, before, after, tz }: { label: string; before: string | null | undefined; after: string | null | undefined; tz?: string | null }) {
  const changed = !!after && after !== before;
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink">
        {changed ? (
          <>
            <span className="text-ink-muted line-through">{t(before, tz)}</span> <span aria-hidden="true">→</span> <span className="font-medium">{t(after, tz)}</span>
            <span className="sr-only">changed from {t(before, tz)} to {t(after, tz)}</span>
          </>
        ) : (
          t(before ?? after, tz)
        )}
      </dd>
    </div>
  );
}

function CorrectionCard({ r, onDeny }: { r: CorrectionRequest; onDeny: (r: CorrectionRequest) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const approve = useMutation({
    mutationFn: () => decideCorrection(r.id, 'APPROVE'),
    onSuccess: () => {
      // The card leaves the Waiting list: the toast keeps the way to the
      // entry it changed, so checking the punch is one tap, not a search.
      toast.success(`Approved. ${r.name}’s time now shows the corrected punch.`, {
        action: r.timeEntryId ? { label: 'View entry', onClick: () => navigate(`/time-attendance?entry=${r.timeEntryId}`) } : undefined,
      });
      void qc.invalidateQueries({ queryKey: ['time-corrections'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not approve it.'),
  });
  const waiting = r.status === 'SUBMITTED';
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <AssociateLink associateId={r.associateId} className="font-medium text-ink">
            {r.name}
          </AssociateLink>
          <Badge size="sm" variant="outline">
            {KIND_LABEL[r.kind]}
          </Badge>
          {!waiting && (
            <Badge size="sm" variant={r.status === 'APPROVED' ? 'success' : 'outline'}>
              {STATUS_LABEL[r.status]}
            </Badge>
          )}
          <span className="text-xs text-ink-muted">
            {r.workDate ? fmtDate(parseYmd(r.workDate)) : ''}
            {r.siteName ? ` · ${r.siteName}` : ''}
          </span>
        </div>
        <dl className="space-y-1">
          <TimesRow label="Clock-in" before={r.before?.clockInAt ?? null} after={r.proposedClockIn} tz={r.timezone} />
          <TimesRow label="Clock-out" before={r.before?.clockOutAt ?? null} after={r.proposedClockOut} tz={r.timezone} />
        </dl>
        {r.reason && <p className="text-sm text-ink">“{r.reason}”</p>}
        {r.attestationText && (
          <p className="flex items-start gap-2 text-xs text-ink-muted">
            <FileSignature className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              Signed {r.attestedAt ? fmtDateTime(r.attestedAt) : ''}: “{r.attestationText}”
            </span>
          </p>
        )}
        {r.decisionReason && <p className="text-xs text-ink-muted">{r.decidedBy ? `${r.decidedBy}: ` : ''}{r.decisionReason}</p>}
        {waiting && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => approve.mutate()} loading={approve.isPending}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDeny(r)}>
              Don’t approve
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function TimeCorrectionsDesk() {
  const term = useTerm();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'SUBMITTED' | 'APPROVED' | 'DENIED'>('SUBMITTED');
  const q = useQuery({ queryKey: ['time-corrections', status], queryFn: () => listCorrections(status) });
  const [denying, setDenying] = useState<CorrectionRequest | null>(null);
  const [reason, setReason] = useState('');
  const deny = useMutation({
    mutationFn: () => decideCorrection(denying!.id, 'DENY', reason.trim()),
    onSuccess: () => {
      toast.success('Sent back with your reason.');
      setDenying(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['time-corrections'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send it back.'),
  });
  // Monday morning is a stack of signed, clean corrections: approve the
  // whole waiting list in one go instead of one card at a time.
  const waiting = status === 'SUBMITTED' ? (q.data?.requests ?? []) : [];
  const approveAll = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(waiting.map((r) => decideCorrection(r.id, 'APPROVE')));
      return results.filter((x) => x.status === 'rejected').length;
    },
    onSuccess: (failed) => {
      if (failed === 0) toast.success(`Approved all ${waiting.length}.`);
      else toast.warning(`Approved ${waiting.length - failed}; ${failed} could not be approved.`);
      void qc.invalidateQueries({ queryKey: ['time-corrections'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not approve them.'),
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">Each request carries the {term('worker').toLowerCase()}’s signed attestation. Approving changes their time record under your name.</p>
        {waiting.length > 1 && (
          <Button size="sm" variant="secondary" onClick={() => approveAll.mutate()} loading={approveAll.isPending}>
            Approve all {waiting.length}
          </Button>
        )}
        <SegmentedControl<'SUBMITTED' | 'APPROVED' | 'DENIED'>
          ariaLabel="Which requests"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'SUBMITTED', label: 'Waiting' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'DENIED', label: 'Not approved' },
          ]}
        />
      </div>
      {q.isError ? (
        <QueryError what="punch corrections" query={q} />
      ) : !q.data ? (
        <SkeletonRows count={3} />
      ) : q.data.requests.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={FileSignature}
              title={status === 'SUBMITTED' ? 'No corrections waiting' : status === 'APPROVED' ? 'Nothing approved yet' : 'Nothing sent back'}
              description={status === 'SUBMITTED' ? "When someone asks to fix a missed or wrong punch from their phone, it shows here." : undefined}
            />
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3" aria-label="Punch corrections">
          {q.data.requests.map((r) => (
            <li key={r.id}>
              <CorrectionCard r={r} onDeny={setDenying} />
            </li>
          ))}
        </ul>
      )}
      {q.data?.truncated && <p className="text-xs text-ink-muted">Showing the first 200.</p>}
      <Dialog open={!!denying} onOpenChange={(o) => !o && setDenying(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Don’t approve {denying?.name}’s correction?</DialogTitle>
            <DialogDescription>They’ll see your reason, so say what they should do next.</DialogDescription>
          </DialogHeader>
          <Field label="Why" required>
            {(p) => <Textarea {...p} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The camera shows you left at 5:10 — send a new request with that time." />}
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDenying(null)}>
              Cancel
            </Button>
            <Button onClick={() => deny.mutate()} disabled={reason.trim().length < 3} loading={deny.isPending}>
              Send it back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function BreakFlagsDesk() {
  const qc = useQueryClient();
  const term = useTerm();
  const q = useQuery({ queryKey: ['time-corrections', 'break-flags'], queryFn: listBreakFlags });
  const ack = useMutation({
    mutationFn: (id: string) => acknowledgeBreakFlag(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['time-corrections', 'break-flags'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not mark it handled.'),
  });
  if (q.isError) return <QueryError what="missed breaks" query={q} />;
  if (!q.data) return <SkeletonRows count={3} />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        {term('workers')} who said at clock-out they didn’t get a break. Where a state pays by its labor rules, the premium is paid automatically; here, put it right and mark it handled.
      </p>
      {q.data.flags.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={Coffee} title="No missed breaks reported" description="Answers come from the clock-out question in states that require meal or rest breaks." />
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2" aria-label="Missed breaks reported">
          {q.data.flags.map((f: BreakFlag) => (
            <li key={f.id}>
              <Card>
                <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <AssociateLink associateId={f.associateId} className="font-medium text-ink">
                        {f.name}
                      </AssociateLink>
                      {f.meal === 'NO' && <Badge size="sm" variant="pending">No meal break</Badge>}
                      {f.rest === 'NO' && <Badge size="sm" variant="pending">Missed a rest break</Badge>}
                    </div>
                    <p className="text-xs text-ink-muted">
                      Shift {t(f.clockInAt, f.timezone)} – {f.clockOutAt ? t(f.clockOutAt, f.timezone) : 'still open'}
                      {f.siteName ? ` · ${f.siteName}` : ''}
                    </p>
                    {f.note && <p className="text-sm text-ink">“{f.note}”</p>}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => ack.mutate(f.id)} loading={ack.isPending && ack.variables === f.id}>
                    Mark handled
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
