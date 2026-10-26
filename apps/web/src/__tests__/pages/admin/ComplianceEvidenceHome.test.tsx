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
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('Needs sign-off').length).toBe(1);
    expect(within(table).getAllByText('No evidence').length).toBe(COMPLIANCE_CONTROLS.length - 2);
    expect(screen.getByText('All 4 per-job secrets are set.')).toBeInTheDocument();
  });

  it('opens on the status tiles (F500 G4): exact counts, and each tile filters the table', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<ComplianceEvidenceHome />, '/admin/compliance-evidence');
    const strip = await screen.findByRole('group', { name: 'Controls by status' });
    const tile = (name: RegExp) => within(strip).getByRole('button', { name });
    // The tiles count up; wait for the settled numbers.
    await waitFor(() => {
      expect(tile(/^Passing/)).toHaveTextContent(`1 of ${COMPLIANCE_CONTROLS.length}`);
      expect(tile(/^Needs sign-off/)).toHaveTextContent(/^Needs sign-off1/);
      expect(tile(/^Failing/)).toHaveTextContent(/^Failing0/);
      expect(tile(/^No evidence/)).toHaveTextContent(new RegExp(`^No evidence${COMPLIANCE_CONTROLS.length - 2}`));
    }, { timeout: 4000 });
    await user.click(tile(/^Needs sign-off/));
    expect(tile(/^Needs sign-off/)).toHaveAttribute('aria-pressed', 'true');
    const table = screen.getByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBe(2)); // header + the access review
    expect(within(table).getByText('Quarterly access review')).toBeInTheDocument();
    // The setting comes after the status and the table.
    const contact = screen.getByRole('heading', { name: 'Security contact' });
    expect(strip.compareDocumentPosition(contact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(table.compareDocumentPosition(contact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says what each control means in plain words, and what to do when it is not passing', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<ComplianceEvidenceHome />, '/admin/compliance-evidence');
    await screen.findByText('Quarterly access review');
    // No rollout-plan language: a control with no evidence says so plainly.
    expect(screen.queryByText(/Collected from step/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Not collected yet').length).toBe(COMPLIANCE_CONTROLS.length - 2);
    expect(screen.getByText('The app talks to its database over an encrypted connection.')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: 'Open Encrypted connection to the database' });
    await user.click(within(row).getByRole('button', { name: /What to do/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Require SSL on the database connection/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Owner: HR Administrator/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/step \d of Brief/)).not.toBeInTheDocument();
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
