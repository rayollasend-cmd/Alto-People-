import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'vitest-axe';
import { ConfirmProvider } from '@/lib/confirm';
import { dueText, recentQuarters } from '@/pages/payrollTaxes/taxShared';

/**
 * The payroll-tax desk: who files (the provider's penalty guarantee, or the
 * customer's own checklist), deposits to make with specific deadlines,
 * returns to file and agency letters. Axe-clean.
 */

const filing = vi.hoisted(() => ({ value: { mode: 'IN_HOUSE', providerLabel: null as string | null, penaltyGuarantee: false, environment: null as string | null } }));

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith('/payroll-taxes/overview'))
      return {
        today: '2026-11-12',
        filing: filing.value,
        totals: { owedOpen: 1200, overdue: 759, dueSoon: 60, failedPayments: 0, openNotices: 1 },
        overdue: [{ kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', agency: 'Internal Revenue Service', dueDate: '2026-11-09', amount: 759, liabilities: 1, scheduled: 0, accountId: 'a1' }],
        dueSoon: [{ kind: 'STATE_WITHHOLDING', jurisdiction: 'CA', agency: 'California withholding', dueDate: '2026-11-16', amount: 60, liabilities: 1, scheduled: 0, accountId: 'a2' }],
        upcoming: [],
        returns: {
          previous: { periodLabel: '2026-Q3', items: [] },
          current: { periodLabel: '2026-Q4', items: [{ kind: 'F941', label: 'Form 941 — quarterly federal', jurisdiction: 'US', agency: 'Internal Revenue Service', periodLabel: '2026-Q4', dueDate: '2027-02-01', returnId: null, status: 'NOT_STARTED' }] },
        },
        registrations: [{ kind: 'STATE_UNEMPLOYMENT', jurisdiction: 'TX', agencyName: 'Texas unemployment insurance', accountId: 'a3', reason: 'Tax is owed here and the account is not set up yet.', steps: ['Register.'] }],
        noticesDue: [{ id: 'n1', agencyName: 'Internal Revenue Service', noticeType: 'Late deposit penalty', responseDueAt: '2026-12-31', amountDue: 45.5 }],
      };
    return {};
  }),
}));

import { PayrollTaxesDesk } from '@/pages/payrollTaxes/PayrollTaxesDesk';

function renderDesk() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/payroll/taxes']}>
          <PayrollTaxesDesk />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe('PayrollTaxesDesk', () => {
  it('in house: says the customer files and pays, with the deposits and their deadlines', async () => {
    filing.value = { mode: 'IN_HOUSE', providerLabel: null, penaltyGuarantee: false, environment: null };
    const { container } = renderDesk();
    expect(await screen.findByText('You file and pay these yourself')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect a payroll tax provider' })).toBeTruthy();
    expect(screen.getByText(/Was due Nov 9, 2026 · 3 days late/)).toBeTruthy();
    expect(screen.getByText(/Due Nov 16, 2026 · in 4 days/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pay Internal Revenue Service, $759.00' })).toBeTruthy();
    expect(screen.getByText('Texas unemployment insurance')).toBeTruthy();
    expect(screen.getByText(/Respond by Dec 31, 2026/)).toBeTruthy();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations).toHaveLength(0);
  });

  it('with a provider and a guarantee: says who is covering the penalties', async () => {
    filing.value = { mode: 'PROVIDER', providerLabel: 'Check', penaltyGuarantee: true, environment: 'PRODUCTION' };
    renderDesk();
    expect(await screen.findByText('Covered by Check’s penalty guarantee')).toBeTruthy();
    expect(screen.queryByText('You file and pay these yourself')).toBeNull();
  });

  it('with a provider and no guarantee: the penalties stay with the customer', async () => {
    filing.value = { mode: 'PROVIDER', providerLabel: 'Zeal', penaltyGuarantee: false, environment: 'SANDBOX' };
    renderDesk();
    expect(await screen.findByText('Paid and filed through Zeal')).toBeTruthy();
    expect(screen.getByText(/penalties for a late or wrong filing stay with you/)).toBeTruthy();
  });
});

describe('deadline words', () => {
  it('reads a due date as a person would', () => {
    expect(dueText('2026-11-16', '2026-11-16')).toBe('Due today, Nov 16, 2026');
    expect(dueText('2026-11-17', '2026-11-16')).toBe('Due tomorrow, Nov 17, 2026');
    expect(dueText('2026-11-10', '2026-11-16')).toBe('Was due Nov 10, 2026 · 6 days late');
    expect(recentQuarters('2026-11-16', 3)).toEqual(['2026-Q4', '2026-Q3', '2026-Q2']);
    expect(recentQuarters('2026-02-01', 2)).toEqual(['2026-Q1', '2025-Q4']);
  });
});
