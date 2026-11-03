import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';

// The drawer header links to the associate's profile, so renders need a
// Router context.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// The tab reads through the query layer; every render gets a client.
const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
import userEvent from '@testing-library/user-event';
import type { I9Verification } from '@alto-people/shared';

vi.mock('@/lib/complianceApi', () => ({
  listI9s: vi.fn(),
  upsertI9: vi.fn(),
  listI9Reverifications: vi.fn(async () => ({ reverifications: [] })),
  recordI9Reverification: vi.fn(),
}));

vi.mock('@/lib/i9Api', () => ({
  listI9Documents: vi.fn(),
  submitI9Section2: vi.fn(),
}));

import { listI9s, recordI9Reverification, upsertI9 } from '@/lib/complianceApi';
import { listI9Documents, submitI9Section2 } from '@/lib/i9Api';
import { I9Tab } from '@/pages/compliance/I9Tab';

const APP_ID = '00000000-0000-4000-8000-00000000aaaa';
const I9_ID = '00000000-0000-4000-8000-00000000bbbb';
const ASSOC_ID = '00000000-0000-4000-8000-00000000cccc';
const DOC_FRONT = '00000000-0000-4000-8000-0000000d0001';
const DOC_BACK = '00000000-0000-4000-8000-0000000d0002';

function pendingRow(): I9Verification {
  return {
    id: I9_ID,
    associateId: ASSOC_ID,
    associateName: 'Maria Lopez',
    associateEmail: 'maria@example.com',
    applicationId: APP_ID,
    section1CompletedAt: '2026-04-25T18:00:00.000Z',
    section2CompletedAt: null,
    section2VerifierUserId: null,
    section2VerifierEmail: null,
    documentList: null,
    supportingDocIds: [],
  };
}

beforeEach(() => {
  vi.mocked(listI9s).mockReset();
  vi.mocked(listI9Documents).mockReset();
  vi.mocked(submitI9Section2).mockReset();
  vi.mocked(upsertI9).mockReset();
  // The tab persists its status/client filters — isolate tests from each
  // other's clicks.
  window.localStorage.clear();
});

// In the new UI, an I-9 row is a clickable Card (no explicit "Verify Section 2"
// button). Clicking the row opens a drawer; the verifier card lives inside.
async function openRowDrawer(user: ReturnType<typeof userEvent.setup>) {
  const nameEl = await screen.findByText('Maria Lopez');
  await user.click(nameEl);
}

