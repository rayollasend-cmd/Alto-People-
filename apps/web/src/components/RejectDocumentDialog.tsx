import { useEffect, useState } from 'react';
import { XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { rejectDocument } from '@/lib/documentsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
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
import { Textarea } from '@/components/ui/Input';

// Same canned reasons as the document vault's reject dialogs (REJECT_PRESETS
// in AdminDocumentsView — not exported there, keep the strings in sync).
// Clicking one fills the free-text field (still editable).
const REJECT_PRESETS = [
  'Blurry / unreadable',
  'Expired document',
  'Wrong document type',
] as const;

export interface RejectableDocument {
  id: string;
  filename: string;
  kind: string;
}

/**
 * Compact per-document rejection dialog — the vault's reject flow (preset
 * reasons + required free text → POST /documents/admin/:id/reject) made
 * reusable so HR can reject an identity document mid-review without
 * leaving the application drawer. The endpoint keeps all its side effects
 * (task rewind + associate email) regardless of which surface calls it.
 */
export function RejectDocumentDialog({
  doc,
  onClose,
  onRejected,
}: {
  /** Null keeps the dialog closed. */
  doc: RejectableDocument | null;
  onClose: () => void;
  /** Fires after the API accepted the rejection — caller refreshes. */
  onRejected: (docId: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // A dialog opened for a different document starts with a blank reason.
  useEffect(() => {
    setReason('');
  }, [doc?.id]);

  const confirm = async () => {
    if (!doc || !reason.trim() || submitting) return;
    setSubmitting(true);
    try {
      await rejectDocument(doc.id, { reason: reason.trim() });
      toast.success(`Rejected ${doc.filename}.`);
      onRejected(doc.id);
      onClose();
    } catch (err) {
      toast.error('Rejection failed.', {
        description:
          err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!doc} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject document</DialogTitle>
          <DialogDescription>
            Tell the associate why so they can re-upload. They'll see this
            message attached to the rejected document.
          </DialogDescription>
        </DialogHeader>
        {doc && (
          <div className="space-y-3">
            <div className="rounded-md border border-navy-secondary bg-navy-secondary/40 p-2.5 text-xs">
              <div className="font-medium text-white truncate">
                {doc.filename}
              </div>
              <div className="text-silver mt-0.5">
                {doc.kind.replace(/_/g, ' ')}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {REJECT_PRESETS.map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => setReason(r)}
                  className={cn(
                    'rounded-md',
                    reason === r &&
                      'border-gold text-gold bg-gold/10 hover:border-gold hover:text-gold',
                  )}
                >
                  {r}
                </Button>
              ))}
            </div>
            <Field label="Reason" required>
              {(p) => (
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="Pick a preset above or write your own."
                  className="mt-1"
                  autoFocus
                  {...p}
                />
              )}
            </Field>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void confirm()}
            loading={submitting}
            disabled={!reason.trim()}
          >
            <XCircle className="h-4 w-4" />
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
