import { toast } from 'sonner';

const UNDO_WINDOW_MS = 5_000;

/**
 * Gmail-style undo: apply the change in the UI immediately, show a toast
 * with an Undo action, and only COMMIT (call the API) once the window
 * closes. Undo cancels the pending commit and lets the caller restore
 * the UI — no reverse API needed, so it works for irreversible endpoints
 * like "withdraw request".
 *
 * The timer lives at module scope, so navigating away doesn't cancel the
 * commit; closing the tab inside the 5s window drops it, which is the
 * accepted trade-off of this pattern (the action the user just watched
 * happen simply didn't stick — the list shows the truth on next load).
 *
 * onCommit failures surface via commitFailedMessage so an optimistic UI
 * that already removed the row doesn't silently diverge from the server.
 */
export function performWithUndo(opts: {
  /** Toast body, e.g. 'Request withdrawn'. */
  message: string;
  /** Called when the undo window closes without an undo. */
  onCommit: () => Promise<unknown>;
  /** Called when the user taps Undo — restore the optimistic UI here. */
  onUndo: () => void;
  /** Shown if onCommit rejects, with the error message as description. */
  commitFailedMessage: string;
  undoLabel?: string;
}): void {
  let undone = false;
  const timer = setTimeout(() => {
    if (undone) return;
    void opts.onCommit().catch((err: unknown) => {
      toast.error(opts.commitFailedMessage, {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }, UNDO_WINDOW_MS);

  toast(opts.message, {
    duration: UNDO_WINDOW_MS,
    action: {
      label: opts.undoLabel ?? 'Undo',
      onClick: () => {
        undone = true;
        clearTimeout(timer);
        opts.onUndo();
      },
    },
  });
}
