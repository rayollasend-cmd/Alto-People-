import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { CALL_OUT_REASONS, callOutMine, type CallOutReason } from '@/lib/callOutsApi';
import { fmtRelativeDayTz, fmtShiftRangeTz } from '@/lib/format';
import { hapticConfirm } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
} from '@/components/ui';
import { Textarea } from '@/components/ui/Input';

/**
 * "Can't make it?" — a worker calls out of their own shift. One reason,
 * an optional note, one tap; the server records it, applies the attendance
 * policy, starts cover and tells the lead (lib/callOuts). Calm on purpose:
 * no warnings about points, just what happens next.
 */

export interface CallOutShift {
  id: string;
  position: string;
  startsAt: string;
  endsAt: string;
  timezone?: string | null;
}

const LATE_MS = 2 * 3_600_000;

export function CallOutDialog({ shift, open, onOpenChange }: { shift: CallOutShift | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<CallOutReason | null>(null);
  const [note, setNote] = useState('');

  const send = useMutation({
    mutationFn: () => callOutMine({ shiftId: shift!.id, reason: reason!, note: note.trim() || undefined }),
    onSuccess: (r) => {
      hapticConfirm();
      toast.success(r.message);
      onOpenChange(false);
      setReason(null);
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['me', 'shifts'] });
      void queryClient.invalidateQueries({ queryKey: ['me', 'callOuts'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('callout.failed')),
  });

  if (!shift) return null;
  const when = `${fmtRelativeDayTz(shift.startsAt, shift.timezone ?? null, Date.now())} · ${fmtShiftRangeTz(shift.startsAt, shift.endsAt, shift.timezone ?? null)}`;
  const late = new Date(shift.startsAt).getTime() - Date.now() < LATE_MS;

  return (
    <Dialog open={open} onOpenChange={(o) => !send.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('callout.title')}</DialogTitle>
          <DialogDescription>{t('callout.body', { shift: `${shift.position}, ${when}` })}</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium text-ink">{t('callout.why')}</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('callout.why')}>
            {CALL_OUT_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={reason === r}
                onClick={() => setReason(r)}
                className={cn(
                  'rounded-full border px-3.5 py-2 text-sm transition-colors coarse:min-h-11',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  reason === r ? 'border-accent bg-accent-fill/15 text-ink' : 'border-line text-ink-muted hover:border-accent/60 hover:text-ink',
                )}
              >
                {t(`callout.reason.${r}` as MessageKey)}
              </button>
            ))}
          </div>
        </fieldset>
        <Field label={t('callout.note')}>
          {(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        {late && <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-ink">{t('callout.late')}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            {t('callout.keep')}
          </Button>
          <Button onClick={() => send.mutate()} disabled={!reason} loading={send.isPending}>
            {t('callout.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
