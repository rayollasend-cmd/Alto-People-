import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/onboardingApi', () => ({
  submitW4: vi.fn(async () => {}),
  // W4Task mounts and immediately calls getW4 to hydrate prior submissions.
  // hasSsnOnFile:true means the form treats the SSN as already on record
  // (showing "•••-••-1234" rather than asking the associate to retype it),
  // so the default-submit happy-path test can submit without typing an SSN.
  // Tests that exercise the SSN-input path call mockResolvedValueOnce with
  // hasSsnOnFile:false to override.
  getW4: vi.fn(async () => ({
    hasSubmission: true,
    filingStatus: null,
    multipleJobs: false,
    dependentsAmount: null,
    otherIncome: null,
    deductions: null,
    extraWithholding: null,
    hasSsnOnFile: true,
    ssnNeedsResubmit: false,
    hasSsnCardOnFile: true,
    ssnLast4: '6789',
    submittedAt: null,
  })),
}));

vi.mock('@/lib/i9Api', () => ({
  uploadI9Document: vi.fn(async () => ({
    documentId: 'd1',
    kind: 'SSN_CARD',
    side: null,
    size: 100,
    mimeType: 'image/jpeg',
    sha256: 'x',
  })),
}));

import { submitW4, getW4 } from '@/lib/onboardingApi';
import { uploadI9Document } from '@/lib/i9Api';
import { W4Task } from '@/pages/onboarding/tasks/W4Task';

// The page reads through the query layer; every render gets a client.
function withQueryClient({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  );
}
const render = (ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) =>
  rtlRender(ui, { wrapper: withQueryClient, ...options });

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
      <MemoryRouter initialEntries={[`/onboarding/me/${APP_ID}/w4`]}>
        <Routes>
          <Route path="/onboarding/me/:applicationId/w4" element={<W4Task />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(submitW4).mockClear();
  vi.mocked(submitW4).mockResolvedValue(undefined);
});

