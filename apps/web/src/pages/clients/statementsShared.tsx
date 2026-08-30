import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

/**
 * Bits shared between the per-client StatementsSection (ClientDetail) and
 * the all-clients weekly-close roll-up page (/clients/statements).
 */

// Fetch-then-save instead of a bare <a download>: an auth failure or 500
// on a raw link dumps the user on a JSON error page with no way back.
export async function downloadStatementFile(
  url: string,
  fallbackName: string,
): Promise<void> {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const m = /filename="([^"]+)"/.exec(cd);
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = m?.[1] ?? fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  } catch {
    toast.error('Download failed — try again.');
  }
}

/**
 * Replaces the old `window.prompt` for recording a client payment: a real
 * dialog with a labelled reference input, so the reference lands in the
 * receivables record (and the audit packet) instead of being fat-fingered
 * into a browser prompt.
 */
export function MarkPaidDialog({
  open,
  onOpenChange,
  statementLabel,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "Acme Stores — Mar 1, 2026 – Mar 31, 2026" */
  statementLabel: string;
  busy: boolean;
  onConfirm: (paymentRef: string | undefined) => void | Promise<void>;
}) {
  const [paymentRef, setPaymentRef] = useState('');

  // Clear the field whenever the dialog opens so one statement's check
  // number never leaks onto the next.
  useEffect(() => {
    if (open) setPaymentRef('');
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = paymentRef.trim();
    await onConfirm(trimmed || undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            {statementLabel} — marks the statement paid and moves it out of
            receivables. This cannot be undone from the UI.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field
            label="Payment reference (optional)"
            hint="Check or ACH number — shown on the External Payment Record in the audit packet."
          >
            {(p) => (
              <Input
                autoFocus
                value={paymentRef}
                onChange={(e) => setPaymentRef(e.target.value)}
                maxLength={120}
                placeholder="e.g. ACH 8841027 or check #1042"
                {...p}
              />
            )}
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={busy}>
              Record payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
