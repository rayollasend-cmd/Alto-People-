import { Toaster as SonnerToaster, toast } from 'sonner';

/**
 * Application-wide toast surface. Mount once at the app root (Layout or
 * App). Then anywhere call `toast("Saved")`, `toast.success(...)`,
 * `toast.error(...)`, etc. Branded to match the navy/gold palette.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      richColors
      closeButton
      // 5s default reads naturally for short success messages while staying
      // long enough to register an error before it dismisses itself.
      duration={5000}
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
      mobileOffset={{
        top: 'max(0.5rem, env(safe-area-inset-top))',
        right: 'max(0.5rem, env(safe-area-inset-right))',
      }}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-navy group-[.toaster]:text-white group-[.toaster]:border-navy-secondary group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-silver',
          actionButton: 'group-[.toast]:bg-gold group-[.toast]:text-navy',
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
