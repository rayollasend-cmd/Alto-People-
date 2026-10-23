import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * New-hire reports (F500 G3, P1): every row's status used to be a Badge
 * listing four problems — two of them the employer's — and on a phone it
 * became a six-line blob. The employer's gaps are now said once per state
 * with a link to fix them; rows say the person's own gaps in a few words;
 * a disabled Download says why.
 */
const row = (id: string, name: string, person: Array<'ssn' | 'address'>, employer: Array<'ein' | 'address'>) => ({
  id,
  associateId: `a-${id}`,
  name,
  state: 'FL',
  hireDate: '2026-10-18',
  dueDate: '2026-11-07',
  deadlineDays: 20,
  confirmDeadlineWithState: false,
  status: 'DUE',
  overdue: false,
  method: null,
  confirmation: null,
  submittedAt: null,
  blockedBy: [
    ...(person.includes('ssn') ? ['No SSN on file'] : []),
    ...(person.includes('address') ? ['Home address incomplete'] : []),
    ...(employer.includes('ein') ? ['Employer EIN missing'] : []),
    ...(employer.includes('address') ? ['Employer address incomplete'] : []),
  ],
  missing: { person, employer },
  employer: person.length || employer.length ? { id: 'emp1', name: 'Alto HR' } : null,
  filingService: null,
});

vi.mock('@/lib/payComplianceApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/payComplianceApi')>()),
  listNewHireReports: vi.fn(async () => ({
    reports: [row('r1', 'Ana Ruiz', ['ssn', 'address'], ['ein', 'address']), row('r2', 'Ben Cole', [], ['ein', 'address'])],
    truncated: false,
    filing: { kind: 'MANUAL_UPLOAD', provider: { key: 'csv', label: 'CSV' }, configured: true, note: 'Manual upload.' },
  })),
  getNewHireSettings: vi.fn(async () => ({ multistateState: null })),
}));

import { employerGapSentence, NewHireReportsTab, personGapText } from '@/pages/payroll/PayComplianceTabs';

describe('new-hire reports: whose gap is it', () => {
  it('says the employer’s gaps once per state, with where to fix them', async () => {
    renderAs('FINANCE_ACCOUNTANT', <NewHireReportsTab />, '/payroll/compliance');
    const gaps = await screen.findAllByTestId('new-hire-employer-gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toHaveTextContent('Alto HR’s EIN and business address are missing, so no hire it employs can be reported.');
    expect(within(gaps[0]!).getByRole('link', { name: 'Open employers' })).toHaveAttribute('href', '/admin/employers');
  });

  it('rows say the person’s own gaps in a few words, not a badge of four problems', async () => {
    renderAs('FINANCE_ACCOUNTANT', <NewHireReportsTab />, '/payroll/compliance');
    expect((await screen.findAllByText('Missing SSN, address')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Waiting on the employer’s details').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Employer EIN missing/)).toBeNull();
  });

  it('a disabled Download says why', async () => {
    renderAs('FINANCE_ACCOUNTANT', <NewHireReportsTab />, '/payroll/compliance');
    expect(await screen.findByTestId('new-hire-why-FL')).toHaveTextContent('No reports ready: fix the missing details first.');
    expect(screen.getByRole('button', { name: /Download file/ })).toBeDisabled();
  });

  it('the words', () => {
    expect(personGapText({ missing: { person: ['ssn'], employer: ['ein'] }, blockedBy: [] })).toBe('Missing SSN');
    expect(personGapText({ missing: { person: [], employer: ['ein'] }, blockedBy: ['Employer EIN missing'] })).toBeNull();
    // An older API without the split still reads right.
    expect(personGapText({ blockedBy: ['No SSN on file', 'Employer EIN missing'] })).toBe('Missing SSN');
    expect(employerGapSentence({ name: 'Alto HR', gaps: ['ein'] })).toBe('Alto HR’s EIN is missing, so no hire it employs can be reported.');
  });
});
