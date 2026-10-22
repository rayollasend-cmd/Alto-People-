import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { PageTitleProvider } from '@/lib/pageTitle';
import { renderAs } from '../pages/hrPack/harness';

/**
 * The store scope once the client list outgrows a row of buttons: the top
 * bar's searchable picker (filter as you type, arrows/Enter/Escape, "All
 * clients" first, the current one marked, 300 clients fine) and the phone
 * menu's search above the chips. Six short names or fewer keep the
 * segments at xl.
 */

const setClientId = vi.fn();
let scope = { enabled: true, ready: true, clients: [] as Array<{ id: string; name: string }>, clientId: '', setClientId };
vi.mock('@/lib/storeScope', async (orig) => ({
  ...(await orig<typeof import('@/lib/storeScope')>()),
  useStoreScope: () => scope,
}));
vi.mock('@/lib/communicationsApi', () => ({
  listMyInbox: vi.fn(async () => ({ notifications: [], total: 0 })),
  markAllRead: vi.fn(),
  markAllSeen: vi.fn(),
  markRead: vi.fn(),
}));
let phone = false;
vi.mock('@/lib/useViewport', async (orig) => ({
  ...(await orig<typeof import('@/lib/useViewport')>()),
  useMediaQuery: () => phone,
}));
vi.mock('@/lib/inboxApi', () => ({ useInbox: () => ({ data: { total: 0, sources: [] } }) }));

import { Topbar } from '@/components/Topbar';
import { MobileNav } from '@/components/MobileNav';
import { StoreScopeCombobox, matchClients } from '@/components/StoreScopeCombobox';
import { ThemeProvider } from '@/lib/theme';

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, name: i % 10 === 0 ? `Walmart Supercenter #${i + 1}` : `Harbor Store ${i + 1}` }));
const FOUR = [
  { id: 'w1', name: 'Walmart Santa Rosa Beach' },
  { id: 'w2', name: 'Walmart Destin' },
  { id: 'w3', name: 'Walmart Fort Walton' },
  { id: 'w4', name: 'Walmart Panama City' },
];

function topbar() {
  return renderAs(
    'OPERATIONS_MANAGER',
    <PageTitleProvider>
      <TooltipProvider>
        <Topbar onOpenCommandPalette={vi.fn()} onOpenHelp={vi.fn()} />
      </TooltipProvider>
    </PageTitleProvider>,
    '/scheduling',
  );
}

beforeEach(() => {
  phone = false;
  setClientId.mockReset();
  scope = { enabled: true, ready: true, clients: FOUR, clientId: '', setClientId };
});

describe('the top bar picks segments or the searchable picker', () => {
  it('six short names or fewer: segments at xl, the picker below it', () => {
    topbar();
    expect(screen.getByTestId('store-scope-segments').className).toContain('xl:inline-flex');
    expect(screen.getByTestId('store-scope-select').className).toContain('xl:hidden');
    expect(screen.getByRole('combobox', { name: 'Store scope' })).toHaveAttribute('aria-haspopup', 'listbox');
  });

  it('more than six clients: the picker only, at every desktop width', () => {
    scope = { ...scope, clients: many(7) };
    topbar();
    expect(screen.queryByTestId('store-scope-segments')).not.toBeInTheDocument();
    const picker = screen.getByTestId('store-scope-select');
    expect(picker.className).toContain('lg:block');
    expect(picker.className).not.toContain('xl:hidden');
  });

  it('three long names that would not fit the bar: the picker, not segments', () => {
    scope = { ...scope, clients: [
      { id: 'a', name: 'Alto HR — Internal Hires' },
      { id: 'b', name: 'Coastal Resort Holdings' },
      { id: 'c', name: 'Seaside Hospitality Group' },
    ] };
    topbar();
    expect(screen.queryByTestId('store-scope-segments')).not.toBeInTheDocument();
    expect(screen.getByTestId('store-scope-select')).toBeInTheDocument();
  });
});

