import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TimeEntry } from '@alto-people/shared';
import { TimesheetWeeks } from '@/pages/time/TimesheetWeeks';

/**
 * Audit 2026-10-21 #11 — the week's overtime on the shared timesheet shell
 * (admin focus mode and the associate's history) is the server's split:
 * each entry's share of the labor rules the paycheck pays. It used to be
 * `week net − 40h` here, which missed daily overtime and hours worked for
 * another client the page hadn't loaded.
 */

const base = (over: Partial<TimeEntry>): TimeEntry =>
  ({
    id: 'e1',
    associateId: 'a',
    associateName: 'Ana Ruiz',
    clientId: null,
    clientName: null,
    clockInAt: '2026-09-14T13:00:00.000Z',
    clockOutAt: '2026-09-14T23:00:00.000Z',
    status: 'APPROVED',
    notes: null,
    rejectionReason: null,
    approvedById: null,
    approverEmail: null,
    approvedAt: null,
    minutesElapsed: 600,
    netMinutes: 600,
    ...over,
  }) as TimeEntry;

const split = (reg: number, ot: number, dt = 0) => ({ regularMinutes: reg, overtimeMinutes: ot, doubleTimeMinutes: dt, overtimeMultiplier: 1.5, doubleMultiplier: 2 });

describe('<TimesheetWeeks> overtime', () => {
  it('shows the server’s overtime and double time for the week, though the week is under 40 hours', () => {
    render(
      <TimesheetWeeks
        entries={[
          base({ id: 'mon', hours: split(480, 120) }),
          base({ id: 'tue', clockInAt: '2026-09-15T12:00:00.000Z', clockOutAt: '2026-09-16T01:00:00.000Z', minutesElapsed: 780, netMinutes: 780, hours: split(480, 240, 60) }),
        ]}
        renderEntry={(e) => <span>{e.id}</span>}
      />,
    );
    expect(screen.getByText('6.00h OT')).toBeInTheDocument();
    expect(screen.getByText('1.00h double time')).toBeInTheDocument();
  });

  it('never subtracts 40 itself: no split from the server, no overtime badge', () => {
    render(
      <TimesheetWeeks
        entries={Array.from({ length: 5 }, (_, i) =>
          base({ id: `d${i}`, clockInAt: `2026-09-1${4 + i}T12:00:00.000Z`, clockOutAt: `2026-09-1${4 + i}T21:00:00.000Z`, minutesElapsed: 540, netMinutes: 540 }),
        )}
        renderEntry={(e) => <span>{e.id}</span>}
      />,
    );
    expect(screen.queryByText(/OT$/)).not.toBeInTheDocument();
  });

  it('a rejected entry’s share never counts', () => {
    render(
      <TimesheetWeeks
        entries={[base({ id: 'r', status: 'REJECTED', hours: split(480, 120) })]}
        renderEntry={(e) => <span>{e.id}</span>}
      />,
    );
    expect(screen.queryByText(/OT$/)).not.toBeInTheDocument();
  });
});
