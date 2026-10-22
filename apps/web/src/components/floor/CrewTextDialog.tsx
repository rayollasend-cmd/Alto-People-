import { useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { textCrew, type CrewTextResult } from '@/lib/floorApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';

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
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const r = sendOverride ? await sendOverride(body.trim()) : await textCrew({ shiftIds, body: body.trim() });
      // Honest outcome: a text with no provider behind it was never sent.
      if (r.notConfigured) {
        toast.error(`Nothing was sent — ${r.notConfigured}`);
        return;
      }
      const notes: string[] = [];
      if (r.noPhone.length) notes.push(`No phone on file: ${r.noPhone.join(', ')}.`);
      if (r.optedOut > 0) notes.push(`${r.optedOut} opted out of texts.`);
      if (r.failed > 0) notes.push(`${r.failed} could not be delivered — see the communications log.`);
      const summary = `Sent to ${r.sent}.${notes.length ? ` ${notes.join(' ')}` : ''}`;
      if (r.sent === 0 && (r.failed > 0 || r.optedOut > 0)) toast.error(summary);
      else toast.success(summary);
      setBody('');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the text.');
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
            Text the crew
          </DialogTitle>
          <DialogDescription>
            {label} · {count} {count === 1 ? 'person' : 'people'}. One SMS each, kept in the log.
          </DialogDescription>
        </DialogHeader>
        <Field label="Message" required>
          {(p) => <Textarea {...p} value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={600} placeholder="Dock 2 opens at 5:45 today — come in the side door." autoFocus />}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void send()} loading={busy} disabled={busy || !body.trim()}>
            Send to {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
