import { useEffect, useRef } from 'react';

/**
 * Move keyboard focus to the first `aria-invalid="true"` control inside
 * the form whenever a server / client validation error appears.
 *
 * WCAG 2.1 SC 3.3.1 requires that error messages be identified AND that
 * the user can locate the bad field. Today the app renders a banner at
 * the top of the form and leaves focus on the submit button — sighted
 * users squint upward, keyboard users have to tab back through every
 * field. This hook closes the gap with no per-form rewriting.
 *
 * Usage:
 *   const formRef = useFocusFirstError<HTMLFormElement>(error);
 *   <form ref={formRef} onSubmit={...}>…</form>
 *
 * `error` can be a string, boolean, or anything truthy — the hook just
 * watches it for changes. Pass the page-level error state; if the form
 * uses per-field errors via Field's `error` prop, those flip the
 * aria-invalid attribute that this hook reads.
 *
 * When `error` is null/empty the hook does nothing; when it becomes
 * truthy we wait one tick (so React's commit lands and aria-invalid is
 * on the DOM) and then focus the first invalid control. If no field is
 * marked invalid we focus the form's error banner (`role="alert"` or
 * the first ErrorBanner) so the message is reachable.
 */
export function useFocusFirstError<T extends HTMLElement>(
  error: unknown,
): React.RefObject<T> {
  const ref = useRef<T>(null);
  const lastErrorRef = useRef<unknown>(null);

  useEffect(() => {
    const wasEmpty =
      lastErrorRef.current == null ||
      lastErrorRef.current === '' ||
      lastErrorRef.current === false;
    const isPresent = !!error;
    lastErrorRef.current = error;
    if (!isPresent || !wasEmpty) return;

    const form = ref.current;
    if (!form) return;

    // Defer one tick so the aria-invalid attributes that just got set
    // alongside `error` are already on the DOM by the time we query.
    const handle = window.setTimeout(() => {
      const invalid =
        form.querySelector<HTMLElement>('[aria-invalid="true"]') ||
        form.querySelector<HTMLElement>('[role="alert"]');
      if (invalid) {
        invalid.focus({ preventScroll: false });
        // Some elements (banners, role=alert divs) aren't natively
        // focusable; give them a tabindex so the focus actually lands.
        if (
          document.activeElement !== invalid &&
          !invalid.hasAttribute('tabindex')
        ) {
          invalid.setAttribute('tabindex', '-1');
          invalid.focus({ preventScroll: false });
        }
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, [error]);

  return ref;
}
