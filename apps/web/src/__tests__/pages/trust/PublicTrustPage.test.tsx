import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TrustSummaryPublic } from '@alto-people/shared';

vi.mock('@/lib/trustApi', () => ({
  getTrustPublic: vi.fn(),
  requestTrustDocument: vi.fn(async () => ({ id: 'r1', status: 'PENDING' })),
}));

import { getTrustPublic, requestTrustDocument } from '@/lib/trustApi';
import { PublicTrustPage } from '@/pages/trust/PublicTrustPage';

/**
 * Audit 2026-10-21: the public Trust Center says where SOC 2 stands from the
 * evidence, and takes a request for a report instead of "ask your account team".
 */

const base: TrustSummaryPublic = {
  generatedAt: '2026-10-21T12:00:00.000Z',
  product: 'Alto People',
  controls: { passing: 12, total: 16, items: [{ id: 'tls-web', title: 'TLS on the web', criteria: ['CC6.7'], status: 'PASS', checkedAt: '2026-10-21T01:00:00.000Z', how: 'Probes the certificate.' }] },
  auditChain: { verifiedAt: '2026-10-21T01:00:00.000Z', ok: true },
  retention: { auditYearsMinimum: 7 },
  agents: { registered: 4, certified: 3, governed: true },
  subProcessors: [{ name: 'Neon', purpose: 'Database', region: 'United States', url: 'https://neon.tech' }],
  commitments: [{ title: 'A person is accountable', body: 'Every agent has an owner.' }],
  securityContactSet: true,
  soc2: { stage: 'observation', controlsPassing: 12, controlsCurrent: 16, controlsTotal: 16, lastEvidenceAt: '2026-10-21T01:00:00.000Z', observationSince: '2026-09-01', reportIssuedOn: null },
  areas: [
    { key: 'data-protection', label: 'Data protection', status: 'attention', lastCheckedAt: '2026-10-21T01:00:00.000Z', controls: [{ id: 'tls-database', title: 'Encrypted connections to the database', summary: 'The app talks to its database over an encrypted connection.', criteria: ['CC6.7'] }] },
    { key: 'availability', label: 'Availability', status: 'passing', lastCheckedAt: null, controls: [{ id: 'database-backup', title: 'Nightly encrypted backups', summary: 'The database is backed up, encrypted, every night.', criteria: ['A1.2'] }] },
  ],
};

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/trust-center']}>
        <PublicTrustPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the public Trust Center', () => {
  it('shows the SOC 2 stage from the evidence and never claims audited without a report', async () => {
    vi.mocked(getTrustPublic).mockResolvedValue(base);
    renderPage();
    expect(await screen.findByText('SOC 2 progress')).toBeInTheDocument();
    expect(screen.getByText('Observation period: every control is collecting evidence')).toBeInTheDocument();
    const now = screen.getByText('Now').closest('li');
    expect(now).toHaveTextContent('Observation period');
    // F500 G5: no per-control pass count for an anonymous reader; the observation date stays.
    expect(screen.queryByText('12 / 16')).not.toBeInTheDocument();
    // A day the app's way (the year only when it isn't this one), never the ISO "2026-09-01".
    expect(screen.getByText(/^Sep 1(, 2026)?$/)).toBeInTheDocument();
    expect(screen.queryByText('2026-09-01')).toBeNull();
  });

  it('leads with what is monitored and reads by area in plain words — no "3 / 16 passing", no "Failed", no script names (F500 G5)', async () => {
    vi.mocked(getTrustPublic).mockResolvedValue(base);
    renderPage();
    expect(await screen.findByTestId('trust-lead')).toHaveTextContent(/^16 controls monitored daily · SOC 2: observation period · last checked/);
    const areas = screen.getAllByTestId('trust-area');
    expect(areas.map((a) => a.querySelector('h3')!.textContent)).toEqual(['Data protection', 'Availability']);
    expect(areas[0]).toHaveTextContent('Being addressed');
    expect(areas[0]).toHaveTextContent('Encrypted connections to the database');
    expect(areas[1]).toHaveTextContent('All checks passing');
    expect(screen.queryByText(/Controls passing/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Failed$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Probes the certificate.')).not.toBeInTheDocument();
  });

  it('takes a request for a report and says where the link will go', async () => {
    vi.mocked(getTrustPublic).mockResolvedValue({ ...base, soc2: { ...base.soc2, stage: 'preparing', observationSince: null, controlsCurrent: 11 } });
    renderPage();
    expect(await screen.findByText('Reports and questionnaires')).toBeInTheDocument();
    // No "Not yet: …" line for a date that isn't there (F500 G5).
    expect(screen.queryByText(/Not yet: every control must have current evidence first/)).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Request the document' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Your name/), 'Priya Natarajan');
    await userEvent.type(screen.getByLabelText(/Work email/), 'Priya@BuyerCo.com');
    await userEvent.type(screen.getByLabelText(/Company/), 'BuyerCo');
    await userEvent.selectOptions(screen.getByLabelText(/Document/), 'PEN_TEST_SUMMARY');
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(requestTrustDocument).toHaveBeenCalledWith({ name: 'Priya Natarajan', email: 'Priya@BuyerCo.com', company: 'BuyerCo', kind: 'PEN_TEST_SUMMARY', note: undefined });
    expect(await screen.findByRole('status')).toHaveTextContent('the link goes to priya@buyerco.com');
  });
});
