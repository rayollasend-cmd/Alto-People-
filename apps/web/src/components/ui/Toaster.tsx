import { useEffect, useState } from 'react';
import { Toaster as SonnerToaster, toast } from 'sonner';

/** Small local matchMedia subscription — phones get bottom toasts. */
function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches,
  );
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 640px)');
    const onChange = (e: MediaQueryListEvent) => setIsPhone(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isPhone;
}

/**
 * Application-wide toast surface. Mount once at the app root (Layout or
 * App). Then anywhere call `toast("Saved")`, `toast.success(...)`,
 * `toast.error(...)`, etc. Branded to match the navy/gold palette.
 *
 * Position is device-aware: top-right is the desktop-web idiom; native
 * mobile confirmation lives at the BOTTOM, in thumb reach, above the tab
 * bar — so phones get bottom-center.
 */
export function Toaster() {
  const isPhone = useIsPhone();
  return (
    <SonnerToaster
      position={isPhone ? 'bottom-center' : 'top-right'}
      richColors
      closeButton
      // 8s default. 5s is fine for "Saved" but screen-reader users and
      // anyone reading a multi-line error message can't catch the detail
      // before it self-dismisses; sonner pauses on hover and exposes the
      // close button, so a longer dwell time doesn't hurt the happy path.
      duration={8000}
      // Tighter visible stack — older toasts can be expanded on hover.
      visibleToasts={4}
      gap={10}
      // Stay clear of the iOS status bar / Dynamic Island. Without this,
      // top-right toasts land directly under the time/battery icons on
      // iPhone PWA installs and are hard to read or dismiss.
      offset={{
        top: 'max(1rem, env(safe-area-inset-top))',
        right: 'max(1rem, env(safe-area-inset-right))',
      }}
      // Bottom-center on phones: clear the BottomTabBar (56px) + home
      // indicator.
      mobileOffset={{
        bottom: 'max(5rem, calc(env(safe-area-inset-bottom) + 4.5rem))',
        left: '0.75rem',
        right: '0.75rem',
      }}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-navy group-[.toaster]:text-white group-[.toaster]:border-navy-secondary group-[.toaster]:elev-2',
          description: 'group-[.toast]:text-silver',
          // on-accent: theme-stable dark ink on gold (text-navy flips to
          // white in light mode and broke contrast).
          actionButton: 'group-[.toast]:bg-gold-fill group-[.toast]:text-on-accent',
          cancelButton: 'group-[.toast]:bg-navy-secondary group-[.toast]:text-silver',
          success: 'group-[.toast]:!border-success/40',
          error: 'group-[.toast]:!border-alert/40',
          warning: 'group-[.toast]:!border-warning/40',
        },
      }}
    />
  );
}

export { toast };