describe('<I9Tab> Section 2 verifier card', () => {
  it('happy path: HR picks LIST_A + one doc, calls submitI9Section2 with that applicationId', async () => {
    vi.mocked(listI9s).mockResolvedValue({ i9s: [pendingRow()] });
    vi.mocked(listI9Documents).mockResolvedValue({
      documents: [
        {
          id: DOC_FRONT,
          kind: 'ID',
          filename: 'id-front.jpg',
          mimeType: 'image/jpeg',
          size: 100_000,
          status: 'UPLOADED',
          side: 'FRONT',
          createdAt: '2026-04-25T18:01:00.000Z',
          fileAvailable: true,
        },
        {
          id: DOC_BACK,
          kind: 'ID',
          filename: 'id-back.jpg',
          mimeType: 'image/jpeg',
          size: 100_000,
          status: 'UPLOADED',
          side: 'BACK',
          createdAt: '2026-04-25T18:02:00.000Z',
          fileAvailable: true,
        },
      ],
    });
    vi.mocked(submitI9Section2).mockResolvedValue({
      section2CompletedAt: '2026-04-26T20:00:00.000Z',
      documentList: 'LIST_A',
      supportingDocIds: [DOC_FRONT],
    });

    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);

    await openRowDrawer(user);

    await waitFor(() => expect(listI9Documents).toHaveBeenCalledWith(APP_ID));
    // Default doc-list is LIST_A (1 doc minimum); pick the front of the ID.
    const front = await screen.findByLabelText(/id front/i);
    await user.click(front);

    const submit = await screen.findByRole('button', { name: /verify section 2 \(1 doc\)/i });
    await user.click(submit);

    await waitFor(() => expect(submitI9Section2).toHaveBeenCalledTimes(1));
    expect(submitI9Section2).toHaveBeenCalledWith(APP_ID, {
      documentList: 'LIST_A',
      supportingDocIds: [DOC_FRONT],
    });
  });

  it('disables submit until at least one doc is picked (LIST_A)', async () => {
    vi.mocked(listI9s).mockResolvedValue({ i9s: [pendingRow()] });
    vi.mocked(listI9Documents).mockResolvedValue({
      documents: [
        {
          id: DOC_FRONT,
          kind: 'ID',
          filename: 'id-front.jpg',
          mimeType: 'image/jpeg',
          size: 100_000,
          status: 'UPLOADED',
          side: 'FRONT',
          createdAt: '2026-04-25T18:01:00.000Z',
          fileAvailable: true,
        },
      ],
    });

    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);

    await openRowDrawer(user);
    await screen.findByLabelText(/id front/i);

    const submit = screen.getByRole('button', { name: /verify section 2 \(0 docs\)/i });
    expect(submit).toBeDisabled();
  });

  it('LIST_B_AND_C requires at least 2 documents before submit unlocks', async () => {
    vi.mocked(listI9s).mockResolvedValue({ i9s: [pendingRow()] });
    vi.mocked(listI9Documents).mockResolvedValue({
      documents: [
        {
          id: DOC_FRONT,
          kind: 'ID',
          filename: 'id-front.jpg',
          mimeType: 'image/jpeg',
          size: 100_000,
          status: 'UPLOADED',
          side: 'FRONT',
          createdAt: '2026-04-25T18:01:00.000Z',
          fileAvailable: true,
        },
        {
          id: DOC_BACK,
          kind: 'SSN_CARD',
          filename: 'ssn.jpg',
          mimeType: 'image/jpeg',
          size: 100_000,
          status: 'UPLOADED',
          side: null,
          createdAt: '2026-04-25T18:02:00.000Z',
          fileAvailable: true,
        },
      ],
    });

    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);

    await openRowDrawer(user);
    await screen.findByLabelText(/id front/i);
    await user.click(screen.getByRole('radio', { name: /lists b \+ c/i }));
    await user.click(screen.getByLabelText(/id front/i));

    // Only one picked → still disabled.
    expect(screen.getByRole('button', { name: /verify section 2 \(1 doc\)/i })).toBeDisabled();

    await user.click(screen.getByLabelText(/ssn_card/i));
    expect(screen.getByRole('button', { name: /verify section 2 \(2 docs\)/i })).toBeEnabled();
  });

  it('a doc whose file is missing on the server cannot be picked', async () => {
    vi.mocked(listI9s).mockResolvedValue({ i9s: [pendingRow()] });
    vi.mocked(listI9Documents).mockResolvedValue({
      documents: [
        {
          id: DOC_FRONT,
          kind: 'ID',
          filename: 'id-front.jpg',
          mimeType: 'image/jpeg',
          size: 100_000,
          status: 'UPLOADED',
          side: 'FRONT',
          createdAt: '2026-04-25T18:01:00.000Z',
          // Blob lost server-side (e.g. ephemeral disk wiped) — the tile
          // must be disabled so HR can't "inspect" a document that
          // doesn't exist.
          fileAvailable: false,
        },
      ],
    });

    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);

    await openRowDrawer(user);
    const tile = await screen.findByLabelText(/id front/i);
    expect(tile).toBeDisabled();
    await user.click(tile);
    expect(
      screen.getByRole('button', { name: /verify section 2 \(0 docs\)/i }),
    ).toBeDisabled();
  });

  it('pre-checks classified docs matching the auto-picked list (missing blobs stay unpicked)', async () => {
    vi.mocked(listI9s).mockResolvedValue({ i9s: [pendingRow()] });
    vi.mocked(listI9Documents).mockResolvedValue({
      documents: [
        {
          id: DOC_FRONT,
          kind: 'ID',
          filename: 'passport.jpg',
          mimeType: 'image/jpeg',
          size: 100_000,
          status: 'UPLOADED',
          side: null,
          i9DocTitle: 'U.S. Passport or Passport Card',
          i9List: 'A',
          createdAt: '2026-04-25T18:01:00.000Z',
          fileAvailable: true,
        },
        {
          id: DOC_BACK,
          kind: 'ID',
          filename: 'passport-2.jpg',
          mimeType: 'image/jpeg',
          size: 100_000,
          status: 'UPLOADED',
          side: null,
          i9DocTitle: 'U.S. Passport or Passport Card',
          i9List: 'A',
          createdAt: '2026-04-25T18:02:00.000Z',
          // Missing blob → disabled checkbox, must never be pre-picked.
          fileAvailable: false,
        },
      ],
    });

    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);

    await openRowDrawer(user);
    // One usable List-A doc pre-checked — submit is enabled with no clicks.
    const submit = await screen.findByRole('button', {
      name: /verify section 2 \(1 doc\)/i,
    });
    expect(submit).toBeEnabled();
  });

  it('"Verify & next" advances the drawer to the next pending row in view', async () => {
    const APP2 = '00000000-0000-4000-8000-00000000aab2';
    const row2: I9Verification = {
      ...pendingRow(),
      id: '00000000-0000-4000-8000-00000000bbb2',
      associateId: '00000000-0000-4000-8000-00000000ccc2',
      associateName: 'John Roe',
      associateEmail: 'john@example.com',
      applicationId: APP2,
    };
    vi.mocked(listI9s).mockResolvedValue({ i9s: [pendingRow(), row2] });
    vi.mocked(listI9Documents).mockResolvedValue({
      documents: [
        {
          id: DOC_FRONT,
          kind: 'ID',
          filename: 'passport.jpg',
          mimeType: 'image/jpeg',
          size: 100_000,
          status: 'UPLOADED',
          side: null,
          i9DocTitle: 'U.S. Passport or Passport Card',
          i9List: 'A',
          createdAt: '2026-04-25T18:01:00.000Z',
          fileAvailable: true,
        },
      ],
    });
    vi.mocked(submitI9Section2).mockResolvedValue({
      section2CompletedAt: '2026-04-26T20:00:00.000Z',
      documentList: 'LIST_A',
      supportingDocIds: [DOC_FRONT],
    });

    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);

    await openRowDrawer(user); // Maria first
    await screen.findByRole('button', { name: /verify section 2 \(1 doc\)/i });

    await user.click(screen.getByRole('button', { name: /verify & next/i }));

    // The drawer hops to John's pending I-9 and loads HIS documents.
    await waitFor(() => expect(listI9Documents).toHaveBeenCalledWith(APP2));
    expect(submitI9Section2).toHaveBeenCalledWith(APP_ID, {
      documentList: 'LIST_A',
      supportingDocIds: [DOC_FRONT],
    });
  });

  it('re-verification due: the drawer records a Supplement B with the new expiry (owner, 2026-11-03)', async () => {
    // 30 days out — inside the ≤90d window whatever day the test runs.
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    const soonYmd = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
    vi.mocked(listI9s).mockResolvedValue({
      i9s: [{ ...pendingRow(), workAuthExpiresAt: soonYmd, reverifyDueAt: soonYmd, citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', reverifyDue: true }],
    });
    vi.mocked(listI9Documents).mockResolvedValue({ documents: [] });
    vi.mocked(recordI9Reverification).mockResolvedValue({
      id: '00000000-0000-4000-8000-0000000f0001',
      associateId: ASSOC_ID,
      documentTitle: 'Employment Authorization Document (Form I-766)',
      documentNumberLast4: '7890',
      issuingAuthority: null,
      previousExpiresAt: soonYmd,
      newExpiresAt: '2027-06-30',
      reviewedOn: soonYmd,
      reviewedByEmail: null,
      notes: null,
      createdAt: new Date().toISOString(),
    });

    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);

    await openRowDrawer(user);
    fireEvent.change(await screen.findByLabelText(/^document$/i), { target: { value: 'Employment Authorization Document (Form I-766)' } });
    fireEvent.change(screen.getByLabelText(/document number/i), { target: { value: 'SRC1234567890' } });
    fireEvent.change(screen.getByLabelText(/new expiry date/i), { target: { value: '2027-06-30' } });
    await user.click(screen.getByRole('button', { name: /record re-verification/i }));

    await waitFor(() =>
      expect(recordI9Reverification).toHaveBeenCalledWith(ASSOC_ID, expect.objectContaining({
        documentTitle: 'Employment Authorization Document (Form I-766)',
        documentNumber: 'SRC1234567890',
        newExpiresAt: '2027-06-30',
      })),
    );
    expect(upsertI9).not.toHaveBeenCalled();
  });

  it('a permanent resident’s card expiry offers no re-verification', async () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    const soonYmd = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
    vi.mocked(listI9s).mockResolvedValue({
      i9s: [{ ...pendingRow(), workAuthExpiresAt: soonYmd, reverifyDueAt: null, citizenshipStatus: 'LAWFUL_PERMANENT_RESIDENT', reverifyDue: false }],
    });
    vi.mocked(listI9Documents).mockResolvedValue({ documents: [] });
    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);
    await openRowDrawer(user);
    await screen.findByText(/section 2 verification/i);
    expect(screen.queryByRole('button', { name: /record re-verification/i })).not.toBeInTheDocument();
  });

  it('shows the legacy edit form (not the verifier card) when section2 already complete', async () => {
    const completed: I9Verification = {
      ...pendingRow(),
      section2CompletedAt: '2026-04-26T19:00:00.000Z',
      section2VerifierUserId: '00000000-0000-4000-8000-0000000eeeee',
      section2VerifierEmail: 'admin@altohr.com',
      documentList: 'LIST_A',
      supportingDocIds: [DOC_FRONT],
    };
    vi.mocked(listI9s).mockResolvedValue({ i9s: [completed] });

    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);

    // Filtering is client-side over the full list now — a completed row is
    // hidden from the default Pending view, so switch chips first.
    await user.click(await screen.findByRole('button', { name: /^complete$/i }));

    await openRowDrawer(user);
    // Legacy form contains "Section 1 complete" + "Section 2 complete" checkboxes.
    expect(await screen.findByLabelText(/section 1 complete/i)).toBeInTheDocument();
    expect(listI9Documents).not.toHaveBeenCalled();
  });
});

