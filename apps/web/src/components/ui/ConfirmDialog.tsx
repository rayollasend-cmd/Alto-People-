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
 * One-shot replacement for `window.confirm` and `window.prompt`. Variants:
 *   - Plain confirmation:                    `requireReason` omitted.
 *   - Required reason capture:               `requireReason: true`.
 *   - Optional reason (empty allowed):       `requireReason: 'optional'`.
 *   - Numeric input (e.g. score, amount):    `numericInput: true` + bounds.
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
  numericInput?: never;
  onConfirm: () => void | Promise<void>;
}

interface ReasonProps extends BaseProps {
  requireReason: true | 'optional';
  numericInput?: never;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  reasonMaxLength?: number;
  onConfirm: (reason: string) => void | Promise<void>;
}

interface NumericProps extends BaseProps {
  requireReason?: never;
  numericInput: true;
  numericLabel?: string;
  numericPlaceholder?: string;
  numericMin?: number;
  numericMax?: number;
  numericStep?: number;
  numericRequired?: boolean;
  onConfirm: (value: number | null) => void | Promise<void>;
}

export type ConfirmDialogProps = ConfirmProps | ReasonProps | NumericProps;

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

  const isReason = props.requireReason === true || props.requireReason === 'optional';
  const reasonOptional = props.requireReason === 'optional';
  const isNumeric = props.numericInput === true;
  const [reason, setReason] = React.useState('');
  const [numeric, setNumeric] = React.useState('');

  // Clear the fields whenever the dialog opens so old text doesn't leak.
  React.useEffect(() => {
    if (open) {
      setReason('');
      setNumeric('');
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (isReason) {
      const trimmed = reason.trim();
      if (!reasonOptional && !trimmed) return;
      await (props as ReasonProps).onConfirm(trimmed);
    } else if (isNumeric) {
      const trimmed = numeric.trim();
      if (!trimmed) {
        if ((props as NumericProps).numericRequired) return;
        await (props as NumericProps).onConfirm(null);
        return;
      }
      const parsed = parseFloat(trimmed);
      if (Number.isNaN(parsed)) return;
      await (props as NumericProps).onConfirm(parsed);
    } else {
      await (props as ConfirmProps).onConfirm();
    }
  };

  const numericProps = isNumeric ? (props as NumericProps) : null;
  const reasonProps = isReason ? (props as ReasonProps) : null;
  const submitDisabled =
    busy ||
    (isReason && !reasonOptional && !reason.trim()) ||
    (isNumeric &&
      numericProps?.numericRequired === true &&
      !numeric.trim());

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
                {reasonProps?.reasonLabel ??
                  (reasonOptional ? 'Notes (optional)' : 'Reason')}
              </label>
              <Textarea
                autoFocus
                required={!reasonOptional}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={reasonProps?.reasonPlaceholder}
                maxLength={reasonProps?.reasonMaxLength ?? 500}
                rows={4}
              />
            </div>
          )}
          {isNumeric && (
            <div className="grid gap-1">
              <label className="text-[11px] uppercase tracking-wider text-silver">
                {numericProps?.numericLabel ?? 'Value'}
              </label>
              <input
                autoFocus
                type="number"
                required={numericProps?.numericRequired === true}
                value={numeric}
                onChange={(e) => setNumeric(e.target.value)}
                placeholder={numericProps?.numericPlaceholder}
                min={numericProps?.numericMin}
                max={numericProps?.numericMax}
                step={numericProps?.numericStep ?? 1}
                className="bg-midnight border border-navy-secondary rounded p-2 text-white"
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
              disabled={submitDisabled}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
