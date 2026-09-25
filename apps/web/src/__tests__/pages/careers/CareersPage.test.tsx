import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/careersApi', () => ({
  listCareerPostings: vi.fn(),
  getCareerPosting: vi.fn(),
  applyToPosting: vi.fn(),
}));

import { ApiError } from '@/lib/api';
import { applyToPosting, getCareerPosting, listCareerPostings } from '@/lib/careersApi';
import { CareerPostingPage, CareersListPage } from '@/pages/careers/CareersPage';

/**
 * Every job posting showed an address — /careers/{slug} — and there was no
 * such page. The API served postings and took applications; nothing
 * rendered them.
 */

const STOCKER = {
  slug: 'overnight-stocker',
  title: 'Overnight Stocker',
  location: 'Destin, FL',
  clientName: 'Walmart',
  minSalary: '15.00',
  maxSalary: '17.50',
  currency: 'USD',
  openedAt: '2026-09-20T12:00:00.000Z',
};

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/careers" element={<CareersListPage />} />
          <Route path="/careers/:slug" element={<CareerPostingPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(applyToPosting).mockReset();
});

describe('/careers', () => {
  it('lists the open jobs with where and what they pay', async () => {
    vi.mocked(listCareerPostings).mockResolvedValue({ postings: [STOCKER] });
    renderAt('/careers?source=indeed');
    const job = await screen.findByRole('link', { name: /overnight stocker/i });
    // The source rides along to the job page, so the application records it.
    expect(job).toHaveAttribute('href', '/careers/overnight-stocker?source=indeed');
    expect(job).toHaveTextContent('Destin, FL');
    expect(job).toHaveTextContent('$15.00 – $17.50 an hour');
  });

  it('says plainly when nothing is open', async () => {
    vi.mocked(listCareerPostings).mockResolvedValue({ postings: [] });
    renderAt('/careers');
    expect(await screen.findByText(/no open jobs right now/i)).toBeInTheDocument();
  });
});

describe('/careers/:slug', () => {
  it('takes an application and confirms it', async () => {
    vi.mocked(getCareerPosting).mockResolvedValue({ ...STOCKER, description: 'Stock shelves overnight.' });
    vi.mocked(applyToPosting).mockResolvedValue({ id: 'cand-1', alreadyApplied: false });
    const user = renderAt('/careers/overnight-stocker?source=indeed');

    expect(await screen.findByRole('heading', { name: 'Overnight Stocker' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/first name/i), 'Jasmine');
    await user.type(screen.getByLabelText(/last name/i), 'Reed');
    await user.type(screen.getByLabelText(/^email/i), 'jasmine@example.com');
    await user.type(screen.getByLabelText(/^phone/i), '850-555-0110');
    await user.click(screen.getByRole('button', { name: 'Send application' }));

    await waitFor(() =>
      expect(applyToPosting).toHaveBeenCalledWith(
        'overnight-stocker',
        expect.objectContaining({
          firstName: 'Jasmine',
          lastName: 'Reed',
          email: 'jasmine@example.com',
          phone: '850-555-0110',
          source: 'indeed',
          website: null,
        }),
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/application sent/i);
    expect(screen.getByRole('status')).toHaveTextContent('jasmine@example.com');
  });

  it('someone already on file is told it was added, not to apply again', async () => {
    vi.mocked(getCareerPosting).mockResolvedValue({ ...STOCKER, description: 'x' });
    vi.mocked(applyToPosting).mockResolvedValue({ id: 'cand-1', alreadyApplied: true });
    const user = renderAt('/careers/overnight-stocker');
    await user.type(await screen.findByLabelText(/first name/i), 'Pat');
    await user.type(screen.getByLabelText(/last name/i), 'Hopeful');
    await user.type(screen.getByLabelText(/^email/i), 'pat@example.com');
    await user.click(screen.getByRole('button', { name: 'Send application' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/no need to apply again/i);
  });

  it('a filled or closed job says so', async () => {
    vi.mocked(getCareerPosting).mockRejectedValue(new ApiError(404, 'not_found', 'Posting not found.'));
    renderAt('/careers/gone');
    expect(await screen.findByText(/isn't open anymore/i)).toBeInTheDocument();
  });
});
