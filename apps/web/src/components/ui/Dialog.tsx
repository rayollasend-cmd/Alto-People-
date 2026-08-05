import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './Button';

/* ------------------------------------------------------- discard guard */

/**
 * Dirty-guard plumbing shared by Dialog and Drawer. When a dialog carries
 * `confirmDiscard`, USER dismissals (Esc, overlay click, the X button, the
 * swipe/drag gesture) are intercepted with a "Discard your changes?"
 * confirm before `onOpenChange(false)` propagates. Programmatic closes
 * (a successful submit flipping `open` to false) are never intercepted —
 * they don't travel through Radix's dismissal events.
 *
 * The confirm is a minimal inline Radix dialog rather than lib/confirm's
 * imperative API: that API needs the app-level <ConfirmProvider> (absent
 * in isolated renders/tests) and importing it here would create a module
 * cycle (Dialog → confirm → ConfirmDialog → Dialog).
 */
interface DiscardGuardValue {
  /** Call from a user-dismissal path; preventDefaults + confirms when dirty. */
  onUserDismiss: (e: { preventDefault: () => void }) => void;
}

const DiscardGuardContext = React.createContext<DiscardGuardValue | null>(null);

/** Minimal "Discard your changes?" confirm, stacked above the guarded layer. */
export function DiscardConfirm({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onKeep()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-backdrop backdrop-blur-sm',
            'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out'
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
            'w-[calc(100vw-2rem)] max-w-sm rounded-lg border border-navy-secondary bg-navy elev-3 p-6 grid gap-3 focus:outline-none',
            'data-[state=open]:animate-zoom-in data-[state=closed]:animate-zoom-out'
          )}
        >
          <DialogPrimitive.Title className="text-2xl text-white leading-none">
            Discard your changes?
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-sm text-silver">
            You have unsaved edits — closing now will lose them.
          </DialogPrimitive.Description>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onKeep}>
              Keep editing
            </Button>
            <Button type="button" variant="destructive" onClick={onDiscard}>
              Discard
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Shared guard state. `intercept(e?)` returns true when the close was
 * captured (dirty) — event paths pass the Radix event so its default is
 * prevented; gesture paths (drawer swipe) call it bare and branch on the
 * return value.
 */
export function useDiscardGuard(
  confirmDiscard: boolean | (() => boolean) | undefined,
  close: () => void
) {
  const [confirming, setConfirming] = React.useState(false);
  const intercept = (e?: { preventDefault: () => void }): boolean => {
    const dirty =
      typeof confirmDiscard === 'function' ? confirmDiscard() : confirmDiscard === true;
    if (!dirty) return false;
    e?.preventDefault();
    setConfirming(true);
    return true;
  };
  const keep = () => setConfirming(false);
  const discard = () => {
    setConfirming(false);
    close();
  };
  return { enabled: confirmDiscard !== undefined, confirming, intercept, keep, discard };
}

export interface DialogProps
  extends React.ComponentProps<typeof DialogPrimitive.Root> {
  /**
   * Guard user dismissals (Esc / overlay / X / drag-down) behind a
   * "Discard your changes?" confirm while the value (or predicate) is
   * true. Programmatic closes — the caller setting `open` to false —
   * are never intercepted.
   */
  confirmDiscard?: boolean | (() => boolean);
}

export function Dialog({ confirmDiscard, ...props }: DialogProps) {
  const { onOpenChange } = props;
  const guard = useDiscardGuard(confirmDiscard, () => onOpenChange?.(false));
  return (
    <DiscardGuardContext.Provider value={{ onUserDismiss: guard.intercept }}>
      <DialogPrimitive.Root {...props} />
      {guard.enabled && (
        <DiscardConfirm
          open={guard.confirming}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      )}
    </DiscardGuardContext.Provider>
  );
}

