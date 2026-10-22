import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AutoFillCandidate } from '@alto-people/shared';
import { AssignCandidateFacts } from '@/pages/scheduling/AssignCandidateFacts';

/**
 * Role walk, ops 7 — the Assign dialog's rows carry the facts a scheduler
 * decides on, and an older server (no facts) still gets a row.
 */

const base: AutoFillCandidate = {
  associateId: '22222222-2222-4222-8222-222222222222',
  associateName: 'Ana Lopez',
  weeklyMinutesScheduled: 32 * 60,
  weeklyMinutesActual: 0,
  matchesAvailability: true,
  noConflict: true,
  onApprovedTimeOff: false,
  score: 0.9,
};

afterEach(cleanup);

describe('<AssignCandidateFacts>', () => {
  it('shows home store, hours after this shift with the OT premium, cost, reliability, availability, site history and missing credentials', () => {
    render(
      <AssignCandidateFacts
        c={{
          ...base,
          homeLocationName: 'Front Beach',
          projectedWeeklyMinutes: 42 * 60,
          hourlyRateCents: 1800,
          shiftCostCents: 14400,
          otPremiumCents: 1800,
          reliability: { late: 2, noShow: 0, callOut: 1, days: 90 },
          availabilityLabel: 'Avail Mon–Fri 4:00 PM–11:00 PM',
          siteShiftsWorked: 4,
          distanceMiles: 3.2,
          credentials: { required: ['Food handler'], missing: ['Food handler'] },
        }}
      />,
    );
    const facts = screen.getByTestId('candidate-facts');
    expect(facts).toHaveTextContent('Front Beach');
    expect(facts).toHaveTextContent('32h → 42h this wk');
    expect(facts).toHaveTextContent('+$18.00 OT');
    expect(facts).toHaveTextContent('$144.00 this shift');
    expect(facts).toHaveTextContent('2 late · 0 no-shows · 1 call-out · 90d');
    expect(facts).toHaveTextContent('Avail Mon–Fri 4:00 PM–11:00 PM');
    expect(facts).toHaveTextContent('4 shifts here · 3.2 mi');
    expect(facts).toHaveTextContent('Missing: Food handler');
  });

  it("takes the server's overtime answer over the 40-hour line (a California 10-hour day under 40)", () => {
    render(
      <AssignCandidateFacts
        c={{ ...base, weeklyMinutesScheduled: 20 * 60, projectedWeeklyMinutes: 30 * 60, wouldBeOvertime: true, otMinutes: 120, otPremiumCents: 1800 }}
      />,
    );
    const facts = screen.getByTestId('candidate-facts');
    expect(facts).toHaveTextContent('20h → 30h this wk');
    expect(facts).toHaveTextContent('+$18.00 OT');
  });

  it('shows no overtime past 40 when the server says the shift adds none', () => {
    render(<AssignCandidateFacts c={{ ...base, projectedWeeklyMinutes: 42 * 60, wouldBeOvertime: false, otMinutes: 0, otPremiumCents: 0 }} />);
    const facts = screen.getByTestId('candidate-facts');
    expect(facts).toHaveTextContent('32h → 42h this wk');
    expect(facts).not.toHaveTextContent('OT');
  });

  it('renders only the hours line when the server sent no facts', () => {
    render(<AssignCandidateFacts c={base} />);
    const facts = screen.getByTestId('candidate-facts');
    expect(facts).toHaveTextContent('32h this wk');
    expect(facts).not.toHaveTextContent('Missing');
    expect(facts).not.toHaveTextContent('OT');
  });
});
