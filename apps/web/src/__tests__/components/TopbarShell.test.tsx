import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { PageTitleProvider, usePublishPageTitle, usePublishPageUp } from '@/lib/pageTitle';
import { Topbar, backCrumbOf } from '@/components/Topbar';

/**
 * The top bar names every page (its nav label when the page published
 * none — never the wordmark), gives a phone's page name the room (help and
 * the assistant live in the account menu there), and keeps a Back to an
 * area (Settings & trust) whose pages sit at the top level of the URL.
 */

function Publish({ title, crumbs, up }: { title?: string; crumbs?: { label: string; to?: string }[]; up?: { label: string; to: string } }) {
  usePublishPageTitle(title ?? null, crumbs ?? null);
  usePublishPageUp(up ?? null);
  return null;
}

function renderAt(path: string, publish: React.ReactNode = null, onOpenHelp = vi.fn(), onOpenCommandPalette = vi.fn()) {
  window.history.replaceState({ idx: 1 }, '', path);
  const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
  render(
    <AuthContext.Provider
      value={{
        isInitializing: false,
        isOffline: false,
        user: { id: 'u', email: 'hr@altohr.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE', clientId: null, associateId: null },
        role: 'HR_ADMINISTRATOR',
        capabilities: new Set<Capability>(caps),
        signIn: vi.fn(),
        signOut: vi.fn(),
        can: (c: Capability) => caps.has(c),
      }}
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PageTitleProvider>
          <TooltipProvider>
            <MemoryRouter initialEntries={[path]}>
              {publish}
              <Topbar onOpenCommandPalette={onOpenCommandPalette} onOpenHelp={onOpenHelp} />
            </MemoryRouter>
          </TooltipProvider>
        </PageTitleProvider>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return { onOpenHelp, onOpenCommandPalette };
}

describe('the top bar’s name for a page', () => {
  it('a page that published nothing is named by the nav, not the wordmark', () => {
    renderAt('/assets');
    expect(within(screen.getByTestId('topbar-title')).getByRole('heading')).toHaveTextContent('Assets');
  });

  it('the home page is Home', () => {
    renderAt('/');
    expect(within(screen.getByTestId('topbar-title')).getByRole('heading')).toHaveTextContent('Home');
  });

  it('a published title still wins', () => {
    renderAt('/assets', <Publish title="Laptops" />);
    expect(within(screen.getByTestId('topbar-title')).getByRole('heading')).toHaveTextContent('Laptops');
  });

  it('gives the name the room on a phone: at least 40% of the bar', () => {
    renderAt('/assets');
    expect(screen.getByTestId('topbar-title').className).toContain('min-w-[40%]');
  });
});

describe('Back', () => {
  it('names the nearest crumb that is a place — a section heading has no page', () => {
    expect(backCrumbOf([{ label: 'Settings & trust', to: '/admin' }, { label: 'Access & trust' }, { label: 'Users & access' }])).toEqual({ label: 'Settings & trust', to: '/admin' });
    expect(backCrumbOf([{ label: 'Payroll', to: '/payroll' }, { label: 'Banking' }])).toEqual({ label: 'Payroll', to: '/payroll' });
    expect(backCrumbOf([{ label: 'Only' }])).toBeNull();
  });

  it('an area page at the top of the URL (/audit) still gets Back to the area', () => {
    renderAt('/audit', <Publish title="Audit log" crumbs={[{ label: 'Settings & trust', to: '/admin' }, { label: 'Access & trust' }, { label: 'Audit log' }]} up={{ label: 'Settings & trust', to: '/admin' }} />);
    expect(screen.getByRole('button', { name: 'Settings & trust' })).toBeInTheDocument();
  });

  it('a top-level page outside an area keeps the logo, not a Back', () => {
    renderAt('/audit', <Publish title="Audit log" />);
    expect(screen.queryByRole('button', { name: /Settings & trust|Back/ })).not.toBeInTheDocument();
  });
});

describe('the account menu on a phone', () => {
  it('holds help for the page (moved off the crowded bar)', async () => {
    const { onOpenHelp } = renderAt('/assets');
    // Help's bar button is desktop-only now.
    expect(screen.getByRole('button', { name: 'Help for this page' }).className).toContain('hidden');
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Help for this page' }));
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
  });
});

describe('a phone detail page', () => {
  it('with Back in the bar, search moves into the account menu so the page’s name keeps its room', async () => {
    const palette = vi.fn();
    renderAt('/payroll/banking', <Publish title="Payroll banking" crumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Payroll banking' }]} />, vi.fn(), palette);
    expect(screen.getByRole('button', { name: 'Payroll' })).toBeInTheDocument();
    const phoneSearch = screen.getAllByRole('button', { name: 'Open command palette' }).find((b) => b.className.includes('md:hidden'))!;
    expect(phoneSearch.className).toMatch(/(^|\s)hidden(\s|$)/);
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Search or jump to…' }));
    expect(palette).toHaveBeenCalledTimes(1);
  });
});

describe('publishing a trail', () => {
  it('a trail rebuilt on every render (an area’s) settles — publishing it does not loop', () => {
    let renders = 0;
    function FreshTrail() {
      renders += 1;
      // A new array each render, equal in content.
      usePublishPageTitle('Users & access', [{ label: 'Settings & trust', to: '/admin' }, { label: 'Users & access' }]);
      return null;
    }
    renderAt('/admin/users', <FreshTrail />);
    expect(renders).toBeLessThan(10);
    expect(within(screen.getByTestId('topbar-title')).getByText('Users & access')).toBeInTheDocument();
  });
});
