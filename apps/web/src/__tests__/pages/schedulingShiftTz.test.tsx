import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fmtShiftTz, setDisplayTimeZone } from '@/lib/format';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmProvider } from '@/lib/confirm';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { MobileScheduleList } from '@/pages/scheduling/MobileScheduleList';
import { makeShift } from './scheduling/scheduleHarness';

/**
 * Role walk, ops 2 — one shift showed three start times: the list in the
 * store's zone, the Assign dialog and Home in the browser's, the decision
 * room in New York. Every display now goes through fmtShiftTz with the
 * shift's own zone, and says the zone when the viewer isn't in it.
 */

const calls = vi.hoisted(() => [] as Array<{ url: string; body?: unknown }>);
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (url: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ url, body: init?.body });
      if (url === '/scheduling/shifts' && init?.method === 'POST') return { id: '88888888-8888-4888-8888-888888888888' };
      return { candidates: [] };
    },
  };
});

import { AssignDialog, copyShiftToCell } from '@/pages/scheduling/AdminSchedulingView';

// 2026-07-14 14:00Z = 9:00 AM CDT at a Chicago store, 10:00 AM EDT in New York.
const START = '2026-07-14T14:00:00.000Z';
const shift = makeShift({ id: '77777777-7777-4777-8777-777777777777', startsAt: START, endsAt: '2026-07-14T22:00:00.000Z', timezone: 'America/Chicago', clientName: null });

beforeEach(() => setDisplayTimeZone('America/New_York'));
afterEach(() => {
  setDisplayTimeZone(null);
  cleanup();
});

describe('fmtShiftTz', () => {
  it('renders the store wall-clock with the zone when the viewer is elsewhere, and bare at the store', () => {
    expect(fmtShiftTz(START, 'America/Chicago')).toMatch(/9:00 AM CDT$/);
    expect(fmtShiftTz(START, 'America/Chicago', { day: false })).toBe('9:00 AM CDT');
    setDisplayTimeZone('America/Chicago');
    expect(fmtShiftTz(START, 'America/Chicago', { day: false })).toBe('9:00 AM');
  });
});

describe('every display uses the shift zone', () => {
  it('the Assign dialog header reads 9:00 AM CDT from New York, and names the store when there is no client', () => {
    render(
      <I18nProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TooltipProvider>
            <MemoryRouter>
              <ConfirmProvider>
                <AssignDialog target={shift} associates={[]} openShiftsInWeek={[]} onClose={() => {}} onAssigned={() => {}} onAssignedNext={() => {}} />
              </ConfirmProvider>
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(screen.getByTestId('assign-when')).toHaveTextContent('9:00 AM CDT');
    expect(screen.getByText(/Housekeeper at Front Beach/)).toBeInTheDocument();
  });

  it('the mobile card reads 9:00 AM CDT from New York', () => {
    const anchor = new Date(2026, 6, 14);
    render(
      <MobileScheduleList shifts={[shift]} associates={[]} dayAnchor={anchor} displayTimeZone="America/Chicago" canManage onShiftClick={() => {}} onPrevDay={() => {}} onNextDay={() => {}} onCreate={() => {}} />,
    );
    expect(screen.getByText(/9:00 AM CDT – 5:00 PM CDT/)).toBeInTheDocument();
  });
});

describe('Alt-drag copy (ops 8) keeps the shift zone and lands on the target row', () => {
  it('copies to Thursday at 9:00 AM Chicago and assigns the person it was dropped on', async () => {
    calls.length = 0;
    const ASSOC = '33333333-3333-4333-8333-333333333333';
    // The Thursday column: a local-midnight anchor, as the grid passes it.
    const r = await copyShiftToCell(shift, { associateId: ASSOC, dayStart: new Date(2026, 6, 16) }, async () => true, 'Ana Lopez');
    expect(r).toBe('copied');
    const create = calls.find((c) => c.url === '/scheduling/shifts')!;
    // 9:00 AM CDT on Jul 16 = 14:00Z, eight hours long — not 9 AM New York.
    expect(create.body).toMatchObject({ startsAt: '2026-07-16T14:00:00.000Z', endsAt: '2026-07-16T22:00:00.000Z', position: 'Housekeeper' });
    const assign = calls.find((c) => c.url.endsWith('/assign'))!;
    expect(assign.url).toBe('/scheduling/shifts/88888888-8888-4888-8888-888888888888/assign');
    expect(assign.body).toMatchObject({ associateId: ASSOC });
  });

  it('a drop on the Unassigned row copies without an assign', async () => {
    calls.length = 0;
    await copyShiftToCell(shift, { associateId: null, dayStart: new Date(2026, 6, 16) }, async () => true);
    expect(calls.some((c) => c.url.endsWith('/assign'))).toBe(false);
  });
});
