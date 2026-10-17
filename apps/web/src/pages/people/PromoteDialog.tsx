import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtMoney, ymdLocal } from '@/lib/format';
import { listJobProfiles } from '@/lib/orgApi';
import { proposePromotion } from '@/lib/approvalRequestsApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/**
 * A promotion as one record: the new seat, the level, the new pay and the
 * date. It goes to a second person; once approved it lands as a comp
 * record, an org assignment with history, and a letter in their documents.
 */
export function PromoteDialog({
  associate,
  currentAmount,
  currentPayType,
  open,
  onOpenChange,
}: {
  associate: { id: string; firstName: string; lastName: string; clientId?: string | null };
  currentAmount: number | null;
  currentPayType: 'HOURLY' | 'SALARY' | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [jobProfileId, setJobProfileId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [level, setLevel] = useState('');
  const [amount, setAmount] = useState('');
  const [payType, setPayType] = useState<'HOURLY' | 'SALARY'>(currentPayType ?? 'HOURLY');
  const [effectiveFrom, setEffectiveFrom] = useState(ymdLocal());
  const [notes, setNotes] = useState('');

  const profiles = useQuery({ queryKey: ['org', 'job-profiles', associate.clientId ?? 'all'], queryFn: () => listJobProfiles(associate.clientId ?? undefined), enabled: open });
  const amountNum = amount.trim() === '' ? null : Number(amount);
  const amountOk = amountNum === null || (Number.isFinite(amountNum) && amountNum > 0);
  const changesSomething = jobProfileId !== '' || newTitle.trim() !== '' || level.trim() !== '' || amountNum !== null;
  const valid = amountOk && changesSomething && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom);

  const propose = useMutation({
    mutationFn: () =>
      proposePromotion({
        associateId: associate.id,
        jobProfileId: jobProfileId || null,
        newTitle: newTitle.trim() || null,
        level: level.trim() || null,
        payType: amountNum !== null ? payType : null,
        amount: amountNum,
        effectiveFrom,
        notes: notes.trim() || null,
      }),
    onSuccess: async () => {
      toast.success('Sent for approval. It lands as pay, seat and letter once a second person approves.');
      await Promise.all([qc.invalidateQueries({ queryKey: ['promotions'] }), qc.invalidateQueries({ queryKey: ['approvals'] })]);
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send the promotion.'),
  });

  const name = `${associate.firstName} ${associate.lastName}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} confirmDiscard={() => changesSomething || notes.trim() !== ''}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote {name}</DialogTitle>
          <DialogDescription>
            The new seat, the level and the pay, from a date. A second person approves it; then the pay record, the org assignment and a letter land together.
            {currentAmount != null && (
              <>
                {' '}
                Today: {fmtMoney(currentAmount)} {currentPayType === 'SALARY' ? 'per year' : 'per hour'}.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) propose.mutate();
          }}
        >
          <Field label="Job profile" hint="The seat they move into. Leave it if only the title, level or pay changes.">
            {(p) => (
              <Select {...p} value={jobProfileId} onChange={(e) => setJobProfileId(e.target.value)} disabled={profiles.isPending}>
                <option value="">{profiles.isPending ? 'Loading…' : 'No change'}</option>
                {(profiles.data?.jobProfiles ?? []).map((jp) => (
                  <option key={jp.id} value={jp.id}>
                    {jp.title}
                    {jp.level ? ` · ${jp.level}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="New title">{(p) => <Input {...p} value={newTitle} maxLength={120} onChange={(e) => setNewTitle(e.target.value)} placeholder="Shift lead" />}</Field>
            <Field label="Level">{(p) => <Input {...p} value={level} maxLength={40} onChange={(e) => setLevel(e.target.value)} placeholder="L2" />}</Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="New pay" error={!amountOk ? 'Enter an amount above zero.' : undefined} className="sm:col-span-2">
              {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="No change" />}
            </Field>
            <Field label="Per">
              {(p) => (
                <Select {...p} value={payType} onChange={(e) => setPayType(e.target.value as 'HOURLY' | 'SALARY')} disabled={amountNum === null}>
                  <option value="HOURLY">Hour</option>
                  <option value="SALARY">Year</option>
                </Select>
              )}
            </Field>
          </div>
          <Field label="Effective from" required>
            {(p) => <Input {...p} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />}
          </Field>
          <Field label="Why" hint="Goes with the request and on the letter's record.">
            {(p) => <Textarea {...p} rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </Field>
          {!changesSomething && <p className="text-xs2 text-ink-muted">A promotion changes the seat, the level or the pay — name at least one.</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid} loading={propose.isPending}>
              Send for approval
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
