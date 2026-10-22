import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import { PageTitleProvider } from '@/lib/pageTitle';
import { PageHeader } from '@/components/ui/PageHeader';
import { SettingsArea } from '@/pages/settings/SettingsArea';
import { useSettingsRail } from '@/pages/settings/settingsRail';
import { MODULES } from '@/lib/modules';

/**
 * Settings & trust, as one area: its rail is the one source for the
 * names and the trail of every page in it; the overview has no rail (its
 * cards are the same list); below lg there is no rail strip (Back goes to
 * the overview).
 */

const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
function Auth({ children }: { children: ReactNode }) {
  return (
    <AuthContext.Provider
      value={{ user: { id: 'u1', email: 'hr@x.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE' }, tenant: DEFAULT_TENANT, can: (c: Capability) => caps.has(c) } as never}
    >
      {children}
    </AuthContext.Provider>
  );
}

function renderArea(path: string) {
  return render(
    <Auth>
      <PageTitleProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<SettingsArea />}>
              <Route path="/admin" element={<PageHeader title="Settings & trust" />} />
              {/* A page written with its own (wrong) crumb: the area's wins. */}
              <Route path="/admin/users" element={<PageHeader title="Users & access" breadcrumbs={[{ label: 'Settings' }, { label: 'Users & access' }]} />} />
              <Route path="/integrations/connections/:id" element={<PageHeader title="Workday" breadcrumbs={[{ label: 'Integrations', to: '/integrations' }, { label: 'Workday' }]} />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </PageTitleProvider>
    </Auth>,
  );
}

describe('<SettingsArea>', () => {
  it('a page’s trail comes from the rail: Settings & trust › its section, whatever the page wrote', () => {
    renderArea('/admin/users');
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Settings & trust' })).toHaveAttribute('href', '/admin');
    expect(within(trail).getByText('Access & trust')).toBeInTheDocument();
    expect(within(trail).queryByText('Settings')).not.toBeInTheDocument();
  });

  it('a page below a rail item links the item and names itself', () => {
    renderArea('/integrations/connections/c1');
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Integrations' })).toHaveAttribute('href', '/integrations');
  });

  it('the overview has no rail — its cards are the same list', () => {
    renderArea('/admin');
    expect(screen.queryByTestId('settings-rail')).not.toBeInTheDocument();
  });

  it('a page in the area keeps the rail on a laptop and drops it below lg (no 27-link strip on a phone)', () => {
    renderArea('/admin/users');
    const railNav = screen.getByTestId('settings-rail');
    expect(railNav.className).toContain('hidden');
    expect(railNav.className).toContain('lg:flex');
    // No eyebrow above the page: the trail carries the area's name.
    expect(screen.queryByText('Settings & Trust')).not.toBeInTheDocument();
  });

  it('rail names never truncate: two lines and the whole name on hover', () => {
    renderArea('/admin/users');
    const item = within(screen.getByTestId('settings-rail')).getByText('Cost centers & ledger codes');
    expect(item).toHaveAttribute('title', 'Cost centers & ledger codes');
    expect(item.className).not.toContain('truncate');
  });
});

describe('useSettingsRail — one source for the names', () => {
  it('a rail row that is a module takes the module’s name (the sidebar’s, the page’s, the trail’s)', () => {
    const rail = renderHook(() => useSettingsRail(), { wrapper: Auth }).result.current;
    const label = (k: string) => rail.find((i) => i.key === k)?.label;
    expect(label('audit')).toBe(MODULES.find((m) => m.key === 'audit')!.label);
    expect(label('approval-record')).toBe('Approval record');
    expect(label('trust')).toBe(MODULES.find((m) => m.key === 'trust-center')!.label);
    expect(label('organization')).toBe(MODULES.find((m) => m.key === 'tenant-profile')!.label);
    // Pages only the rail lists keep its own words.
    expect(label('agents')).toBe('Agents & gates');
  });
});

vi.mock('@/lib/inboxApi', () => ({ useInbox: () => ({ data: { total: 0, sources: [] } }) }));
