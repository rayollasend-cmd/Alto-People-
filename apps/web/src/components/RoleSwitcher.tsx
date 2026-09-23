import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronRight, Loader2, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/DropdownMenu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * Switch hats.
 *
 * Some people do two jobs — the shift supervisor at Front Beach who also
 * drives the Sunday van. They are one person with one email, and making
 * them keep a second login means two profiles, two sets of notifications,
 * and a driver nobody can tie back to the supervisor who ran the shift.
 *
 * So the account holds both roles and wears one at a time. This is where
 * they change. It renders nothing at all for the overwhelming majority of
 * accounts, which have exactly one role — a switcher that is always there
 * offering one option is just a menu item that lies.
 *
 * Switching is the whole app changing underneath them, so it says so: the
 * new role by name, a line about what that role does, and a return to the
 * dashboard rather than leaving them on a page the new role cannot open.
 *
 * Two shapes. On a desktop the sidebar's account menu has room beside it
 * for a submenu (RoleSwitcher). A phone does not: the submenu opened beside
 * a menu that already filled the screen, got squeezed into a 155px column
 * on top of it, and cut the role names off — the half you came to read. So
 * the phone's account menu offers one row (RoleSwitchItem) that hands off
 * to a full-width bottom sheet (RoleSwitchSheet), like every other choice
 * the app asks for on a phone.
 */

const INTRO = 'This account does more than one job. Pick the one you are doing now.';

function useRoleSwitch(onSwitched?: () => void) {
  const { role, primaryRole, availableRoles, switchRole } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState<Role | null>(null);

  // Defensive: an offline session saved before this shipped, or an older
  // server, carries no role list at all — which correctly means "one hat"
  // and must not throw its way through the account menu.
  const roles = availableRoles ?? [];

  const pick = async (next: Role) => {
    if (next === role || pending) return;
    setPending(next);
    try {
      await switchRole(next);
      toast.success(`You are now working as ${ROLE_LABELS[next]}.`);
      onSwitched?.();
      // The page they were on belonged to the old role. Home is the one
      // route every role can open.
      navigate('/', { replace: true });
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : 'Could not switch. Check your connection and try again.',
      );
    } finally {
      setPending(null);
    }
  };

  return { role, primaryRole, roles, pending, pick, canSwitch: !!role && roles.length >= 2 };
}

/** One role: the tick (or spinner), its name, and what it actually does —
 *  because "Driver" is only obvious to the person who set the account up. */
function RoleRow({
  r,
  active,
  pending,
  isMain,
}: {
  r: Role;
  active: boolean;
  pending: boolean;
  isMain: boolean;
}) {
  return (
    <>
      {pending ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-gold" aria-hidden="true" />
      ) : active ? (
        <Check className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm">
          {ROLE_LABELS[r]}
          {isMain && <span className="ml-1.5 text-2xs text-silver/50">main</span>}
        </span>
        <span className="mt-0.5 block whitespace-normal text-2xs leading-snug text-silver/60">
          {ROLE_DESCRIPTIONS[r]}
        </span>
      </span>
      {active && <span className="sr-only">(you are working as this now)</span>}
    </>
  );
}

/** Desktop: a submenu of the sidebar's account menu. */
export function RoleSwitcher({ onSwitched }: { onSwitched?: () => void }) {
  const { role, primaryRole, roles, pending, pick, canSwitch } = useRoleSwitch(onSwitched);
  if (!canSwitch || !role) return null;

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Repeat className="h-4 w-4" />
          Switch role
          <span className="ml-auto max-w-[8rem] truncate text-xs text-silver">
            {ROLE_LABELS[role]}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          // Radix never shrinks a submenu to fit — it only flips it to the
          // other side. Take the room Radix says it actually has (min-w-0
          // because the primitive's 10rem floor can be wider than that),
          // and scroll rather than clip when four hats and their
          // descriptions are taller than the window.
          className="max-h-[var(--radix-dropdown-menu-content-available-height,100dvh)] min-w-0 max-w-[min(18rem,var(--radix-dropdown-menu-content-available-width,18rem))] overflow-y-auto"
        >
          <DropdownMenuLabel className="text-2xs font-normal normal-case text-silver/70">
            {INTRO}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {roles.map((r) => (
            <DropdownMenuItem
              key={r}
              disabled={pending !== null}
              onSelect={(e) => {
                e.preventDefault();
                void pick(r);
              }}
            >
              <RoleRow r={r} active={r === role} pending={pending === r} isMain={r === primaryRole} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

/**
 * Phone: the account menu's row for it. Selecting it lets the menu close
 * and opens the sheet, which the caller renders OUTSIDE the menu — a
 * sheet inside the menu's content would unmount with it.
 */
export function RoleSwitchItem({ onOpen }: { onOpen: () => void }) {
  const { role, canSwitch } = useRoleSwitch();
  if (!canSwitch || !role) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onOpen}>
        <Repeat className="h-4 w-4" />
        Switch role
        <span className="ml-auto flex min-w-0 items-center gap-1 text-xs text-silver">
          <span className="truncate">{ROLE_LABELS[role]}</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-silver/70" aria-hidden="true" />
        </span>
      </DropdownMenuItem>
    </>
  );
}

/** Phone: the choice itself, full width, one big row per hat. */
export function RoleSwitchSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { role, primaryRole, roles, pending, pick, canSwitch } = useRoleSwitch(() =>
    onOpenChange(false),
  );
  if (!canSwitch || !role) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch role</DialogTitle>
          <DialogDescription>{INTRO}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="Switch role" className="grid gap-2">
          {roles.map((r) => {
            const active = r === role;
            return (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={pending !== null}
                onClick={() => void pick(r)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-60',
                  active ? 'border-gold ring-1 ring-gold/60' : 'border-navy-secondary hover:border-silver/40',
                )}
              >
                <RoleRow r={r} active={active} pending={pending === r} isMain={r === primaryRole} />
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
