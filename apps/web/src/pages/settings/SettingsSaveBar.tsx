import * as React from 'react';
import { CheckCircle2 } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';

/**
 * One save for a whole Settings page (F500 G4): the form's changes wait
 * here, counted, with Discard and Save. Branding used to carry four Save
 * buttons on one page; the Organization page's sat 1,800px down.
 *
 * The one model for every settings form (F500 polish, 2026-10-26): a page
 * of fields saves from this bar; a control that applies the moment it is
 * flipped (a switch, a segmented choice) says so in a toast instead.
 *
 * Nothing changed: one quiet line, no dead Save button. Something changed:
 * the bar rises — sticky at the bottom of the screen while the page
 * scrolls, Save in gold. Sticky, not fixed: the phone tab bar is a sibling
 * below <main>, so the bar rides just above it and never covers it.
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
  const pending = dirty > 0 || saving;
  if (!pending) {
    return (
      <div
        role="region"
        aria-label="Save changes"
        data-testid="settings-save-bar"
        data-state="saved"
        className={cn('flex items-center gap-1.5 px-1 text-xs text-ink-muted print:hidden', className)}
      >
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <p className="min-w-0" aria-live="polite">
          Everything is saved.
          {note ? <> {note}</> : null}
        </p>
      </div>
    );
  }
  return (
    <div
      role="region"
      aria-label="Save changes"
      className={cn(
        'sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface/95 p-3 backdrop-blur elev-2 print:hidden',
        className,
      )}
      data-testid="settings-save-bar"
      data-state="dirty"
    >
      <p className="min-w-0 text-sm text-ink-muted" aria-live="polite">
        <span className="font-medium text-ink">{dirty === 0 ? 'Saving…' : dirty === 1 ? '1 unsaved change.' : `${dirty} unsaved changes.`}</span>
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
