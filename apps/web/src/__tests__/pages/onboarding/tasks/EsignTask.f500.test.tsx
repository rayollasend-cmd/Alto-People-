import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ApiError } from '@/lib/api';

/**
 * E-sign and identity documents after the F500 fix-up (2026-10-22): an
 * honest "Nothing to sign" with the way on, a plain error with Retry
 * instead of "Request failed (500)" over pulsing skeletons, and the
 * documents step's footer in the order of every other task.
 */

vi.mock('@/lib/onboardingApi', () => ({
  getApplication: vi.fn(),
  listEsignAgreements: vi.fn(),
  signEsignAgreement: vi.fn(),
  finishDocumentUpload: vi.fn(),
}));
vi.mock('@/lib/documentsApi', () => ({
  listMyDocuments: vi.fn(async () => ({ documents: [] })),
  uploadMyDocument: vi.fn(),
  deleteMyDocument: vi.fn(),
}));

import { getApplication, listEsignAgreements } from '@/lib/onboardingApi';
import { EsignTask } from '@/pages/onboarding/tasks/EsignTask';
import { DocumentUploadTask } from '@/pages/onboarding/tasks/DocumentUploadTask';

const APP_ID = '00000000-0000-4000-8000-00000000e5e5';

function renderAt(path: string, element: React.ReactNode) {
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'maria@example.com', role: 'ASSOCIATE' as const, status: 'ACTIVE' as const, clientId: null, associateId: 'a' },
    role: 'ASSOCIATE' as const,
    capabilities: new Set<Capability>(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: () => false,
  };
  return rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/onboarding/me/:applicationId/tasks/:kind" element={element} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const tasks = (esign: 'SKIPPED' | 'PENDING') => ({
  id: APP_ID,
  tasks: [
    { id: 't1', kind: 'E_SIGN', status: esign, title: 'E-sign', description: null, order: 1, documentId: null, completedAt: null },
    { id: 't2', kind: 'W4', status: 'PENDING', title: 'W-4', description: null, order: 2, documentId: null, completedAt: null },
  ],
});

beforeEach(() => {
  vi.mocked(getApplication).mockReset();
  vi.mocked(listEsignAgreements).mockReset();
});

describe('<EsignTask> (F500)', () => {
  it('a step HR marked not needed with nothing drafted: "Nothing to sign", and the way on', async () => {
    vi.mocked(getApplication).mockResolvedValue(tasks('SKIPPED') as never);
    vi.mocked(listEsignAgreements).mockResolvedValue({ agreements: [] });
    renderAt(`/onboarding/me/${APP_ID}/tasks/e_sign`, <EsignTask />);
    expect(await screen.findByText('Nothing to sign')).toBeInTheDocument();
    expect(await screen.findByText(/this step isn't needed/i)).toBeInTheDocument();
    const onward = await screen.findByRole('link', { name: /continue/i });
    expect(onward).toHaveAttribute('href', `/onboarding/me/${APP_ID}/tasks/w4`);
    expect(onward).toHaveTextContent('Next: W-4');
  });

  it('a step still open with nothing drafted yet says so, without blaming anyone', async () => {
    vi.mocked(getApplication).mockResolvedValue(tasks('PENDING') as never);
    vi.mocked(listEsignAgreements).mockResolvedValue({ agreements: [] });
    renderAt(`/onboarding/me/${APP_ID}/tasks/e_sign`, <EsignTask />);
    expect(await screen.findByText('Nothing to sign')).toBeInTheDocument();
    expect(screen.getByText(/hasn't added an agreement for you yet/i)).toBeInTheDocument();
  });

  it('a failed load: plain words and Retry, no raw "Request failed (500)", no skeletons', async () => {
    vi.mocked(getApplication).mockResolvedValue(tasks('PENDING') as never);
    vi.mocked(listEsignAgreements).mockRejectedValue(new ApiError(500, 'internal', 'Request failed (500)'));
    const { container } = renderAt(`/onboarding/me/${APP_ID}/tasks/e_sign`, <EsignTask />);
    expect(await screen.findByText(/couldn.t load your agreements/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText(/request failed/i)).toBeNull();
    await waitFor(() => expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(0));
  });
});

describe('<DocumentUploadTask> (F500)', () => {
  it('says the limit the way people do ("10 MB") and puts Cancel before the action', async () => {
    vi.mocked(getApplication).mockRejectedValue(new Error('not loaded'));
    renderAt(`/onboarding/me/${APP_ID}/tasks/document_upload`, <DocumentUploadTask />);
    expect(await screen.findByText(/up to 10 MB per file/i)).toBeInTheDocument();
    expect(screen.queryByText(/10\.00 MB/)).toBeNull();
    const cancel = screen.getByRole('link', { name: /cancel/i });
    const action = screen.getByRole('button', { name: /upload at least one/i });
    expect(cancel.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