describe('<I9Tab> manual Section 2 (owner, 2026-11-03)', () => {
  const completed = (): I9Verification => ({
    ...pendingRow(),
    section2CompletedAt: '2026-04-26T19:00:00.000Z',
    section2VerifierUserId: '00000000-0000-4000-8000-0000000eeeee',
    section2VerifierEmail: 'admin@altohr.com',
    documentList: 'LIST_A',
    section2ExaminedOn: '2026-04-26',
    hireDate: '2026-04-20',
  });

  it('unticking a completed Section 2 asks why, and sends the reason', async () => {
    vi.mocked(listI9s).mockResolvedValue({ i9s: [completed()] });
    vi.mocked(upsertI9).mockResolvedValue({ ...completed(), section2CompletedAt: null });
    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);
    await user.click(await screen.findByRole('button', { name: /^complete$/i }));
    await openRowDrawer(user);
    await user.click(await screen.findByLabelText(/section 2 complete/i));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/why section 2 is being unticked/i);
    expect(upsertI9).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/why is section 2 being unticked/i), { target: { value: 'Ticked on the wrong person' } });
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(upsertI9).toHaveBeenCalledWith(ASSOC_ID, expect.objectContaining({ section2CompletedAt: null, reason: 'Ticked on the wrong person' })),
    );
    // Not an examined date for a Section 2 being unticked.
    expect(vi.mocked(upsertI9).mock.calls[0]![1]).not.toHaveProperty('section2ExaminedOn');
  });

  it('a save that leaves Section 2 alone never invents an examined date', async () => {
    vi.mocked(listI9s).mockResolvedValue({ i9s: [{ ...completed(), section2ExaminedOn: null }] });
    vi.mocked(upsertI9).mockResolvedValue(completed());
    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);
    await user.click(await screen.findByRole('button', { name: /^complete$/i }));
    await openRowDrawer(user);
    await user.click(await screen.findByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(upsertI9).toHaveBeenCalled());
    expect(vi.mocked(upsertI9).mock.calls[0]![1]).not.toHaveProperty('section2ExaminedOn');
  });
});

