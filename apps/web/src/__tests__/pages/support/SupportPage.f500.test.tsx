import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
vi.mock('@/lib/kb124Api', () => ({ searchKb: vi.fn(async () => ({ articles: [{ id: 'k1', slug: 'reset-password', title: 'Reset your password', category: 'Account', tags: [], views: 0, helpful: 0, notHelpful: 0, publishedAt: null }] })) }));
vi.mock('@/lib/statusApi', () => ({ getPublicStatus: vi.fn(async () => ({ overall: 'OPERATIONAL' })) }));
import { apiFetch } from '@/lib/api';
import { SupportPage } from '@/pages/support/SupportPage';

/**
 * Support, F500 G5: it opens on help (articles, the platform's state, how
 * long an answer takes), "My requests" can be answered back, and an
 * associate is sent to HR for pay/schedule/job questions with no "Billing".
 */

const mine = {
  requests: [{ id: 'r1', category: 'QUESTION', subject: 'Export the roster', status: 'RESOLVED', reply: 'Use Export on the roster page.', createdAt: '2026-10-20T12:00:00.000Z' }],
  typicalResolveHours: 6,
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === '/support/config') return { statusPageUrl: '/status' } as never;
    if (path === '/support/mine') return mine as never;
    if (path === '/support/r1/followup' && init?.method === 'POST') return { id: 'r1', status: 'OPEN' } as never;
    return {} as never;
  });
});

describe('SupportPage (F500)', () => {
  it('leads with the platform state, the typical answer time and help articles', async () => {
    renderAs('MANAGER', <SupportPage />, '/support');
    expect(await screen.findByText('All systems working')).toBeInTheDocument();
    expect(await screen.findByTestId('support-typical')).toHaveTextContent('Requests are usually resolved in about 6 hours.');
    await userEvent.type(screen.getByRole('textbox', { name: 'Search help articles' }), 'password');
    const list = await screen.findByTestId('support-articles');
    expect(within(list).getByRole('link', { name: /Reset your password/ })).toHaveAttribute('href', '/help-center?article=reset-password');
    // Staff can still ask about billing.
    expect(screen.getByRole('option', { name: 'Billing' })).toBeInTheDocument();
  });

  it('a reply can be answered back', async () => {
    renderAs('MANAGER', <SupportPage />, '/support');
    const row = await screen.findByTestId('support-request');
    expect(row).toHaveTextContent('Use Export on the roster page.');
    await userEvent.click(within(row).getByRole('button', { name: 'Answer back' }));
    await userEvent.type(within(row).getByRole('textbox', { name: 'Your answer' }), 'There is no Export button.');
    await userEvent.click(within(row).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/support/r1/followup', { method: 'POST', body: { body: 'There is no Export button.' } }));
  });

  it('an associate is pointed to HR and has no "Billing"', async () => {
    renderAs('ASSOCIATE', <SupportPage />, '/support', { associateId: 'a1' });
    const hr = await screen.findByTestId('support-ask-hr');
    expect(within(hr).getByRole('link', { name: 'Ask HR' })).toHaveAttribute('href', '/hr-cases?new=1');
    expect(screen.queryByRole('option', { name: 'Billing' })).toBeNull();
  });
});

describe('SupportPage — one help destination, no bare "None yet" (F500 2026-10-26)', () => {
  it('links its article search to the help center and says what fills My requests', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/support/config') return { statusPageUrl: null } as never;
      if (path === '/support/mine') return { requests: [], typicalResolveHours: null } as never;
      return {} as never;
    });
    renderAs('MANAGER', <SupportPage />, '/support');
    expect(screen.getByTestId('support-help-center')).toHaveAttribute('href', '/help-center');
    expect(screen.getByTestId('support-articles-hint')).toBeInTheDocument();
    expect(await screen.findByText('No requests yet')).toBeInTheDocument();
    expect(screen.queryByText('None yet.')).toBeNull();
  });
});
