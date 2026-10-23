import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { createPersonRecord, type AdminUser } from '@/lib/usersAdminApi';
import { errorText } from '@/lib/errorText';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';

/**
 * The person record behind a staff login (2026-10-22). Schedule, time and
 * pay key off it; a login made in Users admin has none, and nothing else in
 * the app could make one — the internal recruiter could not clock in. Two
 * fields, prefilled from the email, one button.
 */

/** "britney.subratie@…" → ["Britney", "Subratie"]; anything else → ["", ""]. */
function guessName(email: string): [string, string] {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length < 2) return ['', ''];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return [cap(parts[0]), parts.slice(1).map(cap).join(' ')];
}

export function PersonRecordDialog({
  user,
  open,
  onOpenChange,
  onSaved,
}: {
  user: AdminUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [guessFirst, guessLast] = guessName(user.email);
  const [firstName, setFirstName] = useState(guessFirst);
  const [lastName, setLastName] = useState(guessLast);
  const [busy, setBusy] = useState(false);
  const canSave = firstName.trim().length > 0 && lastName.trim().length > 0 && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    try {
      const r = await createPersonRecord(user.id, { firstName: firstName.trim(), lastName: lastName.trim() });
      toast.success(
        r.created
          ? 'Person record created and linked. Their clock works the next time they sign in.'
          : 'Linked to the person record already in People. Their clock works the next time they sign in.',
      );
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(errorText(err, "Couldn't create the person record."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>Set up their person record</DialogTitle>
            <DialogDescription>
              Clocking in, the schedule and pay all key off a person record in People. This creates one for{' '}
              <span className="text-ink">{user.email}</span>, or links the record already there under that email, and
              ties it to this login.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="First name" required>
              {(p) => <Input {...p} value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus maxLength={80} />}
            </Field>
            <Field label="Last name" required>
              {(p) => <Input {...p} value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={80} />}
            </Field>
          </div>
          <DialogFooter className="mt-5">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} loading={busy}>
              Create &amp; link
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
