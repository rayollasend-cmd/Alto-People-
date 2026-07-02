import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
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
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
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
      {/* Grab-handle affordance — sheet idiom, phones only. */}
      <div
        aria-hidden="true"
        className="sm:hidden mx-auto -mt-3 -mb-1 h-1 w-10 rounded-full bg-silver/30"
      />
      {children}
      <DialogPrimitive.Close
        // Same safe-area-aware positioning as Drawer's close button so
        // iOS notches don't clip the X target on full-bleed dialogs.
        className="absolute grid place-items-center h-10 w-10 rounded-md text-silver hover:text-white hover:bg-navy-secondary/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright top-[max(0.5rem,env(safe-area-inset-top))] right-[max(0.5rem,env(safe-area-inset-right))]"
        aria-label="Close"
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
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
    className={cn('font-display text-2xl text-white leading-none', className)}
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
