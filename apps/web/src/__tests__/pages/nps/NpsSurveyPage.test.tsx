import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/npsApi', () => ({ getNpsInvite: vi.fn(), answerNps: vi.fn() }));

import { answerNps, getNpsInvite } from '@/lib/npsApi';
import { NpsSurveyPage } from '@/pages/nps/NpsSurveyPage';

/** A store manager's quarterly answer — outside the portal, no login. */

function renderAt() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/nps/tok-9']}>
        <Routes>
          <Route path="/nps/:token" element={<NpsSurveyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(answerNps).mockReset();
});

describe('/nps/:token', () => {
  it('asks the one question and sends a score with a comment', async () => {
    vi.mocked(getNpsInvite).mockResolvedValue({ orgName: 'Alto HR', clientName: 'Walmart', quarter: '2026-Q4', closed: false, answered: false, score: null });
    vi.mocked(answerNps).mockResolvedValue({ ok: true });
    const user = renderAt();
    expect(await screen.findByRole('heading', { name: /How likely are you to recommend Alto HR/ })).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send my answer' });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: '9' }));
    await user.type(screen.getByRole('textbox'), 'Faster fills on weekends.');
    await user.click(send);
    await waitFor(() => expect(answerNps).toHaveBeenCalledWith('tok-9', { score: 9, comment: 'Faster fills on weekends.' }));
    expect(await screen.findByText('Thank you')).toBeInTheDocument();
  });

  it('a closed wave says so', async () => {
    vi.mocked(getNpsInvite).mockResolvedValue({ orgName: 'Alto HR', clientName: 'Walmart', quarter: '2026-Q3', closed: true, answered: false, score: null });
    renderAt();
    expect(await screen.findByText(/survey has closed/)).toBeInTheDocument();
  });
});
