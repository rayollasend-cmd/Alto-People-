import { isNative } from './platform';

/**
 * Face ID / Touch ID / fingerprint, to re-open the app (never to replace
 * signing in). The words follow the phone: "Face ID" on an iPhone with
 * Face ID, "Touch ID", or "fingerprint" / "face unlock" on Android.
 */

export interface Biometry {
  available: boolean;
  /** What to call it in copy: "Face ID", "Touch ID", "fingerprint", "face unlock". */
  label: string;
  kind: 'face' | 'finger' | 'none';
}

export async function checkBiometry(): Promise<Biometry> {
  if (!isNative()) return { available: false, label: 'biometrics', kind: 'none' };
  try {
    const { BiometricAuth, BiometryType } = await import('@aparajita/capacitor-biometric-auth');
    const r = await BiometricAuth.checkBiometry();
    const t = r.biometryType;
    if (t === BiometryType.faceId) return { available: r.isAvailable, label: 'Face ID', kind: 'face' };
    if (t === BiometryType.touchId) return { available: r.isAvailable, label: 'Touch ID', kind: 'finger' };
    if (t === BiometryType.faceAuthentication) return { available: r.isAvailable, label: 'face unlock', kind: 'face' };
    return { available: r.isAvailable, label: 'fingerprint', kind: r.isAvailable ? 'finger' : 'none' };
  } catch {
    return { available: false, label: 'biometrics', kind: 'none' };
  }
}

/** Resolves true when the person passed; false when they cancelled or it failed. */
export async function authenticateBiometric(reason: string): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    await BiometricAuth.authenticate({
      reason,
      cancelTitle: 'Cancel',
      allowDeviceCredential: true,
      iosFallbackTitle: 'Use passcode',
      androidTitle: 'Unlock Alto People',
      androidSubtitle: reason,
      androidConfirmationRequired: false,
    });
    return true;
  } catch {
    return false;
  }
}
