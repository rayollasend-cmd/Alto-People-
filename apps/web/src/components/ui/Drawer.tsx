import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

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
  children: React.ReactNode;
}

export function Drawer({ open, onOpenChange, width = 'max-w-md', children }: DrawerProps) {
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
          className={cn(
            'fixed right-0 top-0 bottom-0 z-50 w-full',
            width,
            'bg-navy border-l border-navy-secondary shadow-2xl',
            'flex flex-col',
            'focus:outline-none',
            'data-[state=open]:animate-slide-in-from-right data-[state=closed]:animate-slide-out-to-right',
          )}
        >
          <DialogPrimitive.Close
            className="absolute right-3 top-3 grid place-items-center h-8 w-8 rounded-md text-silver hover:text-white hover:bg-navy-secondary/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function DrawerHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'p-6 pr-12 border-b border-navy-secondary flex flex-col gap-1',
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
        className,
      )}
      {...props}
    />
  );
}
