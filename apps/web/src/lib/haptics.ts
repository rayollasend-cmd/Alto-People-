import { isNative } from './native/platform';

/**
 * Confirmation haptics for the moments that matter (clock in/out, shift
 * confirmed, pickup requested). Inside the native app these are the
 * phone's own Taptic / haptic engine (@capacitor/haptics); in the browser
 * the Vibration API gives us the same on Android. iOS Safari has no
 * vibration API at all, so the web path silently no-ops there — never
 * feature-detect-warn, never throw.
 */

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Unsupported / blocked (e.g. no user activation yet) — irrelevant.
  }
}

type NativeHaptic = 'light' | 'success' | 'error';

function native(kind: NativeHaptic): boolean {
  if (!isNative()) return false;
  void import('@capacitor/haptics')
    .then(({ Haptics, ImpactStyle, NotificationType }) =>
      kind === 'light'
        ? Haptics.impact({ style: ImpactStyle.Light })
        : Haptics.notification({ type: kind === 'success' ? NotificationType.Success : NotificationType.Error }),
    )
    .catch(() => {});
  return true;
}

/** One short tick — a primary action landed. */
export function hapticConfirm(): void {
  if (!native('light')) vibrate(15);
}

/** Double tick — something significant completed (clocked in/out). */
export function hapticSuccess(): void {
  if (!native('success')) vibrate([15, 60, 15]);
}

/** A firm buzz — it didn't work (a badge not recognized). */
export function hapticError(): void {
  if (!native('error')) vibrate([40, 40, 40]);
}
