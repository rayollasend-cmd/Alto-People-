import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { renderAs } from './hrPack/harness';

/**
 * Brief 2-6 step 4 — Billing shows the plan, this month's active workers by
 * type and the invoices, with a draft's reason in words. Axe-clean.
 */

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) => (path === '/billing/contact' ? { stripeUpdated: true } : {
    contact: { name: 'Acme Hotels LLC', email: 'ap@acme.test', paymentMethod: { kind: 'card', label: 'Visa ending 4242, expires 4/2028' }, paymentMethodNote: null },
    plan: 'standard',
    invoiced: true,
    stripe: 'test',
    month: '2026-10',
    daysCounted: 14,
    running: { PERSON: 212, AGENT: 3, ROBOT: 1 },
    history: [
      { month: '2026-09', daysCounted: 30, counts: { PERSON: 198, AGENT: 2, ROBOT: 1 } },
      { month: '2026-08', daysCounted: 31, counts: { PERSON: 200, AGENT: 0, ROBOT: 0 } },
      { month: '2026-07', daysCounted: 0, counts: { PERSON: 0, AGENT: 0, ROBOT: 0 } },
    ],
    invoices: [
      { id: 'i2', month: '2026-09', status: 'OPEN', totalCents: 9900, lines: [{ type: 'ROBOT', quantity: 1, unitPriceCents: 9900, amountCents: 9900 }], holdReason: null, hostedUrl: 'https://invoice.stripe.test/in_1', lastPaymentError: null, paidAt: null },
      { id: 'i1', month: '2026-08', status: 'DRAFT', totalCents: 0, lines: [{ type: 'PERSON', quantity: 200, unitPriceCents: null, amountCents: 0 }], holdReason: 'prices_missing', hostedUrl: null, lastPaymentError: null, paidAt: null },
    ],
  })),
}));

import { BillingHome } from '@/pages/admin/BillingHome';

describe('BillingHome', () => {
  it('shows the running counts, the invoices and why a draft waits', async () => {
    const { container } = renderAs('HR_ADMINISTRATOR', <BillingHome />, '/admin/billing');
    // The running counts are MetricCards that count up; wait for the landed value.
    const strip = await screen.findByRole('group', { name: 'October 2026 so far' });
    await waitFor(() => expect(strip).toHaveTextContent('212'), { timeout: 3000 });
    expect(screen.getAllByText('AI agents').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$99.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /view/i }).getAttribute('href')).toBe('https://invoice.stripe.test/in_1');
    expect(screen.getByText('Waiting for your plan’s prices.')).toBeTruthy();
    // The billing contact and the payment method on file (audit 2026-10-21, Tier 3).
    expect(screen.getByText('Acme Hotels LLC')).toBeTruthy();
    expect(screen.getByText('ap@acme.test')).toBeTruthy();
    expect(screen.getByText('Visa ending 4242, expires 4/2028')).toBeTruthy();
    // An admin can change who the invoices go to.
    expect(screen.getByRole('button', { name: 'Edit contact' })).toBeTruthy();
    // The last six months beside the invoice each became (F500 G4).
    const history = screen.getByRole('table', { name: /Billable workers by month/ });
    expect(history).toHaveTextContent('September 2026');
    expect(history).toHaveTextContent('198');
    expect(history).toHaveTextContent('Due');
    // A month with nothing counted folds into one line under the table, not a row of dashes.
    expect(history).not.toHaveTextContent('July 2026');
    expect(screen.getByText('Nothing was counted in July 2026.')).toBeTruthy();
    // This month leads the table, so far.
    expect(history).toHaveTextContent('October 2026so far');
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations).toHaveLength(0);
  });
  it('says in one line when the last six months counted nothing, names the plan in words, and drops worker types it never counted', async () => {
    const { apiFetch } = await import('@/lib/api');
    vi.mocked(apiFetch).mockImplementationOnce(async () => ({
      plan: 'internal', invoiced: false, stripe: 'off', month: '2026-10', daysCounted: 3, running: { PERSON: 1, AGENT: 0, ROBOT: 0 },
      history: ['2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04'].map((month) => ({ month, daysCounted: 0, counts: { PERSON: 0, AGENT: 0, ROBOT: 0 } })),
      invoices: [],
    }) as never);
    renderAs('HR_ADMINISTRATOR', <BillingHome />, '/admin/billing');
    expect(await screen.findByText('Nothing was counted from April 2026 to September 2026.')).toBeTruthy();
    // The usage table still stands, with this month in it.
    expect(screen.getByRole('table', { name: /Billable workers by month/ })).toHaveTextContent('October 2026');
    // "Plan Internal · Not invoiced" read as unfinished: the plan in words, and what it means.
    expect(screen.getByTestId('page-facts')).toHaveTextContent('Internal plan');
    expect(screen.getByTestId('page-facts')).toHaveTextContent('Not invoiced');
    expect(screen.getByTestId('billing-internal')).toHaveTextContent('Internal plan accounts aren’t invoiced');
    // No AI agents were ever counted: no "AI agents 0" tile or column.
    expect(screen.queryByText('AI agents')).toBeNull();
  });
});
