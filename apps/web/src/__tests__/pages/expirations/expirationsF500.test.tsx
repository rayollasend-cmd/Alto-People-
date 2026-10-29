import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';
import { AuthContext } from '@/lib/auth';
import { RequireCapability } from '@/lib/RequireCapability';

/**
 * Expirations, F500:
 *   - an associate who follows a link here lands on their own credentials,
 *     not on "Missing capability: view:org";
 *   - three totals across every view (blocking a shift, expired, due in
 *     30 days), each opening the list it counts;
 *   - nothing due anywhere is one empty state, not three empty grids, and
 *     the timeline draws no empty chart.
 */

vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [] }) }));
vi.mock('@/lib/useViewport', async (orig) => ({ ...(await orig<typeof import('@/lib/useViewport')>()), useMediaQuery: () => false }));
const getExpirationRisk = vi.fn();
const getExpirations = vi.fn();
vi.mock('@/lib/expirations113Api', () => ({
  getExpirationRisk: (...a: unknown[]) => getExpirationRisk(...a),
  getExpirations: (...a: unknown[]) => getExpirations(...a),
}));
vi.mock('@/lib/qualApi', () => ({ grantAssociateQual: vi.fn() }));
vi.mock('@/pages/transport/TransportDesk', () => ({ TransportExpiringSection: () => null }));

import { ExpirationsHome } from '@/pages/expirations/ExpirationsHome';

const emptyRisk = {
  asOf: '2026-10-22T12:00:00.000Z',
  days: 90,
  truncated: false,
  items: [],
  atRisk: [],
  weeks: ['2026-10-19', '2026-10-26'],
  timeline: [],
  filters: { clients: [], stores: [], qualifications: [] },
};
const blockingItem = {
  id: 'q1',
  associateId: 'a1',
  associateName: 'Ana Lopez',
  associateEmail: 'ana@example.com',
  qualificationId: 'food',
  qualificationCode: 'FOOD',
  qualificationName: 'Food handler',
  isCert: true,
  expiresAt: '2026-10-27',
  daysUntilExpiry: 5,
  storeId: 's1',
  storeName: 'Front Beach',
  clientId: null,
  clientName: null,
  nextShift: null,
  blockingShift: { id: 'sh1', startsAt: '2026-10-27T13:00:00.000Z', storeId: 's1', storeName: 'Front Beach', position: 'Cook', requiredBy: 'shift' },
};
const listItem = (id: string, days: number) => ({
  id,
  associateId: `a-${id}`,
  associateName: `Person ${id}`,
  associateEmail: `${id}@example.com`,
  qualificationId: 'food',
  qualificationCode: 'FOOD',
  qualificationName: 'Food handler',
  isCert: true,
  expiresAt: '2026-10-01',
  daysUntilExpiry: days,
});
const counts = (expired: number, dueSoon: number, dueLater: number, days = 60) => ({
  days,
  counts: { expired, dueSoon, dueLater },
  expired: Array.from({ length: expired }, (_, i) => listItem(`e${i}`, -3)),
  dueSoon: Array.from({ length: dueSoon }, (_, i) => listItem(`s${i}`, 10)),
  dueLater: Array.from({ length: dueLater }, (_, i) => listItem(`l${i}`, 200)),
});

let search = '';
function Spy() {
  search = useLocation().search;
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  getExpirationRisk.mockResolvedValue({ ...emptyRisk, items: [blockingItem], atRisk: ['q1'], filters: { clients: [], stores: [{ id: 's1', name: 'Front Beach', clientId: null }], qualifications: [{ id: 'food', name: 'Food handler' }] } });
  getExpirations.mockImplementation(async ({ days }: { days: number }) => (days === 30 ? counts(2, 3, 0, 30) : counts(2, 4, 1, days)));
});

