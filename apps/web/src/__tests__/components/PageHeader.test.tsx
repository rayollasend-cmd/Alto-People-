import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { Download, Trash2 } from 'lucide-react';

// The header's shape depends on the screen: desktop unless a test says phone.
let wide = true;
vi.mock('@/lib/useViewport', async (orig) => ({
  ...(await orig<typeof import('@/lib/useViewport')>()),
  useMediaQuery: (q: string) => (/min-width/.test(q) ? wide : !wide),
}));

import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { Button } from '@/components/ui/Button';
import { PageHeader, type PageAction } from '@/components/ui/PageHeader';

/**
 * The page header (F500 fix-up 2026-10-22): one primary and at most two
 * secondary actions in view, everything else — every destructive action
 * included — in "More", destructive ones behind their confirm; on a phone
 * only the primary stays out. Key facts under the title, related pages as
 * links, the whole subtitle, and a trail that never just repeats the title.
 */

function renderHeader(ui: React.ReactElement, { path = '/somewhere', role = 'HR_ADMINISTRATOR' as Role } = {}) {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={{
        isInitializing: false,
        isOffline: false,
        user: { id: 'u', email: 'hr@altohr.com', role, status: 'ACTIVE', clientId: null, associateId: null },
        role,
        capabilities: new Set<Capability>(caps),
        signIn: vi.fn(),
        signOut: vi.fn(),
        can: (c: Capability) => caps.has(c),
      }}
    >
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </ConfirmProvider>
    </AuthContext.Provider>,
  );
}

const run = { approve: vi.fn(), export: vi.fn(), print: vi.fn(), archive: vi.fn(), remove: vi.fn() };

function actions(): PageAction[] {
  return [
    { label: 'Approve run', primary: true, onSelect: run.approve },
    { label: 'Export', icon: Download, onSelect: run.export },
    { label: 'Print', onSelect: run.print },
    { label: 'Archive', onSelect: run.archive },
    { label: 'Delete run', icon: Trash2, destructive: true, confirm: { title: 'Delete this run?' }, onSelect: run.remove },
    { label: 'Hidden one', hidden: true, onSelect: vi.fn() },
  ];
}

beforeEach(() => {
  wide = true;
  for (const f of Object.values(run)) f.mockClear();
});

