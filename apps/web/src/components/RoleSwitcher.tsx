import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from '@alto-people/shared';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/DropdownMenu';
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
 */
export function RoleSwitcher({ onSwitched }: { onSwitched?: () => void }) {
  const { role, primaryRole, availableRoles, switchRole } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState<Role | null>(null);

  // Defensive: an offline session saved before this shipped, or an older
  // server, carries no role list at all — which correctly means "one hat"
  // and must not throw its way through the account menu.
  const roles = availableRoles ?? [];
  if (!role || roles.length < 2) return null;

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
          // other side. On a phone an 18rem menu opening beside a 15rem
          // account menu does not fit on either side, so it flipped left and
          // hung ~145px off the screen: the tick and the role's NAME are the
          // half that lands outside, which is the half you came here to read.
          // So take the room Radix says it actually has (min-w-0 because the
          // primitive's 10rem floor is itself wider than what a phone leaves
          // beside an open menu), and scroll rather than clip when four hats
          // and their descriptions are taller than the screen.
          className="max-h-[var(--radix-dropdown-menu-content-available-height,100dvh)] min-w-0 max-w-[min(18rem,var(--radix-dropdown-menu-content-available-width,18rem))] overflow-y-auto"
        >
          <DropdownMenuLabel className="text-2xs font-normal normal-case text-silver/70">
            This account does more than one job. Pick the one you are doing now.
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {roles.map((r) => {
            const active = r === role;
            return (
              <DropdownMenuItem
                key={r}
                disabled={pending !== null}
                onSelect={(e) => {
                  e.preventDefault();
                  void pick(r);
                }}
              >
                {pending === r ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-gold" aria-hidden="true" />
                ) : active ? (
                  <Check className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
                ) : (
                  <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm">
                    {ROLE_LABELS[r]}
                    {r === primaryRole && roles.length > 1 && (
                      <span className="ml-1.5 text-2xs text-silver/50">main</span>
                    )}
                  </span>
                  {/* What the role actually does, because "Driver" is only
                      obvious to the person who set the account up. */}
                  <span className="mt-0.5 block whitespace-normal text-2xs leading-snug text-silver/60">
                    {ROLE_DESCRIPTIONS[r]}
                  </span>
                </span>
                {active && (
                  <span className="sr-only">(you are working as this now)</span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}
