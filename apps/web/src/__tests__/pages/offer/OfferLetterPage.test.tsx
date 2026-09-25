import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/recruiting90Api', () => ({
  getOfferLetter: vi.fn(),
  acceptOfferLetter: vi.fn(),
  declineOfferLetter: vi.fn(),
}));

import { ApiError } from '@/lib/api';
import { acceptOfferLetter, declineOfferLetter, getOfferLetter } from '@/lib/recruiting90Api';
import { OfferLetterPage } from '@/pages/offer/OfferLetterPage';

/**
 * The candidate's side of an offer. "Accepting" used to mean replying to
 * an email and a recruiter clicking Accepted for them; nothing was signed.
 */

const OFFER = {
  candidateFirstName: 'Kim',
  candidateName: 'Kim Phan',
  jobTitle: 'Cashier',
  clientName: 'Walmart',
  startDate: 'Monday, October 5, 2026',
  pay: '$15.50 per hour',
  letterBody: 'Welcome aboard, Kim.',
  status: 'SENT' as const,
  expiresAt: '2026-10-09T00:00:00.000Z',
  signedName: null,
  signedAt: null,
};

function renderAt() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/offer/tok-123']}>
        <Routes>
          <Route path="/offer/:token" element={<OfferLetterPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(acceptOfferLetter).mockReset();
  vi.mocked(declineOfferLetter).mockReset();
});

describe('/offer/:token', () => {
  it('shows the offer and the letter, and signs only with a name and consent', async () => {
    vi.mocked(getOfferLetter).mockResolvedValue(OFFER);
    vi.mocked(acceptOfferLetter).mockResolvedValue({ ok: true, signedAt: '2026-09-26T15:00:00.000Z' });
    const user = renderAt();
    expect(await screen.findByRole('heading', { name: 'Cashier' })).toBeInTheDocument();
    expect(screen.getByText('$15.50 per hour')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Offer letter' })).toHaveTextContent('Welcome aboard, Kim.');

    const sign = screen.getByRole('button', { name: 'Accept and sign' });
    expect(sign).toBeDisabled();
    await user.type(screen.getByLabelText(/type your full name/i), 'Kim Phan');
    expect(sign).toBeDisabled(); // consent too
    await user.click(screen.getByRole('checkbox'));
    await user.click(sign);

    await waitFor(() => expect(acceptOfferLetter).toHaveBeenCalledWith('tok-123', 'Kim Phan'));
    expect(await screen.findByRole('status')).toHaveTextContent(/accepted — welcome to Alto/i);
    expect(screen.getByRole('status')).toHaveTextContent('Signed by Kim Phan');
  });

  it('can be declined, with a reason', async () => {
    vi.mocked(getOfferLetter).mockResolvedValue(OFFER);
    vi.mocked(declineOfferLetter).mockResolvedValue({ ok: true });
    const user = renderAt();
    await user.click(await screen.findByRole('button', { name: 'Decline this offer' }));
    await user.type(screen.getByLabelText(/anything you'd like us to know/i), 'Took a job closer to home.');
    await user.click(screen.getByRole('button', { name: 'Decline offer' }));
    await waitFor(() => expect(declineOfferLetter).toHaveBeenCalledWith('tok-123', 'Took a job closer to home.'));
    expect(await screen.findByRole('status')).toHaveTextContent(/declined the offer/i);
  });

  it('a used or made-up link says what to do', async () => {
    vi.mocked(getOfferLetter).mockRejectedValue(new ApiError(404, 'not_found', 'This offer link is not valid.'));
    renderAt();
    expect(await screen.findByRole('status')).toHaveTextContent(/already been used, or it isn't a real link/i);
  });

  it('an expired offer can no longer be signed', async () => {
    vi.mocked(getOfferLetter).mockResolvedValue({ ...OFFER, status: 'EXPIRED' as never });
    renderAt();
    expect(await screen.findByRole('status')).toHaveTextContent('This offer has expired');
    expect(screen.queryByRole('button', { name: 'Accept and sign' })).not.toBeInTheDocument();
  });
});
