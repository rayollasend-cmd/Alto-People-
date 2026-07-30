/**
 * Cross-tab "time entries changed" signal.
 *
 * The approval queue and the Fieldglass timesheet render the same TimeEntry
 * rows from different routes — often in different browser tabs. The timesheet
 * holds plain component state, so without a nudge an open tab keeps showing
 * pre-edit hours until the user navigates. Every mutating call in timeApi
 * announces here after it succeeds; the timesheet subscribes and reloads.
 *
 * BroadcastChannel reaches every tab of the same browser profile. It does NOT
 * reach other users' browsers — the timesheet's refetch-on-focus covers that
 * side. Browsers without BroadcastChannel (very old WebViews) just fall back
 * to focus-refetch behavior.
 */
const CHANNEL_NAME = 'alto:time-entries';

export function announceTimeEntriesChanged(): void {
  try {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    ch.postMessage('changed');
    ch.close();
  } catch {
    // No BroadcastChannel support — focus refetch still keeps views honest.
  }
}

/** Subscribe to change announcements. Returns an unsubscribe function. */
export function onTimeEntriesChanged(handler: () => void): () => void {
  try {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    ch.onmessage = () => handler();
    return () => ch.close();
  } catch {
    return () => {};
  }
}
