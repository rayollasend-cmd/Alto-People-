import { useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { textCrew } from '@/lib/floorApi';
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shiftIds: string[];
  /** "Morning · 6:00 AM – 2:00 PM" */
  label: string;
  count: number;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const r = await textCrew({ shiftIds, body: body.trim() });
      toast.success(r.noPhone.length ? `Sent to ${r.sent}. No phone on file: ${r.noPhone.join(', ')}.` : `Sent to ${r.sent}.`);
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
