import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';

/**
 * Warn the user before they leave a form with unsaved changes.
 *
 * Covers two distinct exit paths:
 *  - In-app navigation (React Router) via `useBlocker` — shows a confirm
 *    dialog. The data router is required for this to work; the app uses
 *    `createBrowserRouter`, so this is fine.
 *  - Tab close / reload / back-to-OS via the `beforeunload` event — the
 *    browser shows its own generic dialog; the custom message is ignored
 *    in modern browsers, but the prompt fires.
 *
 * Pass `dirty=false` when the form is saved/reset so the warning stops
 * firing. The hook is a no-op when `dirty` is falsy.
 */
export function useUnsavedChanges(dirty: boolean): void {
  // In-app: useBlocker only blocks when the predicate returns true. We
  // gate it on `dirty` so a saved form moves on silently.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    // Synchronous confirm keeps the UX simple — same intent as the
    // browser's beforeunload dialog for the close-tab case.
    const ok = window.confirm(
      'You have unsaved changes. Leave this page and discard them?',
    );
    if (ok) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Modern browsers show their own generic message; the assignment +
      // returnValue dance is the cross-browser idiom to trigger it.
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
