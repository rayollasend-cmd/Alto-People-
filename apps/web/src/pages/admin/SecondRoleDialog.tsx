import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  MAX_ADDITIONAL_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  additionalRoleRefusal,
  type Role,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { patchAdminUser, type AdminUser } from '@/lib/usersAdminApi';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { cn } from '@/lib/cn';

/**
 * Give one account a second job.
 *
 * The case this exists for: a shift supervisor who also drives an Alto
 * van. Onboarding them a second time as a driver gives you two accounts
 * for one person — two profiles to keep current, two sets of
 * notifications, and a driver nobody can tie back to the supervisor who
 * ran the shift. Instead the account holds both roles and the person
 * switches between them from their own account menu, one at a time.
 *
 * It is not a way to widen anyone's access quietly. A second role is
 * exactly as powerful as that role, so the server applies the same
 * no-escalation rule it applies to the primary one, refuses any
 * combination that crosses the customer/employee line, and writes every
 * grant to the audit log.
 */

const ROLE_ORDER: Role[] = [
  'DRIVER',
  'SHIFT_SUPERVISOR',
  'FLOOR_SUPERVISOR',
  'ASSOCIATE',
  'TRANSPORTATION_DIRECTOR',
  'WORKFORCE_MANAGER',
  'INTERNAL_RECRUITER',
  'MARKETING_MANAGER',
  'FINANCE_ACCOUNTANT',
  'MANAGER',
  'OPERATIONS_MANAGER',
  'EXECUTIVE_CHAIRMAN',
  'HR_ADMINISTRATOR',
];

export function SecondRoleDialog({
  user,
  open,
  onOpenChange,
  onSaved,
}: {
  user: Pick<AdminUser, 'id' | 'email' | 'associateName' | 'role' | 'additionalRoles' | 'activeRole'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const who = user.associateName ?? user.email;
  const [picked, setPicked] = useState<Set<Role>>(
    () => new Set(user.additionalRoles ?? []),
  );
  const [saving, setSaving] = useState(false);

  // Only combinations the server will actually accept — showing a role
  // that is going to be refused is a form that lies to the person using it.
  const offered = useMemo(
    () =>
      ROLE_ORDER.filter((r) => !additionalRoleRefusal(user.role, r)).map((r) => ({
        role: r,
        refusal: null as string | null,
      })),
    [user.role],
  );

  const atCap = picked.size >= MAX_ADDITIONAL_ROLES;
  const dirty =
    picked.size !== (user.additionalRoles?.length ?? 0) ||
    [...picked].some((r) => !(user.additionalRoles ?? []).includes(r));

  // Revoking the role they are wearing right now puts them back on their
  // primary and ends their sessions — say so before it happens.
  const revokingActive =
    user.activeRole != null &&
    user.activeRole !== user.role &&
    !picked.has(user.activeRole);

  const toggle = (r: Role) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else if (next.size < MAX_ADDITIONAL_ROLES) next.add(r);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await patchAdminUser(user.id, { additionalRoles: [...picked] });
      toast.success(
        picked.size === 0
          ? `${who} now works as ${ROLE_LABELS[user.role]} only.`
          : `${who} can now switch between ${[user.role, ...picked]
              .map((r) => ROLE_LABELS[r])
              .join(' and ')}.`,
      );
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not save. Try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  if (user.role === 'CLIENT_PORTAL') {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Second role</DialogTitle>
            <DialogDescription>
              A client portal account belongs to the customer, not to us. It cannot hold a
              second role, and no account can switch into one — that line is the tenant
              boundary and it does not move.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>The other jobs {who} does</DialogTitle>
          <DialogDescription>
            Their main role stays <strong className="text-white">{ROLE_LABELS[user.role]}</strong>.
            Anything picked here is a second hat they can put on from their own account menu —
            one at a time, never both at once. Use it for the supervisor who also drives, rather
            than a second login.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5">
          {offered.map(({ role }) => {
            const on = picked.has(role);
            const blocked = !on && atCap;
            return (
              <li key={role}>
                <label
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors',
                    on
                      ? 'border-gold/50 bg-gold/5'
                      : 'border-navy-secondary hover:border-silver/40',
                    blocked && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-gold"
                    checked={on}
                    disabled={blocked || saving}
                    onChange={() => toggle(role)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-white">{ROLE_LABELS[role]}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-silver/70">
                      {ROLE_DESCRIPTIONS[role]}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <p className="text-2xs text-silver/60">
          At most {MAX_ADDITIONAL_ROLES}. You can only grant a role whose access you already
          have yourself, and every grant and every switch is written to the audit log.
        </p>

        <DialogFooter>
          {revokingActive && (
            <span className="mr-auto self-center text-xs text-warning">
              They are working as {ROLE_LABELS[user.activeRole!]} right now — this puts them
              back on {ROLE_LABELS[user.role]} and signs them out.
            </span>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!dirty}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