describe('<PageHeader> actions — desktop', () => {
  it('shows the primary and two secondaries; the rest and every destructive action wait in More', async () => {
    renderHeader(<PageHeader title="Payroll run" actions={actions()} />);
    const row = screen.getByTestId('page-actions');
    expect(within(row).getByRole('button', { name: 'Approve run' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Print' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Delete run/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden one')).not.toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'More actions' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Archive', 'Delete run']);
    // The destructive item is last and in the alert colour.
    expect(items[1]!.className).toContain('text-alert');
  });

  it('a destructive action keeps its confirm: cancelled does nothing, confirmed runs it', async () => {
    const user = userEvent.setup();
    renderHeader(<PageHeader title="Payroll run" actions={actions()} />);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete run' }));
    expect(await screen.findByRole('dialog', { name: 'Delete this run?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(run.remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete run' }));
    await user.click(await screen.findByRole('button', { name: 'Delete this run' }));
    expect(run.remove).toHaveBeenCalledTimes(1);
  });

  it('a secondary in view runs on click; a link action is a link', async () => {
    renderHeader(<PageHeader title="People" actions={[{ label: 'Invite', primary: true, to: '/people/invite' }, { label: 'Export', onSelect: run.export }]} />);
    expect(screen.getByRole('link', { name: 'Invite' })).toHaveAttribute('href', '/people/invite');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(run.export).toHaveBeenCalledTimes(1);
    // Two actions: nothing to tuck away, so no More.
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });
});

describe('<PageHeader> actions — phone', () => {
  it('only the primary stays out; everything else opens in one sheet, destructive last', async () => {
    wide = false;
    renderHeader(<PageHeader title="Payroll run" actions={actions()} />);
    const row = screen.getByTestId('page-actions');
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['Approve run', 'More']);
    await userEvent.click(within(row).getByRole('button', { name: 'More actions' }));
    const sheet = await screen.findByRole('dialog', { name: 'More actions' });
    const labels = within(sheet).getAllByRole('button').map((b) => b.textContent).filter((l) => l !== '');
    expect(labels.slice(0, 4)).toEqual(['Export', 'Print', 'Archive', 'Delete run']);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Print' }));
    await vi.waitFor(() => expect(run.print).toHaveBeenCalledTimes(1));
  });

  it('a lone secondary stays a button — a menu of one is a detour', () => {
    wide = false;
    renderHeader(<PageHeader title="Reports" actions={[{ label: 'Export', onSelect: run.export }]} />);
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('a page still on React-node actions: its secondaries move into the sheet, the primary stays', async () => {
    wide = false;
    renderHeader(
      <PageHeader
        title="Transport"
        primaryAction={<Button>New run</Button>}
        secondaryActions={
          <>
            <Button variant="outline">Tomorrow</Button>
            <Button variant="outline">Print</Button>
          </>
        }
      />,
    );
    expect(screen.getByRole('button', { name: 'New run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tomorrow' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const sheet = await screen.findByRole('dialog', { name: 'More actions' });
    expect(within(sheet).getByRole('button', { name: 'Tomorrow' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Print' })).toBeInTheDocument();
  });

  it('on a desktop those React-node secondaries stay in the row, as before', () => {
    renderHeader(<PageHeader title="Transport" secondaryActions={<><Button>Tomorrow</Button><Button>Print</Button></>} />);
    expect(screen.getByRole('button', { name: 'Tomorrow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument();
  });
});

describe('<PageHeader> facts, related pages and the subtitle', () => {
  it('draws each key fact as label over value, links the ones with a list behind them, and hides the ones it cannot know', () => {
    renderHeader(
      <PageHeader
        title="Coastal Resort"
        facts={[
          { label: 'Billed this month', value: '$84,120.00' },
          { label: 'People working', value: '212', to: '/people?client=c1' },
          { label: 'Margin', value: null },
        ]}
      />,
    );
    const facts = screen.getByTestId('page-facts');
    expect(within(facts).getByText('Billed this month')).toBeInTheDocument();
    expect(within(facts).getByText('$84,120.00')).toBeInTheDocument();
    expect(within(facts).getByRole('link', { name: '212' })).toHaveAttribute('href', '/people?client=c1');
    // No number, no tile: never a stand-in "0" or "—" for what we don't have.
    expect(within(facts).queryByText('Margin')).not.toBeInTheDocument();
  });

  it('sibling pages are links under the title, not buttons', () => {
    renderHeader(<PageHeader title="Onboarding" related={[{ label: 'Templates', to: '/onboarding/templates' }, { label: 'Analytics', to: '/onboarding/analytics' }]} />);
    const nav = screen.getByRole('navigation', { name: 'Related' });
    expect(within(nav).getByRole('link', { name: 'Templates' })).toHaveAttribute('href', '/onboarding/templates');
    expect(within(nav).queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the whole subtitle on a phone (no two-line clamp)', () => {
    wide = false;
    renderHeader(<PageHeader title="My record" subtitle="Acknowledging confirms you received and read a notice — it does not mean you agree with it." />);
    const p = screen.getByText(/it does not mean you agree with it/);
    expect(p.className).not.toMatch(/line-clamp/);
  });
});

describe('<PageHeader> breadcrumbs', () => {
  it('a lone crumb that only repeats the title is not drawn', () => {
    renderHeader(<PageHeader title="People" breadcrumbs={[{ label: 'People' }]} />);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
  });

  it('the trail stops at the parent when the page’s own name is the heading below it', () => {
    renderHeader(<PageHeader title="Mass update" breadcrumbs={[{ label: 'People', to: '/people' }, { label: 'Mass update' }]} />);
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'People' })).toHaveAttribute('href', '/people');
    expect(within(trail).queryByText('Mass update')).not.toBeInTheDocument();
  });

  it('with no trail of its own, a page gets the nav’s: the parent page the sidebar puts it under', () => {
    renderHeader(<PageHeader title="Payroll banking" />, { path: '/payroll/banking' });
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Payroll' })).toHaveAttribute('href', '/payroll');
  });

  it('`[]` asks for no trail at all', () => {
    renderHeader(<PageHeader title="Payroll banking" breadcrumbs={[]} />, { path: '/payroll/banking' });
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
  });
});
