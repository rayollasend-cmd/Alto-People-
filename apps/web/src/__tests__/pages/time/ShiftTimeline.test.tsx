import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TimeEntry } from '@alto-people/shared';
import { ShiftTimeline } from '@/pages/time/ShiftTimeline';

// Fixed-zone entries so assertions don't depend on the test runner's clock
// zone: the entry carries its own site timezone and the component renders
// site-local wall time.
const TZ = 'America/New_York';

function entryWith(over: Partial<TimeEntry>): TimeEntry {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    associateId: '00000000-0000-4000-8000-000000000002',
    associateName: 'Maria Lopez',
    clientId: null,
    clientName: null,
    clockInAt: '2026-07-28T08:00:00.000Z', // 4:00 AM EDT
    clockOutAt: '2026-07-28T17:00:00.000Z', // 1:00 PM EDT
    status: 'COMPLETED',
    notes: null,
    rejectionReason: null,
    approvedById: null,
    approverEmail: null,
    approvedAt: null,
    minutesElapsed: 540,
    netMinutes: 510,
    locationTimezone: TZ,
    breaks: [
      {
        id: '00000000-0000-4000-8000-000000000003',
        type: 'MEAL',
        startedAt: '2026-07-28T13:00:00.000Z', // 9:00 AM EDT
        endedAt: '2026-07-28T13:30:00.000Z', // 9:30 AM EDT
        minutes: 30,
      },
    ],
    ...over,
  };
}

describe('<ShiftTimeline>', () => {
  it('tells the shift chronologically: in → out for break → back → out', () => {
    render(<ShiftTimeline entry={entryWith({})} />);

    const labels = screen
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(labels[0]).toContain('Clocked in');
    expect(labels[1]).toContain('Out for meal break');
    expect(labels[1]).toContain('Back from break');
    expect(labels[2]).toContain('Clocked out');
  });

  it('shows the totals as one plain-English equation', () => {
    render(<ShiftTimeline entry={entryWith({})} />);
    const card = screen.getByText(/on site/).textContent ?? '';
    expect(card).toContain('9h 00m on site');
    expect(card).toContain('30m break');
    expect(card).toContain('8h 30m paid');
  });

  it('marks a next-day clock-out with +1d', () => {
    render(
      <ShiftTimeline
        entry={entryWith({
          clockInAt: '2026-07-28T20:00:00.000Z', // 4:00 PM EDT
          clockOutAt: '2026-07-29T04:30:00.000Z', // 12:30 AM EDT next day
          minutesElapsed: 510,
          netMinutes: 510,
          breaks: [],
        })}
      />,
    );
    expect(screen.getAllByText(/\+1d/).length).toBeGreaterThan(0);
  });

  it('renders an active entry as still on the clock', () => {
    render(
      <ShiftTimeline
        entry={entryWith({
          status: 'ACTIVE',
          clockOutAt: null,
          minutesElapsed: 120,
          netMinutes: 120,
          breaks: [],
        })}
      />,
    );
    expect(screen.getByText(/still on the clock/i)).toBeInTheDocument();
    expect(screen.getByText(/2h 00m elapsed/)).toBeInTheDocument();
  });

  it('flags an open break instead of pretending it ended', () => {
    render(
      <ShiftTimeline
        entry={entryWith({
          status: 'ACTIVE',
          clockOutAt: null,
          minutesElapsed: 360,
          netMinutes: 330,
          breaks: [
            {
              id: '00000000-0000-4000-8000-000000000004',
              type: 'REST',
              startedAt: '2026-07-28T13:30:00.000Z',
              endedAt: null,
              minutes: 30,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/out for rest break/i)).toBeInTheDocument();
    expect(screen.getByText(/still on break/i)).toBeInTheDocument();
  });
});
