import * as React from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Render a small alert state (red border + ring on focus). */
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, type = 'text', required, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        required={required}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        className={cn(
          // 16px on touch (text-base) — anything smaller makes iOS Safari
          // zoom the whole viewport on focus, the loudest "this is a
          // website" tell. Desktop keeps the denser 14px.
          'flex h-11 md:h-10 w-full rounded-md border bg-navy-secondary/40 px-3 py-2 text-base md:text-sm text-white placeholder:text-silver/90 transition-colors',
          'border-navy-secondary hover:border-silver/40 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/40',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-navy-secondary',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-silver',
          invalid && 'border-alert hover:border-alert focus:border-alert focus:ring-alert/40',
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, required, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        required={required}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        className={cn(
          // 16px on touch — see Input; prevents iOS focus-zoom.
          'flex min-h-[80px] w-full rounded-md border bg-navy-secondary/40 px-3 py-2 text-base md:text-sm text-white placeholder:text-silver/90 transition-colors',
          'border-navy-secondary hover:border-silver/40 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/40',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-navy-secondary',
          invalid && 'border-alert hover:border-alert focus:border-alert focus:ring-alert/40',
          className
        )}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';