describe('<W4Task>', () => {
  it('submits with default filing status (SINGLE) and zero amounts', async () => {
    const user = userEvent.setup();
    renderTask();
    // The saved elections arrive through the query cache; submit only once
    // the form has hydrated (SSN on file → no SSN input to fail on).
    // (The SSN on file shows twice now: in Step 1 and in the review.)
    await screen.findAllByText(/•••-••-6789/);
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));

    await waitFor(() => expect(submitW4).toHaveBeenCalledTimes(1));
    expect(submitW4).toHaveBeenCalledWith(
      APP_ID,
      expect.objectContaining({
        filingStatus: 'SINGLE',
        multipleJobs: false,
        dependentsAmount: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
        ssn: undefined,
      })
    );
  });

  it('passes the SSN through verbatim when typed (server strips dashes + encrypts)', async () => {
    // SSN input is only rendered when no SSN is on file yet.
    vi.mocked(getW4).mockResolvedValueOnce({
      hasSubmission: false, filingStatus: null, multipleJobs: false,
      dependentsAmount: null, otherIncome: null, deductions: null,
      extraWithholding: null, hasSsnOnFile: false, ssnNeedsResubmit: false,
      hasSsnCardOnFile: false, ssnLast4: null, submittedAt: null,
    });
    const user = userEvent.setup();
    renderTask();
    const ssnField = await screen.findByLabelText(/social security/i);
    await user.type(ssnField, '123-45-6789');

    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    await waitFor(() => expect(submitW4).toHaveBeenCalledTimes(1));
    expect(submitW4.mock.calls[0][1]).toMatchObject({ ssn: '123-45-6789' });
  });

  it('does not log SSN to the console (regression guard for an obvious leak)', async () => {
    vi.mocked(getW4).mockResolvedValueOnce({
      hasSubmission: false, filingStatus: null, multipleJobs: false,
      dependentsAmount: null, otherIncome: null, deductions: null,
      extraWithholding: null, hasSsnOnFile: false, ssnNeedsResubmit: false,
      hasSsnCardOnFile: false, ssnLast4: null, submittedAt: null,
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    renderTask();
    await user.type(await screen.findByLabelText(/social security/i), '123456789');
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    await waitFor(() => expect(submitW4).toHaveBeenCalled());

    const allCalls = [...spy.mock.calls, ...errSpy.mock.calls].flat().map(String).join(' ');
    expect(allCalls).not.toContain('123456789');
    spy.mockRestore();
    errSpy.mockRestore();
  });

  it('blocks a recollection resubmit until the card photo is uploaded', async () => {
    vi.mocked(getW4).mockResolvedValueOnce({
      hasSubmission: true, filingStatus: 'SINGLE', multipleJobs: false,
      dependentsAmount: null, otherIncome: null, deductions: null,
      extraWithholding: null, hasSsnOnFile: false, ssnNeedsResubmit: true,
      hasSsnCardOnFile: false, ssnLast4: '6789', submittedAt: null,
    });
    const user = userEvent.setup();
    const { container } = renderTask();
    await user.type(await screen.findByLabelText(/social security number/i), '123-45-6789');

    // No card yet — submit must be refused client-side.
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    expect(
      await screen.findByText(/upload a photo of your social security card before submitting/i)
    ).toBeInTheDocument();
    expect(submitW4).not.toHaveBeenCalled();

    // Upload the card, then the submit goes through.
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(fileInput, new File(['img'], 'card.jpg', { type: 'image/jpeg' }));
    await waitFor(() =>
      expect(uploadI9Document).toHaveBeenCalledWith(
        APP_ID,
        expect.any(File),
        'SSN_CARD'
      )
    );
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    await waitFor(() => expect(submitW4).toHaveBeenCalledTimes(1));
  });

  it('requires the card upload for any resubmit missing a card image', async () => {
    vi.mocked(getW4).mockResolvedValueOnce({
      hasSubmission: true, filingStatus: 'SINGLE', multipleJobs: false,
      dependentsAmount: null, otherIncome: null, deductions: null,
      extraWithholding: null, hasSsnOnFile: true, ssnNeedsResubmit: false,
      hasSsnCardOnFile: false, ssnLast4: '6789', submittedAt: null,
    });
    const user = userEvent.setup();
    const { container } = renderTask();
    expect(
      await screen.findByText(/^social security card photo$/i)
    ).toBeInTheDocument();

    // Mandatory even outside the re-collection state — submit is blocked.
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    expect(
      await screen.findByText(/upload a photo of your social security card before submitting/i)
    ).toBeInTheDocument();
    expect(submitW4).not.toHaveBeenCalled();

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(fileInput, new File(['img'], 'card.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(uploadI9Document).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    await waitFor(() => expect(submitW4).toHaveBeenCalledTimes(1));
  });

  it('changes filing status when the select is updated', async () => {
    const user = userEvent.setup();
    renderTask();
    await user.selectOptions(screen.getByLabelText(/filing status/i), 'HEAD_OF_HOUSEHOLD');
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    await waitFor(() => expect(submitW4).toHaveBeenCalled());
    expect(submitW4.mock.calls[0][1]).toMatchObject({ filingStatus: 'HEAD_OF_HOUSEHOLD' });
  });

  // F500 fix-up 2026-10-22: Step 3 is asked the IRS way — counts, not a
  // dollar box — and the amount the API stores is worked out exactly.
  it('works out the Step 3 amount from the counts: 2 children + 1 other = $4,500', async () => {
    const user = userEvent.setup();
    renderTask();
    await screen.findAllByText(/•••-••-6789/);
    const kids = screen.getByLabelText(/children under 17/i);
    const others = screen.getByLabelText(/other dependents/i);
    await user.clear(kids);
    await user.type(kids, '2');
    await user.clear(others);
    await user.type(others, '1');
    expect(screen.getByTestId('w4-dependents-total')).toHaveTextContent('Total for dependents: $4,500');
    // The review reads back the same number before anything is sent.
    expect(screen.getByTestId('w4-review')).toHaveTextContent('$4,500');

    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    await waitFor(() => expect(submitW4).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitW4).mock.calls[0][1]).toMatchObject({ dependentsAmount: 4500 });
  });

  it('keeps a dependents amount already on file as filed (it cannot be split back into people)', async () => {
    vi.mocked(getW4).mockResolvedValueOnce({
      hasSubmission: true, filingStatus: 'MARRIED_FILING_JOINTLY', multipleJobs: true,
      dependentsAmount: '3700', otherIncome: null, deductions: null,
      extraWithholding: '25', hasSsnOnFile: true, ssnNeedsResubmit: false,
      hasSsnCardOnFile: true, ssnLast4: '6789', submittedAt: null,
    });
    const user = userEvent.setup();
    renderTask();
    const amount = await screen.findByLabelText(/dependents amount/i);
    expect(amount).toHaveValue(3700);
    expect(screen.queryByLabelText(/children under 17/i)).toBeNull();
    // Step 4 opens by itself because something in it was filed.
    expect(screen.getByLabelText(/extra withholding/i)).toBeVisible();
    expect(screen.getByTestId('w4-review')).toHaveTextContent('Extra withholding $25');
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    await waitFor(() => expect(submitW4).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitW4).mock.calls[0][1]).toMatchObject({
      filingStatus: 'MARRIED_FILING_JOINTLY',
      multipleJobs: true,
      dependentsAmount: 3700,
      extraWithholding: 25,
    });
  });

  it('asks for the SSN first (Step 1) and reads it back as the last 4 only', async () => {
    vi.mocked(getW4).mockResolvedValueOnce({
      hasSubmission: false, filingStatus: null, multipleJobs: false,
      dependentsAmount: null, otherIncome: null, deductions: null,
      extraWithholding: null, hasSsnOnFile: false, ssnNeedsResubmit: false,
      hasSsnCardOnFile: false, ssnLast4: null, submittedAt: null,
    });
    const user = userEvent.setup();
    renderTask();
    const ssnField = await screen.findByLabelText(/social security/i);
    const kids = screen.getByLabelText(/children under 17/i);
    // Document order: the SSN comes before Step 3, not last.
    expect(ssnField.compareDocumentPosition(kids) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('w4-review')).toHaveTextContent('Not entered yet');
    await user.type(ssnField, '123-45-6789');
    expect(screen.getByTestId('w4-review')).toHaveTextContent('•••-••-6789');
    expect(screen.getByTestId('w4-review')).not.toHaveTextContent('123-45');
  });
});
