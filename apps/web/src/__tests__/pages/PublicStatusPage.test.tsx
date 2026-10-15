import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicStatus } from '@alto-people/shared';

vi.mock('@/lib/statusApi', () => ({
  getPublicStatus: vi.fn(),
}));

import { getPublicStatus } from '@/lib/statusApi';
import { PublicStatusPage } from '@/pages/status/PublicStatusPage';

/**
 * The public status page: one hero that says the overall state, every
 * component with how it was measured, the incidents as a timeline, and an
 * honest empty state when nothing has happened.
 */

const base: PublicStatus = {
  generatedAt: '2026-10-15T18:00:00.000Z',
  product: 'Alto People',
  overall: 'OPERATIONAL',
  components: [
    { key: 'API', label: 'Platform API', what: 'Every screen talks to it.', state: 'OPERATIONAL', note: '99.9% of requests succeeded over the last two days.', uptime90d: 100 },
    { key: 'WEB', label: 'Web app', what: 'The signed-in app.', state: 'OPERATIONAL', note: 'Served with the API; loading normally.', uptime90d: 100 },
    { key: 'KIOSK', label: 'Kiosk clock-in', what: 'Punches.', state: 'UNMEASURED', note: 'Fewer than ten punches in the last 24 hours; nothing to grade.', uptime90d: null },
    { key: 'MESSAGING', label: 'WhatsApp messaging', what: 'Messages.', state: 'OPERATIONAL', note: '100% of messages went out.', uptime90d: null },
    { key: 'PAYROLL_WEBHOOK', label: 'Payroll disbursement', what: 'Confirmations.', state: 'UNMEASURED', note: 'No disbursement provider is connected on this deployment.', uptime90d: null },
    { key: 'EMAIL', label: 'Email delivery', what: 'Email.', state: 'OPERATIONAL', note: '100% of emails went out.', uptime90d: null },
  ],
  incidents: [],
};

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/status']}>
        <PublicStatusPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('/status', () => {
  it('all operational: the hero says so, each component is listed with its measure, and the incident list is honestly empty', async () => {
    vi.mocked(getPublicStatus).mockResolvedValue(base);
    renderPage();
    expect(await screen.findByRole('heading', { name: /all systems operational/i })).toBeInTheDocument();
    expect(screen.getByText('Platform API')).toBeInTheDocument();
    expect(screen.getByText(/99\.9% of requests succeeded/)).toBeInTheDocument();
    expect(screen.getAllByText(/100%/).length).toBeGreaterThanOrEqual(2);
    // A missing measure is said plainly, never shown as healthy.
    expect(screen.getAllByText('No recent activity').length).toBe(2);
    expect(screen.getByText(/no incidents in the last 90 days/i)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /public pages/i })).toHaveTextContent('Trust Center');
  });

  it('degraded with an open incident: the hero changes, the component carries the incident, the timeline reads newest first', async () => {
    vi.mocked(getPublicStatus).mockResolvedValue({
      ...base,
      overall: 'DEGRADED',
      components: base.components.map((c) => (c.key === 'MESSAGING' ? { ...c, state: 'DEGRADED', note: 'WhatsApp deliveries delayed — see the incident below.' } : c)),
      incidents: [
        {
          id: 'i1',
          title: 'WhatsApp deliveries delayed',
          component: 'MESSAGING',
          impact: 'DEGRADED',
          state: 'IDENTIFIED',
          startedAt: '2026-10-15T16:00:00.000Z',
          resolvedAt: null,
          updates: [
            { at: '2026-10-15T16:00:00.000Z', state: 'INVESTIGATING', note: 'Template sends are queueing at Meta.' },
            { at: '2026-10-15T16:40:00.000Z', state: 'IDENTIFIED', note: 'A rate limit on our sender; raising it with Meta.' },
          ],
        },
      ],
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: /some systems are degraded/i })).toBeInTheDocument();
    expect(screen.getByText(/one open incident/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'WhatsApp deliveries delayed' })).toBeInTheDocument();
    const notes = screen.getAllByText(/queueing at Meta|raising it with Meta/).map((n) => n.textContent);
    expect(notes[0]).toMatch(/raising it with Meta/);
    expect(screen.getAllByText('Identified').length).toBeGreaterThan(0);
  });

  it('an outage: the hero is unmistakable and a resolved incident keeps its resolution time', async () => {
    vi.mocked(getPublicStatus).mockResolvedValue({
      ...base,
      overall: 'OUTAGE',
      components: base.components.map((c) => (c.key === 'API' ? { ...c, state: 'OUTAGE', note: 'API down — see the incident below.' } : c)),
      incidents: [
        {
          id: 'i2',
          title: 'API down',
          component: 'API',
          impact: 'OUTAGE',
          state: 'INVESTIGATING',
          startedAt: '2026-10-15T17:50:00.000Z',
          resolvedAt: null,
          updates: [{ at: '2026-10-15T17:50:00.000Z', state: 'INVESTIGATING', note: 'Requests are failing; the team is on it.' }],
        },
        {
          id: 'i0',
          title: 'Email bounced for one hour',
          component: 'EMAIL',
          impact: 'DEGRADED',
          state: 'RESOLVED',
          startedAt: '2026-10-01T09:00:00.000Z',
          resolvedAt: '2026-10-01T10:00:00.000Z',
          updates: [
            { at: '2026-10-01T09:00:00.000Z', state: 'INVESTIGATING', note: 'Bounces from the provider.' },
            { at: '2026-10-01T10:00:00.000Z', state: 'RESOLVED', note: 'Provider restored.' },
          ],
        },
      ],
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: /a system is down/i })).toBeInTheDocument();
    expect(screen.getByText(/resolved .*2026/i)).toBeInTheDocument();
    expect(screen.getAllByText('Resolved').length).toBeGreaterThan(0);
  });
});
