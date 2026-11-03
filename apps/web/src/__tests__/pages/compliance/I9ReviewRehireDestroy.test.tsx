import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComplianceWorkforce, I9Verification } from '@alto-people/shared';
import { ymdLocal } from '@/lib/format';

vi.mock('@/lib/complianceApi', () => ({
  listI9s: vi.fn(),
  upsertI9: vi.fn(),
  listI9Reverifications: vi.fn(async () => ({ reverifications: [] })),
  recordI9Reverification: vi.fn(),
  destroyI9: vi.fn(),
  destroyI9s: vi.fn(),
}));
vi.mock('@/lib/i9Api', () => ({ listI9Documents: vi.fn(async () => ({ documents: [] })), submitI9Section2: vi.fn() }));

import { destroyI9, destroyI9s, listI9s, recordI9Reverification, upsertI9 } from '@/lib/complianceApi';
import { I9Tab } from '@/pages/compliance/I9Tab';

/**
 * The I-9 tab's three follow-ups (owner, 2026-11-03): an I-9 with an end
 * date and no citizenship status needs review (and HR records the status
 * from the paper Section 1); a rehire within 3 years reuses the I-9 on
 * Supplement B; an I-9 past retention can be destroyed — one with the typed
 * word DESTROY, several with the typed count.
 */

const day = (n: number) => {
  const d = new Date();
  return ymdLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, name: string, over: Partial<I9Verification> = {}): I9Verification {
  return {
    id: uuid(n),
    associateId: uuid(n + 100),
    associateName: name,
    associateEmail: `${name.split(' ')[0]!.toLowerCase()}@example.com`,
    applicationId: null,
    section1CompletedAt: '2024-01-02T12:00:00.000Z',
    section2CompletedAt: '2024-01-05T12:00:00.000Z',
    section2VerifierUserId: null,
    section2VerifierEmail: null,
    documentList: 'LIST_A',
    supportingDocIds: [],
    startDate: '2024-01-02',
    workAuthExpiresAt: null,
    retainUntil: '2029-01-02',
    reverifyDueAt: null,
    workStatus: 'ACTIVE',
    ...over,
  };
}

const CURRENT = [
  row(1, 'Nora Review', { workAuthExpiresAt: day(40), citizenshipStatus: null, needsReview: true }),
  row(2, 'Rae Rehire', { hireDate: day(-10), originalSection2On: '2024-01-05', rehired: true, citizenshipStatus: 'US_CITIZEN' }),
  row(3, 'Otto Old', { hireDate: day(-10), originalSection2On: '2020-01-05', rehired: true, citizenshipStatus: 'US_CITIZEN' }),
];
const FORMER = [
  row(9, 'Gone Grant', { retainUntil: day(-30), leftOn: '2022-01-15', workStatus: 'SEPARATED' }),
  row(8, 'Gone Gail', { retainUntil: day(-10), leftOn: '2022-03-01', workStatus: 'SEPARATED' }),
  row(7, 'Recent Rex', { retainUntil: day(300), leftOn: day(-60), workStatus: 'SEPARATED' }),
];

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <I9Tab canManage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const open = async (name: string) => fireEvent.click(await screen.findByText(name));

describe('I-9 needs review, rehire and destroy', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(upsertI9).mockReset();
    vi.mocked(recordI9Reverification).mockReset();
    vi.mocked(destroyI9).mockReset();
    vi.mocked(destroyI9s).mockReset();
    vi.mocked(listI9s).mockImplementation(async (_f, opts: { workforce?: ComplianceWorkforce } = {}) => ({
      i9s: opts.workforce === 'former' ? FORMER : CURRENT,
    }));
  });

  it('an end date with no citizenship status needs review: a tile, a chip, and the status recorded from Section 1', async () => {
    renderAt('/compliance?tab=i9&status=needs_review&workforce=current');
    expect(await screen.findByText('Nora Review')).toBeInTheDocument();
    expect(screen.queryByText('Rae Rehire')).toBeNull();
    expect(screen.getByText('Needs review', { selector: 'div' }).nextElementSibling).toHaveTextContent('1');
    vi.mocked(upsertI9).mockResolvedValue(CURRENT[0]!);
    await open('Nora Review');
    expect(await screen.findByText('Citizenship status missing — check Section 1 and the expiry date')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Section 1 says the employee is'), { target: { value: 'US_CITIZEN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record status' }));
    await waitFor(() => expect(upsertI9).toHaveBeenCalledWith(uuid(101), { citizenshipStatus: 'US_CITIZEN' }));
  });

  it('a rehire within 3 years records the rehire to reuse the I-9; past 3 years it says to complete a new one', async () => {
    renderAt('/compliance?tab=i9');
    fireEvent.click(await screen.findByRole('button', { name: 'All statuses' }));
    vi.mocked(recordI9Reverification).mockResolvedValue({} as never);
    await open('Rae Rehire');
    const button = await screen.findByRole('button', { name: 'Record rehire' });
    expect(screen.getByText(/no new document is needed/)).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(recordI9Reverification).toHaveBeenCalledWith(uuid(102), expect.objectContaining({ kind: 'REHIRE', rehiredOn: day(-10) })));
    expect(vi.mocked(recordI9Reverification).mock.calls[0]![1]).not.toHaveProperty('documentTitle');
  });

  it('past 3 years since the original I-9: no rehire form, a new I-9', async () => {
    renderAt('/compliance?tab=i9');
    fireEvent.click(await screen.findByRole('button', { name: 'All statuses' }));
    await open('Otto Old');
    expect(await screen.findByText('Rehired more than 3 years after the original I-9: complete a new I-9.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record rehire' })).toBeNull();
  });

  it('one I-9 past retention: Destroy waits for the typed word, then the row leaves', async () => {
    vi.mocked(destroyI9).mockResolvedValue({ destroyed: [{ associateId: uuid(109), documents: 2 }], refused: [] });
    renderAt('/compliance?tab=i9&status=retention&workforce=former');
    await open('Gone Grant');
    fireEvent.click(await screen.findByRole('button', { name: 'Destroy I-9' }));
    const dialog = await screen.findByRole('dialog', { name: /Destroy Gone Grant’s I-9\?/ });
    expect(within(dialog).getByText(/can’t be undone|can't be undone/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Destroy I-9' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type DESTROY to confirm'), { target: { value: 'destroy' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type DESTROY to confirm'), { target: { value: 'DESTROY' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(destroyI9).toHaveBeenCalledWith(uuid(109), 'DESTROY'));
  });

  it('several past retention: pick them, type the count, and each is sent', async () => {
    vi.mocked(destroyI9s).mockResolvedValue({ destroyed: [{ associateId: uuid(109), documents: 1 }, { associateId: uuid(108), documents: 0 }], refused: [] });
    renderAt('/compliance?tab=i9&status=retention&workforce=former');
    await screen.findByText('Gone Grant');
    // Only the two past retention are listed (Recent Rex must be kept).
    expect(screen.queryByText('Recent Rex')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Gone Grant' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Gone Gail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Destroy 2 I-9s' }));
    const dialog = await screen.findByRole('dialog', { name: 'Destroy 2 I-9s?' });
    fireEvent.change(within(dialog).getByLabelText('Type 2 to confirm'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Destroy 2 I-9s' }));
    await waitFor(() => expect(destroyI9s).toHaveBeenCalledWith([uuid(109), uuid(108)], '2'));
  });
});
