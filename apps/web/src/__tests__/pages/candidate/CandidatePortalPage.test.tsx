import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/candidatePortalApi', () => ({
  getCandidatePortal: vi.fn(),
  confirmPortalInterview: vi.fn(),
  uploadPortalDocument: vi.fn(),
}));

import { ApiError } from '@/lib/api';
import { confirmPortalInterview, getCandidatePortal, uploadPortalDocument, type CandidatePortal } from '@/lib/candidatePortalApi';
import { CandidatePortalPage } from '@/pages/candidate/CandidatePortalPage';

/** The candidate's own page: their stage, interview and the documents we asked for. */

const PORTAL: CandidatePortal = {
  orgName: 'Alto HR',
  firstName: 'Kim',
  position: 'Cashier',
  postingSlug: null,
  stage: 'INTERVIEW',
  stageLabel: 'Interview stage',
  stageDetail: 'Your interview details are below.',
  expiresAt: '2026-11-16T00:00:00.000Z',
  interviews: [{ id: 'iv1', scheduledFor: '2026-10-20T14:00:00.000Z', when: 'Tue, Oct 20, 10:00 AM EDT', durationMinutes: 30, location: 'Destin #1234', interviewerName: 'Dana Reyes', confirmedAt: null }],
  documents: [{ id: 'd1', label: "Driver's licence", note: null, status: 'REQUESTED', fileName: null, uploadedAt: null, reviewNote: null }],
};

function renderAt() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/candidate/tok-1']}>
        <Routes>
          <Route path="/candidate/:token" element={<CandidatePortalPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(getCandidatePortal).mockReset();
  vi.mocked(confirmPortalInterview).mockReset();
  vi.mocked(uploadPortalDocument).mockReset();
});

describe('/candidate/:token', () => {
  it('shows where they stand and lets them confirm the interview', async () => {
    vi.mocked(getCandidatePortal).mockResolvedValue(PORTAL);
    vi.mocked(confirmPortalInterview).mockResolvedValue({ ok: true, confirmedAt: '2026-10-17T12:00:00.000Z' });
    const user = renderAt();
    expect(await screen.findByRole('heading', { name: 'Hi Kim' })).toBeInTheDocument();
    expect(screen.getByText('Interview stage')).toBeInTheDocument();
    expect(screen.getByText('Tue, Oct 20, 10:00 AM EDT')).toBeInTheDocument();
    expect(screen.getByText(/with Dana Reyes/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /I’ll be there/ }));
    await waitFor(() => expect(confirmPortalInterview).toHaveBeenCalledWith('tok-1', 'iv1'));
  });

  it('names the recruiter to ask, not "the email your recruiter sent" (F500 G5)', async () => {
    vi.mocked(getCandidatePortal).mockResolvedValue({ ...PORTAL, recruiter: { name: 'Rosa Recruiter', email: 'rosa@altohr.com', phone: '+18505550199' } });
    renderAt();
    const line = await screen.findByTestId('contact-line');
    expect(line).toHaveTextContent('Rosa Recruiter');
    expect(line.querySelector('a[href="mailto:rosa@altohr.com"]')).not.toBeNull();
    expect(screen.queryByText(/Reply to the email your recruiter sent/)).not.toBeInTheDocument();
  });

  it('uploads a document asked for', async () => {
    vi.mocked(getCandidatePortal).mockResolvedValue(PORTAL);
    vi.mocked(uploadPortalDocument).mockResolvedValue({ ok: true, status: 'UPLOADED', fileName: 'licence.png' });
    const user = renderAt();
    expect(await screen.findByText("Driver's licence")).toBeInTheDocument();
    expect(screen.getByText('Needed')).toBeInTheDocument();
    const file = new File(['x'], 'licence.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText("Upload Driver's licence"), file);
    await waitFor(() => expect(uploadPortalDocument).toHaveBeenCalledWith('tok-1', 'd1', file));
  });

  it('an expired link says how to get a new one — and from whom (410, F500 G5)', async () => {
    vi.mocked(getCandidatePortal).mockRejectedValue(
      new ApiError(410, 'link_expired', 'expired', { recruiter: { name: 'Rosa Recruiter', email: 'rosa@altohr.com', phone: null } }),
    );
    renderAt();
    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
    expect(screen.getByText(/Ask Rosa Recruiter for a new one/)).toBeInTheDocument();
    expect(screen.getByTestId('link-problem-contact')).toHaveTextContent('rosa@altohr.com');
  });

  it('a confirm that fails never looks confirmed (CODE-20): it says so, and an expired link turns the page to "expired"', async () => {
    vi.mocked(getCandidatePortal).mockResolvedValueOnce(PORTAL);
    vi.mocked(confirmPortalInterview).mockRejectedValue(new ApiError(500, 'server_error', 'Something went wrong on our side.'));
    const user = renderAt();
    await user.click(await screen.findByRole('button', { name: /I’ll be there/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    expect(screen.queryByText(/You said you’ll be there/)).not.toBeInTheDocument();

    // The link lapsed between loading and tapping: the page re-reads and says so.
    vi.mocked(confirmPortalInterview).mockRejectedValue(new ApiError(410, 'link_expired', 'expired'));
    vi.mocked(getCandidatePortal).mockRejectedValue(new ApiError(410, 'link_expired', 'expired', { recruiter: null }));
    await user.click(screen.getByRole('button', { name: /I’ll be there/ }));
    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
  });

  it('a link we never issued is "not valid", not "expired" (404)', async () => {
    vi.mocked(getCandidatePortal).mockRejectedValue(new ApiError(404, 'not_found', 'This link is not valid.'));
    renderAt();
    expect(await screen.findByText('This link isn’t valid')).toBeInTheDocument();
    expect(screen.queryByText('This link has expired')).not.toBeInTheDocument();
  });
});
