import { useEffect, useRef } from 'react';

/**
 * Whether a form in a dialog has been changed since it opened (PEOPLE-14).
 *
 *   const dirty = useDirtyForm(open, { firstName, lastName, email });
 *   <Dialog open={open} onOpenChange={…} confirmDiscard={dirty}>
 *
 * The values seen just after the dialog opens (once any prefill or
 * remembered picks have settled) are the baseline; typing anything that
 * differs makes it dirty, and Dialog/Drawer's `confirmDiscard` then asks
 * "Discard your changes?" before an Esc, a backdrop click, the X or a
 * swipe throws the typing away. A successful submit closes the dialog
 * programmatically and is never asked about.
 *
 * Values are compared as JSON — pass plain strings, numbers, booleans and
 * small arrays/objects of them.
 */
export function useDirtyForm(open: boolean, values: unknown): () => boolean {
  const baseline = useRef<string | null>(null);
  const current = useRef<string>('');
  const serial = JSON.stringify(values ?? null);
  current.current = serial;
  useEffect(() => {
    baseline.current = null;
    if (!open) return;
    // Opening takes a fresh baseline — a tick later, so defaults the
    // dialog fills in from its own effects (a remembered client, next
    // Monday's start date, a prefill) are the baseline, not "edits".
    const t = setTimeout(() => {
      baseline.current = current.current;
    }, 0);
    return () => clearTimeout(t);
  }, [open]);
  return () => baseline.current !== null && current.current !== baseline.current;
}
