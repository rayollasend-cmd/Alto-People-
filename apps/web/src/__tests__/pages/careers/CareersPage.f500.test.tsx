import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/careersApi', () => ({
  listCareerPostings: vi.fn(),
  getCareerPosting: vi.fn(),
  applyToPosting: vi.fn(),
  getCareersBrand: vi.fn(async () => ({ headline: null, intro: null, values: [], perks: [], ctaText: null, photos: [] })),
  recordCareersView: vi.fn(),
}));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn(async () => ({ contact: { email: 'jobs@harbor.example' } })) }));
import { getCareerPosting, listCareerPostings } from '@/lib/careersApi';
import { CareerPostingPage, CareersListPage } from '@/pages/careers/CareersPage';

/**
 * The careers site (F500 G5): the fallback intro names the organization
 * (not one tenant's geography); search and Location / Schedule chips over
 * a counted, newest-first list; an empty board that says who to write to;
 * a sticky Apply on a phone.
 */

const job = (slug: string, title: string, location: string, schedule: 'FULL_TIME' | 'PART_TIME', openedAt: string) => ({
  slug, title, location, clientName: null, minSalary: null, maxSalary: null, currency: 'USD', openedAt, schedule, payUnit: null,
});

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

describe('/careers (F500 G5)', () => {
  it('names the organization, counts the jobs newest first, and narrows by search and chips', async () => {
    vi.mocked(listCareerPostings).mockResolvedValue({
      orgName: 'Harbor Staffing',
      postings: [
        job('cook', 'Line Cook', 'Destin, FL', 'FULL_TIME', '2026-09-01T00:00:00Z'),
        job('stocker', 'Overnight Stocker', 'Pensacola, FL', 'PART_TIME', '2026-10-01T00:00:00Z'),
        job('cashier', 'Cashier', 'Destin, FL', 'PART_TIME', '2026-09-15T00:00:00Z'),
      ],
    } as never);
    const user = renderAt('/careers');
    expect(await screen.findByText(/^Open jobs at Harbor Staffing\./)).toBeInTheDocument();
    expect(screen.queryByText(/Florida Panhandle/)).not.toBeInTheDocument();
    expect(screen.getByTestId('careers-count')).toHaveTextContent('3 open jobs');
    const titles = () => screen.getAllByRole('link').map((a) => a.textContent).filter((t) => /Cook|Stocker|Cashier/.test(t ?? ''));
    expect(titles()[0]).toMatch(/^Overnight Stocker/);
    await user.click(screen.getByRole('button', { name: 'Destin, FL' }));
    expect(screen.getByTestId('careers-count')).toHaveTextContent('2 open jobs');
    await user.click(screen.getByRole('button', { name: 'Part-time' }));
    expect(screen.getByTestId('careers-count')).toHaveTextContent('1 open job');
    await user.click(within(screen.getByTestId('careers-count')).getByRole('button', { name: 'Show all' }));
    await user.type(screen.getByPlaceholderText('Search by job, place or company'), 'cook');
    expect(screen.getByTestId('careers-count')).toHaveTextContent('1 open job');
  });

  it('an empty board says who to write to — not a dead end', async () => {
    vi.mocked(listCareerPostings).mockResolvedValue({ orgName: 'Harbor Staffing', postings: [] } as never);
    renderAt('/careers');
    const empty = await screen.findByTestId('careers-empty');
    expect(await within(empty).findByRole('link', { name: 'jobs@harbor.example' })).toHaveAttribute('href', expect.stringMatching(/^mailto:jobs@harbor\.example/));
  });

  it('a posting has a sticky Apply on a phone that takes you to the form', async () => {
    vi.mocked(getCareerPosting).mockResolvedValue({
      ...job('stocker', 'Overnight Stocker', 'Pensacola, FL', 'PART_TIME', '2026-10-01T00:00:00Z'),
      description: 'Stock shelves overnight.',
      orgName: 'Harbor Staffing',
    } as never);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const user = renderAt('/careers/stocker');
    const sticky = await screen.findByTestId('careers-sticky-apply');
    await user.click(within(sticky).getByRole('button', { name: 'Apply for this job' }));
    expect(scroll).toHaveBeenCalled();
  });
});
