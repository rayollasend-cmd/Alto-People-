import { useCallback, useEffect, useState } from 'react';
import { Fingerprint, ScanFace } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { authenticateBiometric, checkBiometry, type Biometry } from '@/lib/native/biometric';
import { hapticError, hapticSuccess } from '@/lib/haptics';

/**
 * The lock screen: covers the app until Face ID / fingerprint passes. It
 * asks once on its own (as native apps do) and then waits on a button, so
 * a cancelled prompt never loops. "Sign in again" is always there for a
 * phone whose biometrics changed.
 */
export function BiometricLock({
  signedIn,
  onUnlocked,
  onSignInAgain,
}: {
  signedIn: boolean;
  onUnlocked: () => void | Promise<void>;
  onSignInAgain: () => void | Promise<void>;
}) {
  const [bio, setBio] = useState<Biometry | null>(null);
  const [state, setState] = useState<'idle' | 'checking' | 'failed'>('idle');

  const unlock = useCallback(async () => {
    setState('checking');
    const ok = await authenticateBiometric(signedIn ? 'Unlock Alto People' : 'Unlock to sign back in');
    if (ok) {
      hapticSuccess();
      await onUnlocked();
    } else {
      hapticError();
      setState('failed');
    }
  }, [onUnlocked, signedIn]);

  useEffect(() => {
    void checkBiometry().then((b) => {
      setBio(b);
      // The first prompt is automatic; after that, the person taps.
      if (b.available) void unlock();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const Icon = bio?.kind === 'finger' ? Fingerprint : ScanFace;
  const label = bio?.label ?? 'Face ID';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-title"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-surface-sunken px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))] text-center"
    >
      <img src="/icon-192.png" alt="" className="h-16 w-16 rounded-2xl shadow-lg" />
      <h1 id="lock-title" className="mt-6 font-display text-3xl text-ink">
        Alto People is locked
      </h1>
      <p className="mt-2 max-w-xs text-sm text-ink-muted" aria-live="polite">
        {state === 'failed'
          ? `${label} didn’t match. Try again, or sign in with your password.`
          : bio && !bio.available
            ? `${label} isn’t set up on this phone. Sign in with your password instead.`
            : `Use ${label} to open the app.`}
      </p>
      <div className="mt-8 flex w-full max-w-xs flex-col gap-3">
        {(!bio || bio.available) && (
          <Button size="lg" onClick={() => void unlock()} loading={state === 'checking'} className="w-full">
            <Icon className="h-5 w-5" aria-hidden="true" />
            Unlock with {label}
          </Button>
        )}
        <Button size="lg" variant="ghost" onClick={() => void onSignInAgain()} className="w-full">
          Sign in with password
        </Button>
      </div>
    </div>
  );
}
