import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Flag } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { raiseFloorFlag, type FloorFlagKind } from '@/lib/floorApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { cn } from '@/lib/cn';

/**
 * Two taps from the floor: the watch-only lead saw a no-show or a hazard
 * and their shift supervisor should know now. The flag reaches the
 * supervisor's bell and their home; a hazard reaches HR too. No decision
 * is made here — that stays with the person who decides.
 */

const KINDS: Array<{ value: FloorFlagKind; label: string }> = [
  { value: 'NO_SHOW', label: 'No-show' },
  { value: 'HAZARD', label: 'Hazard' },
  { value: 'OTHER', label: 'Something else' },
];

export function FloorFlagDialog({
  open,
  onOpenChange,
  presetKind = 'NO_SHOW',
  presetAssociate = null,
  shiftId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presetKind?: FloorFlagKind;
  presetAssociate?: PickedAssociate | null;
  shiftId?: string | null;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<FloorFlagKind>(presetKind);
  const [who, setWho] = useState<PickedAssociate | null>(presetAssociate);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const body = note.trim() || (kind === 'NO_SHOW' && who ? `${who.name} has not shown up.` : '');
    if (!body) {
      toast.error('A few words so your supervisor knows what you saw.');
      return;
    }
    setBusy(true);
    try {
      await raiseFloorFlag({ kind, note: body, associateId: kind === 'HAZARD' ? null : who?.id ?? null, shiftId });
      toast.success('Flagged. Your shift supervisor has it.');
      void qc.invalidateQueries({ queryKey: ['floor', 'flags'] });
      setNote('');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not raise the flag.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)} confirmDiscard={() => note.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flag className="h-5 w-5 text-warning" aria-hidden="true" />
            Flag it
          </DialogTitle>
          <DialogDescription>Reaches your shift supervisor right away. You watch the floor; they decide.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="What you saw">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={kind === k.value}
                onClick={() => setKind(k.value)}
                className={cn('rounded-md border px-2 py-2.5 text-sm coarse:min-h-11', kind === k.value ? 'border-gold bg-gold/[0.08] text-ink' : 'border-navy-secondary text-silver')}
              >
                {k.label}
              </button>
            ))}
          </div>
          {kind !== 'HAZARD' && (
            <Field label="Who">{(p) => <AssociatePicker id={p.id} value={who} onChange={setWho} placeholder="Search the crew" />}</Field>
          )}
          <Field label="What you saw" required={kind !== 'NO_SHOW'}>
            {(p) => (
              <Textarea
                {...p}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder={kind === 'HAZARD' ? 'Forklift leaking by bay 2.' : kind === 'NO_SHOW' ? 'Not here 20 minutes in, phone goes to voicemail.' : 'What your supervisor should know.'}
                autoFocus
              />
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={busy}>
            Send to my supervisor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
