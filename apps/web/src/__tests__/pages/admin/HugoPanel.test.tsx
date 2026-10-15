import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/hugoApi', () => ({
  getHugo: vi.fn(),
  askHugo: vi.fn(),
  listProposals: vi.fn(),
}));

import { ApiError } from '@/lib/api';
import { askHugo, getHugo, listProposals } from '@/lib/hugoApi';
import { HugoPanel } from '@/pages/admin/HugoPanel';

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <HugoPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<HugoPanel>', () => {
  it('says who he is and what he can do here, answers an example, and links to the record', async () => {
    vi.mocked(getHugo).mockResolvedValue({
      name: 'Hugo',
      audience: 'manager',
      intro: "I'm Hugo, the AI assistant in Alto People. I'm not a person. I can help with: coverage for the next 7 days.",
      can: [{ key: 'COVERAGE', label: 'Coverage for the next 7 days', example: 'Where are we short this week?' }],
    });
    vi.mocked(listProposals).mockResolvedValue({
      proposals: [
        { id: 'p1', workerId: 'w', capabilityKey: 'shift.fill', subjectType: 'Shift', subjectId: 's', payload: {}, approvalId: 'a', status: 'PROPOSED', statusAt: new Date().toISOString(), outcome: null, outcomeAt: null, createdAt: new Date().toISOString() },
      ],
    });
    vi.mocked(askHugo).mockResolvedValue({ intent: 'COVERAGE', reply: 'Next 7 days: 1 short day across 1 of your properties.', linkUrl: '/scheduling?week=2026-10-17&location=l1' });
    renderPanel();

    expect(await screen.findByText(/the AI assistant in Alto People\. I'm not a person\./)).toBeInTheDocument();
    expect(await screen.findByText('Fill open shifts')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Where are we short this week?' }));
    await waitFor(() => expect(askHugo).toHaveBeenCalledWith('Where are we short this week?'));
    expect(await screen.findByText(/1 short day across 1 of your properties/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/scheduling?week=2026-10-17&location=l1');
  });

  it('switched off: one quiet line, no ask box', async () => {
    vi.mocked(getHugo).mockRejectedValue(new ApiError(409, 'hugo_off', 'The assistant is switched off for now.'));
    vi.mocked(listProposals).mockResolvedValue({ proposals: [] });
    renderPanel();
    expect(await screen.findByTestId('hugo-off')).toHaveTextContent('The assistant is switched off for now.');
    expect(screen.queryByRole('textbox', { name: 'Your question' })).not.toBeInTheDocument();
  });
});