export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-backdrop backdrop-blur-sm',
      'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onEscapeKeyDown, onPointerDownOutside, onInteractOutside, ...props }, ref) => {
  // Dirty-guard: provided by the Dialog wrapper when `confirmDiscard` is
  // set. Each user-dismissal path below routes through it; it no-ops
  // (returns false) when the dialog is clean or unguarded.
  const discardGuard = React.useContext(DiscardGuardContext);
  // Drag-to-dismiss for the phone bottom sheet. The grab handle below is
  // the universal "drag me down" signal — it used to be decoration, which
  // is worse than absent: users tried the gesture and nothing happened.
  // The drag lives on the HANDLE only (not the sheet body), so it never
  // fights the content's own scrolling.
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const drag = React.useRef({ startY: 0, dy: 0, active: false });

  const setRefs = (node: HTMLDivElement | null) => {
    contentRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  const onHandleTouchStart = (e: React.TouchEvent) => {
    drag.current = { startY: e.touches[0]?.clientY ?? 0, dy: 0, active: true };
    const el = contentRef.current;
    if (el) el.style.transition = 'none';
  };
  const onHandleTouchMove = (e: React.TouchEvent) => {
    if (!drag.current.active) return;
    const dy = Math.max(0, (e.touches[0]?.clientY ?? 0) - drag.current.startY);
    drag.current.dy = dy;
    const el = contentRef.current;
    if (el) el.style.transform = `translateY(${dy}px)`;
  };
  const onHandleTouchEnd = () => {
    if (!drag.current.active) return;
    const { dy } = drag.current;
    drag.current.active = false;
    const el = contentRef.current;
    if (!el) return;
    if (dy > 90) {
      el.style.transform = '';
      el.style.transition = '';
      closeRef.current?.click();
    } else {
      el.style.transition = 'transform 150ms ease-out';
      el.style.transform = 'translateY(0px)';
      window.setTimeout(() => {
        el.style.transform = '';
        el.style.transition = '';
      }, 160);
    }
  };

  return (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={setRefs}
      onEscapeKeyDown={(e) => {
        onEscapeKeyDown?.(e);
        if (!e.defaultPrevented) discardGuard?.onUserDismiss(e);
      }}
      onPointerDownOutside={(e) => {
        onPointerDownOutside?.(e);
        if (!e.defaultPrevented) discardGuard?.onUserDismiss(e);
      }}
      onInteractOutside={(e) => {
        onInteractOutside?.(e);
        if (!e.defaultPrevented) discardGuard?.onUserDismiss(e);
      }}
      className={cn(
        'fixed z-50 bg-navy elev-3 p-6 grid gap-4 focus:outline-none overflow-y-auto overscroll-contain',
        // PHONES: a bottom sheet, not a floating web modal. Anchored to
        // the bottom edge it survives the iOS keyboard (which pushes it
        // up instead of clipping a vertically-centered box), slides up
        // like a native form, and puts the primary action near thumbs.
        'inset-x-0 bottom-0 w-full rounded-t-2xl border-t border-navy-secondary',
        'max-h-[calc(100dvh-3rem-env(safe-area-inset-top))]',
        'pb-[max(1.5rem,env(safe-area-inset-bottom))]',
        'data-[state=open]:animate-slide-up-in data-[state=closed]:animate-slide-down-out',
        // sm+: the original centered dialog.
        'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2',
        'sm:w-[calc(100vw-2rem)] sm:max-w-lg sm:rounded-lg sm:border sm:border-navy-secondary',
        // Height: cap at viewport-minus-gutter-minus-safe-area so tall
        // dialogs (long forms, listings) stay clear of the iOS notch and
        // home indicator. Internal scroll handles overflow — without
        // this, the submit button drops below the fold.
        'sm:max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]',
        'sm:pb-6',
        'sm:data-[state=open]:animate-zoom-in sm:data-[state=closed]:animate-zoom-out',
        className
      )}
      {...props}
    >
      {/* Grab handle — phones only, and it actually drags. touch-none
          keeps the browser from scrolling while the finger owns the
          handle; the padded wrapper is the real hit area. */}
      <div
        aria-hidden="true"
        className="sm:hidden -mt-6 -mx-6 px-6 pt-3 pb-2 touch-none"
        onTouchStart={onHandleTouchStart}
        onTouchMove={onHandleTouchMove}
        onTouchEnd={onHandleTouchEnd}
        onTouchCancel={onHandleTouchEnd}
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-silver/30" />
      </div>
      {children}
      <DialogPrimitive.Close
        ref={closeRef}
        // Radix's own close-on-click checks defaultPrevented, so the
        // guard's preventDefault holds the dialog open. Drag-to-dismiss
        // funnels through this button (closeRef.click()) — guarded too.
        onClick={(e) => discardGuard?.onUserDismiss(e)}
        // Same safe-area-aware positioning as Drawer's close button so
        // iOS notches don't clip the X target on full-bleed dialogs.
        className="absolute grid place-items-center h-10 w-10 rounded-md text-silver hover:text-white hover:bg-navy-secondary/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright top-[max(0.5rem,env(safe-area-inset-top))] right-[max(0.5rem,env(safe-area-inset-right))]"
        aria-label="Close"
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col space-y-1.5 pr-11', className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse sm:flex-row sm:justify-end sm:gap-2 gap-2 pt-2',
        className
      )}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-2xl text-white leading-none', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-silver', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
