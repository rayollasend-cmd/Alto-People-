import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The decision queue (F500 SH-4): a failed load says so with Retry instead
 * of the "Needs you" section silently vanishing; the rows come from the one
 * shared decisions query the home's count reads; the two links say what they
 * do ("Discuss" opens the room, "Go to it" the thing itself); and a page that
 * shows an item as its own card can leave it out of the queue.
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ user: { id: 'me', email: 'hr@example.com', role: 'HR_ADMINISTRATOR' }, can: () => true }),
}));
vi.mock('@/components/DecisionRoom', () => ({ DecisionRoom: () => null }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn().mockResolvedValue('') }));

import { ApiError, apiFetch } from '@/lib/api';
import { RoleDecisionQueue } from '@/components/RoleDecisionQueue';
import { ME_DECISIONS_KEY } from '@/lib/meDecisions';

const row = (key: string, label: string) => ({
  key, severity: 'high', label, detail: 'Do it.', stakes: null, ageDays: 3, linkUrl: '/compliance', claimedBy: null, claimedByMe: false, assigned: false, note: null, escalated: false, nextStep: null,
});

function renderQueue(props: Parameters<typeof RoleDecisionQueue>[0] = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RoleDecisionQueue {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => vi.clearAllMocks());

describe('<RoleDecisionQueue>', () => {
  it('a failed load says so and retries — the section never just disappears', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiError(500, 'server_error', 'boom'));
    vi.mocked(apiFetch).mockResolvedValue({ decisions: [row('a', 'Answer Nia Carter’s FL unemployment claim — due Sat, Oct 24')] } as never);
    renderQueue();
    const retry = await screen.findByRole('button', { name: /retry/i });
    await userEvent.click(retry);
    expect(await screen.findByText(/Answer Nia Carter’s FL unemployment claim/)).toBeInTheDocument();
  });

  it('Discuss opens the room; Go to it opens the thing; the rows are the shared query’s', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ decisions: [row('a', 'First'), row('b', 'Second')] } as never);
    const qc = renderQueue();
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Discuss' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Go to it' })[0]).toHaveAttribute('href', '/compliance');
    expect(qc.getQueryData(ME_DECISIONS_KEY)).toMatchObject({ decisions: [{ key: 'a' }, { key: 'b' }] });
  });

  it('leaves out the items the page shows as its own card', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ decisions: [row('coverage:loc:swing', 'Today’s Swing: 0 of 6 scheduled'), row('time:unapproved', '12 punches to approve')] } as never);
    renderQueue({ excludeKeyPrefix: 'coverage:' });
    expect(await screen.findByText('12 punches to approve')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Today’s Swing/)).not.toBeInTheDocument());
  });
});
