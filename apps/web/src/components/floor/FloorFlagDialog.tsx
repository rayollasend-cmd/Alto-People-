import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Flag } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { raiseFloorFlag, type FloorFlagKind } from '@/lib/floorApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { cn } from '@/lib/cn';
import { useI18n, type MessageKey } from '@/lib/i18n';
import '@/lib/i18n/en/floorUi';

/**
 * Two taps from the floor: the watch-only lead saw a no-show or a hazard
 * and their shift supervisor should know now. The flag reaches the
 * supervisor's bell and their home; a hazard reaches HR too. No decision
 * is made here — that stays with the person who decides.
 */

const KINDS: Array<{ value: FloorFlagKind; label: MessageKey }> = [
  { value: 'NO_SHOW', label: 'floorUi.kindNoShow' },
  { value: 'HAZARD', label: 'floorUi.kindHazard' },
  { value: 'OTHER', label: 'floorUi.kindSomethingElse' },
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
  const { t } = useI18n();
  const qc = useQueryClient();
  const [kind, setKind] = useState<FloorFlagKind>(presetKind);
  const [who, setWho] = useState<PickedAssociate | null>(presetAssociate);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const body = note.trim() || (kind === 'NO_SHOW' && who ? `${who.name} has not shown up.` : '');
    if (!body) {
      toast.error(t('floorUi.flagNeedWords'));
      return;
    }
    setBusy(true);
    try {
      await raiseFloorFlag({ kind, note: body, associateId: kind === 'HAZARD' ? null : who?.id ?? null, shiftId });
      toast.success(t('floorUi.flagged'));
      void qc.invalidateQueries({ queryKey: ['floor', 'flags'] });
      setNote('');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('floorUi.flagFailed'));
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
            {t('floorUi.flagIt')}
          </DialogTitle>
          <DialogDescription>{t('floorUi.flagDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('floorUi.whatYouSaw')}>
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={kind === k.value}
                onClick={() => setKind(k.value)}
                className={cn('rounded-md border px-2 py-2.5 text-sm coarse:min-h-11', kind === k.value ? 'border-gold bg-gold/[0.08] text-ink' : 'border-navy-secondary text-silver')}
              >
                {t(k.label)}
              </button>
            ))}
          </div>
          {kind !== 'HAZARD' && (
            <Field label={t('floorUi.who')}>{(p) => <AssociatePicker id={p.id} value={who} onChange={setWho} placeholder={t('floorUi.searchTheCrew')} />}</Field>
          )}
          <Field label={t('floorUi.whatYouSaw')} required={kind !== 'NO_SHOW'}>
            {(p) => (
              <Textarea
                {...p}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder={kind === 'HAZARD' ? t('floorUi.flagPhHazard') : kind === 'NO_SHOW' ? t('floorUi.flagPhNoShow') : t('floorUi.flagPhOther')}
                autoFocus
              />
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={busy}>
            {t('floorUi.sendToMySupervisor')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
