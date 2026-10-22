import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROLE_CAPABILITIES } from '@alto-people/shared';
import { renderAs } from '../pages/hrPack/harness';
import { tabSetFor } from '@/components/BottomTabBar';

// Phone unless a test says otherwise (the tab bar is on screen).
let phone = true;
vi.mock('@/lib/useViewport', () => ({ useMediaQuery: () => phone }));
vi.mock('@/lib/inboxApi', () => ({ useInbox: () => ({ data: { total: 14, sources: [{ path: '/payroll/banking', count: 2 }] } }) }));
const setClientId = vi.fn();
let scope = { enabled: false, clients: [] as Array<{ id: string; name: string }>, clientId: '', setClientId };
vi.mock('@/lib/storeScope', async (orig) => ({
  ...(await orig<typeof import('@/lib/storeScope')>()),
  useStoreScope: () => scope,
}));

import { MobileNav } from '@/components/MobileNav';
import { ThemeProvider } from '@/lib/theme';

const sheet = (route = '/', role: Parameters<typeof renderAs>[0] = 'HR_ADMINISTRATOR') =>
  renderAs(
    role,
    <ThemeProvider>
      <MobileNav open onClose={() => undefined} onOpenCommandPalette={() => undefined} />
    </ThemeProvider>,
    route,
  );

beforeEach(() => {
  phone = true;
  scope = { enabled: false, clients: [], clientId: '', setClientId };
  setClientId.mockReset();
  localStorage.clear();
});

describe('<MobileNav> — the phone menu sheet', () => {
  it('starts with sections closed, each one a tap away, with its count on the heading', async () => {
    sheet();
    const pay = screen.getByRole('button', { name: /pay & finance/i });
    expect(pay).toHaveAttribute('aria-expanded', 'false');
    expect(within(pay).getByText('2')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /payroll banking/i })).toBeNull();
    await userEvent.click(pay);
    expect(pay).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /payroll banking/i })).toBeInTheDocument();
  });

  it('the section holding this page opens itself', () => {
    sheet('/payroll/banking');
    expect(screen.getByRole('button', { name: /pay & finance/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /payroll banking/i })).toHaveAttribute('aria-current', 'page');
  });

  it('on a phone it leaves out what the tab bar already has; on a tablet it is the whole menu', () => {
    const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
    const tabs = tabSetFor({ role: 'HR_ADMINISTRATOR' }, (c) => caps.has(c)).map((t) => t.path);
    expect(tabs).toContain('/');
    const first = sheet();
    expect(screen.queryByRole('link', { name: /^home$/i })).toBeNull();
    first.unmount();
    phone = false;
    sheet();
    expect(screen.getByRole('link', { name: /^home$/i })).toBeInTheDocument();
  });

  it('language and theme are one quiet row that opens in place', async () => {
    sheet();
    const row = screen.getByRole('button', { name: /display & language/i });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('combobox', { name: /language/i })).toBeNull();
    await userEvent.click(row);
    expect(screen.getByRole('combobox', { name: /language/i })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: /theme/i })).toBeInTheDocument();
  });

  it('an admin picks the client scope from chips at the top', async () => {
    scope = { enabled: true, clients: [{ id: 'c1', name: 'Coastal Resort Holdings' }, { id: 'c2', name: 'Seaside Hospitality Group' }], clientId: '', setClientId };
    sheet();
    const group = screen.getByRole('group', { name: /client scope/i });
    expect(within(group).getByRole('button', { name: /all clients/i })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(group).getByRole('button', { name: /seaside/i }));
    expect(setClientId).toHaveBeenCalledWith('c2');
  });

  it('an associate reads "Paystubs" under My pay, not the office’s "Payroll"', async () => {
    // At tablet width (on a phone it's the Pay tab, so the sheet leaves it out).
    phone = false;
    sheet('/', 'ASSOCIATE');
    await userEvent.click(screen.getByRole('button', { name: /my pay/i }));
    expect(screen.getByRole('link', { name: /paystubs/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^payroll$/i })).toBeNull();
  });
});

describe('tab bar', () => {
  it('the ops admin’s Approvals tab carries the waiting count, like the supervisor’s', () => {
    const caps = ROLE_CAPABILITIES.OPERATIONS_MANAGER;
    const approvals = tabSetFor({ role: 'OPERATIONS_MANAGER' }, (c) => caps.has(c)).find((t) => t.path === '/approvals');
    expect(approvals?.badge).toBe('approvals');
  });

  it('the HR admin’s Inbox tab carries the Inbox total (HR walk 14)', () => {
    const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
    const tabs = tabSetFor({ role: 'HR_ADMINISTRATOR' }, (c) => caps.has(c));
    expect(tabs.map((t) => t.path)).toEqual(['/', '/inbox', '/people', '/onboarding']);
    expect(tabs.find((t) => t.path === '/inbox')?.badge).toBe('inbox');
  });
});
