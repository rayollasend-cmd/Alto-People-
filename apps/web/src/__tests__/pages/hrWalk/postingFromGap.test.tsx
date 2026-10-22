import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * Role walk HR 5: a staffing gap becomes a job posting in one step. The
 * short store row on the headcount plan links to the postings tab with the
 * posting filled in (client, title, store, openings = the shortfall,
 * Seasonal); the drawer opens on it, and "Save & open" is the default —
 * a draft fills nothing.
 */

vi.mock('@/pages/recruiting/staffingGaps', async (orig) => ({
  ...(await orig<typeof import('@/pages/recruiting/staffingGaps')>()),
  getStaffingPlan: vi.fn(),
}));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [], error: null, reload: vi.fn() }) }));
vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn().mockResolvedValue({ clients: [{ id: 'c1', name: 'Coastal Resort Holdings' }] }),
}));
vi.mock('@/lib/recruiting90Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/recruiting90Api')>()),
  listJobPostings: vi.fn().mockResolvedValue({ postings: [] }),
  listInterviewKits: vi.fn().mockResolvedValue({ kits: [] }),
  listOffers: vi.fn().mockResolvedValue({ offers: [] }),
  listReferrals: vi.fn().mockResolvedValue({ referrals: [] }),
  createJobPosting: vi.fn().mockResolvedValue({ id: 'po-new' }),
  openJobPosting: vi.fn().mockResolvedValue({ ok: true }),
}));

import { getStaffingPlan, gapsWithoutPosting, type StaffingPlanResponse } from '@/pages/recruiting/staffingGaps';
import { postingForGapHref, postingSeedFrom } from '@/pages/recruiting/postingSeed';
import { createJobPosting, openJobPosting, type JobPostingRecord } from '@/lib/recruiting90Api';
import { StaffingPlanView } from '@/pages/headcount/StaffingPlan';
import { RecruitingExtras } from '@/pages/recruiting/RecruitingExtras';
import { StaffingGaps } from '@/pages/RecruiterDashboard';
import { listJobPostings } from '@/lib/recruiting90Api';

const week = (w: string, required: number, placed: number) => ({
  week: w,
  required,
  placed,
  scheduled: placed,
  gap: Math.max(0, required - placed),
  hours: 0,
  budget: null,
  source: 'season' as const,
});

const plan: StaffingPlanResponse = {
  weeks: ['2026-11-07', '2026-11-14'],
  stores: [
    { storeId: 's1', storeName: 'Front Beach 218', clientId: 'c1', clientName: 'Coastal Resort Holdings', placed: 8, weeks: [week('2026-11-07', 20, 8), week('2026-11-14', 31, 8)] },
    { storeId: 's2', storeName: 'Bayside', clientId: 'c1', clientName: 'Coastal Resort Holdings', placed: 6, weeks: [week('2026-11-07', 6, 6), week('2026-11-14', 6, 6)] },
  ],
  totals: [],
  priced: 0,
};

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('staffing gaps', () => {
  it('a short store row links to a posting filled in with the largest weekly shortfall', async () => {
    vi.mocked(getStaffingPlan).mockResolvedValue(plan);
    renderAs('HR_ADMINISTRATOR', <StaffingPlanView />, '/headcount/plan');
    const link = await screen.findByRole('link', { name: /Open a posting for 23/ });
    const href = new URL(link.getAttribute('href')!, 'http://x');
    expect(href.pathname).toBe('/recruiting/extras');
    expect(Object.fromEntries(href.searchParams)).toEqual({
      tab: 'postings',
      new: '1',
      clientId: 'c1',
      title: 'Associate — Front Beach 218',
      location: 'Front Beach 218',
      openings: '23',
      schedule: 'SEASONAL',
    });
    // A store that is covered every week has no button.
    expect(screen.queryByRole('link', { name: /Open a posting for 0/ })).not.toBeInTheDocument();
  });

  it('a gap counts until an open posting for that store exists', () => {
    expect(gapsWithoutPosting(plan, []).map((g) => [g.storeName, g.short])).toEqual([['Front Beach 218', 23]]);
    const open = { id: 'p', status: 'OPEN', clientId: 'c1', title: 'Associate — Front Beach 218', location: 'Front Beach 218' } as JobPostingRecord;
    expect(gapsWithoutPosting(plan, [open])).toEqual([]);
    // A draft hires nobody.
    expect(gapsWithoutPosting(plan, [{ ...open, status: 'DRAFT' }])).toHaveLength(1);
  });

  it('reads the posting seed from the link, and nothing from any other URL', () => {
    const href = postingForGapHref({ clientId: 'c1', storeName: 'Front Beach 218', openings: 23 });
    expect(postingSeedFrom(href.slice(href.indexOf('?')))).toEqual({
      clientId: 'c1',
      title: 'Associate — Front Beach 218',
      location: 'Front Beach 218',
      openings: 23,
      schedule: 'SEASONAL',
    });
    expect(postingSeedFrom('?tab=offers&new=1')).toBeNull();
  });
});

describe('the recruiter home — staffing gaps without a posting', () => {
  it('lists the short store with its link, and goes quiet once a posting is open', async () => {
    vi.mocked(getStaffingPlan).mockResolvedValue(plan);
    vi.mocked(listJobPostings).mockResolvedValue({ postings: [] });
    const { unmount } = renderAs('INTERNAL_RECRUITER', <StaffingGaps canPost />);
    expect(await screen.findByText('Staffing gaps without a posting')).toBeInTheDocument();
    expect(screen.getByText('Front Beach 218')).toBeInTheDocument();
    expect(screen.queryByText('Bayside')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open a posting for 23/ })).toHaveAttribute(
      'href',
      postingForGapHref({ clientId: 'c1', storeName: 'Front Beach 218', openings: 23 }),
    );
    unmount();

    vi.mocked(listJobPostings).mockResolvedValue({
      postings: [{ id: 'p', status: 'OPEN', clientId: 'c1', title: 'Associate — Front Beach 218', location: 'Front Beach 218' }] as JobPostingRecord[],
    });
    renderAs('INTERNAL_RECRUITER', <StaffingGaps canPost />);
    await waitFor(() => expect(listJobPostings).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Staffing gaps without a posting')).not.toBeInTheDocument();
  });
});

describe('the postings tab, opened from a gap', () => {
  it('opens the drawer filled in, and Save & open creates the posting then opens it', async () => {
    window.history.replaceState({}, '', postingForGapHref({ clientId: 'c1', storeName: 'Front Beach 218', openings: 23 }));
    renderAs('HR_ADMINISTRATOR', <RecruitingExtras />, `/recruiting/extras${window.location.search}`);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New job posting')).toBeInTheDocument();
    const inputs = within(dialog).getAllByRole('textbox') as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(expect.arrayContaining(['Associate — Front Beach 218', 'associate-front-beach-218', 'Front Beach 218']));
    expect((within(dialog).getAllByRole('spinbutton') as HTMLInputElement[]).map((i) => i.value)).toContain('23');
    await waitFor(() => expect((within(dialog).getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('c1'));
    expect(within(dialog).getByText(/Pay is left for you/)).toBeInTheDocument();

    // A description is the one field the gap can't write.
    await userEvent.type(dialog.querySelector('textarea')!, 'Seasonal housekeeping.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save & open' }));
    await waitFor(() => expect(openJobPosting).toHaveBeenCalledWith('po-new'));
    expect(createJobPosting).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', title: 'Associate — Front Beach 218', location: 'Front Beach 218', openings: 23, schedule: 'SEASONAL' }),
    );
  });
});
