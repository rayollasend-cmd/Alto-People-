import { toast } from 'sonner';
import { ApiError } from '@/lib/api';

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
        description: err instanceof Error ? err.message : 'Something went wrong.',
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

/**
 * The other kind of undo: the server has already done it, but holds the
 * consequence (an invite email) until `dueAt`. Undo calls the reverse
 * endpoint inside that window, so the email never goes out; closing the
 * tab changes nothing — unlike performWithUndo, the action still stands.
 * The toast stays up exactly as long as the window is open.
 */
export function undoWindowToast(opts: {
  message: string;
  dueAt: string;
  /** Undo it; resolves with what to say when it worked. */
  onUndo: () => Promise<string>;
  description?: string;
}): void {
  const ms = Math.max(3_000, Date.parse(opts.dueAt) - Date.now());
  toast.success(opts.message, {
    description: opts.description,
    duration: ms,
    action: {
      label: 'Undo',
      onClick: () =>
        void opts
          .onUndo()
          .then((done) => toast.success(done))
          .catch((err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not undo it.')),
    },
  });
}

/** Whole seconds from now until `dueAt`. */
export function secondsUntil(dueAt: string): number {
  return Math.max(1, Math.round((Date.parse(dueAt) - Date.now()) / 1000));
}