describe('<StoreScopeCombobox>', () => {
  const clients = many(300);
  const renderBox = (clientId = '') => render(<StoreScopeCombobox clients={clients} clientId={clientId} onChange={setClientId} />);

  it('opens with "All clients" first and the current client marked', async () => {
    renderBox('c5');
    const trigger = screen.getByRole('combobox', { name: 'Store scope' });
    expect(trigger).toHaveTextContent('Harbor Store 5');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(301);
    expect(options[0]).toHaveTextContent('All clients');
    expect(options[5]).toHaveAttribute('aria-selected', 'true');
    expect(options[5]).toHaveTextContent('Harbor Store 5 (current)');
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1);
    // The search has focus, pointing at the current one.
    const search = screen.getByRole('searchbox', { name: 'Find a client' });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('aria-activedescendant', options[5]!.id);
  });

  it('typing filters 300 clients down; arrows and Enter pick; the scope is set', async () => {
    renderBox();
    await userEvent.click(screen.getByRole('combobox', { name: 'Store scope' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a client' }), 'walmart');
    let options = within(screen.getByRole('listbox')).getAllByRole('option');
    // "All clients" + the 30 Walmart stores (#1, #11 … #291).
    expect(options).toHaveLength(31);
    expect(options[0]).toHaveTextContent('All clients');
    // Typing points at the first match, not at "All clients".
    expect(screen.getByRole('searchbox')).toHaveAttribute('aria-activedescendant', options[1]!.id);
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('searchbox')).toHaveAttribute('aria-activedescendant', options[2]!.id);
    await userEvent.keyboard('{Enter}');
    expect(setClientId).toHaveBeenCalledWith('c11');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Store scope' })).toHaveFocus();

    // Every word must match.
    await userEvent.click(screen.getByRole('combobox', { name: 'Store scope' }));
    await userEvent.type(screen.getByRole('searchbox'), 'supercenter 29');
    options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['All clients (current)', 'Walmart Supercenter #291']);
  });

  it('Up to "All clients" and Enter clears the scope; Escape closes without choosing', async () => {
    renderBox('c2');
    await userEvent.click(screen.getByRole('combobox', { name: 'Store scope' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(setClientId).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Store scope' })).toHaveFocus();

    // From the button: ArrowDown opens; Home goes to the top.
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Home}{Enter}');
    expect(setClientId).toHaveBeenCalledWith('');
  });

  it('a click picks, and nothing matching says so', async () => {
    renderBox();
    await userEvent.click(screen.getByRole('combobox', { name: 'Store scope' }));
    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('No client matches “zzz”')).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'harbor store 42');
    await userEvent.click(screen.getByRole('option', { name: /Harbor Store 42/ }));
    expect(setClientId).toHaveBeenCalledWith('c42');
  });

  it('matchClients ignores case and needs every word', () => {
    expect(matchClients(FOUR, 'DESTIN').map((c) => c.id)).toEqual(['w2']);
    expect(matchClients(FOUR, 'walmart city').map((c) => c.id)).toEqual(['w4']);
    expect(matchClients(FOUR, '  ')).toHaveLength(4);
  });
});

describe('the phone menu', () => {
  const sheet = () =>
    renderAs(
      'HR_ADMINISTRATOR',
      <ThemeProvider>
        <MobileNav open onClose={() => undefined} onOpenCommandPalette={() => undefined} />
      </ThemeProvider>,
    );

  it('past six clients: a search above the chips, which wrap instead of scrolling sideways', async () => {
    phone = true;
    scope = { ...scope, clients: many(40), clientId: 'c7' };
    sheet();
    const box = screen.getByTestId('store-scope-search');
    const chips = within(box).getByRole('group', { name: 'Client scope' });
    expect(chips.className).toContain('flex-wrap');
    expect(chips.className).not.toContain('overflow-x-auto');
    // All clients, then the current one, then matches (24 shown, the rest counted).
    const buttons = within(chips).getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('All clients');
    expect(buttons[1]).toHaveTextContent('Harbor Store 7');
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'true');
    expect(buttons).toHaveLength(2 + 24);
    expect(within(box).getByText('15 more: type to narrow')).toBeInTheDocument();

    await userEvent.type(within(box).getByRole('searchbox', { name: 'Find a client' }), 'walmart');
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All clients',
      'Harbor Store 7',
      // The chips use the short store name, as before.
      'Supercenter #1',
      'Supercenter #11',
      'Supercenter #21',
      'Supercenter #31',
    ]);
    await userEvent.click(within(chips).getByRole('button', { name: 'Supercenter #21' }));
    expect(setClientId).toHaveBeenCalledWith('c21');

    await userEvent.clear(within(box).getByRole('searchbox'));
    await userEvent.type(within(box).getByRole('searchbox'), 'nowhere');
    expect(within(box).getByText('No client matches')).toBeInTheDocument();
  });

  it('six or fewer keep the one sideways row of chips', () => {
    phone = true;
    scope = { ...scope, clients: FOUR };
    sheet();
    expect(screen.queryByTestId('store-scope-search')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Client scope' }).className).toContain('overflow-x-auto');
  });
});
