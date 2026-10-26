import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * The on/off switch for a setting that applies the moment it is flipped
 * (F500 polish, 2026-10-26). Ink when on, never gold: Account settings
 * carried some forty gold switches, and gold is the one primary action's
 * colour. Off is an outlined track with a muted knob, so on and off read
 * apart in both themes without leaning on colour.
 *
 * A real checkbox underneath (role="switch"): the keyboard, the label and
 * tests treat it as any input. The caller confirms the change (a toast).
 */
export interface SettingsSwitchProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked' | 'size'> {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** The wrapper (the hit area). */
  className?: string;
}

export const SettingsSwitch = React.forwardRef<HTMLInputElement, SettingsSwitchProps>(function SettingsSwitch(
  { checked, onCheckedChange, disabled, className, ...rest },
  ref,
) {
  return (
    <label
      className={cn(
        // 44px hit area on touch; the track itself stays 24 × 44.
        'relative inline-flex shrink-0 items-center justify-center coarse:min-h-11 coarse:min-w-11',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        className,
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        aria-checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange(e.target.checked)}
        {...rest}
      />
      <span
        aria-hidden="true"
        data-switch-track=""
        className={cn(
          'relative block h-6 w-11 rounded-full border-2 border-ink-muted/50 bg-transparent transition-colors',
          'peer-checked:border-ink peer-checked:bg-ink',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface',
          "after:absolute after:left-[3px] after:top-1/2 after:h-3.5 after:w-3.5 after:-translate-y-1/2 after:rounded-full after:bg-ink-muted after:transition after:content-['']",
          'peer-checked:after:translate-x-5 peer-checked:after:bg-surface',
          'motion-reduce:transition-none motion-reduce:after:transition-none',
        )}
      />
    </label>
  );
});
