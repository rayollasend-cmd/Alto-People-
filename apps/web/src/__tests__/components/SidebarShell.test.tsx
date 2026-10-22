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

  it('Recent never repeats a pinned row, an always-on row, a row in an open door, or the page in view', () => {
    personal.pinned = ['messages'];
    personal.recents = ['inbox', 'messages', 'payroll-banking', 'documents', 'payroll'];
    rail('HR_ADMINISTRATOR', '/payroll');
    const recent = within(nav()).getByRole('button', { name: 'Recent' }).parentElement!;
    const names = within(recent).getAllByRole('link').map((l) => l.textContent);
    // Inbox (always on), Messages (pinned), Payroll (here) and Payroll banking
    // (the open Pay door) are already on screen; Documents is not.
    expect(names).toEqual(['Documents']);
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
