import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Agent families step 1 — a shift the Workforce agent proposes to fill is
 * one item on the desk's queue: it names the person and the shift, links
 * to the shift on the schedule, and carries Approve and Reject.
 */

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ user: { id: 'me', email: 'pm@grandhotel.example', role: 'SHIFT_SUPERVISOR' }, can: () => true }),
}));
vi.mock('@/components/DecisionRoom', () => ({ DecisionRoom: () => null }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn().mockResolvedValue('') }));

import { apiFetch } from '@/lib/api';
import { RoleDecisionQueue } from '@/components/RoleDecisionQueue';

const APPROVAL = '33333333-3333-4333-8333-333333333333';
const SITE = '11111111-1111-4111-8111-111111111111';

const item = {
  key: `agents:shift-fill:${APPROVAL}`,
  severity: 'high',
  label: 'Assign Tess Free to Housekeeper at The Grand Hotel, Oct 14 7:00 AM–3:00 PM. The open-shift broadcast went unanswered.',
  detail: 'Proposed by the Workforce agent. Nothing is assigned until you approve; it then assigns under the same rules as the schedule.',
  stakes: null,
  ageDays: 0,
  linkUrl: `/scheduling?week=2026-10-14&location=${SITE}`,
  quickAction: 'Approve',
  declineAction: 'Reject',
  claimedBy: null,
  claimedByMe: false,
  assigned: false,
  note: null,
  escalated: false,
  nextStep: null,
};

function setup() {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/me/decisions') return { decisions: [item] } as never;
    if (path === '/me/decisions/quick') return { ok: true, summary: 'Approved and assigned. The person has been told.' } as never;
    throw new Error(`not mocked: ${path}`);
  });
  // The queue reads the one shared decisions query (lib/meDecisions, F500 SH-4).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RoleDecisionQueue />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a proposed shift fill on the desk', () => {
  it('names the person and the shift, links to the shift, and Approve sends the quick action', async () => {
    const user = userEvent.setup();
    setup();
    expect(await screen.findByText(/Assign Tess Free to Housekeeper at The Grand Hotel/)).toBeInTheDocument();
    // "Go to it" opens the thing itself ("Discuss" is the room).
    const open = screen.getAllByRole('link', { name: /Go to it/ })[0]!;
    expect(open).toHaveAttribute('href', `/scheduling?week=2026-10-14&location=${SITE}`);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/me/decisions/quick', { method: 'POST', body: { key: item.key } }));
  });

  it('Reject sends the decline', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/me/decisions/quick', { method: 'POST', body: { key: item.key, decline: true } }));
  });
});
