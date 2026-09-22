import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { RoleSwitcher } from '@/components/RoleSwitcher';

/**
 * The account switcher: for the shift supervisor who also drives the van.
 *
 * The two things that matter are that it is INVISIBLE to the ~everyone
 * who has one job, and that when it is visible it actually changes the
 * account rather than only the label.
 */

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'rosa.m@altohr.com',
  role: 'SHIFT_SUPERVISOR' as Role,
  status: 'ACTIVE' as const,
  clientId: null,
  associateId: null,
  firstName: 'Rosa',
  lastName: 'Martinez',
  photoUrl: null,
  timezone: null,
  mfaEnabled: false,
};

function renderMenu(
  overrides: Partial<{
    role: Role;
    primaryRole: Role;
    availableRoles: Role[] | undefined;
    switchRole: (r: Role) => Promise<void>;
  }> = {},
) {
  const role = overrides.role ?? 'SHIFT_SUPERVISOR';
  const switchRole = overrides.switchRole ?? vi.fn(async () => {});
  const value = {
    isInitializing: false,
    isOffline: false,
    user: { ...USER, role },
    role,
    primaryRole: overrides.primaryRole ?? 'SHIFT_SUPERVISOR',
    availableRoles:
      overrides.availableRoles === undefined && !('availableRoles' in overrides)
        ? ['SHIFT_SUPERVISOR' as Role, 'DRIVER' as Role]
        : (overrides.availableRoles as Role[]),
    capabilities: ROLE_CAPABILITIES[role],
    signIn: vi.fn(),
    submitMfaChallenge: vi.fn(),
    signOut: vi.fn(),
    refreshUser: vi.fn(),
    switchRole,
    can: () => true,
  };
  render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <AuthContext.Provider value={value as any}>
      <MemoryRouter>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Account</DropdownMenuTrigger>
          <DropdownMenuContent>
            <RoleSwitcher />
          </DropdownMenuContent>
        </DropdownMenu>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return { switchRole };
}

describe('the role switcher', () => {
  it('is not there at all for an account with one job', () => {
    renderMenu({ availableRoles: ['SHIFT_SUPERVISOR'] });
    expect(screen.queryByText(/Switch role/i)).not.toBeInTheDocument();
  });

  it('survives a session saved before this existed', () => {
    // An offline session or an older server says nothing about roles,
    // which means one — not a crash on the way to the account menu.
    renderMenu({ availableRoles: undefined });
    expect(screen.queryByText(/Switch role/i)).not.toBeInTheDocument();
  });

  it('offers the other job, and switching calls the account through', async () => {
    const switchRole = vi.fn(async () => {});
    renderMenu({ switchRole });

    await userEvent.click(screen.getByText(/Switch role/i));
    // Named, and described — "Driver" is only obvious to whoever set the
    // account up.
    expect(await screen.findByText('Driver')).toBeInTheDocument();
    expect(screen.getByText(/Drives an Alto van/i)).toBeInTheDocument();

    // By the menu item, not the label — the submenu trigger also shows
    // the current role's name.
    const driver = screen.getByRole('menuitem', { name: /Drives an Alto van/i });
    // This account's two hats and nothing else. Offering the fifteen roles
    // that exist is both wrong and the fastest way back to a menu taller
    // than the phone it opened on.
    expect(within(driver.closest('[role="menu"]')!).getAllByRole('menuitem')).toHaveLength(2);

    await userEvent.click(driver);
    expect(switchRole).toHaveBeenCalledWith('DRIVER');
  });

  it('is bounded by the screen it opened on, and scrolls instead of clipping', async () => {
    // The owner's report: on a phone the submenu opened ~145px off the LEFT
    // edge. Radix flips a menu that does not fit, but it never shrinks one —
    // so an 18rem submenu beside a 15rem account menu hung off a 390px
    // screen, and the half that fell outside was the left half: the tick and
    // the role's name. Both axes have to stay inside the room Radix reports.
    renderMenu();
    await userEvent.click(screen.getByText(/Switch role/i));
    const menu = (await screen.findByRole('menuitem', { name: /Drives an Alto van/i }))
      .closest('[role="menu"]')!;

    expect(menu.className).toMatch(
      /max-w-\[min\(18rem,var\(--radix-dropdown-menu-content-available-width/,
    );
    expect(menu.className).toMatch(
      /max-h-\[var\(--radix-dropdown-menu-content-available-height/,
    );
    // A height cap that clips rather than scrolls just hides the last hat
    // instead of the first.
    expect(menu.className).toContain('overflow-y-auto');
    // The primitive's own 10rem floor is wider than a phone leaves beside an
    // open account menu, so the cap has to outrank it.
    expect(menu.className).toContain('min-w-0');
    expect(menu.className).not.toMatch(/min-w-\[/);
  });

  it('marks the hat currently being worn, and does not re-switch to it', async () => {
    const switchRole = vi.fn(async () => {});
    renderMenu({ role: 'DRIVER', switchRole });

    await userEvent.click(screen.getByText(/Switch role/i));
    expect(
      await screen.findByText(/you are working as this now/i),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('menuitem', { name: /Drives an Alto van/i }));
    expect(switchRole).not.toHaveBeenCalled();
  });
});