describe('<I9Tab> ?return= round-trip from the application drawer', () => {
  const RETURN_TO = `/onboarding?applicationId=${APP_ID}`;

  // Routes so the tab can actually navigate somewhere assertable.
  const renderAt = (entry: string) =>
    rtlRender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/compliance" element={<I9Tab canManage={true} />} />
            <Route path="/onboarding" element={<div>Onboarding return probe</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  const passportDoc = {
    id: DOC_FRONT,
    kind: 'ID' as const,
    filename: 'passport.jpg',
    mimeType: 'image/jpeg',
    size: 100_000,
    status: 'UPLOADED' as const,
    side: null,
    i9DocTitle: 'U.S. Passport or Passport Card',
    i9List: 'A' as const,
    createdAt: '2026-04-25T18:01:00.000Z',
    fileAvailable: true,
  };

  it('deep link with return= shows "Back to application" and navigates back after verify', async () => {
    vi.mocked(listI9s).mockResolvedValue({ i9s: [pendingRow()] });
    vi.mocked(listI9Documents).mockResolvedValue({ documents: [passportDoc] });
    vi.mocked(submitI9Section2).mockResolvedValue({
      section2CompletedAt: '2026-04-26T20:00:00.000Z',
      documentList: 'LIST_A',
      supportingDocIds: [DOC_FRONT],
    });

    const user = userEvent.setup();
    renderAt(
      `/compliance?tab=i9&associateId=${ASSOC_ID}&return=${encodeURIComponent(RETURN_TO)}`,
    );

    // The deep link auto-opens the drawer; the return path surfaces a way back.
    expect(
      await screen.findByRole('link', { name: /back to application/i }),
    ).toBeInTheDocument();

    // Passport pre-checked → verify with zero extra clicks.
    await user.click(
      await screen.findByRole('button', { name: /verify section 2 \(1 doc\)/i }),
    );

    await waitFor(() =>
      expect(submitI9Section2).toHaveBeenCalledWith(APP_ID, {
        documentList: 'LIST_A',
        supportingDocIds: [DOC_FRONT],
      }),
    );
    // Successful verify returns the reviewer to the application page.
    expect(await screen.findByText('Onboarding return probe')).toBeInTheDocument();
  });

  it('rejects non-app return paths (protocol-relative URL is ignored)', async () => {
    vi.mocked(listI9s).mockResolvedValue({ i9s: [pendingRow()] });
    vi.mocked(listI9Documents).mockResolvedValue({ documents: [passportDoc] });

    renderAt(
      `/compliance?tab=i9&associateId=${ASSOC_ID}&return=${encodeURIComponent('//evil.example.com/steal')}`,
    );

    // Drawer opens for the deep-linked associate…
    await screen.findByRole('button', { name: /verify section 2 \(1 doc\)/i });
    // …but the poisoned return path is dropped entirely.
    expect(
      screen.queryByRole('link', { name: /back to application/i }),
    ).not.toBeInTheDocument();
  });
});
