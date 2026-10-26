import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * Floor walk 26 on /me: the employment type reads as words ("Employee",
 * with what it means — not "W-2", a tax form, and never the raw enum), and the clock-in number is masked like it is on the home
 * page — shown only on a tap.
 */

vi.mock('@/lib/selfApi', () => ({
  getProfile: vi.fn().mockResolvedValue({
    id: 'a1',
    firstName: 'Maria',
    lastName: 'Lopez',
    email: 'maria@example.com',
    phone: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    zip: null,
    employmentType: 'W2_EMPLOYEE',
    photoUrl: null,
    department: null,
    jobProfile: null,
    managerName: null,
    managerPhone: null,
    managerEmail: null,
  }),
  getEmployeeNumber: vi.fn().mockResolvedValue({ employeeNumber: '4821', issuedAt: '2026-10-01T12:00:00.000Z' }),
  listEmergency: vi.fn().mockResolvedValue({ contacts: [] }),
  listDependents: vi.fn().mockResolvedValue({ dependents: [] }),
  listBeneficiaries: vi.fn().mockResolvedValue({ beneficiaries: [] }),
  listLifeEvents: vi.fn().mockResolvedValue({ events: [] }),
  listTaxDocs: vi.fn().mockResolvedValue({ documents: [] }),
  getFaceConsent: vi.fn().mockResolvedValue({ status: null, at: null }),
  setFaceConsent: vi.fn(),
  updateSelfProfile: vi.fn(),
  createBeneficiary: vi.fn(),
  createDependent: vi.fn(),
  createEmergency: vi.fn(),
  createLifeEvent: vi.fn(),
  deleteBeneficiary: vi.fn(),
  deleteDependent: vi.fn(),
  deleteEmergency: vi.fn(),
  updateBeneficiary: vi.fn(),
  updateDependent: vi.fn(),
  updateEmergency: vi.fn(),
}));

import { MeHome } from '@/pages/me/MeHome';

describe('/me — profile polish (floor walk 26)', () => {
  it('names the employment type and masks the clock-in number until asked', async () => {
    renderAs('ASSOCIATE', <MeHome />, '/me', { associateId: 'a1' });
    expect(await screen.findByText('Employee')).toBeInTheDocument();
    expect(screen.getByText('Taxes are taken out of each paycheck.')).toBeInTheDocument();
    expect(screen.queryByText('W-2')).not.toBeInTheDocument();
    expect(screen.queryByText('W2_EMPLOYEE')).not.toBeInTheDocument();

    const number = await screen.findByTestId('me-employee-number');
    expect(number).toHaveTextContent('••••');
    expect(screen.queryByText('4821')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show my clock-in number' }));
    expect(number).toHaveTextContent('4821');
    expect(screen.getByRole('button', { name: 'Hide my clock-in number' })).toHaveAttribute('aria-pressed', 'true');
  });
});
