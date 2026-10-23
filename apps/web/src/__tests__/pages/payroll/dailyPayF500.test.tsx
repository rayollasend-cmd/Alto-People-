import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * Daily pay (F500 G3): the policy form and the "search to enroll" card were
 * always open on the page, and "Run tonight's now" sat disabled with no
 * reason when daily pay was off. The policy is one line with "Edit policy";
 * enrolling opens from the header; an off desk has no dead button.
 */
const getDailyPayDesk = vi.fn();
vi.mock('@/lib/payExpApi', async (orig) => ({ ...(await orig<typeof import('@/lib/payExpApi')>()), getDailyPayDesk: () => getDailyPayDesk() }));

import { DailyPayDesk, dailyPayPolicyLine } from '@/pages/payroll/DailyPayDesk';

const policy = (over: Record<string, unknown> = {}) => ({ status: 'OFF', timing: 'NEXT_DAY', eligibility: 'ENROLLED', dailyCapCents: 20000, feeCents: 0, lastRunAt: null, pending: null, ...over });
const desk = (p: Record<string, unknown>) => ({ policy: policy(p), enrolled: [{ associateId: 'a1', name: 'Ana Ruiz', enrolledAt: '2026-10-01T00:00:00Z' }], enrolledCount: 1, truncated: false, dailySchedulePeople: 0, recent: [] });

describe('Daily pay', () => {
  it('off: no run button, the policy reads in one line, and the empty list offers the policy', async () => {
    getDailyPayDesk.mockResolvedValue(desk({}));
    renderAs('FINANCE_ACCOUNTANT', <DailyPayDesk />, '/payroll/daily-pay');
    expect(await screen.findByTestId('daily-pay-policy-line')).toHaveTextContent(/Policy:\s*Off/);
    expect(screen.queryByRole('button', { name: /Run tonight/ })).toBeNull();
    expect(screen.getByText('Daily pay is off')).toBeInTheDocument();
    // No always-open form or enroll search on the page.
    expect(screen.queryByLabelText('Most per day ($, before taxes)')).toBeNull();
    expect(screen.queryByPlaceholderText('Search by name to enroll…')).toBeNull();
  });

  it('“Enroll people” opens who is paid daily, with the search', async () => {
    getDailyPayDesk.mockResolvedValue(desk({ status: 'ACTIVE' }));
    renderAs('FINANCE_ACCOUNTANT', <DailyPayDesk />, '/payroll/daily-pay');
    fireEvent.click(await screen.findByRole('button', { name: /Enroll people/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Who is paid daily')).toBeInTheDocument();
    expect(within(dialog).getByText('Ana Ruiz')).toBeInTheDocument();
  });

  it('on: the run button is there', async () => {
    getDailyPayDesk.mockResolvedValue(desk({ status: 'ACTIVE' }));
    renderAs('FINANCE_ACCOUNTANT', <DailyPayDesk />, '/payroll/daily-pay');
    expect(await screen.findByRole('button', { name: /Run tonight/ })).toBeEnabled();
  });

  it('the policy line', () => {
    expect(dailyPayPolicyLine(policy({ status: 'ACTIVE', timing: 'SAME_DAY', eligibility: 'EVERYONE', feeCents: 150 }) as never)).toBe('Same day · any hourly worker can opt in · up to $200.00 a day · $1.50 fee a day');
  });
});
