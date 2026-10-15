import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { COMPLIANCE_CONTROLS, type ComplianceControlView, type ComplianceEvidenceResponse, type EvidenceRow } from '@alto-people/shared';
import { renderAsAdmin } from './orgAdminHarness';

vi.mock('@/lib/complianceEvidenceApi', () => ({
  getComplianceEvidence: vi.fn(),
  getControlHistory: vi.fn(),
  signOffEvidence: vi.fn(),
}));

import { getComplianceEvidence, getControlHistory, signOffEvidence } from '@/lib/complianceEvidenceApi';
import { ComplianceEvidenceHome } from '@/pages/admin/ComplianceEvidenceHome';

const accessRow: EvidenceRow = {
  id: 'ev1',
  control: 'access-review',
  status: 'WARN',
  summary: '42 accounts, 3 flagged for review.',
  details: {},
  collectedAt: '2026-10-13T12:00:00.000Z',
  collectedBy: 'scripts/access-report.ts',
  periodStart: null,
  periodEnd: null,
  signoffs: [],
};

function overview(): ComplianceEvidenceResponse {
  const controls: ComplianceControlView[] = COMPLIANCE_CONTROLS.map((c) => {
    if (c.id === 'access-review') return { ...c, latest: accessRow, ageDays: 0, state: 'awaiting-signoff' };
    if (c.id === 'job-secrets-separated')
      return { ...c, latest: { ...accessRow, id: 'ev2', control: c.id, status: 'PASS', summary: 'All 4 per-job secrets are set.' }, ageDays: 0, state: 'current' };
    return { ...c, latest: null, ageDays: null, state: 'missing' };
  });
  return {
    generatedAt: '2026-10-13T12:00:00.000Z',
    controls,
    counts: { current: 1, stale: 0, failing: 0, missing: controls.length - 2, 'awaiting-signoff': 1 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getComplianceEvidence).mockResolvedValue(overview());
  vi.mocked(getControlHistory).mockResolvedValue({ control: 'access-review', evidence: [accessRow] });
  vi.mocked(signOffEvidence).mockResolvedValue({ id: 'so1' });
});

describe('Compliance evidence', () => {
  it('shows how many controls are current and every control with its state', async () => {
    renderAsAdmin(<ComplianceEvidenceHome />, '/admin/compliance-evidence');
    expect(await screen.findByText(`1 of ${COMPLIANCE_CONTROLS.length}`)).toBeInTheDocument();
    expect(screen.getByText('Quarterly access review')).toBeInTheDocument();
    expect(screen.getAllByText('Needs sign-off').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No evidence').length).toBe(COMPLIANCE_CONTROLS.length - 2);
    expect(screen.getByText('All 4 per-job secrets are set.')).toBeInTheDocument();
  });

  it('opens a control and signs its latest evidence off with a note', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<ComplianceEvidenceHome />, '/admin/compliance-evidence');
    await screen.findByText('Quarterly access review');
    await user.click(screen.getByRole('row', { name: 'Open Quarterly access review' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('42 accounts, 3 flagged for review.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Sign-off note/), 'Reviewed with the owner');
    await user.click(within(dialog).getByRole('button', { name: 'Sign off the latest evidence' }));
    await waitFor(() => expect(signOffEvidence).toHaveBeenCalledWith('ev1', { note: 'Reviewed with the owner' }));
  });
});
