import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  // base — every button gets these
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight disabled:pointer-events-none disabled:opacity-50 select-none',
  {
    variants: {
      variant: {
        // Primary CTA — gold on navy, used for the single most-important
        // action on a page (Save, Submit, Approve).
        primary:
          'bg-gold text-navy hover:bg-gold-bright shadow-sm',
        // Secondary — subtle border, used for "Cancel", "Edit", row actions.
        secondary:
          'bg-navy-secondary/40 text-white border border-navy-secondary hover:border-silver/40 hover:bg-navy-secondary',
        // Outline — transparent with an outline. Good for inverse contexts.
        outline:
          'border border-silver/30 text-silver hover:text-white hover:border-silver/60 bg-transparent',
        // Ghost — no chrome, used for icon buttons in toolbars.
        ghost:
          'text-silver hover:text-white hover:bg-navy-secondary/60',
        // Destructive — irreversible actions (Delete, Cancel run, Reject).
        destructive:
          'bg-alert/90 text-white hover:bg-alert',
        // Link-styled (rare — use only for inline navigation in copy).
        link: 'text-gold underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-11 px-6 text-base',
        // Icon-only — square; intended for IconButton use.
        icon: 'h-10 w-10',
        'icon-sm': 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** When true, render the child element with our class+ref instead of a <button>. Useful for `<Button asChild><Link …/></Button>`. */
  asChild?: boolean;
  /** Show a spinner and disable while truthy. */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        {...props}
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {children}
      </Comp>
    );
  }
);
Button.displayName = 'Button';

export { buttonVariants };