describe('Expirations totals', () => {
  it('shows blocking / expired / due in 30 days, the exact counts, over every view', async () => {
    renderAs('HR_ADMINISTRATOR', <><ExpirationsHome /><Spy /></>, '/expirations');
    const blocking = await screen.findByRole('button', { name: /Blocking a shift/ });
    expect(blocking).toHaveAttribute('aria-pressed', 'true');
    // The tiles count up; wait for the landed values.
    await waitFor(() => expect(blocking).toHaveTextContent(/Blocking a shift\s*1/), { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Expired/ })).toHaveTextContent(/Expired\s*2/), { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('button', { name: /Due in 30 days/ })).toHaveTextContent(/Due in 30 days\s*3/), { timeout: 5000 });
    expect(getExpirations).toHaveBeenCalledWith({ days: 30 });
  });

  it('a tile opens the full list on its bucket, kept in the URL', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <><ExpirationsHome /><Spy /></>, '/expirations');
    await user.click(await screen.findByRole('button', { name: /Due in 30 days/ }));
    await waitFor(() => expect(search).toContain('view=list'));
    expect(search).toContain('within=30');
    await waitFor(() => expect(getExpirations).toHaveBeenCalledWith({ days: 30, isCert: undefined }));
    expect(await screen.findByText('Due in next 30 days')).toBeInTheDocument();
  });

  it('nothing anywhere: one line instead of three zero tiles', async () => {
    getExpirationRisk.mockResolvedValue(emptyRisk);
    getExpirations.mockResolvedValue(counts(0, 0, 0));
    renderAs('HR_ADMINISTRATOR', <ExpirationsHome />, '/expirations');
    expect(await screen.findByText('Nothing has expired, nothing lapses in the next 30 days, and no shift is blocked.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Blocking a shift/ })).not.toBeInTheDocument();
    // The at-risk view doesn't repeat the empty state's sentence above it.
    expect(await screen.findByText('Nobody’s shifts are at risk')).toBeInTheDocument();
    expect(screen.queryByText(/No scheduled shift is blocked/)).not.toBeInTheDocument();
  });
});

describe('Expirations empty states', () => {
  it('the full list with nothing due is one empty state, not three empty grids', async () => {
    getExpirations.mockResolvedValue(counts(0, 0, 0));
    renderAs('HR_ADMINISTRATOR', <ExpirationsHome />, '/expirations?view=list');
    expect(await screen.findByText('Nothing expired or expiring within a year')).toBeInTheDocument();
    expect(screen.queryByText('Due later (within 1 year)')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('an empty bucket beside a full one is one line', async () => {
    getExpirations.mockResolvedValue(counts(0, 2, 0));
    renderAs('HR_ADMINISTRATOR', <ExpirationsHome />, '/expirations?view=list');
    expect(await screen.findByText('· Nothing expired.')).toBeInTheDocument();
    expect(screen.getByText('· Nothing further out.')).toBeInTheDocument();
  });

  it('a column the API capped says "Showing 500 of 812" (CODE-33)', async () => {
    getExpirations.mockResolvedValue({ ...counts(0, 3, 0), counts: { expired: 0, dueSoon: 812, dueLater: 0 }, truncated: { expired: false, dueSoon: true, dueLater: false } });
    renderAs('HR_ADMINISTRATOR', <ExpirationsHome />, '/expirations?view=list');
    expect(await screen.findByTestId('bucket-truncated')).toHaveTextContent('Showing 3 of 812.');
  });

  it('the timeline draws no chart when nothing lapses', async () => {
    getExpirationRisk.mockResolvedValue(emptyRisk);
    renderAs('HR_ADMINISTRATOR', <ExpirationsHome />, '/expirations?view=timeline');
    expect(await screen.findByText('Nothing lapses in the next 90 days')).toBeInTheDocument();
    expect(screen.queryByText('Lapsing each week')).not.toBeInTheDocument();
  });
});

describe('the /expirations route guard', () => {
  function renderRoute(role: 'ASSOCIATE' | 'CLIENT_PORTAL', associateId: string | null) {
    return render(
      <AuthContext.Provider value={{ user: { id: 'u', role, associateId }, can: () => false } as never}>
        <MemoryRouter initialEntries={['/expirations']}>
          <Routes>
            <Route
              path="/expirations"
              element={
                <RequireCapability cap="view:org" selfService="/me/wallet">
                  <div>org expirations</div>
                </RequireCapability>
              }
            />
            <Route path="/me/wallet" element={<div>my credentials</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
  }

  it('sends an associate to their own credentials', () => {
    renderRoute('ASSOCIATE', 'a1');
    expect(screen.getByText('my credentials')).toBeInTheDocument();
    expect(screen.queryByText('org expirations')).not.toBeInTheDocument();
  });

  it('shows the access page to someone with no record of their own', () => {
    renderRoute('CLIENT_PORTAL', null);
    expect(screen.getByRole('heading', { name: /don.t have access to this page/ })).toBeInTheDocument();
  });
});
