import * as React from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';

/**
 * One save for a whole Settings page (F500 G4): a bar that stays at the
 * bottom of the screen while the page scrolls, says how many changes are
 * waiting, and holds Discard and Save. Branding used to carry four Save
 * buttons on one page; the Organization page's sat 1,800px down.
 *
 * Sticky, not fixed: the phone tab bar is a sibling below <main>, so the
 * bar rides just above it and never covers it.
 */
export function SettingsSaveBar({
  dirty,
  saving = false,
  onSave,
  onDiscard,
  saveLabel = 'Save',
  note,
  disabled = false,
  className,
}: {
  /** How many fields differ from what is saved (0 = nothing to save). */
  dirty: number;
  saving?: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  saveLabel?: string;
  /** A line beside the count: where related settings live, why Save is off. */
  note?: React.ReactNode;
  /** Save is off even with changes (an invalid field). */
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="region"
      aria-label="Save changes"
      className={cn(
        'sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface/95 p-3 backdrop-blur elev-2 print:hidden',
        className,
      )}
      data-testid="settings-save-bar"
    >
      <p className="min-w-0 text-xs text-ink-muted" aria-live="polite">
        <span className={cn(dirty > 0 && 'font-medium text-ink')}>{dirty > 0 ? `${dirty} unsaved ${dirty === 1 ? 'change' : 'changes'}.` : 'Everything is saved.'}</span>
        {note ? <> {note}</> : null}
      </p>
      <div className="flex items-center gap-2">
        {onDiscard && dirty > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
        )}
        <Button type="button" size="sm" onClick={onSave} loading={saving} disabled={dirty === 0 || saving || disabled}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
