import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../pages/hrPack/harness';
import { ThemeProvider } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';
import { TooltipProvider } from '@/components/ui/Tooltip';

vi.mock('@/lib/inboxApi', () => ({ useInbox: () => ({ data: { total: 0, sources: [] } }) }));

import { Sidebar } from '@/components/Sidebar';

/**
 * The desktop rail draws the two rearrangements: a manager's company-wide
 * doors folded under "Company admin" (ops 21), and the Pay door in its
 * five jobs (finance 5).
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

beforeEach(() => {
  localStorage.clear();
});

describe('<Sidebar>', () => {
  it('a manager sees their own doors; the company’s are one tap away under Company admin', async () => {
    rail('MANAGER');
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(within(nav).getByRole('link', { name: /Time & scheduling/ })).toBeInTheDocument();
    const fold = within(nav).getByRole('button', { name: 'Company admin' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav).queryByRole('link', { name: /Pay & finance/ })).not.toBeInTheDocument();
    await userEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: /Pay & finance/ })).toBeInTheDocument();
  });

  it('the fold opens itself when the page in view is behind it', () => {
    rail('MANAGER', '/payroll');
    expect(screen.getByRole('button', { name: 'Company admin' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('finance’s Pay door opens to its five jobs, each page once', async () => {
    rail('FINANCE_ACCOUNTANT', '/payroll');
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(expect.arrayContaining(['Run payroll', 'Taxes & filings', 'Billing & receivables']));
    const run = screen.getByRole('group', { name: 'Run payroll' });
    expect(within(run).getByRole('link', { name: /Pay schedules/ })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Garnishments/ })).toHaveLength(1);
  });
});
