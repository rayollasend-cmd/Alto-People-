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
    expect(screen.getByText('16 / 16')).toBeInTheDocument();
    expect(screen.getByText('2026-09-01')).toBeInTheDocument();
  });

  it('takes a request for a report and says where the link will go', async () => {
    vi.mocked(getTrustPublic).mockResolvedValue({ ...base, soc2: { ...base.soc2, stage: 'preparing', observationSince: null, controlsCurrent: 11 } });
    renderPage();
    expect(await screen.findByText('Reports and questionnaires')).toBeInTheDocument();
    expect(screen.getByText(/Not yet: every control must have current evidence first/)).toBeInTheDocument();
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
