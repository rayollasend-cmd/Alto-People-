import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Scale } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { getRotation, offerShift, recordOfferAnswer, type RotationCandidate } from '@/lib/laborLiveApi';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, SkeletonRows, Textarea } from '@/components/ui';

/**
 * Inside the assign dialog for an open shift: who would go into overtime by
 * taking it, in the order the rotation asks them (fewest overtime first,
 * after everyone who wouldn't go over), with an Offer button and each
 * offer's answer. Out of turn needs a reason, which the record keeps.
 */

const OFFER_LABEL: Record<NonNullable<RotationCandidate['offer']>['status'], string> = {
  OFFERED: 'Offered — waiting',
  ACCEPTED: 'Took it',
  DECLINED: 'Passed',
  EXPIRED: 'Offer closed',
  SKIPPED: 'Skipped',
};

export function OvertimeRotationPanel({ shiftId }: { shiftId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['overtime-offers', 'shift', shiftId], queryFn: () => getRotation(shiftId), enabled: open });
  const [outOfTurn, setOutOfTurn] = useState<{ candidate: RotationCandidate; ahead: string[] } | null>(null);
  const [reason, setReason] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['overtime-offers', 'shift', shiftId] });
  const offer = useMutation({
    mutationFn: ({ c, why }: { c: RotationCandidate; why?: string }) => offerShift(shiftId, c.associateId, why ?? null),
    onSuccess: (_r, v) => {
      toast.success(`Offered to ${v.c.name}. They’ll see it in their app.`);
      setOutOfTurn(null);
      setReason('');
      refresh();
    },
    onError: (err, v) => {
      if (err instanceof ApiError && err.code === 'out_of_turn') {
        const ahead = ((err.details as { ahead?: Array<{ name: string }> } | undefined)?.ahead ?? []).map((a) => a.name);
        setOutOfTurn({ candidate: v.c, ahead });
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'Could not send the offer.');
    },
  });
  const answer = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACCEPTED' | 'DECLINED' }) => recordOfferAnswer(id, status),
    onSuccess: (_r, v) => {
      toast.success(v.status === 'ACCEPTED' ? 'Assigned.' : 'Recorded as passed.');
      refresh();
      void qc.invalidateQueries({ queryKey: ['scheduling'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the answer.'),
  });

  const over = (q.data?.candidates ?? []).filter((c) => c.wouldAddOvertimeHours > 0);
  const underCount = (q.data?.candidates ?? []).length - over.length;

  return (
    <section className="rounded-md border border-line" aria-label="Overtime, in turn">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-ink coarse:min-h-11"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-ink-muted" aria-hidden="true" />
          Who gets overtime first?
        </span>
        {open ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-3">
          {q.isError ? (
            <p className="text-sm text-ink-muted">Couldn’t load the rotation. Close and try again.</p>
          ) : !q.data ? (
            <SkeletonRows count={2} />
          ) : (
            <>
              <p className="text-xs text-ink-muted">
                {underCount > 0 ? `${underCount} ${underCount === 1 ? 'person' : 'people'} can take it without overtime — assign one of them above. ` : ''}
                {over.length === 0 ? 'Nobody here would go into overtime.' : 'Taking it would put these people into overtime, asked in this order:'}
                {q.data.enabled ? '' : ' (the rotation is advisory — turn it on in Labor rules › Timekeeping)'}
              </p>
              {over.length > 0 && (
                <ol className="space-y-1.5">
                  {over.map((c) => (
                    <li key={c.associateId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="min-w-0">
                        <span className="text-ink">{c.name}</span>{' '}
                        <span className="text-xs text-ink-muted">
                          +{c.wouldAddOvertimeHours} h overtime · {c.recentOvertimeHours} h in the last 4 weeks
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        {c.offer && <Badge size="sm" variant={c.offer.status === 'ACCEPTED' ? 'success' : c.offer.status === 'OFFERED' ? 'pending' : 'outline'}>{OFFER_LABEL[c.offer.status]}</Badge>}
                        {c.offer?.status === 'OFFERED' ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => answer.mutate({ id: c.offer!.id, status: 'ACCEPTED' })} disabled={answer.isPending}>
                              They took it
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => answer.mutate({ id: c.offer!.id, status: 'DECLINED' })} disabled={answer.isPending}>
                              They passed
                            </Button>
                          </>
                        ) : !c.offer || c.offer.status === 'DECLINED' || c.offer.status === 'EXPIRED' || c.offer.status === 'SKIPPED' ? (
                          <Button size="sm" variant="outline" onClick={() => offer.mutate({ c })} loading={offer.isPending && offer.variables?.c.associateId === c.associateId} disabled={!q.data.open}>
                            Offer
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
      <Dialog open={!!outOfTurn} onOpenChange={(o) => !o && setOutOfTurn(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Offer {outOfTurn?.candidate.name} out of turn?</DialogTitle>
            <DialogDescription>
              {outOfTurn && outOfTurn.ahead.length > 0 ? `${outOfTurn.ahead.slice(0, 3).join(', ')}${outOfTurn.ahead.length > 3 ? ` and ${outOfTurn.ahead.length - 3} more` : ''} come first.` : 'Others come first.'} They’ll be recorded as skipped, with your reason.
            </DialogDescription>
          </DialogHeader>
          <Field label="Why skip them" required>
            {(p) => <Textarea {...p} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Only Bea holds the forklift certificate this shift needs." />}
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOutOfTurn(null)}>
              Cancel
            </Button>
            <Button onClick={() => outOfTurn && offer.mutate({ c: outOfTurn.candidate, why: reason.trim() })} disabled={reason.trim().length < 3} loading={offer.isPending}>
              Offer with this reason
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
