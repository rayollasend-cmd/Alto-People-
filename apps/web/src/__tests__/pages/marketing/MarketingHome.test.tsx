import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { TooltipProvider } from '@/components/ui/Tooltip';

vi.mock('@/lib/marketingApi', () => ({
  getMarketingOverview: vi.fn(),
  getEmployerBrand: vi.fn(),
  saveEmployerBrand: vi.fn(),
  uploadBrandPhoto: vi.fn(),
  removeBrandPhoto: vi.fn(),
  listCampaigns: vi.fn(),
  createCampaign: vi.fn(),
  updateCampaign: vi.fn(),
  setCampaignStatus: vi.fn(),
  listCampaignReferrals: vi.fn(),
  proposeReferralBonus: vi.fn(),
}));
vi.mock('@/components/home/HugoSeat', () => ({ HugoSeat: () => null }));
// recharts measures a DOM jsdom doesn't have.
vi.mock('recharts', async (orig) => {
  const real = await orig<typeof import('recharts')>();
  return { ...real, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div style={{ width: 400, height: 200 }}>{children}</div> };
});

import { getEmployerBrand, getMarketingOverview, listCampaignReferrals, listCampaigns, saveEmployerBrand, type MarketingOverview } from '@/lib/marketingApi';
import { MarketingHome } from '@/pages/marketing/MarketingHome';

/** Marketing's home: the funnel as the hero, then source of hire, the brand page and campaigns. */

const OVERVIEW: MarketingOverview = {
  range: { from: '2026-07-20T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z' },
  funnel: { views: 400, applicants: 40, interviewed: 12, hires: 6 },
  bySource: [
    { source: 'indeed', views: 300, applicants: 30, interviewed: 9, hires: 4, viewToApplyPct: 10, applyToHirePct: 13.3, spend: 400, costPerHire: 100, retained90Pct: 75 },
    { source: 'referral', views: 0, applicants: 10, interviewed: 3, hires: 2, viewToApplyPct: null, applyToHirePct: 20, spend: null, costPerHire: null, retained90Pct: 100 },
  ],
  byPosting: [{ slug: 'cashier', title: 'Cashier', status: 'OPEN', views: 300, applicants: 30, hires: 4 }],
  weekly: [{ weekStart: '2026-10-12', views: 40, applicants: 4, hires: 1 }],
  campaigns: { active: 1, referrals: 5, referralHires: 2, bonusesProposed: 1, bonusesApproved: 0 },
};

function renderHome(path = '/marketing') {
  const caps = ROLE_CAPABILITIES.MARKETING_MANAGER;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ConfirmProvider>
          <AuthContext.Provider
            value={{
              isInitializing: false,
              isOffline: false,
              user: { id: 'u', email: 'mk@altohr.com', firstName: 'Mo', role: 'MARKETING_MANAGER', status: 'ACTIVE', clientId: null, associateId: null } as never,
              role: 'MARKETING_MANAGER',
              capabilities: new Set<Capability>(caps),
              signIn: vi.fn(),
              signOut: vi.fn(),
              can: (c: Capability) => caps.has(c),
            } as never}
          >
            <MemoryRouter initialEntries={[path]}>
              <MarketingHome />
            </MemoryRouter>
          </AuthContext.Provider>
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(getMarketingOverview).mockResolvedValue(OVERVIEW);
  vi.mocked(getEmployerBrand).mockResolvedValue({ headline: 'Work with us', intro: null, values: [], perks: ['Weekly pay'], ctaText: null, photos: [], updatedAt: null });
  vi.mocked(listCampaigns).mockResolvedValue({ campaigns: [] });
  vi.mocked(listCampaignReferrals).mockResolvedValue({ referrals: [] });
  vi.mocked(saveEmployerBrand).mockReset();
});

describe('marketing home', () => {
  it('the funnel is the hero and a waiting bonus is counted', async () => {
    renderHome();
    expect(await screen.findByText('Careers site views')).toBeInTheDocument();
    // The numbers count up (MetricCard); the step-to-step rates are static text.
    expect(screen.getByText('10% of the step before')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /1 referral bonus with Finance/ })).toHaveAttribute('href', '/marketing/bonuses');
  });

  it('source of hire shows views, applicants, hires and cost per hire per source', async () => {
    renderHome('/marketing?tab=sources');
    const grid = await screen.findByRole('table', { name: 'Source of hire' });
    expect(within(grid).getByText('Indeed')).toBeInTheDocument();
    expect(within(grid).getByText('Referral')).toBeInTheDocument();
    expect(within(grid).getByText('$100.00')).toBeInTheDocument();
  });

  it('the brand page publishes to the careers site', async () => {
    vi.mocked(saveEmployerBrand).mockImplementation(async (b) => ({ headline: b.headline ?? null, intro: null, values: [], perks: b.perks ?? [], ctaText: null, photos: [], updatedAt: null }));
    const user = renderHome('/marketing?tab=brand');
    const headline = await screen.findByLabelText('Headline');
    await user.clear(headline);
    await user.type(headline, 'Paid weekly');
    await user.click(screen.getByRole('button', { name: 'Publish to the careers page' }));
    expect(saveEmployerBrand).toHaveBeenCalledWith(expect.objectContaining({ headline: 'Paid weekly', perks: ['Weekly pay'] }));
  });
});

describe('<MarketingHome> — F500 G4', () => {
  it('is headed "Marketing" with the greeting on the quiet line, plain tab labels, and no second way to the Postings tab', async () => {
    renderHome();
    expect(await screen.findByRole('heading', { level: 1, name: 'Marketing' })).toBeInTheDocument();
    expect(screen.getByTestId('home-meta')).toHaveTextContent(/(?:Good (?:morning|afternoon|evening)|Up late), Mo/);
    // Postings & boards is a tab; the shortcuts row no longer repeats it.
    expect(screen.getAllByText('Postings & boards')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Employer brand' }).querySelector('svg')).toBeNull();
  });
});
