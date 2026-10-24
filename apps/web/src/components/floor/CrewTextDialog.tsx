import { useState } from 'react';
import { MessageSquareText } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { textCrew, type CrewTextResult } from '@/lib/floorApi';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import '@/lib/i18n/en/crewText';

/**
 * One text to everyone on a shift — the supervisor's own crew, from the
 * face wall. Each text is kept in the communications log like any other.
 */
export function CrewTextDialog({
  open,
  onOpenChange,
  shiftIds,
  label,
  count,
  send: sendOverride,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shiftIds: string[];
  /** "Morning · 6:00 AM – 2:00 PM" */
  label: string;
  count: number;
  /** Send it some other way (e.g. one text per client); defaults to one /floor/crew-text call. */
  send?: (body: string) => Promise<CrewTextResult>;
}) {
  const { t } = useI18n();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const r = sendOverride ? await sendOverride(body.trim()) : await textCrew({ shiftIds, body: body.trim() });
      // Honest outcome: a text with no provider behind it was never sent.
      if (r.notConfigured) {
        toast.error(t('crewText.notSent', { reason: r.notConfigured }));
        return;
      }
      const notes: string[] = [];
      if (r.noPhone.length) notes.push(t('crewText.noPhone', { names: r.noPhone.join(', ') }));
      if (r.optedOut > 0) notes.push(t('crewText.optedOut', { n: r.optedOut }));
      if (r.failed > 0) notes.push(t('crewText.failed', { n: r.failed }));
      const summary = `${t('crewText.sentTo', { n: r.sent })}${notes.length ? ` ${notes.join(' ')}` : ''}`;
      if (r.sent === 0 && (r.failed > 0 || r.optedOut > 0)) toast.error(summary);
      else toast.success(summary);
      setBody('');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('crewText.sendFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)} confirmDiscard={() => body.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareText className="h-5 w-5 text-gold" aria-hidden="true" />
            {t('crewText.title')}
          </DialogTitle>
          <DialogDescription>
            {count === 1 ? t('crewText.descOne', { label }) : t('crewText.descMany', { label, n: count })}
          </DialogDescription>
        </DialogHeader>
        <Field label={t('crewText.message')} required>
          {(p) => <Textarea {...p} value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={600} placeholder={t('crewText.placeholder')} autoFocus />}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('crewText.cancel')}
          </Button>
          <Button onClick={() => void send()} loading={busy} disabled={busy || !body.trim()}>
            {t('crewText.sendTo', { n: count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
