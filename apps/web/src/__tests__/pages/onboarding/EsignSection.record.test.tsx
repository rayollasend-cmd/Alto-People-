import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/onboardingApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/onboardingApi')>()),
  listEsignAgreements: vi.fn(),
}));

import { listEsignAgreements } from '@/lib/onboardingApi';
import { EsignSection } from '@/pages/onboarding/EsignSection';

const APP_A = '00000000-0000-4000-8000-00000000aaa1';
const APP_B = '00000000-0000-4000-8000-00000000bbb2';

function agreement(applicationId: string, title: string) {
  return {
    id: `${applicationId}-agr`,
    applicationId,
    taskId: null,
    title,
    body: 'Terms',
    createdAt: '2026-09-01T12:00:00.000Z',
    signedAt: null,
    signatureId: null,
  };
}

/**
 * The section's query used to be keyed ['EsignSection', 'items'] with no
 * application in it, so the second application opened within the stale
 * window rendered the first application's agreements. The key now carries
 * the id; with a long staleTime this would still show APP_A's rows for
 * APP_B if it did not.
 */
describe('EsignSection — one application, one list', () => {
  it('shows the second application its own agreements, not the first one’s', async () => {
    vi.mocked(listEsignAgreements).mockImplementation(async (applicationId: string) => ({
      agreements: [agreement(applicationId, applicationId === APP_A ? 'Handbook for A' : 'Handbook for B')],
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    const ui = (applicationId: string) => (
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <EsignSection applicationId={applicationId} canManage={false} esignTasks={[]} associateId="assoc-1" />
        </QueryClientProvider>
      </MemoryRouter>
    );
    const view = render(ui(APP_A));
    expect(await screen.findByText('Handbook for A')).toBeInTheDocument();

    view.rerender(ui(APP_B));
    expect(await screen.findByText('Handbook for B')).toBeInTheDocument();
    expect(screen.queryByText('Handbook for A')).not.toBeInTheDocument();
    expect(listEsignAgreements).toHaveBeenCalledWith(APP_B);
  });
});
