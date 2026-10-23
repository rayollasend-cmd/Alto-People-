import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * Manual checks (F500 G3): voiding a check changes year-to-date pay, the
 * tax ledger and the W-2, so it is asked — with a reason on the record —
 * never one click with a hard-coded reason. Recording opens from the header
 * in a dialog instead of a 13-field form sitting above the list, and the
 * checks / sick pay switch lives in the URL.
 */

const getManualChecks = vi.fn();
const voidManualCheck = vi.fn();
const voidSickPay = vi.fn();
vi.mock('@/lib/payExpApi', () => ({
  getManualChecks: () => getManualChecks(),
  recordManualCheck: vi.fn(),
  recordSickPay: vi.fn(),
  voidManualCheck: (runId: string, reason: string) => voidManualCheck(runId, reason),
  voidSickPay: (id: string, reason?: string) => voidSickPay(id, reason),
}));

import { ManualChecksPage } from '@/pages/payroll/ManualChecksPage';

const CHECK = { itemId: 'i1', runId: 'run1', associateId: 'a1', associateName: 'Ana Ruiz', checkNumber: '1042', payDate: '2026-10-02', gross: 500, taxes: 60, net: 440, status: 'RECORDED' as const };
const SICK = { id: 's1', associateId: 'a1', associateName: 'Ana Ruiz', payerName: 'Lincoln Financial', payDate: '2026-08-14', grossAmount: 1000, nontaxableAmount: 200, employerTaxesBy: 'EMPLOYER' as const, voided: false };

beforeEach(() => {
  getManualChecks.mockReset();
  voidManualCheck.mockReset().mockResolvedValue({ ok: true });
  voidSickPay.mockReset().mockResolvedValue({ ok: true });
});

describe('Manual checks', () => {
  it('voiding a check asks why and sends that reason, not a hard-coded one', async () => {
    getManualChecks.mockResolvedValue({ checks: [CHECK], sickPay: [] });
    renderAs('FINANCE_ACCOUNTANT', <ManualChecksPage />, '/payroll/manual-checks');
    fireEvent.click(await screen.findByRole('button', { name: 'Void check 1042' }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(within(dialog).getByText('Void check #1042?')).toBeInTheDocument();
    // Nothing is voided by the click alone.
    expect(voidManualCheck).not.toHaveBeenCalled();
    const confirm = within(dialog).getByRole('button', { name: 'Void check' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Written for the wrong amount' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(voidManualCheck).toHaveBeenCalledWith('run1', 'Written for the wrong amount'));
  });

  it('cancelling the void leaves the check alone', async () => {
    getManualChecks.mockResolvedValue({ checks: [CHECK], sickPay: [] });
    renderAs('FINANCE_ACCOUNTANT', <ManualChecksPage />, '/payroll/manual-checks');
    fireEvent.click(await screen.findByRole('button', { name: 'Void check 1042' }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText('Void check #1042?')).toBeNull());
    expect(voidManualCheck).not.toHaveBeenCalled();
  });

  it('records from the header in a dialog; no form sits above the list', async () => {
    getManualChecks.mockResolvedValue({ checks: [CHECK], sickPay: [] });
    renderAs('FINANCE_ACCOUNTANT', <ManualChecksPage />, '/payroll/manual-checks');
    await screen.findByText('Ana Ruiz');
    expect(screen.queryByLabelText('Check number')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /Record a manual check/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Check number')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Record check' })).toBeDisabled();
  });

  it('Replace opens the same dialog for that check', async () => {
    getManualChecks.mockResolvedValue({ checks: [CHECK], sickPay: [] });
    renderAs('FINANCE_ACCOUNTANT', <ManualChecksPage />, '/payroll/manual-checks');
    fireEvent.click(await screen.findByRole('button', { name: 'Replace check 1042' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Replace check #1042')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Record the replacement' })).toBeInTheDocument();
  });

  it('an empty list says what to do, not "Nothing here yet"', async () => {
    getManualChecks.mockResolvedValue({ checks: [], sickPay: [] });
    renderAs('FINANCE_ACCOUNTANT', <ManualChecksPage />, '/payroll/manual-checks');
    expect(await screen.findByText('No manual checks recorded')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here yet/)).toBeNull();
  });

  it('?tab=sick opens on sick pay, and voiding it asks why too', async () => {
    getManualChecks.mockResolvedValue({ checks: [CHECK], sickPay: [SICK] });
    renderAs('FINANCE_ACCOUNTANT', <ManualChecksPage />, '/payroll/manual-checks?tab=sick');
    expect(await screen.findByText('Lincoln Financial')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Record sick pay/ }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Void sick pay for Ana Ruiz' }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Corrected statement' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Void sick pay' }));
    await waitFor(() => expect(voidSickPay).toHaveBeenCalledWith('s1', 'Corrected statement'));
  });
});
