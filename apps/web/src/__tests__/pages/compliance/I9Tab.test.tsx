import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { I9Verification } from '@alto-people/shared';

vi.mock('@/lib/complianceApi', () => ({
  listI9s: vi.fn(),
  upsertI9: vi.fn(),
}));

vi.mock('@/lib/i9Api', () => ({
  listI9Documents: vi.fn(),
  submitI9Section2: vi.fn(),
}));

import { listI9s } from '@/lib/complianceApi';
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
});

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

    const verifyBtn = await screen.findByRole('button', { name: /verify section 2/i });
    await user.click(verifyBtn);

    await waitFor(() => expect(listI9Documents).toHaveBeenCalledWith(APP_ID));
    // Default doc-list is LIST_A (1 doc minimum); pick the first.
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
        },
      ],
    });

    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);

    await user.click(await screen.findByRole('button', { name: /verify section 2/i }));
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
        },
      ],
    });

    const user = userEvent.setup();
    render(<I9Tab canManage={true} />);

    await user.click(await screen.findByRole('button', { name: /verify section 2/i }));
    await screen.findByLabelText(/id front/i);
    await user.click(screen.getByRole('radio', { name: /lists b \+ c/i }));
    await user.click(screen.getByLabelText(/id front/i));

    // Only one picked → still disabled.
    expect(screen.getByRole('button', { name: /verify section 2 \(1 doc\)/i })).toBeDisabled();

    await user.click(screen.getByLabelText(/ssn_card/i));
    expect(screen.getByRole('button', { name: /verify section 2 \(2 docs\)/i })).toBeEnabled();
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

    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    // Legacy form contains "Section 1 complete" + "Section 2 complete" checkboxes.
    expect(screen.getByLabelText(/section 1 complete/i)).toBeInTheDocument();
    expect(listI9Documents).not.toHaveBeenCalled();
  });
});
