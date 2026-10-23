import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/anonReport128Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/anonReport128Api')>()),
  getHotlineOrg: vi.fn(),
  fileAnonymousReport: vi.fn(async () => ({ trackingCode: 'ABCD-EFGH-IJKL' })),
}));
import { ApiError } from '@/lib/api';
import { fileAnonymousReport, getHotlineOrg } from '@/lib/anonReport128Api';
import { HotlinePage } from '@/pages/hotline/HotlinePage';

/**
 * The hotline names the organization that receives a report, says what a
 * reporter looks for (no retaliation, who reads it and how fast, call 911),
 * starts with no category, and files into the organization of /hotline/:slug.
 */

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/hotline" element={<HotlinePage />} />
          <Route path="/hotline/:slug" element={<HotlinePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getHotlineOrg).mockReset();
  vi.mocked(fileAnonymousReport).mockClear();
});

describe('the hotline (F500 G5)', () => {
  it('says whose ethics team reads it, reassures first, and files into that organization only once a category is chosen', async () => {
    vi.mocked(getHotlineOrg).mockResolvedValue({ org: { name: 'Harbor Staffing', slug: 'harbor-staffing' } });
    renderAt('/hotline/harbor-staffing');
    expect(await screen.findByTestId('hotline-org')).toHaveTextContent('Harbor Staffing');
    expect(getHotlineOrg).toHaveBeenCalledWith('harbor-staffing');
    const reassure = screen.getByTestId('hotline-reassurance');
    expect(reassure).toHaveTextContent('No retaliation');
    expect(reassure).toHaveTextContent('3 business days');
    expect(reassure).toHaveTextContent('Call 911');
    const category = screen.getByLabelText(/Category/) as HTMLSelectElement;
    expect(category.value).toBe('');
    await userEvent.type(screen.getByLabelText(/Subject/), 'Blocked fire exit');
    await userEvent.type(screen.getByLabelText(/What happened/), 'The back fire exit has been blocked by pallets all week.');
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(fileAnonymousReport).not.toHaveBeenCalled();
    await userEvent.selectOptions(category, 'SAFETY');
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(fileAnonymousReport).toHaveBeenCalledWith(expect.objectContaining({ category: 'SAFETY', org: 'harbor-staffing' }));
  });

  it('an unknown hotline address says so and links the main hotline', async () => {
    vi.mocked(getHotlineOrg).mockRejectedValue(new ApiError(404, 'org_not_found', 'We don’t recognise that hotline address.'));
    renderAt('/hotline/nobody-here');
    expect(await screen.findByTestId('hotline-unknown')).toHaveTextContent('We don’t recognise that hotline address');
    expect(screen.getByRole('link', { name: 'Go to the hotline' })).toHaveAttribute('href', '/hotline');
  });
});
