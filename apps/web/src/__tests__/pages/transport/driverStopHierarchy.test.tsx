import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { I18nProvider } from '@/lib/i18n';
import type { Ride, RideRun } from '@/lib/transportApi';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/components/transport/LazyLiveMap', () => ({ LazyLiveMap: () => null }));

import { apiFetch } from '@/lib/api';
import { DriverHome } from '@/pages/transport/DriverHome';

/**
 * One gold button in the row, and it is the next thing to do.
 *
 * This regressed silently once already: the row carried
 * `variant={arrivedAt ? 'secondary' : 'secondary'}`, a ternary that
 * always resolved the same way, so Navigate never changed appearance and
 * nobody noticed — a dead conditional reads as a live one.
 *
 * The rule is that the driver, one-handed and parking, should be able to
 * find the next action by colour alone:
 *
 *   driving to the stop   Navigate      (Arrived and All on board quiet)
 *   standing at it        All on board  (Navigate steps back)
 *
 * The assertion is deliberately "exactly one gold thing on the card",
 * not "Navigate is primary". Competing gold buttons are the failure mode
 * and a per-button assertion lets them through — Button defaults to
 * primary, so any control added to this card without a variant breaks
 * the rule while every individual expectation still passes.
 */

const tz = 'America/Chicago';
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function ride(over: Partial<Ride> & { id: string }): Ride {
  return {
    direction: 'TO_WORK',
    targetAt: at(2),
    serviceDate: new Date().toISOString().slice(0, 10),
    status: 'SCHEDULED',
    shiftId: null,
    note: null,
    pickup: { kind: 'stop', id: 's1', name: 'Seaside Housing', address: '100 Seaside Dr' },
    point: null,
    store: { id: 'l1', name: 'Front Beach 218', timezone: tz, clientId: 'c1', clientName: 'Coastal' },
    rider: { associateId: `a-${over.id}`, name: 'Maria Lopez', phone: '555-0100' },
    pickupOrder: 1,
    pickupAt: at(1),
    run: null,
    fareCents: 500,
    noShowFeeCents: 100,
    owedCents: 0,
    waived: false,
    waiveReason: null,
    charged: false,
    boardedAt: null,
    completedAt: null,
    noShowAt: null,
    cancelledAt: null,
    cancelReason: null,
    vanArrivedAt: null,
    riderSignal: null,
    acceptedAt: null,
    declines: 0,
    allDeclined: false,
    createdAt: new Date().toISOString(),
    ...over,
  } as Ride;
}

/** A run on the road, with two riders waiting at one stop. */
function activeRun(vanArrivedAt: string | null): RideRun {
  return {
    id: 'run1',
    direction: 'TO_WORK',
    serviceDate: new Date().toISOString().slice(0, 10),
    departAt: at(1),
    status: 'ACTIVE',
    startedAt: at(-1),
    endedAt: null,
    notes: null,
    van: { id: 'v1', name: 'Van 2', plate: 'ALT 101', capacity: 12 },
    driver: { userId: 'u', name: 'Dana' },
    seats: { taken: 2, capacity: 12 },
    // Two, so "All on board" renders at all — it is the control that
    // takes over as primary once the van has arrived.
    rides: [
      ride({ id: 'r1', vanArrivedAt }),
      ride({ id: 'r2', vanArrivedAt, pickupOrder: 2 }),
    ],
  } as RideRun;
}

function routes(vanArrivedAt: string | null) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/transport/driver/runs') {
      return { today: new Date().toISOString().slice(0, 10), runs: [activeRun(vanArrivedAt)] } as never;
    }
    if (path === '/transport/driver/requests') return { van: null, requests: [] } as never;
    if (path.startsWith('/transport/driver/schedule?')) {
      return { from: '', to: '', van: null, runs: [], asking: [] } as never;
    }
    // The live map's own poll — RunMap renders nothing without it, which
    // is what the LazyLiveMap mock already guarantees.
    return { run: null } as never;
  });
}

function renderDriver() {
  const caps = ROLE_CAPABILITIES.DRIVER;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'dana@altohr.com', role: 'DRIVER', status: 'ACTIVE', clientId: null, associateId: 'a' },
          role: 'DRIVER',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <I18nProvider>
          <ConfirmProvider>
            <MemoryRouter>
              <DriverHome />
            </MemoryRouter>
          </ConfirmProvider>
        </I18nProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

/**
 * Every gold control on the card. `btn-gold` is what Button's primary
 * variant paints with and no other variant uses it, so this reads the
 * same cue a driver does. Links count too — Navigate is an <a> behind
 * asChild.
 */
function goldOnCard(card: HTMLElement): string[] {
  return [
    ...within(card).queryAllByRole('button'),
    ...within(card).queryAllByRole('link'),
  ]
    .filter((el) => el.className.split(/\s+/).includes('btn-gold'))
    .map((el) => el.textContent?.trim() ?? '');
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the stop card offers exactly one next thing', () => {
  it('while driving to the stop, that is Navigate', async () => {
    routes(null);
    renderDriver();
    const card = await screen.findByRole('region', { name: /Van 2/ });
    // Arrived and All on board are both present and both quiet.
    expect(within(card).getByRole('button', { name: /Arrived/ })).toBeInTheDocument();
    // The WHOLE card, not just the action row: each rider's "On board" is
    // quiet until the van is at the kerb too, so while driving there is
    // exactly one gold thing on screen and it is the one to press.
    expect(goldOnCard(card)).toEqual(['Navigate']);
  });

  it('once the van has arrived, it is All on board', async () => {
    routes(at(-0.1));
    renderDriver();
    const card = await screen.findByRole('region', { name: /Van 2/ });
    // Arrived has become the timestamp, so it cannot be the gold one.
    expect(within(card).queryByRole('button', { name: /^Arrived$/ })).toBeNull();
    // Boarding is now the job, so every way of doing it leads: the whole
    // stop at once, or a rider at a time. What must NOT still lead is
    // Navigate — the van is already there.
    const gold = goldOnCard(card);
    expect(gold).toContain('All on board');
    expect(gold).not.toContain('Navigate');
    expect(gold.filter((g) => g === 'On board')).toHaveLength(2);
  });
});
