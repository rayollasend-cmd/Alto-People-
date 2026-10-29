import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Shift } from '@alto-people/shared';
import { I18nProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/english';
import '@/lib/i18n/en/all';
import { directionsUrl } from '@/lib/format';
import { openShiftRate, openShiftWorth } from '@/lib/openShiftPay';
import { MODULES, navShapeFor, roleNavLabels } from '@/lib/modules';
import { saturdayFirst, leadingBlanks } from '@/pages/scheduling/associateWeek';

/**
 * ASSOC units: Directions goes to the store's address (ASSOC-10); one rule
 * prices an open shift (ASSOC-5); the associate's menu and search speak
 * their words (ASSOC-19, ASSOC-26); a Chicago shift read in LA names its
 * zone once (ASSOC-7); the month grid's rows are payroll weeks (ASSOC-6).
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn().mockResolvedValue({}) }));

const tz = process.env.TZ;
afterEach(() => {
  process.env.TZ = tz;
});

describe('Directions (ASSOC-10)', () => {
  it('opens turn-by-turn to the store’s point, else its address — never a search for "client store department"', () => {
    expect(directionsUrl({ lat: 30.18, lng: -85.8, address: '15495 Panama City Beach Pkwy', names: ['Coastal Resort', 'Front Beach 218'] })).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=30.18,-85.8',
    );
    expect(directionsUrl({ address: '15495 Panama City Beach Pkwy, Panama City Beach, FL', names: ['Coastal Resort'] })).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=15495%20Panama%20City%20Beach%20Pkwy%2C%20Panama%20City%20Beach%2C%20FL',
    );
    // Nothing on file: the names, as before.
    expect(directionsUrl({ names: ['Coastal Resort', null, 'Front Beach 218'] })).toBe(
      'https://www.google.com/maps/search/?api=1&query=Coastal%20Resort%20Front%20Beach%20218',
    );
  });
});

describe('what an open shift is worth (ASSOC-5)', () => {
  const shift = { startsAt: '2026-10-30T19:00:00.000Z', endsAt: '2026-10-31T01:00:00.000Z' }; // 2–8 PM CDT, 6h
  it('its posted rate when it has one, else theirs — on paid hours', () => {
    expect(openShiftRate('15.50', 15)).toBe(15.5);
    expect(openShiftRate(null, 15)).toBe(15);
    expect(openShiftRate(null, null)).toBeNull();
    expect(openShiftWorth(shift, '15.50', 15)).toBe(93);
    expect(openShiftWorth(shift, null, 15)).toBe(90);
    // Past six hours the unpaid hour comes off (the shared break rule).
    expect(openShiftWorth({ startsAt: '2026-10-30T13:00:00.000Z', endsAt: '2026-10-30T21:00:00.000Z' }, 20, 15)).toBe(140);
  });
});

describe('the associate’s menu and search (ASSOC-19, ASSOC-26)', () => {
  const t = (k: string) => (en as Record<string, string>)[k] ?? k;
  const mods = roleNavLabels(MODULES.filter((m) => ['payroll', 'time-attendance', 'learning', 'me', 'communications', 'messages', 'documents'].includes(m.key)), 'ASSOCIATE', t as never);
  const by = (k: string) => mods.find((m) => m.key === k)!;

  it('labels are the page titles', () => {
    expect(by('time-attendance').label).toBe('My time');
    expect(by('learning').label).toBe('My training');
    expect(by('payroll').label).toBe('Paystubs');
  });

  it('descriptions are what the page does for them, and their words find it', () => {
    expect(by('payroll').description).toBe('Your paychecks, taxes and direct deposit');
    expect(by('payroll').description).not.toMatch(/anomaly|Branch|Wise/);
    expect(by('payroll').keywords).toMatch(/direct deposit/);
    expect(by('me').keywords).toMatch(/w2/);
    expect(by('payroll').keywords).toMatch(/w2/);
  });

  it('staff keep the desk’s words', () => {
    const staff = roleNavLabels(MODULES.filter((m) => m.key === 'payroll'), 'HR_ADMINISTRATOR', t as never);
    expect(staff[0]!.label).toBe('Payroll');
    expect(staff[0]!.keywords).toBeUndefined();
  });

  it('Notifications sits beside Messages, not under My records', () => {
    const shape = navShapeFor(mods, 'ASSOCIATE', (k) => k);
    expect(shape.rows.map((m) => m.key)).toEqual(['messages', 'communications']);
    const records = shape.doors.find((d) => d.key === 'my-records');
    expect(records?.children.map((c) => c.key) ?? []).not.toContain('communications');
  });
});

describe('a Chicago shift read on a phone in LA names its zone once (ASSOC-7)', () => {
  it('“6:00 AM – 2:00 PM CDT”, never “CDT CDT”', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const { ShiftCard } = await import('@/pages/scheduling/ShiftCard');
    const shift = {
      id: '00000000-0000-4000-8000-000000000001',
      clientId: null,
      clientName: 'Coastal Resort',
      position: 'Stocker',
      startsAt: '2026-10-30T11:00:00.000Z',
      endsAt: '2026-10-30T19:00:00.000Z',
      location: null,
      locationId: null,
      locationName: 'Front Beach',
      timezone: 'America/Chicago',
      hourlyRate: null,
      payRate: null,
      status: 'ASSIGNED',
      scheduledMinutes: 480,
      acknowledgedAt: '2026-10-29T12:00:00.000Z',
    } as unknown as Shift;
    render(
      <I18nProvider>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <ShiftCard shift={shift} isNext={false} />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nProvider>,
    );
    const line = screen.getByText(/6:00 AM – 2:00 PM/);
    expect(line.textContent).toMatch(/CDT/);
    expect(line.textContent).not.toMatch(/CDT\s+CDT/);
  });
});

describe('the month grid is payroll’s week (ASSOC-6)', () => {
  it('Saturday-first headers and blanks', () => {
    expect(saturdayFirst(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])).toEqual(['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(leadingBlanks(new Date(2026, 10, 1))).toBe(1); // Sun Nov 1 → one blank (Sat)
    expect(leadingBlanks(new Date(2026, 9, 31))).toBe(0); // a Saturday starts the row
    expect(leadingBlanks(new Date(2026, 8, 1))).toBe(3); // Tue Sep 1
  });
});

describe('the earnings card (ASSOC-22, ASSOC-28, CODE-14)', () => {
  it('“1 open shift this week”, hours to two decimals, and today is the company’s day', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const { apiFetch } = await import('@/lib/api');
    const days = ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'].map((date) => ({
      date,
      workedMinutes: date === '2026-10-30' ? 0 : 0,
      workedAmount: date < '2026-10-29' ? 70 : 0,
      scheduledMinutes: 0,
      scheduledAmount: 0,
    }));
    vi.mocked(apiFetch).mockResolvedValue({
      weekStart: '2026-10-24T04:00:00.000Z',
      weekEnd: '2026-10-31T04:00:00.000Z',
      hourlyRate: 15,
      earnedSoFar: 351.45,
      workedHours: 23.43,
      projectedWeek: 351.45,
      remainingHours: 0,
      onClock: false,
      currentRatePerHour: 15,
      overtime: { thresholdHours: 40, multiplier: 1.5, unlocked: false, otHoursSoFar: 0, projectedOtHours: 0 },
      lastWeekEarned: 0,
      days,
      openShifts: { count: 1, estAmount: 93 },
      takeHome: null,
      timezone: 'America/New_York',
      period: null,
      todayShift: null,
    } as never);
    // Thu Oct 29, 5:30 PM Pacific = 8:30 PM in New York (still Thursday for
    // the company) = Fri 00:30 UTC: the UTC day put the glow on Friday.
    const now = new Date('2026-10-30T00:30:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const { EarningsCard } = await import('@/components/EarningsCard');
    render(
      <I18nProvider>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <EarningsCard />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText('1 open shift this week you qualify for · up to ~$93.00 more')).toBeInTheDocument();
    expect(screen.getByText(/23\.43h · \$15\.00\/hr/)).toBeInTheDocument();
    // The glowing bar is the company's Thursday, not UTC's Friday.
    const today = document.querySelector('.ring-gold\\/70')?.parentElement;
    expect(today?.getAttribute('title')).toMatch(/^2026-10-29/);
    vi.useRealTimers();
  });
});

describe('check your pay before payday (ASSOC-1)', () => {
  const preview = (over: Record<string, unknown>) => ({
    available: true, reason: null, payDate: '2026-10-30', opensOn: '2026-10-28', periodStart: '2026-10-10', periodEnd: '2026-10-23', source: 'ESTIMATE',
    days: [], earnings: [{ line: 'earning:REGULAR:0', kind: 'REGULAR', hours: 76.65, rate: 15, amount: 1149.75 }], gross: 1149.75,
    taxes: [{ line: 'tax:SOCIAL_SECURITY', kind: 'SOCIAL_SECURITY', amount: 71.28 }], deductions: [], paidAhead: 0, rides: null, net: 1078.47, check: null,
    ...over,
  });
  const renderCard = async (p: Record<string, unknown>) => {
    const { apiFetch } = await import('@/lib/api');
    vi.mocked(apiFetch).mockResolvedValue(p as never);
    const { PayPreviewCard } = await import('@/components/PayPreviewCard');
    render(
      <I18nProvider>
        <QueryClientProvider client={new QueryClient()}>
          <PayPreviewCard />
        </QueryClientProvider>
      </I18nProvider>,
    );
  };

  it('the van rides this check takes are their own line', async () => {
    await renderCard(preview({ deductions: [{ line: 'deduction:RIDES', kind: 'RIDES', amount: 40 }], rides: { owed: 40, taken: 40, held: 0, minimumWage: 7.25, state: 'TX' }, net: 1038.47 }));
    expect(await screen.findByText('Van rides')).toBeInTheDocument();
    expect(screen.getByText('−$40.00')).toBeInTheDocument();
    expect(screen.queryByTestId('pay-preview-rides-held')).not.toBeInTheDocument();
  });

  it('rides the minimum wage holds back are said, not silently left out', async () => {
    await renderCard(preview({ rides: { owed: 40, taken: 0, held: 40, minimumWage: 15, state: 'FL' } }));
    expect(await screen.findByTestId('pay-preview-rides-held')).toHaveTextContent('$40.00 in van rides isn’t taken from this check: your pay can’t go below the minimum wage ($15.00 an hour).');
  });
});
