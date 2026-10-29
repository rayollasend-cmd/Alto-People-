import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DriverToday } from '@/lib/transportApi';
import { renderAs } from '../hrPack/harness';

/**
 * The driver's pay, Uber-style but honest: a pill in drive mode's header
 * ("Today $86 · Week $412", whole dollars) that ticks while they're on the
 * clock and opens the pay sheet — this shift live, the week and its pace,
 * hours worked against hours driving, the rate (or "ask payroll"),
 * overtime only as the engine counts it, take-home when the answer has
 * it, the payday, and the week by day under the sparse rule. The time
 * clock sits beside the pill, quiet.
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { DriveHeader } from '@/pages/transport/driver/DriveHeader';
import { livePay, payFrom } from '@/pages/transport/driver/driverPay';

const TODAY = '2026-10-28';
const week = (amounts: number[]) =>
  ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'].map((date, i) => ({
    date,
    workedMinutes: Math.round(((amounts[i] ?? 0) / 18) * 60),
    workedAmount: amounts[i] ?? 0,
    scheduledMinutes: 0,
    scheduledAmount: 0,
  }));

type Earnings = NonNullable<DriverToday['earnings']> & Record<string, unknown>;

function day(earnings: Partial<Earnings> | null, over: Partial<DriverToday> = {}): DriverToday {
  return {
    date: TODAY,
    associateId: 'a-mike',
    runs: { total: 4, done: 2, active: 0 },
    hours: { worked: 4.8, driven: 3.25, onClock: false },
    shifts: [{ id: 'sh1', startsAt: '2026-10-28T11:00:00.000Z', endsAt: '2026-10-28T19:00:00.000Z', status: 'ASSIGNED', today: true }],
    earnings:
      earnings === null
        ? null
        : ({
            hourlyRate: 18,
            earnedSoFar: 412.1,
            workedHours: 22.9,
            projectedWeek: 612,
            currentShiftEarned: null,
            onClock: false,
            weekStart: '2026-10-24',
            weekEnd: '2026-10-30',
            ...earnings,
          } as Earnings),
    credentials: null,
    hoursOfService: { maxPerDay: 10, minRest: 8 },
    preTripRequired: true,
    ...over,
  } as DriverToday;
}

function routes(today: DriverToday, extra: (path: string, init?: { method?: string }) => unknown = () => undefined) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string }) => {
    const out = extra(path, init);
    if (out !== undefined) return out as never;
    if (path === '/transport/driver/today') return today as never;
    if (path === '/transport/driver/time') return { entries: [{ id: 'e1', clockInAt: new Date(Date.now() - 130 * 60_000).toISOString(), clockOutAt: null, status: 'ACTIVE', hours: null }] } as never;
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
  });
}

const counts = { total: 4, done: 2, riders: 15 };

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the pay model', () => {
  it('reads the engine’s figures, and on the clock they move at the rate', () => {
    const base = payFrom(day({ onClock: true, currentShiftEarned: 40, days: week([0, 0, 120, 140, 86.4]) } as Partial<Earnings>, { hours: { worked: 4.8, driven: 3.25, onClock: true } }))!;
    expect(base).toMatchObject({ today: 86.4, week: 412.1, shift: 40, rate: 18, onClock: true });
    const later = livePay(base, 0, 3_600_000 / 2);
    expect(later.today).toBeCloseTo(95.4);
    expect(later.week).toBeCloseTo(421.1);
    expect(later.shift).toBeCloseTo(49);
    // Off the clock nothing moves.
    const off = payFrom(day({}))!;
    expect(livePay(off, 0, 3_600_000)).toEqual(off);
    // No days in the answer: today is today's hours at the rate.
    expect(off.today).toBeCloseTo(86.4);
    expect(payFrom(day(null))).toBeNull();
  });
});

describe('the pay pill and the clock', () => {
  it('rounds to whole dollars and ticks while on the clock', async () => {
    // $3,600 an hour: a dollar a second, so the whole-dollar pill moves within a tick.
    routes(day({ hourlyRate: 3600, onClock: true, currentShiftEarned: 10, earnedSoFar: 100.4, days: week([0, 0, 0, 0, 50.4]) } as Partial<Earnings>, { hours: { worked: 1, driven: 0.5, onClock: true } }));
    renderAs('DRIVER', <DriveHeader counts={counts} />);
    const pill = await screen.findByTestId('pay-pill');
    expect(pill).toHaveTextContent(/Today \$5[0-1] · Week \$10[0-1]/);
    await waitFor(() => expect(pill).toHaveTextContent(/Today \$5[2-9] · Week \$10[2-9]/), { timeout: 4000 });
    expect(screen.getByTestId('day-line')).toHaveTextContent('Today: 2 of 4 runs done · 15 riders');
    // The time on the clock rides in the button's name (the sheet says it in full).
    const clock = await screen.findByRole('button', { name: /^Clock out — On the clock · 2h 1\dm$/ });
    expect(clock).not.toHaveClass('btn-gold');
  });

  it('off the clock: the pill holds still, and Clock in is a quiet button', async () => {
    const posted: string[] = [];
    routes(day({}), (path, init) => {
      if (path === '/transport/driver/clock-in' && init?.method === 'POST') {
        posted.push(path);
        return { entry: { id: 'e2', clockInAt: new Date().toISOString() } };
      }
    });
    renderAs('DRIVER', <DriveHeader counts={counts} />);
    expect(await screen.findByTestId('pay-pill')).toHaveTextContent('Today $86 · Week $412');
    const clockIn = screen.getByRole('button', { name: /Clock in/ });
    expect(clockIn).not.toHaveClass('btn-gold');
    await userEvent.click(clockIn);
    await waitFor(() => expect(posted).toEqual(['/transport/driver/clock-in']));
  });

  it('a login with no person record: no pay, and why', async () => {
    routes(day(null, { associateId: null }));
    renderAs('DRIVER', <DriveHeader counts={counts} />);
    expect(await screen.findByText(/isn’t linked to a person record/)).toBeInTheDocument();
    expect(screen.queryByTestId('pay-pill')).toBeNull();
    expect(screen.queryByRole('button', { name: /Clock in/ })).toBeNull();
  });
});

describe('the pay sheet', () => {
  const open = async () => {
    await userEvent.click(await screen.findByTestId('pay-pill'));
    return screen.findByRole('dialog', { name: 'Your pay' });
  };

  it('on the clock: this shift live, the week and its pace, hours, the rate, overtime as counted, take-home, the payday', async () => {
    routes(
      day(
        {
          onClock: true,
          currentShiftEarned: 40.25,
          days: week([0, 0, 120, 140, 86.4]),
          overtime: { thresholdHours: 40, multiplier: 1.5, unlocked: false, otHoursSoFar: 0, projectedOtHours: 0 },
          takeHome: { gross: 412.1, taxes: 52.1, deductions: 10, advances: 0, net: 350, basis: 'W4' },
        } as Partial<Earnings>,
        { hours: { worked: 4.8, driven: 3.25, onClock: true }, nextPayday: { payDate: '2026-11-06', periodStart: '2026-10-17', periodEnd: '2026-10-30' } },
      ),
    );
    renderAs('DRIVER', <DriveHeader counts={counts} />);
    const sheet = await open();
    expect(sheet).toHaveTextContent('Drivers are paid by the hour on the clock — not per ride.');
    expect(within(sheet).getByTestId('pay-shift')).toHaveTextContent(/This shift so far\$40\.2\d/);
    expect(within(sheet).getByTestId('pay-shift')).toHaveTextContent(/On the clock since/);
    expect(within(sheet).getByTestId('pay-week')).toHaveTextContent(/\$412\.\d\d/);
    expect(sheet).toHaveTextContent(/On pace for \$612\.00 by Friday, Oct 30/);
    expect(sheet).toHaveTextContent('About $350.00 after taxes and deductions');
    expect(within(sheet).getByTestId('pay-payday')).toHaveTextContent('Paid Friday, Nov 6');
    expect(sheet).toHaveTextContent(/Hourly rate\$18\.00/);
    expect(sheet).toHaveTextContent(/Driving today3\.25h/);
    expect(within(sheet).getByTestId('pay-overtime')).toHaveTextContent('Overtime starts after 40 hours this week');
    expect(sheet).not.toHaveTextContent(/every hour now pays/);
    // Three days worked: a number and a sentence, not a near-empty chart.
    expect(within(sheet).getByTestId('trend-sparse')).toHaveTextContent('3 days worked so far — the bars start at 4.');
  });

  it('off the clock, with no overtime figure in the answer: no shift number and no overtime line', async () => {
    routes(day({}));
    renderAs('DRIVER', <DriveHeader counts={counts} />);
    const sheet = await open();
    expect(within(sheet).getByTestId('pay-shift')).toHaveTextContent('Off the clock');
    expect(within(sheet).getByTestId('pay-shift')).not.toHaveTextContent('$');
    expect(within(sheet).getByTestId('pay-week')).toHaveTextContent('$412.10');
    expect(within(sheet).queryByTestId('pay-overtime')).toBeNull();
    expect(within(sheet).queryByTestId('pay-payday')).toBeNull();
    // Today's driver shift and the latest punches sit with the pay.
    expect(within(sheet).getByTestId('today-shift')).not.toHaveTextContent('No driver shift today');
  });

  it('overtime the engine says is unlocked, said once and plainly', async () => {
    routes(day({ overtime: { thresholdHours: 40, multiplier: 1.5, unlocked: true, otHoursSoFar: 2, projectedOtHours: 4 }, currentRatePerHour: 27 } as Partial<Earnings>));
    renderAs('DRIVER', <DriveHeader counts={counts} />);
    const sheet = await open();
    expect(within(sheet).getByTestId('pay-overtime')).toHaveTextContent('Past 40 hours this week — every hour now pays $27.00.');
  });

  it('no rate on file: ask payroll, and no dollar figures', async () => {
    routes(day({ hourlyRate: 0, earnedSoFar: 0, projectedWeek: 0 }));
    renderAs('DRIVER', <DriveHeader counts={counts} />);
    expect(await screen.findByTestId('pay-pill')).toHaveTextContent('Pay and hours');
    const sheet = await open();
    expect(sheet).toHaveTextContent('ask payroll to set your rate');
    expect(within(sheet).queryByTestId('pay-week')).toBeNull();
  });

  it('a full week draws the bars', async () => {
    routes(day({ days: week([80, 90, 120, 140, 86.4]) } as Partial<Earnings>));
    renderAs('DRIVER', <DriveHeader counts={counts} />);
    const sheet = await open();
    expect(within(sheet).getByRole('heading', { name: 'Your week, day by day' })).toBeInTheDocument();
    expect(within(sheet).getByRole('img', { name: '5 days worked this week, $412.10 so far.' })).toBeInTheDocument();
    expect(within(sheet).queryByTestId('trend-sparse')).toBeNull();
  });
});
