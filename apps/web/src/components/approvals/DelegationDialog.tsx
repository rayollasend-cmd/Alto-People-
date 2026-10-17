import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { useRoleLabel } from '@/lib/auth';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
import { createDelegation, endDelegation, listMyDelegations } from '@/lib/approvalRequestsApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { Role } from '@alto-people/shared';

/**
 * "Decide my approvals while I'm out": name who covers you and for which
 * days. The cover may decide anything you could; you keep your own right
 * throughout. Current and upcoming cover is listed and can be ended early.
 */

interface Candidate {
  id: string;
  name: string;
  email: string;
  role: Role | null;
}

export const DELEGATIONS_KEY = ['approvals', 'delegations'] as const;

export function DelegationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const roleLabel = useRoleLabel();
  const [toUserId, setToUserId] = useState('');
  const [startsOn, setStartsOn] = useState(ymdLocal());
  const [endsOn, setEndsOn] = useState(ymdLocal());
  const [note, setNote] = useState('');

  const candidates = useQuery({
    queryKey: ['approvals', 'delegation-candidates'],
    queryFn: () => apiFetch<{ candidates: Candidate[] }>('/approvals/delegations/candidates'),
    enabled: open,
  });
  const mine = useQuery({ queryKey: DELEGATIONS_KEY, queryFn: listMyDelegations, enabled: open });

  const give = useMutation({
    mutationFn: () => createDelegation({ toUserId, startsOn, endsOn, note: note.trim() || null }),
    onSuccess: async () => {
      toast.success('Cover set. They can decide your approvals for those days.');
      setToUserId('');
      setNote('');
      await qc.invalidateQueries({ queryKey: DELEGATIONS_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not set the cover.'),
  });
  const end = useMutation({
    mutationFn: (id: string) => endDelegation(id),
    onSuccess: async () => {
      toast.success('Cover ended.');
      await qc.invalidateQueries({ queryKey: DELEGATIONS_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not end the cover.'),
  });

  const valid = toUserId !== '' && startsOn <= endsOn;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cover my approvals</DialogTitle>
          <DialogDescription>While you are out, the person you name decides what you would have decided. You keep your own right throughout.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) give.mutate();
          }}
        >
          <Field label="Who covers you" required>
            {(p) => (
              <Select {...p} value={toUserId} onChange={(e) => setToUserId(e.target.value)} disabled={candidates.isPending}>
                <option value="">{candidates.isPending ? 'Loading…' : 'Choose a person'}</option>
                {(candidates.data?.candidates ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.role ? ` · ${roleLabel(c.role)}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From" required>
              {(p) => <Input {...p} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />}
            </Field>
            <Field label="To" required error={startsOn > endsOn ? 'Ends before it starts.' : undefined}>
              {(p) => <Input {...p} type="date" value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} />}
            </Field>
          </div>
          <Field label="Note" hint="Optional — shown to the person covering you.">
            {(p) => <Input {...p} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Out until Friday" />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="submit" disabled={!valid} loading={give.isPending}>
              Set cover
            </Button>
          </DialogFooter>
        </form>
        {mine.data && (mine.data.given.length > 0 || mine.data.covering.length > 0) && (
          <div className="space-y-3 border-t border-line pt-4">
            {mine.data.given.length > 0 && (
              <section className="space-y-1.5" aria-label="Cover you have given">
                <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">Cover you gave</div>
                <ul className="space-y-1 text-sm">
                  {mine.data.given.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2">
                      <span>
                        <span className="font-medium text-ink">{d.to.name}</span>
                        <span className="text-ink-muted">
                          {' '}
                          · {fmtDate(parseYmd(d.startsOn))} – {fmtDate(parseYmd(d.endsOn))}
                          {d.note ? ` · ${d.note}` : ''}
                        </span>
                      </span>
                      <Button size="xs" variant="ghost" onClick={() => end.mutate(d.id)} disabled={end.isPending}>
                        End
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {mine.data.covering.length > 0 && (
              <section className="space-y-1.5" aria-label="People you cover">
                <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">You cover</div>
                <ul className="space-y-1 text-sm">
                  {mine.data.covering.map((d) => (
                    <li key={d.id}>
                      <span className="font-medium text-ink">{d.from.name}</span>
                      <span className="text-ink-muted">
                        {' '}
                        · {fmtDate(parseYmd(d.startsOn))} – {fmtDate(parseYmd(d.endsOn))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
