import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  CANCEL_REASON_LABEL,
  cancelApplication,
  type CancelInviteReason,
} from '@/lib/onboardingApi';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';

/**
 * Cancel an onboarding invite sent by mistake — the wrong person, the
 * wrong client or store, a duplicate — or for someone not joining after
 * all.
 *
 * It used to take "Reject", which emails the person a decline and left
 * their link working. Cancel is not a decision about them: nothing is
 * emailed, and the link stops working. After a wrong client or a
 * mistake, it offers to send the corrected invite straight away.
 *
 * Opened by `target`, never mounted open.
 */

const REASONS: CancelInviteReason[] = ['SENT_IN_ERROR', 'WRONG_CLIENT', 'WRONG_PERSON', 'DUPLICATE', 'NOT_JOINING', 'OTHER'];
/** Mistakes that usually come with a right version to send. */
const OFFERS_REDO = new Set<CancelInviteReason>(['SENT_IN_ERROR', 'WRONG_CLIENT', 'WRONG_PERSON']);

export interface CancelledInvite {
  mode: 'removed' | 'cancelled';
  associate: { firstName: string; lastName: string; email: string };
}

export type AfterCancel = 'none' | 'corrected' | 'someone_else';

/** The one confirmation every cancel shows, wherever it started. */
export function cancelledToast(r: CancelledInvite): void {
  const name = `${r.associate.firstName} ${r.associate.lastName}`;
  toast.success(
    r.mode === 'removed'
      ? `Invite to ${name} cancelled and removed — their link no longer works.`
      : `Invite to ${name} cancelled — their link no longer works.`,
  );
}

export function CancelInviteDialog({
  target,
  onOpenChange,
  onCancelled,
}: {
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  /** `next`: send nothing more, the same person corrected, or someone else. */
  onCancelled: (result: CancelledInvite, next: AfterCancel) => void;
}) {
  const [reason, setReason] = useState<CancelInviteReason>('SENT_IN_ERROR');
  const [note, setNote] = useState('');
  const [redo, setRedo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; candidateId?: string } | null>(null);

  useEffect(() => {
    if (!target) return;
    setReason('SENT_IN_ERROR');
    setNote('');
    setRedo(true);
    setError(null);
  }, [target]);

  const submit = async () => {
    if (!target) return;
    if (reason === 'OTHER' && !note.trim()) {
      setError({ message: 'Say what happened.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await cancelApplication(target.id, { reason, ...(note.trim() ? { note: note.trim() } : {}) });
      const next: AfterCancel = OFFERS_REDO.has(reason) && redo ? (reason === 'WRONG_PERSON' ? 'someone_else' : 'corrected') : 'none';
      onCancelled(r, next);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        const details = (err.details ?? {}) as { candidateId?: string };
        setError({ message: err.message, candidateId: details.candidateId });
      } else {
        setError({ message: 'Could not cancel the invite.' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !busy && onOpenChange(o)} confirmDiscard={() => note.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel the invite{target ? ` to ${target.name}` : ''}?</DialogTitle>
          <DialogDescription>
            Not a rejection — they won&rsquo;t get a &ldquo;declined&rdquo; email. Their invite link stops working. If they
            never started, their invite is removed entirely.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm text-silver">Why</legend>
          {REASONS.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm text-white">
              <input
                type="radio"
                name="cancel-reason"
                value={r}
                checked={reason === r}
                onChange={() => setReason(r)}
                className="h-4 w-4 accent-gold"
              />
              {CANCEL_REASON_LABEL[r]}
            </label>
          ))}
        </fieldset>
        <Field label={reason === 'OTHER' ? 'What happened' : 'Note (optional)'} required={reason === 'OTHER'}>
          {(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        {OFFERS_REDO.has(reason) && (
          <label className="flex items-center gap-2 text-sm text-silver">
            <input type="checkbox" checked={redo} onChange={(e) => setRedo(e.target.checked)} className="h-4 w-4 accent-gold" />
            {reason === 'WRONG_PERSON' ? 'Invite the right person next' : 'Send a corrected invite next'}
          </label>
        )}
        {error && (
          <ErrorBanner>
            {error.message}
            {error.candidateId && (
              <>
                {' '}
                <Link to={`/recruiting?candidateId=${error.candidateId}`} className="text-gold underline">
                  Open in Recruiting
                </Link>
              </>
            )}
          </ErrorBanner>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep it
          </Button>
          <Button variant="destructive" onClick={() => void submit()} loading={busy} disabled={busy}>
            Cancel invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
