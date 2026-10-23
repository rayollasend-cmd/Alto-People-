import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * /me (F500 G5): personal data reads first and is edited in one drawer
 * (name, phone, home address with a state picker); what's missing is said
 * at the top; kiosk face verification asks Allow / Don't allow while unset;
 * an empty tab has one Add; Life events send a move to the address editor.
 */

const profile = {
  id: 'a1',
  firstName: 'Maria',
  lastName: 'Lopez',
  email: 'maria@example.com',
  phone: '8505550101',
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
};

const self = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getEmployeeNumber: vi.fn(async () => ({ employeeNumber: '4821', issuedAt: '2026-10-01T12:00:00.000Z' })),
  listEmergency: vi.fn(async () => ({ contacts: [] })),
  listDependents: vi.fn(async () => ({ dependents: [] })),
  listBeneficiaries: vi.fn(async () => ({ beneficiaries: [] })),
  listLifeEvents: vi.fn(async () => ({ events: [] })),
  listTaxDocs: vi.fn(async () => ({ documents: [] })),
  getFaceConsent: vi.fn(async () => ({ status: null, at: null })),
  setFaceConsent: vi.fn(),
  updateSelfProfile: vi.fn(async () => ({})),
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
  uploadProfilePhoto: vi.fn(),
  deleteProfilePhoto: vi.fn(),
}));
vi.mock('@/lib/selfApi', () => self);
const settings = vi.hoisted(() => ({ updateProfile: vi.fn(async () => ({ firstName: 'María', lastName: 'Lopez' })) }));
vi.mock('@/lib/settingsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/settingsApi')>()), ...settings }));
// The photo card is Settings' own uploader; stub it here.
vi.mock('@/pages/Settings', () => ({ ProfilePhotoCard: () => <div data-testid="photo-card" /> }));
vi.mock('@/lib/geoApi', () => ({ suggestAddresses: vi.fn() }));

import { MeHome } from '@/pages/me/MeHome';
import { suggestAddresses } from '@/lib/geoApi';

beforeEach(() => {
  self.getProfile.mockResolvedValue(profile);
  self.updateSelfProfile.mockClear();
  settings.updateProfile.mockClear();
  // Dev and tests have no type-ahead provider: the street line is a plain box.
  vi.mocked(suggestAddresses).mockReset();
  vi.mocked(suggestAddresses).mockResolvedValue({ available: false, reason: 'not_configured', results: [] });
});

describe('/me — the home address picked from a suggestion', () => {
  it('fills street, unit, city, the state picker and ZIP, and saves them', async () => {
    vi.mocked(suggestAddresses).mockResolvedValue({
      available: true,
      provider: 'mapbox',
      outage: false,
      results: [
        { label: '382 Flamingo Drive #2', address: '382 Flamingo Drive #2, Destin, Florida 32541', line1: '382 Flamingo Drive', line2: '#2', city: 'Destin', state: 'FL', zip: '32541', county: 'Okaloosa County', lat: 30.4, lng: -86.5, precision: 'exact' },
      ],
    });
    const user = userEvent.setup();
    renderAs('ASSOCIATE', <MeHome />, '/me', { associateId: 'a1' });
    await user.click(await screen.findByTestId('me-personal-edit'));
    await user.type(screen.getByLabelText('Address line 1'), '382 Flamingo #2');
    await user.click(await screen.findByRole('option', { name: /382 Flamingo Drive/ }));
    expect(screen.getByLabelText('State')).toHaveValue('FL');
    await user.click(screen.getByTestId('me-personal-save'));
    await waitFor(() =>
      expect(self.updateSelfProfile).toHaveBeenCalledWith({ phone: '8505550101', addressLine1: '382 Flamingo Drive', addressLine2: '#2', city: 'Destin', state: 'FL', zip: '32541' }),
    );
  });
});

describe('/me — read first, edit in one place (F500 G5)', () => {
  it('shows name, phone and address as text — no "Editable" form — and says what is missing', async () => {
    renderAs('ASSOCIATE', <MeHome />, '/me', { associateId: 'a1' });
    const personal = await screen.findByTestId('me-personal');
    expect(personal).toHaveTextContent('Maria Lopez');
    expect(personal).toHaveTextContent('(850) 555-0101');
    expect(within(personal).getByTestId('me-address')).toHaveTextContent('Not on file');
    expect(screen.queryByText('Editable')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Address line 1')).not.toBeInTheDocument();
    const gaps = await screen.findByTestId('me-gaps');
    expect(gaps).toHaveTextContent('3 things to add');
    expect(within(gaps).getByRole('button', { name: 'Emergency contact' })).toBeInTheDocument();
    expect(within(gaps).getByRole('button', { name: 'Street address' })).toBeInTheDocument();
    expect(within(gaps).getByRole('link', { name: 'Photo' })).toHaveAttribute('href', '#me-photo');
    expect(await screen.findByTestId('photo-card')).toBeInTheDocument();
  });

  it('edits name, phone and home address in one drawer, with a state picker and the home-state note', async () => {
    const user = userEvent.setup();
    renderAs('ASSOCIATE', <MeHome />, '/me', { associateId: 'a1' });
    await user.click(await screen.findByTestId('me-personal-edit'));
    expect(screen.getByText('Moving to another state? HR re-checks your tax setup when your home state changes.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Address line 1'), '100 Seaside Dr');
    await user.type(screen.getByLabelText('City'), 'Destin');
    await user.selectOptions(screen.getByLabelText('State'), 'FL');
    await user.type(screen.getByLabelText('ZIP'), '32541');
    await user.clear(screen.getByLabelText('First name'));
    await user.type(screen.getByLabelText('First name'), 'María');
    await user.click(screen.getByTestId('me-personal-save'));
    await waitFor(() =>
      expect(self.updateSelfProfile).toHaveBeenCalledWith({ phone: '8505550101', addressLine1: '100 Seaside Dr', addressLine2: null, city: 'Destin', state: 'FL', zip: '32541' }),
    );
    expect(settings.updateProfile).toHaveBeenCalledWith({ firstName: 'María', lastName: 'Lopez' });
  });

  it('kiosk face verification, never asked: Allow and Don’t allow — not "Turn off" for something that isn’t on', async () => {
    renderAs('ASSOCIATE', <MeHome />, '/me', { associateId: 'a1' });
    expect(await screen.findByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Don’t allow' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
  });

  it('an empty tab has one Add (its empty state’s)', async () => {
    renderAs('ASSOCIATE', <MeHome />, '/me?tab=emergency', { associateId: 'a1' });
    // The Profile tab isn't open, so wait for the emergency tab's empty state.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Add contact/ })).toHaveLength(1));
  });

  it('Life events send a move to the address editor, and no longer offer "Address change" as an event', async () => {
    const user = userEvent.setup();
    renderAs('ASSOCIATE', <MeHome />, '/me?tab=life-events', { associateId: 'a1' });
    const moved = await screen.findByTestId('me-ev-address');
    await user.click(within(moved).getByRole('button', { name: 'Update your home address' }));
    expect(await screen.findByLabelText('Address line 1')).toBeInTheDocument();
  });
});
