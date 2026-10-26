import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/cn';

/**
 * Form field label. Pairs with Input/Textarea/Select via htmlFor or
 * by wrapping the input. Sentence case at body size, as Okta and Rippling
 * label fields: the spaced capitals read as eyebrows over every field and
 * made long labels ("WHAT WOULD YOU LIKE YOUR TEAM TO CALL ME?") shout
 * (F500 audit 2026-10-26). Eyebrows stay for section headings.
 */
export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & {
    /** Render a red asterisk to signal required without using the word. */
    required?: boolean;
  }
>(({ className, required, children, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'block text-sm font-medium text-ink mb-1.5',
      'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className
    )}
    {...props}
  >
    {children}
    {required && <span className="text-alert ml-0.5" aria-hidden="true">*</span>}
  </LabelPrimitive.Root>
));
Label.displayName = LabelPrimitive.Root.displayName;

/** Inline help text or validation message. */
export function FormHint({
  children,
  variant = 'hint',
  id,
}: {
  children: React.ReactNode;
  variant?: 'hint' | 'error';
  id?: string;
}) {
  return (
    <p
      id={id}
      className={cn(
        'text-xs mt-1.5',
        variant === 'hint' && 'text-silver/70',
        variant === 'error' && 'text-alert'
      )}
      role={variant === 'error' ? 'alert' : undefined}
    >
      {children}
    </p>
  );
}
