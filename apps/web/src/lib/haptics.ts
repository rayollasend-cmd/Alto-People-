/**
 * Confirmation haptics for the moments that matter (clock in/out, shift
 * confirmed, pickup requested). Native apps answer big taps with a buzz;
 * the Vibration API gives us the same on Android. iOS Safari has no
 * vibration API at all, so this silently no-ops there — never feature-
 * detect-warn, never throw.
 */

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Unsupported / blocked (e.g. no user activation yet) — irrelevant.
  }
}

/** One short tick — a primary action landed. */
export function hapticConfirm(): void {
  vibrate(15);
}

/** Double tick — something significant completed (clocked in/out). */
export function hapticSuccess(): void {
  vibrate([15, 60, 15]);
}
