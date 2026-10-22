import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * No electronic new-hire filing service ships: the tab says "Manual upload"
 * with what to do, instead of implying the state was filed with.
 */
vi.mock('@/lib/payComplianceApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/payComplianceApi')>()),
  listNewHireReports: vi.fn(async () => ({
    reports: [
      { id: 'r1', associateId: 'a1', name: 'Ana Ruiz', state: 'ME', hireDate: '2026-10-01', dueDate: '2026-10-08', deadlineDays: 7, confirmDeadlineWithState: true, status: 'DUE', overdue: false, method: null, confirmation: null, submittedAt: null, blockedBy: [], filingService: null },
    ],
    truncated: false,
    filing: { kind: 'MANUAL_UPLOAD', provider: { key: 'csv-manual-upload', label: 'CSV for the state portal' }, configured: true, note: 'Manual upload: download the CSV, upload it at the state new-hire portal, then mark the reports submitted with the confirmation. No electronic filing service is connected.' },
  })),
  getNewHireSettings: vi.fn(async () => ({ multistateState: null })),
}));

import { NewHireReportsTab } from '@/pages/payroll/PayComplianceTabs';

describe('new-hire reports: how filing happens', () => {
  it('says manual upload with the steps, and offers the download — never a "file with" button', async () => {
    renderAs('HR_ADMINISTRATOR', <NewHireReportsTab />, '/payroll/compliance');
    const status = await screen.findByTestId('new-hire-filing-status');
    expect(status).toHaveTextContent('Manual upload');
    expect(status).toHaveTextContent('No electronic filing service is connected');
    expect(await screen.findByRole('button', { name: /Download file/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /File with/ })).not.toBeInTheDocument();
  });
});
