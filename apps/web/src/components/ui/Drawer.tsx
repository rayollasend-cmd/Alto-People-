import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { DiscardConfirm, useDiscardGuard } from './Dialog';

/**
 * Right-edge slide-over drawer for record detail panels — the F500 pattern
 * where clicking a row reveals the full record without leaving the list.
 * Built on Radix Dialog so we get focus trap + Esc-to-close + scroll lock
 * for free, but positioned and animated as a side panel.
 *
 * Usage:
 *   <Drawer open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
 *     <DrawerHeader>
 *       <DrawerTitle>{candidate.firstName} {candidate.lastName}</DrawerTitle>
 *       <DrawerDescription>{candidate.email}</DrawerDescription>
 *     </DrawerHeader>
 *     <DrawerBody>…</DrawerBody>
 *     <DrawerFooter>…</DrawerFooter>
 *   </Drawer>
 */

interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Width in tailwind sizing tokens. Defaults to "max-w-md". */
  width?: string;
  /**
   * Guard user dismissals (Esc / overlay / X / swipe-right) behind a
   * "Discard your changes?" confirm while the value (or predicate) is
   * true. Programmatic closes — the caller setting `open` to false —
   * are never intercepted.
   */
  confirmDiscard?: boolean | (() => boolean);
  children: React.ReactNode;
}

export function Drawer({
  open,
  onOpenChange,
  width = 'max-w-md',
  confirmDiscard,
  children,
}: DrawerProps) {
  // Dirty-guard — same contract as Dialog's confirmDiscard.
  const guard = useDiscardGuard(confirmDiscard, () => onOpenChange(false));
  // Swipe-right-to-close — the native side-panel dismissal gesture.
  // Direction-locked: the gesture only claims the touch once it's clearly
  // horizontal, so vertical scrolling inside DrawerBody is untouched.
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const swipe = React.useRef({ x: 0, y: 0, dx: 0, lock: '' as '' | 'h' | 'v' });

  const onTouchStart = (e: React.TouchEvent) => {
    swipe.current = {
      x: e.touches[0]?.clientX ?? 0,
      y: e.touches[0]?.clientY ?? 0,
      dx: 0,
      lock: '',
    };
    const el = contentRef.current;
    if (el) el.style.transition = 'none';
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current;
    const dx = (e.touches[0]?.clientX ?? 0) - s.x;
    const dy = (e.touches[0]?.clientY ?? 0) - s.y;
    if (s.lock === '') {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      s.lock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    }
    if (s.lock !== 'h') return;
    s.dx = Math.max(0, dx); // rightward only — matches the exit direction
    const el = contentRef.current;
    if (el) el.style.transform = `translateX(${s.dx}px)`;
  };
  const onTouchEnd = () => {
    const s = swipe.current;
    const el = contentRef.current;
    const wasHorizontal = s.lock === 'h';
    const dx = s.dx;
    swipe.current = { x: 0, y: 0, dx: 0, lock: '' };
    if (!el || !wasHorizontal) return;
    if (dx > 110) {
      el.style.transform = '';
      el.style.transition = '';
      // Swipe-dismiss is a user dismissal — snap back + confirm when dirty.
      if (!guard.intercept()) onOpenChange(false);
    } else {
      el.style.transition = 'transform 150ms ease-out';
      el.style.transform = 'translateX(0px)';
      window.setTimeout(() => {
        el.style.transform = '';
        el.style.transition = '';
      }, 160);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-backdrop backdrop-blur-sm',
            'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
          )}
        />
        <DialogPrimitive.Content
          ref={contentRef}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
          onEscapeKeyDown={(e) => guard.intercept(e)}
          onPointerDownOutside={(e) => guard.intercept(e)}
          onInteractOutside={(e) => guard.intercept(e)}
          className={cn(
            'fixed right-0 top-0 bottom-0 z-50 w-full',
            width,
            // elev-3 carries the drawer-above-page elevation signal; a
            // 1px gold/15 accent on the left edge picks up the brand
            // accent so the drawer reads as a floating panel rather
            // than a darker stripe of the page.
            'bg-navy border-l border-gold/15 elev-3',
            'flex flex-col',
            'focus:outline-none',
            'data-[state=open]:animate-slide-in-from-right data-[state=closed]:animate-slide-out-to-right',
          )}
        >
          <DialogPrimitive.Close
            // Radix's close-on-click checks defaultPrevented, so the
            // guard's preventDefault holds the drawer open.
            onClick={(e) => guard.intercept(e)}
            className="absolute grid place-items-center h-10 w-10 rounded-md text-silver hover:text-white hover:bg-navy-secondary/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright top-[max(0.5rem,env(safe-area-inset-top))] right-[max(0.5rem,env(safe-area-inset-right))]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
      {guard.enabled && (
        <DiscardConfirm
          open={guard.confirming}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      )}
    </DialogPrimitive.Root>
  );
}

export function DrawerHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // No bottom border — the drawer's gold/15 left edge from elev-3
        // already announces the panel's boundary, and the body's own
        // padding gives the header its visual separation. The previous
        // navy-secondary bottom border crossed the gold left edge at the
        // corner and read busy.
        'p-6 pr-12 flex flex-col gap-1',
        // Push the title clear of the notch on iOS — the close button uses the
        // same max() pattern so the two stay vertically aligned.
        'pt-[max(1.5rem,calc(env(safe-area-inset-top)+0.75rem))] pr-[max(3rem,calc(env(safe-area-inset-right)+2.25rem))]',
        className,
      )}
      {...props}
    />
  );
}

export const DrawerTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('font-display text-2xl text-white leading-tight', className)}
    {...props}
  />
));
DrawerTitle.displayName = 'DrawerTitle';

export const DrawerDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-silver', className)}
    {...props}
  />
));
DrawerDescription.displayName = 'DrawerDescription';

export function DrawerBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex-1 overflow-y-auto p-6', className)}
      {...props}
    />
  );
}

export function DrawerFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'p-6 border-t border-navy-secondary flex justify-end gap-2',
        // Keep buttons clear of the iOS home indicator on phones with no
        // hardware home button.
        'pb-[max(1.5rem,calc(env(safe-area-inset-bottom)+0.75rem))]',
        className,
      )}
      {...props}
    />
  );
}
