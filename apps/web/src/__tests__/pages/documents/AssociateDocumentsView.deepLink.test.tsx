import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/lib/i18n';

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}

vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useTenant: () => ({ moduleOn: () => true }),
}));
vi.mock('@/lib/documentsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/documentsApi')>()),
  listMyDocuments: vi.fn().mockResolvedValue({
    documents: [
      { id: 'd1', kind: 'ID', filename: 'license.jpg', status: 'VERIFIED', expiresAt: '2026-11-01T00:00:00.000Z', createdAt: '2025-11-01T00:00:00.000Z', mimeType: 'image/jpeg', size: 1000, rejectionReason: null, verifiedAt: null },
    ],
  }),
}));

import { AssociateDocumentsView } from '@/pages/documents/AssociateDocumentsView';

function Where() {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
}

function renderAt(url: string) {
  return render(
    <I18nProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[url]}>
          <AssociateDocumentsView />
          <Where />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

/**
 * Agent families step 4: the Compliance agent's chase links to the renewal
 * itself. ?renew=<id> opens that document's renewal; the link is consumed.
 */
describe('<AssociateDocumentsView> deep link from the chase', () => {
  it('?renew=<id> opens that document\'s renewal and leaves the URL clean', async () => {
    renderAt('/documents?renew=d1');
    expect(await screen.findByText('Replacing: license.jpg')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/documents$/));
  });

  it('an id that is not theirs opens nothing and is still dropped', async () => {
    renderAt('/documents?renew=nope');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/documents$/));
    expect(screen.queryByText(/^Replacing:/)).not.toBeInTheDocument();
  });
});
