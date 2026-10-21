import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Notification } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/recruiting90Api', () => ({
  listJobPostings: vi.fn(async () => ({
    postings: [
      { id: 'p1', clientId: null, clientName: 'Coastal Resort', title: 'Housekeeper', description: '', location: 'Front Beach', minSalary: null, maxSalary: null, currency: 'USD', slug: 'housekeeper', status: 'OPEN', openings: 10, hired: 2, schedule: null, payUnit: null, syndicate: true, openedAt: null, closedAt: null, createdAt: '2026-10-01T00:00:00Z' },
    ],
  })),
  jobFeedUrl: (b: string) => `https://app.example/api/careers/feed.xml?board=${b}`,
}));
vi.mock('recharts', async (orig) => {
  const real = await orig<typeof import('recharts')>();
  return { ...real, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div style={{ width: 400, height: 200 }}>{children}</div> };
});

import { PostingsBoardsPanel, trackedLink } from '@/pages/marketing/PostingsBoardsPanel';
import { PostingsPanel, StageFunnel } from '@/pages/marketing/FunnelPanels';
import { groupSends } from '@/pages/communications/AdminCommsView';
import type { MarketingOverview } from '@/lib/marketingApi';

const OVERVIEW: MarketingOverview = {
  range: { from: '2026-07-20', to: '2026-10-18' },
  funnel: { views: 400, applicants: 40, interviewed: 12, hires: 6 },
  bySource: [],
  byPosting: [{ slug: 'housekeeper', title: 'Housekeeper', status: 'OPEN', views: 300, applicants: 30, hires: 4 }],
  weekly: [],
  campaigns: { active: 1, referrals: 0, referralHires: 0, bonusesProposed: 0, bonusesApproved: 0 },
};

function wrap(ui: React.ReactNode) {
  const caps = ROLE_CAPABILITIES.MARKETING_MANAGER;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={{ user: { id: 'u', role: 'MARKETING_MANAGER' }, can: (c: Capability) => caps.has(c) } as never}>
        <MemoryRouter>{ui}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('Marketing → Postings & boards', () => {
  it('builds a tracked link from a posting and a source — no hand-typed ?source=', async () => {
    expect(trackedLink('https://x.test', 'housekeeper', 'facebook')).toBe('https://x.test/careers/housekeeper?source=facebook');
    expect(trackedLink('https://x.test', null, 'indeed')).toBe('https://x.test/careers?source=indeed');

    const user = userEvent.setup();
    wrap(<PostingsBoardsPanel o={OVERVIEW} />);
    const link = screen.getByLabelText('Tracked link') as HTMLInputElement;
    expect(link.value).toMatch(/\/careers\?source=indeed$/);
    await screen.findByRole('option', { name: /Housekeeper — Coastal Resort/ });
    await user.selectOptions(screen.getByLabelText('Posting'), 'housekeeper');
    await user.selectOptions(screen.getByLabelText('Placed on'), 'facebook');
    expect(link.value).toMatch(/\/careers\/housekeeper\?source=facebook$/);
    // The posting's traffic from the overview, and its job-board state.
    expect(await screen.findByText('In the feeds')).toBeInTheDocument();
    expect(screen.getAllByText('2 / 10').length).toBeGreaterThan(0);
  });

  it('says the views were on the list page when no posting was opened', () => {
    wrap(<PostingsPanel o={{ ...OVERVIEW, byPosting: [] }} />);
    expect(screen.getByText('No posting was opened')).toBeInTheDocument();
    expect(screen.getByText(/The 400 views were on the job list page/)).toBeInTheDocument();
  });

  it('the stage funnel names the steepest drop', () => {
    wrap(<StageFunnel o={OVERVIEW} />);
    // 40 of 400 applied (10%), 12 of 40 interviewed (30%), 6 of 12 hired (50%).
    expect(screen.getByRole('img', { name: /The steepest drop is into “Applied” \(10%/ })).toBeInTheDocument();
  });
});

describe('Communications → the sent log', () => {
  const n = (id: string, over: Partial<Notification>): Notification => ({
    id,
    channel: 'IN_APP',
    status: 'SENT',
    recipientUserId: `u-${id}`,
    recipientPhone: null,
    recipientEmail: null,
    subject: 'Overdue: monthly report',
    body: 'x',
    category: 'compliance.attestation.digest',
    externalRef: null,
    failureReason: null,
    sentAt: null,
    readAt: null,
    senderUserId: null,
    senderEmail: null,
    linkUrl: null,
    createdAt: '2026-10-19T14:05:10.000Z',
    ...over,
  });

  it('shows one message to many people as one row with counts', () => {
    const groups = groupSends([
      n('1', { recipientName: 'Ana Reyes' }),
      n('2', { recipientName: 'Ben Ortiz', readAt: '2026-10-19T15:00:00.000Z' }),
      n('3', { recipientName: 'Cy Lee', status: 'FAILED' }),
      n('4', { subject: 'Welcome', createdAt: '2026-10-19T14:09:00.000Z' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ sent: 1, read: 1, failed: 1 });
    expect(groups[0]!.rows).toHaveLength(3);
    expect(groups[1]!.rows).toHaveLength(1);
  });
});
