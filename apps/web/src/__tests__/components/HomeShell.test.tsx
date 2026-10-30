import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: api.apiFetch }));

import { AuthContext } from '@/lib/auth';
import { HomeTemplate } from '@/components/templates';
import { HomeMeta } from '@/components/home/HomeMeta';
import { ClockStrip } from '@/components/ClockStrip';
import { HugoSeat } from '@/components/home/HugoSeat';
import { countNeedsYou, ME_DECISIONS_KEY } from '@/lib/meDecisions';

/**
 * A home's first screen (F500 fix-up): the "Needs you" number is what the
 * section lists — the role queue's rows and the page's own cards, each
 * thing once; Hugo is a full-width bar, not a third of the page that stays
 * empty; the meta line reads the same on every home.
 */

function renderHome(ui: React.ReactElement, { role = 'HR_ADMINISTRATOR' as Role, decisions }: { role?: Role; decisions?: Array<{ key: string }> } = {}) {
  const caps = ROLE_CAPABILITIES[role];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (decisions) client.setQueryData(ME_DECISIONS_KEY, { decisions });
  return render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'x@example.com', role, status: 'ACTIVE', clientId: null, associateId: null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter>{ui}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.apiFetch.mockReset();
});

describe('countNeedsYou', () => {
  it('queue rows plus cards, a card that is also a row once; unknown while the queue loads', () => {
    expect(countNeedsYou({ queueKeys: ['a', 'b'], cards: 2 })).toBe(4);
    expect(countNeedsYou({ queueKeys: ['coverage:l1:Dinner', 'x'], cardKeys: ['coverage:l1:Dinner', 'coverage:l2:Lunch'] })).toBe(3);
    expect(countNeedsYou({ queueKeys: null, cards: 3 })).toBeUndefined();
  });
});

describe('<HomeTemplate>', () => {
  it('counts the queue’s rows with the page’s cards — 1 over a list of 8 was the bug', () => {
    renderHome(
      <HomeTemplate title="Hi" hero={<p>hero</p>} decisions={{ title: 'Needs you', queue: true, count: 1, content: <p>rows</p> }} />,
      { decisions: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }, { key: 'e' }, { key: 'f' }, { key: 'g' }] },
    );
    expect(screen.getByTestId('needs-you-count')).toHaveTextContent('8');
  });

  it('a card that is also a queue row (the supervisor’s coverage gap) counts once', () => {
    renderHome(
      <HomeTemplate title="Hi" hero={null} decisions={{ title: 'Needs you', queue: true, cardKeys: ['coverage:l1:Dinner'], content: null }} />,
      { decisions: [{ key: 'coverage:l1:Dinner' }, { key: 'claims:pending' }] },
    );
    expect(screen.getByTestId('needs-you-count')).toHaveTextContent('2');
  });

  it('without the queue, the page’s own count stands; zero shows no badge', () => {
    const { unmount } = renderHome(<HomeTemplate title="Hi" hero={null} decisions={{ title: 'Needs you', count: 3, content: null }} />);
    expect(screen.getByTestId('needs-you-count')).toHaveTextContent('3');
    unmount();
    renderHome(<HomeTemplate title="Hi" hero={null} decisions={{ title: 'Needs you', count: 0, content: null }} />);
    expect(screen.queryByTestId('needs-you-count')).not.toBeInTheDocument();
  });

  it('Hugo is a full-width bar right after Needs you, not an aside beside an empty column', () => {
    const { container } = renderHome(
      <HomeTemplate title="Hi" hero={null} decisions={{ title: 'Needs you', content: <p>rows</p> }} assistant={<div>Hugo bar</div>}>
        <p>the rest</p>
      </HomeTemplate>,
    );
    expect(container.querySelector('aside')).toBeNull();
    const seat = screen.getByRole('region', { name: 'Assistant' });
    expect(seat).toHaveTextContent('Hugo bar');
    // In reading order: Needs you, Hugo, then the rest of the day — met, not scrolled past.
    const order = [screen.getByText('rows'), screen.getByText('Hugo bar'), screen.getByText('the rest')];
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('<HomeMeta>', () => {
  it('items with the dot drawn between them — a wrapped phone line never starts with “·”', () => {
    renderHome(<HomeMeta items={['Thu, Oct 22', null, 'Payday Fri, Oct 30']} />);
    const meta = screen.getByTestId('home-meta');
    expect(within(meta).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Thu, Oct 22', 'Payday Fri, Oct 30']);
    expect(meta.textContent).not.toContain('·');
  });
});

describe('<ClockStrip>', () => {
  it('says the days without this year (once, not three times)', async () => {
    const y = new Date().getFullYear();
    api.apiFetch.mockResolvedValue({ weekEndsOn: `${y}-10-23`, closeOn: `${y}-10-27`, payday: { date: `${y + 1}-01-08`, schedule: 'Biweekly' } });
    renderHome(<ClockStrip />);
    const meta = await screen.findByTestId('home-meta');
    expect(meta.textContent).toContain('Week ends Fri, Oct 23');
    expect(meta.textContent).not.toContain(`${y}`);
    // A payday next year says which year.
    expect(meta.textContent).toContain(`${y + 1}`);
  });
});

describe('<HugoSeat>', () => {
  it('a store account (no assistant) is never asked about Hugo', async () => {
    renderHome(<HugoSeat />, { role: 'CLIENT_PORTAL' });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.apiFetch).not.toHaveBeenCalledWith('/hugo');
  });

  it('Hugo’s card says he is your assistant and what he is up to, whole — his full introduction is in the panel', async () => {
    api.apiFetch.mockImplementation(async (path: string) =>
      path === '/hugo' ? { name: 'Hugo', audience: 'staff', intro: "I'm Hugo, your assistant in Alto People — not a person, but always here. Ask me about your work.", model: false, can: [{ key: 'DESK', label: 'Desk', example: 'What is waiting?' }] } : {},
    );
    renderHome(<HugoSeat />);
    expect(await screen.findByText('Your assistant')).toBeInTheDocument();
    // Nothing on his plate: a break, said in plain words, never clamped mid-sentence.
    const mood = screen.getByTestId('hugo-mood');
    expect(['coffee', 'reading']).toContain(mood.dataset.mood);
    expect(mood.textContent).toMatch(/ask me anything$/);
    expect(mood.className).not.toContain('line-clamp');
    expect(screen.queryByText(/Ask me about your work/)).toBeNull();
    expect(screen.queryByText(/\bAI\b/)).toBeNull();
  });
});
