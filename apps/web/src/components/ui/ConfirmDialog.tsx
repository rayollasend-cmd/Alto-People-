import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './Dialog';
import { Button } from './Button';
import { Textarea } from './Input';

/**
 * One-shot replacement for `window.confirm` and the simpler shape of
 * `window.prompt`. Handles two common flavors:
 *   - Plain confirmation:  pass `confirmLabel`, `onConfirm`.
 *   - Reason capture:      pass `requireReason: true`, `onConfirm(reason)`.
 *
 * The destructive flag swaps the primary button to the alert color so users
 * never lose context that the action removes/cancels something.
 */

interface BaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
}

interface ConfirmProps extends BaseProps {
  requireReason?: false;
  onConfirm: () => void | Promise<void>;
}

interface ReasonProps extends BaseProps {
  requireReason: true;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  reasonMaxLength?: number;
  onConfirm: (reason: string) => void | Promise<void>;
}

export type ConfirmDialogProps = ConfirmProps | ReasonProps;

export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    open,
    onOpenChange,
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
    busy = false,
  } = props;

  const isReason = props.requireReason === true;
  const [reason, setReason] = React.useState('');

  // Clear the field whenever the dialog opens so old text doesn't leak.
  React.useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (isReason) {
      const trimmed = reason.trim();
      if (!trimmed) return;
      await props.onConfirm(trimmed);
    } else {
      await props.onConfirm();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          {isReason && (
            <div className="grid gap-1">
              <label className="text-[11px] uppercase tracking-wider text-silver">
                {props.reasonLabel ?? 'Reason'}
              </label>
              <Textarea
                autoFocus
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={props.reasonPlaceholder}
                maxLength={props.reasonMaxLength ?? 500}
                rows={4}
              />
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'primary'}
              loading={busy}
              disabled={busy || (isReason && !reason.trim())}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
