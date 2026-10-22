import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * Role walk HR 8: the offer, made from the candidate in one step. Filled
 * from their posting (client, pay by its unit, title, next Monday), the
 * client's letter written in, and one "Create & send". Pay outside the
 * band stops after create: the approvers were asked, nothing is sent.
 */

vi.mock('@/lib/recruitingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/recruitingApi')>()),
  getCandidate: vi.fn(),
  listCandidates: vi.fn().mockResolvedValue({ candidates: [], total: 0 }),
}));
vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn().mockResolvedValue({ clients: [{ id: 'c1', name: 'Coastal Resort Holdings' }, { id: 'c2', name: 'Other' }] }),
}));
vi.mock('@/lib/recruiting90Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/recruiting90Api')>()),
  listJobPostings: vi.fn(),
  listOfferLetterTemplates: vi.fn().mockResolvedValue({ templates: [{ id: 't1', name: 'Coastal standard', clientName: 'Coastal Resort Holdings' }] }),
  previewOfferLetter: vi.fn().mockResolvedValue({ templateId: 't1', templateName: 'Coastal standard', body: 'Dear Ana, welcome aboard.', unresolvedTokens: [] }),
  createOffer: vi.fn(),
  sendOffer: vi.fn().mockResolvedValue({ ok: true, emailed: true }),
}));

import { getCandidate } from '@/lib/recruitingApi';
import { createOffer, listJobPostings, previewOfferLetter, sendOffer } from '@/lib/recruiting90Api';
import { NewOfferDrawer, nextMonday } from '@/pages/recruiting/OfferDialog';

beforeEach(() => {
  vi.mocked(createOffer).mockReset();
  vi.mocked(sendOffer).mockClear();
  vi.mocked(getCandidate).mockResolvedValue({
    id: 'cand1',
    firstName: 'Ana',
    lastName: 'Silva',
    email: 'ana@example.com',
    position: null,
    jobPostingId: 'po1',
  } as never);
  vi.mocked(listJobPostings).mockResolvedValue({
    postings: [{ id: 'po1', clientId: 'c1', clientName: 'Coastal Resort Holdings', title: 'Housekeeper', minSalary: '17.50', payUnit: 'HOUR', status: 'OPEN' }] as never,
  });
});

function open() {
  const onSaved = vi.fn();
  renderAs('INTERNAL_RECRUITER', <NewOfferDrawer seedCandidateId="cand1" oneStep onClose={vi.fn()} onSaved={onSaved} />);
  return { onSaved };
}

describe('<NewOfferDrawer oneStep> — the offer in one step', () => {
  it('fills client, pay, title and start from the posting, writes the letter, then creates and sends', async () => {
    const { onSaved } = open();
    vi.mocked(createOffer).mockResolvedValue({ id: 'o1', status: 'DRAFT', approvalNote: null });
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByDisplayValue('Housekeeper')).toBeInTheDocument());
    expect(within(dialog).getByDisplayValue('17.50')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue(nextMonday())).toBeInTheDocument();
    await waitFor(() => expect((within(dialog).getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('c1'));
    // The client's letter, written in without a click.
    await waitFor(() => expect(within(dialog).getByDisplayValue('Dear Ana, welcome aboard.')).toBeInTheDocument());
    expect(previewOfferLetter).toHaveBeenCalledWith(expect.objectContaining({ candidateId: 'cand1', clientId: 'c1', hourlyRate: 17.5 }));
    expect(within(dialog).queryByRole('button', { name: 'Create draft' })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: /Create & send/ }));
    await waitFor(() => expect(sendOffer).toHaveBeenCalledWith('o1'));
    expect(createOffer).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: 'cand1', clientId: 'c1', jobTitle: 'Housekeeper', hourlyRate: 17.5, startDate: nextMonday(), letterBody: 'Dear Ana, welcome aboard.' }),
    );
    expect(vi.mocked(createOffer).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(sendOffer).mock.invocationCallOrder[0]!);
    expect(onSaved).toHaveBeenCalled();
  });

  it('pay outside the band goes for approval and is not sent', async () => {
    const { onSaved } = open();
    vi.mocked(createOffer).mockResolvedValue({ id: 'o2', status: 'PENDING_APPROVAL', approvalNote: 'Above the band by $2.00/hr' });
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByDisplayValue('Dear Ana, welcome aboard.')).toBeInTheDocument());
    await userEvent.click(within(dialog).getByRole('button', { name: /Create & send/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(createOffer).toHaveBeenCalled();
    expect(sendOffer).not.toHaveBeenCalled();
  });

  it('next Monday is always ahead, never today', () => {
    expect(nextMonday(new Date(2026, 9, 21))).toBe('2026-10-26'); // a Wednesday
    expect(nextMonday(new Date(2026, 9, 26))).toBe('2026-11-02'); // a Monday
  });
});
