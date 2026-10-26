import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderAs } from '../pages/hrPack/harness';
import { ThemeProvider } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';
import { TooltipProvider } from '@/components/ui/Tooltip';

vi.mock('@/lib/inboxApi', () => ({ useInbox: () => ({ data: { total: 0, sources: [] } }) }));
const personal = vi.hoisted(() => ({ pinned: [] as string[], recents: [] as string[] }));
vi.mock('@/lib/navPersonalization', () => ({
  usePinnedModules: () => ({ pinned: personal.pinned, isPinned: (k: string) => personal.pinned.includes(k), togglePin: vi.fn() }),
  useRecentModules: () => personal.recents,
}));

import { Sidebar } from '@/components/Sidebar';
import { MODULES, navShapeFor, visibleModules } from '@/lib/modules';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';

/**
 * The sidebar (F500 fix-up): names that fit (two lines, the whole name on
 * hover), the highlight on the page you are on, a "Recent" that never
 * repeats what is already on screen, and a store account's home listed once.
 */

function rail(role: Parameters<typeof renderAs>[0], route = '/') {
  return renderAs(
    role,
    <ThemeProvider>
      <DensityProvider>
        <TooltipProvider>
          <Sidebar />
        </TooltipProvider>
      </DensityProvider>
    </ThemeProvider>,
    route,
  );
}

const nav = () => screen.getByRole('navigation', { name: 'Primary navigation' });

beforeEach(() => {
  localStorage.clear();
  personal.pinned = [];
  personal.recents = [];
});

describe('<Sidebar>', () => {
  it('long names wrap to two lines and carry the whole name on hover — never “Departments & job profi…”', () => {
    rail('HR_ADMINISTRATOR', '/org');
    const link = within(nav()).getByRole('link', { name: /Departments & job profiles/ });
    const label = within(link).getByText('Departments & job profiles');
    expect(label).toHaveAttribute('title', 'Departments & job profiles');
    expect(label.className).toContain('line-clamp-2');
    expect(label.className).not.toContain('truncate');
  });

  it('Recent never repeats a pinned row, an always-on row or the page in view — and stays put from page to page', () => {
    personal.pinned = ['messages'];
    personal.recents = ['inbox', 'messages', 'team', 'payroll-banking', 'documents', 'payroll'];
    rail('HR_ADMINISTRATOR', '/payroll');
    const recent = within(nav()).getByRole('button', { name: 'Recent' }).parentElement!;
    const names = within(recent).getAllByRole('link').map((l) => l.textContent);
    // Inbox (always on), Messages (pinned), My team (a door drawn as one row)
    // and Payroll (here) are left out. Which doors are open no longer
    // decides it, so the group does not appear and vanish (F500 2026-10-26).
    expect(names).toEqual(['Payroll banking', 'Documents']);
    // Nothing in Recent lights: the page lights in its own place only.
    for (const l of within(recent).getAllByRole('link')) expect(l).not.toHaveAttribute('aria-current', 'page');
  });

  it('one active location: a page behind two doors lights in the door that holds it only', () => {
    rail('HR_ADMINISTRATOR', '/audit');
    const lit = within(nav()).getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');
    expect(lit.length).toBeLessThanOrEqual(1);
  });

  it('the transport director’s home IS the Transportation desk: that row lights, not Home', () => {
    rail('TRANSPORTATION_DIRECTOR', '/');
    expect(within(nav()).getByRole('link', { name: /Transportation/ })).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current', 'page');
  });

  it('the account footer says the role in full, never "TRANSPORTATION DIRE…"', () => {
    rail('TRANSPORTATION_DIRECTOR', '/transport');
    const role = screen.getByTestId('sidebar-role');
    expect(role.className).not.toContain('truncate');
    expect(role.className).not.toContain('uppercase');
    expect(role.className).toContain('line-clamp-2');
  });

  it('/audit/approvals lights Settings & trust — where the approval record lives — not Audit log', () => {
    rail('HR_ADMINISTRATOR', '/audit/approvals');
    expect(within(nav()).getByRole('link', { name: /Settings & trust/ })).toHaveAttribute('aria-current', 'page');
    const audit = within(nav()).queryByRole('link', { name: /Audit log/ });
    if (audit) expect(audit).not.toHaveAttribute('aria-current', 'page');
  });
});

describe('a store account’s menu', () => {
  it('lists its home once: Home, not Home and My store (one page)', () => {
    const caps = ROLE_CAPABILITIES.CLIENT_PORTAL;
    const visible = visibleModules('CLIENT_PORTAL', (c: Capability) => caps.has(c), {});
    expect(visible.some((m) => m.key === 'portal')).toBe(true);
    const shape = navShapeFor(visible, 'CLIENT_PORTAL', (k) => k);
    expect(shape.rows.map((m) => m.key)).not.toContain('portal');
    expect(shape.rows.map((m) => m.key)).not.toContain('region');
  });

  it('Home lights on the store page wherever it was reached from', () => {
    rail('CLIENT_PORTAL', '/portal');
    expect(within(nav()).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).queryByRole('link', { name: 'My store' })).not.toBeInTheDocument();
  });

  it('the approval record is a page of Settings & trust in the nav model too', () => {
    const settings = MODULES.find((m) => m.key === 'approval-record');
    expect(settings).toMatchObject({ path: '/audit/approvals', label: 'Approval record' });
  });
});
