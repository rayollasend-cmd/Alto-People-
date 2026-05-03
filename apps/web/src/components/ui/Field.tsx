import * as React from 'react';
import { cn } from '@/lib/cn';
import { FormHint, Label } from './Label';

interface FieldRenderArgs {
  /** Auto-generated id; spread onto the input/select/textarea. */
  id: string;
  /** Mirrors the Field's `required` prop so native browser validation fires. */
  required: boolean | undefined;
  /** Points at the hint or error node when one is rendered. */
  'aria-describedby': string | undefined;
  /** True when `error` is set so the input renders the alert ring. */
  'aria-invalid': true | undefined;
}

export interface FieldProps {
  /** Label text. */
  label: React.ReactNode;
  /** Show the red required asterisk on the label. */
  required?: boolean;
  /** Help text rendered below the input when no error is showing. */
  hint?: React.ReactNode;
  /** Error message. When set, replaces the hint and flips aria-invalid. */
  error?: React.ReactNode;
  /**
   * Render the input/select/textarea here. Receives an id +
   * aria-describedby + aria-invalid that you must spread onto the
   * control so screen readers can connect the label, hint, and error.
   */
  children: (args: FieldRenderArgs) => React.ReactElement;
  className?: string;
}

/**
 * Single-source-of-truth wrapper for a labelled form control.
 *
 * Pages used to hand-roll Label + Input + FormHint trios, which meant
 * htmlFor/id and aria-describedby drifted out of sync as fields got
 * added or moved. Field generates the id once via useId() and threads
 * everything through a render prop so the wiring can't get forgotten.
 *
 *   <Field label="Email" required hint="We'll send a magic link.">
 *     {(p) => <Input type="email" value={email} onChange={...} {...p} />}
 *   </Field>
 *
 * Existing call sites that already manually wire htmlFor/id stay
 * working as-is — Field is for new forms and migrations, not a forced
 * cutover.
 */
export function Field({
  label,
  required,
  hint,
  error,
  children,
  className,
}: FieldProps) {
  const reactId = React.useId();
  const id = `f${reactId.replace(/:/g, '')}`;
  const hintId = `${id}-hint`;
  const showError = error != null && error !== false && error !== '';
  const showHint = !showError && hint != null && hint !== false && hint !== '';

  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {children({
        id,
        required: required || undefined,
        'aria-describedby': showError || showHint ? hintId : undefined,
        'aria-invalid': showError ? true : undefined,
      })}
      {showError && (
        <FormHint id={hintId} variant="error">
          {error}
        </FormHint>
      )}
      {showHint && <FormHint id={hintId}>{hint}</FormHint>}
    </div>
  );
}
