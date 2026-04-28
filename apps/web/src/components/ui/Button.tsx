import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  // base — every button gets these
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] disabled:active:scale-100 select-none',
  {
    variants: {
      variant: {
        // Primary CTA — gold on navy, used for the single most-important
        // action on a page (Save, Submit, Approve).
        primary:
          'bg-gold text-navy hover:bg-gold-bright shadow-sm hover:shadow-md',
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
          'bg-alert text-white hover:bg-alert/90 shadow-sm',
        // Link-styled (rare — use only for inline navigation in copy).
        link: 'text-gold underline-offset-4 hover:underline p-0 h-auto active:scale-100',
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
    // Slot enforces React.Children.only on its child, so the spinner sibling
    // we'd normally render alongside `children` would crash when asChild is
    // true. Suppress the inline spinner in that case — `disabled` still
    // conveys the busy state on the underlying element. Callers that need a
    // visible spinner with a Link should use `useNavigate` + onClick instead.
    const showSpinner = loading && !asChild;
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {showSpinner && <Loader2 className="h-4 w-4 animate-spin" />}
        {children}
      </Comp>
    );
  }
);
Button.displayName = 'Button';

export { buttonVariants };
