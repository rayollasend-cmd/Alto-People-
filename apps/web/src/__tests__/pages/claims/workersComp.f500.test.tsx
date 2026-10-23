import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';
import type { WcClaim } from '@/lib/claimsApi';

const claims = vi.hoisted(() => ({
  getWcSummary: vi.fn(),
  listUnclaimedIncidents: vi.fn(),
  listWcClaims: vi.fn(),
  openWcClaim: vi.fn(),
  getWcClaim: vi.fn(),
  getDutyMatches: vi.fn(),
  patchWcClaim: vi.fn(),
}));
vi.mock('@/lib/claimsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/claimsApi')>()), ...claims }));
const osha = vi.hoisted(() => ({ createOshaIncident: vi.fn() }));
vi.mock('@/lib/oshaWcEeoApi', async (orig) => ({ ...(await orig<typeof import('@/lib/oshaWcEeoApi')>()), ...osha }));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [{ id: 'c1', name: 'Coastal Resort' }] }) }));
vi.mock('@/components/ui/AssociatePicker', () => ({
  AssociatePicker: ({ value, onChange }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string }) => void }) => (
    <button type="button" onClick={() => onChange({ id: 'a3', name: 'Ana Hurt' })}>
      {value ? value.name : 'Pick a person'}
    </button>
  ),
}));

import { WorkersCompHome } from '@/pages/claims/WorkersCompHome';

/** Workers' comp (F500 G6): report an injury from the page itself; a sent first report reads as a record, changed by "Amend". */

const wc = (o: Partial<WcClaim> = {}): WcClaim => ({
  id: 'w1',
  oshaIncidentId: 'i1',
  associateId: 'a3',
  associateName: 'Ana Hurt',
  clientId: 'c1',
  clientName: 'Coastal',
  locationId: 's1',
  storeName: 'Front Beach',
  jurisdiction: 'CA',
  injuryDate: '2026-12-01T15:00:00.000Z',
  reportedToEmployerAt: '2026-12-01',
  froiDueAt: '2026-12-06',
  froi: {
    employer: { name: 'Alto HR', fein: '12-3456789', address: null, policyNumber: 'WC-1' },
    employee: { name: 'Ana Hurt', address: null, phone: null, dob: null, ssnLast4: null, hireDate: null, jobTitle: 'Houseman', wageRate: 16, wageUnit: 'HOUR', hoursPerWeek: 30 },
    injury: { occurredAt: '2026-12-01T15:00:00.000Z', where: null, description: 'Strained back.', bodyPart: 'Lower back', nature: 'Strain', cause: 'Lifting', objectOrSubstance: null, witnesses: null, treatment: 'CLINIC', physician: null, lastDayWorked: '2026-12-01', returnedToWork: null, fatal: false },
    reportedBy: { name: null, title: null },
  },
  froiSubmittedAt: null,
  carrierName: null,
  carrierClaimNumber: null,
  status: 'OPEN',
  claimType: 'MEDICAL_ONLY',
  lostTimeDays: 0,
  restrictedDays: 0,
  reserveMedical: null,
  reserveIndemnity: null,
  restrictions: null,
  restrictionRules: null,
  rtwDate: null,
  notes: null,
  dutyOffers: [],
  next: null,
  createdAt: '2026-12-02T10:00:00.000Z',
  ...o,
});

beforeEach(() => {
  for (const f of [...Object.values(claims), ...Object.values(osha)]) f.mockReset();
  claims.getWcSummary.mockResolvedValue({ open: 0, froiDue: 0, froiOverdue: 0, lostTimeDaysOpen: 0, restrictedDaysOpen: 0, claimsLast12Months: 0, incidentRate: null, hoursWorkedLast12Months: 0, byPlace: [] });
  claims.listUnclaimedIncidents.mockResolvedValue({ incidents: [] });
  claims.listWcClaims.mockResolvedValue({ claims: [], total: 0, hasMore: false });
  claims.getDutyMatches.mockResolvedValue({ rules: null, shifts: [] });
});

describe('workers’ comp (F500 G6)', () => {
  it('“Report an injury” logs it and starts the claim in one step', async () => {
    osha.createOshaIncident.mockResolvedValue({ id: 'i7' });
    claims.openWcClaim.mockResolvedValue({ claim: wc({ id: 'w7', oshaIncidentId: 'i7' }) });
    claims.getWcClaim.mockResolvedValue({ claim: wc({ id: 'w7' }), froiDefaultDays: 5 });
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <WorkersCompHome />, '/claims/workers-comp');
    await user.click(await screen.findByRole('button', { name: /Report an injury/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Report an injury' });
    const go = within(dialog).getByRole('button', { name: 'Report and start the claim' });
    expect(go).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Pick a person' }));
    await user.selectOptions(within(dialog).getByLabelText('Client'), 'c1');
    await user.type(within(dialog).getByLabelText('What happened'), 'Slipped on a wet floor.');
    await user.click(go);
    await waitFor(() => expect(osha.createOshaIncident).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', associateId: 'a3', description: 'Slipped on a wet floor.', severity: 'MEDICAL_TREATMENT' })));
    await waitFor(() => expect(claims.openWcClaim).toHaveBeenCalledWith({ oshaIncidentId: 'i7' }));
    await waitFor(() => expect(claims.getWcClaim).toHaveBeenCalledWith('w7'));
  });

  it('a first report already sent reads as a record; “Amend” opens it', async () => {
    claims.listWcClaims.mockResolvedValue({ claims: [wc({ froiSubmittedAt: '2026-12-03T12:00:00.000Z', status: 'SUBMITTED' })], total: 1, hasMore: false });
    claims.getWcClaim.mockResolvedValue({ claim: wc({ froiSubmittedAt: '2026-12-03T12:00:00.000Z', status: 'SUBMITTED' }), froiDefaultDays: 5 });
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <WorkersCompHome />, '/claims/workers-comp?claim=w1');
    expect(await screen.findByText(/Sent to the carrier/)).toBeInTheDocument();
    expect(screen.queryByLabelText('FEIN')).toBeNull();
    expect(screen.getByText('12-3456789')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Amend' }));
    expect(await screen.findByLabelText('FEIN')).toHaveValue('12-3456789');
    expect(screen.getByRole('button', { name: 'Save the amendment' })).toBeInTheDocument();
  });
});
