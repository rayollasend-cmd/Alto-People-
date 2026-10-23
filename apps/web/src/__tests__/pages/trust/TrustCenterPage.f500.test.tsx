import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TrustControlPublic, TrustSummary } from '@alto-people/shared';
import { renderAsAdmin } from '../admin/orgAdminHarness';

vi.mock('@/lib/trustApi', () => ({
  getTrust: vi.fn(),
  listTrustRequests: vi.fn(async () => ({ requests: [] })),
  listTrustDocuments: vi.fn(async () => ({ documents: [] })),
  decideTrustRequest: vi.fn(),
  uploadTrustDocument: vi.fn(async (i: { kind: string; title: string }) => ({ kind: i.kind, title: i.title, bytes: 2048, updatedAt: '2026-10-22T12:00:00.000Z' })),
  setSoc2ReportDate: vi.fn(async (d: string | null) => ({ reportIssuedOn: d })),
}));

import { getTrust, setSoc2ReportDate, uploadTrustDocument } from '@/lib/trustApi';
import { TrustCenterPage, worstControls } from '@/pages/trust/TrustCenterPage';

const control = (id: string, title: string, controlStatus: TrustControlPublic['controlStatus']): TrustControlPublic => ({
  id,
  title,
  criteria: ['CC6.1'],
  status: controlStatus === 'PASSING' ? 'PASS' : controlStatus === 'FAILING' ? 'FAIL' : controlStatus === 'NEEDS_SIGNOFF' ? 'WARN' : 'PENDING',
  controlStatus,
  checkedAt: null,
  how: `How ${title} is checked.`,
  plain: `What ${title} means.`,
});

const items = [
  control('a', 'Alpha passing', 'PASSING'),
  control('b', 'Bravo no evidence', 'NO_EVIDENCE'),
  control('c', 'Charlie failing', 'FAILING'),
  control('d', 'Delta sign-off', 'NEEDS_SIGNOFF'),
  control('e', 'Echo no evidence', 'NO_EVIDENCE'),
  control('f', 'Foxtrot failing', 'FAILING'),
];

const summary: TrustSummary = {
  generatedAt: '2026-10-22T12:00:00.000Z',
  product: 'Alto People',
  controls: { passing: 1, total: 6, items },
  auditChain: { verifiedAt: '2026-10-22T09:21:00.000Z', ok: true },
  retention: { auditYearsMinimum: 7 },
  agents: { registered: 6, certified: 2, governed: true },
  subProcessors: [],
  commitments: [],
  securityContactSet: false,
  soc2: { stage: 'preparing', controlsPassing: 1, controlsCurrent: 4, controlsTotal: 6, lastEvidenceAt: null, observationSince: null, reportIssuedOn: null },
  tenant: {
    auditChain: { verifiedAt: '2026-10-22T09:21:00.000Z', ok: true, rows: 798, headSeq: '798' },
    retentionYears: 7,
    archives: 1,
    siem: 'OFF',
    sso: { connections: 0, ssoRequiredForStaff: false, scim: false },
    agents: { registered: 6, active: 6, certified: 2, suspended: 0, gates: 0, decisionRecords: 0, lastBiasAuditAt: null },
    accessReview: { lastAt: '2026-10-17T06:49:00.000Z', signedOff: false },
  },
};

beforeEach(() => {
  vi.mocked(getTrust).mockResolvedValue(summary);
});

describe('worstControls', () => {
  it('lists failing first, then sign-off, then no evidence, three at most, never a passing one', () => {
    expect(worstControls(items).map((c) => c.title)).toEqual(['Charlie failing', 'Foxtrot failing', 'Delta sign-off']);
    expect(worstControls(items, 10).map((c) => c.id)).toEqual(['c', 'f', 'd', 'b', 'e']);
    expect(worstControls([control('a', 'A', 'PASSING')])).toEqual([]);
  });
});

describe('Trust Center (F500 G4)', () => {
  it('shows the three worst controls in plain words and sends the rest to Compliance evidence', async () => {
    renderAsAdmin(<TrustCenterPage />, '/trust');
    const section = (await screen.findByRole('heading', { name: 'Controls that need someone' })).closest('section')!;
    expect(section).toHaveTextContent('1 of 6 passing. The 3 most urgent of 5:');
    const table = within(section).getByRole('table');
    const titles = within(table).getAllByRole('row').slice(1).map((r) => r.querySelector('.font-medium')?.textContent);
    expect(titles).toEqual(['Charlie failing', 'Foxtrot failing', 'Delta sign-off']);
    expect(within(table).getByText('What Charlie failing means.')).toBeInTheDocument();
    // The technical line waits behind "How it's checked".
    expect(within(table).getAllByText('How it’s checked')).toHaveLength(3);
    expect(within(section).getByRole('link', { name: /See all evidence/ })).toHaveAttribute('href', '/admin/compliance-evidence');
  });

  it('says "Needs sign-off" for the access review and links it to Access certifications', async () => {
    renderAsAdmin(<TrustCenterPage />, '/trust');
    const row = await screen.findByRole('link', { name: /Quarterly access review/ });
    expect(row).toHaveAttribute('href', '/admin/access-certifications');
    expect(row).toHaveTextContent('Needs sign-off');
  });

  it('uploads a missing document, with the SOC 2 report date, from one dialog — no inline forms', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<TrustCenterPage />, '/trust');
    const docs = (await screen.findByRole('heading', { name: 'Documents on file' })).closest('section')!;
    await waitFor(() => expect(within(docs).getAllByText('Missing')).toHaveLength(4));
    expect(within(docs).queryByLabelText('PDF')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'SOC 2 report date' })).not.toBeInTheDocument();
    const soc2 = within(docs).getByText('SOC 2 report').closest('li')!;
    await user.click(within(soc2).getByRole('button', { name: 'Upload' }));
    const dialog = await screen.findByRole('dialog');
    const file = new File(['%PDF-1.4'], 'soc2.pdf', { type: 'application/pdf' });
    await user.upload(within(dialog).getByLabelText('PDF'), file);
    await user.type(within(dialog).getByLabelText(/Title/), 'SOC 2 Type II, 2026');
    await user.type(within(dialog).getByLabelText(/Report issued on/), '2026-10-01');
    await user.click(within(dialog).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(uploadTrustDocument).toHaveBeenCalledWith({ kind: 'SOC2_REPORT', title: 'SOC 2 Type II, 2026', file }));
    expect(setSoc2ReportDate).toHaveBeenCalledWith('2026-10-01');
  });
});
