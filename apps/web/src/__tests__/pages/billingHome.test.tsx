import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
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
    expect(await screen.findByText('212')).toBeTruthy();
    expect(screen.getByText('AI agents')).toBeTruthy();
    expect(screen.getByText('$99.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: /view/i }).getAttribute('href')).toBe('https://invoice.stripe.test/in_1');
    expect(screen.getByText('Waiting for your plan’s prices.')).toBeTruthy();
    // The billing contact and the payment method on file (audit 2026-10-21, Tier 3).
    expect(screen.getByText('Acme Hotels LLC')).toBeTruthy();
    expect(screen.getByText('ap@acme.test')).toBeTruthy();
    expect(screen.getByText('Visa ending 4242, expires 4/2028')).toBeTruthy();
    // An admin can change who the invoices go to.
    expect(screen.getByRole('button', { name: 'Edit contact' })).toBeTruthy();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations).toHaveLength(0);
  });
});
