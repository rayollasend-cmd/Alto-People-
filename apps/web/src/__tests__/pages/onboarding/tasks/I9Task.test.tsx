import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/i9Api', () => ({
  getI9Status: vi.fn(),
  submitI9Section1: vi.fn(),
  uploadI9Document: vi.fn(),
  submitI9Section2: vi.fn(),
}));

import { getI9Status, submitI9Section1, uploadI9Document } from '@/lib/i9Api';
import { I9Task } from '@/pages/onboarding/tasks/I9Task';

const APP_ID = '00000000-0000-4000-8000-00000000bbbb';

function renderTask() {
  const value = {
    isInitializing: false,
    isOffline: false,
    user: {
      id: 'u',
      email: 'maria@example.com',
      role: 'ASSOCIATE' as const,
      status: 'ACTIVE' as const,
      clientId: null,
      associateId: 'a',
    },
    role: 'ASSOCIATE' as const,
    capabilities: new Set<Capability>(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: () => false,
  };
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={[`/onboarding/me/${APP_ID}/tasks/i9_verification`]}>
        <Routes>
          <Route
            path="/onboarding/me/:applicationId/tasks/i9_verification"
            element={<I9Task />}
          />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(getI9Status).mockReset();
  vi.mocked(submitI9Section1).mockReset();
  vi.mocked(uploadI9Document).mockReset();
});

describe('<I9Task> Section 1', () => {
  it('US_CITIZEN happy path: typing name + signing calls submitI9Section1 without A-Number/expiry fields', async () => {
    vi.mocked(getI9Status).mockResolvedValue({
      associateId: 'a',
      section1: null,
      section2: null,
    });
    vi.mocked(submitI9Section1).mockResolvedValue({
      section1CompletedAt: new Date().toISOString(),
      citizenshipStatus: 'US_CITIZEN',
    });

    const user = userEvent.setup();
    renderTask();

    // Wait for the form to render (status fetch resolved).
    const typeNameField = await screen.findByLabelText(/type your full legal name/i);
    await user.type(typeNameField, 'Maria Lopez');
    await user.click(screen.getByRole('button', { name: /sign section 1/i }));

    await waitFor(() => expect(submitI9Section1).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(submitI9Section1).mock.calls[0];
    expect(payload).toEqual({
      citizenshipStatus: 'US_CITIZEN',
      typedName: 'Maria Lopez',
    });
  });

  it('reveals A-Number + expiry fields when ALIEN_AUTHORIZED_TO_WORK is selected', async () => {
    vi.mocked(getI9Status).mockResolvedValue({
      associateId: 'a',
      section1: null,
      section2: null,
    });
    const user = userEvent.setup();
    renderTask();

    const select = await screen.findByLabelText(/i attest, under penalty/i);
    await user.selectOptions(select, 'ALIEN_AUTHORIZED_TO_WORK');

    expect(screen.getByLabelText(/alien registration/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/work authorization expires/i)).toBeInTheDocument();
  });

  it('refuses to submit ALIEN_AUTHORIZED_TO_WORK without an A-Number (client-side guard)', async () => {
    vi.mocked(getI9Status).mockResolvedValue({
      associateId: 'a',
      section1: null,
      section2: null,
    });
    const user = userEvent.setup();
    renderTask();

    const select = await screen.findByLabelText(/i attest, under penalty/i);
    await user.selectOptions(select, 'ALIEN_AUTHORIZED_TO_WORK');
    await user.type(screen.getByLabelText(/type your full legal name/i), 'Maria Lopez');
    // Fill in expiry but leave A-Number empty.
    await user.type(screen.getByLabelText(/work authorization expires/i), '2027-01-01');
    await user.click(screen.getByRole('button', { name: /sign section 1/i }));

    expect(screen.getByText(/alien registration number.*required/i)).toBeInTheDocument();
    expect(submitI9Section1).not.toHaveBeenCalled();
  });

  it('shows the signed summary when section1 is already complete (no form rendered)', async () => {
    vi.mocked(getI9Status).mockResolvedValue({
      associateId: 'a',
      section1: {
        completedAt: '2026-04-26T18:00:00.000Z',
        citizenshipStatus: 'US_CITIZEN',
        workAuthExpiresAt: null,
        hasAlienNumber: false,
        typedName: 'Maria Lopez',
      },
      section2: null,
    });
    renderTask();

    expect(await screen.findByText(/signed by:/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign section 1/i })).toBeNull();
  });
});

describe('<I9Task> document upload', () => {
  it('uploads a picked file via uploadI9Document and shows it in the list', async () => {
    vi.mocked(getI9Status).mockResolvedValue({
      associateId: 'a',
      section1: {
        completedAt: '2026-04-26T18:00:00.000Z',
        citizenshipStatus: 'US_CITIZEN',
        workAuthExpiresAt: null,
        hasAlienNumber: false,
        typedName: 'Maria Lopez',
      },
      section2: null,
    });
    vi.mocked(uploadI9Document).mockResolvedValue({
      documentId: 'doc-1',
      kind: 'I9_SUPPORTING',
      side: null,
      size: 1234,
      mimeType: 'image/png',
      sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    });

    const user = userEvent.setup();
    const { container } = renderTask();
    await screen.findByText(/identification documents/i);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.getAttribute('capture')).toBe('environment');

    const fakeFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'license.png', {
      type: 'image/png',
    });
    await user.upload(input, fakeFile);

    await waitFor(() => expect(uploadI9Document).toHaveBeenCalledTimes(1));
    expect(uploadI9Document).toHaveBeenCalledWith(APP_ID, fakeFile, 'I9_SUPPORTING');
    expect(await screen.findByText('license.png')).toBeInTheDocument();
  });

  it('hides the upload control once Section 2 is verified', async () => {
    vi.mocked(getI9Status).mockResolvedValue({
      associateId: 'a',
      section1: {
        completedAt: '2026-04-26T18:00:00.000Z',
        citizenshipStatus: 'US_CITIZEN',
        workAuthExpiresAt: null,
        hasAlienNumber: false,
        typedName: 'Maria Lopez',
      },
      section2: {
        completedAt: '2026-04-26T19:00:00.000Z',
        verifierEmail: 'admin@altohr.com',
        documentList: 'LIST_A',
        supportingDocIds: ['doc-1'],
      },
    });
    const { container } = renderTask();
    await screen.findByText(/identification documents/i);
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeNull();
    expect(screen.getAllByText(/verified/i).length).toBeGreaterThan(0);
  });
});
