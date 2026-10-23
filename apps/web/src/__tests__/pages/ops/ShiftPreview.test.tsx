import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ShiftPreview } from '@/pages/ops/OpsRunner';

/** F500 G2 — before clock-in, "My shift" shows what the shift will need. */
describe('ShiftPreview', () => {
  it('lists the open handover notes, the checklists with item counts and the crew, capped with "+N more"', () => {
    const crew = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      name: `Person ${i}`,
      position: 'Stocker',
      startsAt: '2026-10-22T19:00:00.000Z',
      endsAt: '2026-10-23T03:00:00.000Z',
    }));
    render(
      <ShiftPreview
        preview={{
          dateKey: '2026-10-22',
          timezone: 'America/Chicago',
          myShift: { startsAt: '2026-10-22T19:00:00.000Z', endsAt: '2026-10-23T03:00:00.000Z', position: 'Shift Supervisor', store: 'Front Beach 218' },
          handover: [{ id: 'h1', kind: 'NOTE', body: 'Cooler 3 door sticks', priority: 'HIGH', at: '2026-10-22T15:00:00.000Z', department: 'Frozen & Dairy', period: 'MORNING' }],
          sops: [
            { templateId: 't1', name: 'Swing Standard', department: 'F&D', window: 'Swing', store: 'Front Beach 218', items: 25 },
            { templateId: 't2', name: 'Close-out', department: 'GM', window: 'Close', store: 'Front Beach 218', items: 1 },
          ],
          crew,
        }}
      />,
    );
    const root = screen.getByTestId('ops-shift-preview');
    expect(root).toHaveTextContent(/Your shift: Shift Supervisor · .*–.* · Front Beach 218/);
    expect(within(root).getByText('Cooler 3 door sticks')).toBeInTheDocument();
    expect(within(root).getByText('25 items')).toBeInTheDocument();
    expect(within(root).getByText('1 item')).toBeInTheDocument();
    expect(within(root).getByText('Person 7')).toBeInTheDocument();
    expect(within(root).queryByText('Person 8')).not.toBeInTheDocument();
    expect(within(root).getByText('+2 more')).toBeInTheDocument();
  });

  it('says plainly when there is nothing to show', () => {
    render(<ShiftPreview preview={{ dateKey: '2026-10-22', timezone: 'America/Chicago', myShift: null, handover: [], sops: [], crew: [] }} />);
    expect(screen.getByText('No open notes from the last shift.')).toBeInTheDocument();
    expect(screen.getByText('No checklist is set for the shifts you lead yet.')).toBeInTheDocument();
    expect(screen.getByText('No one else is scheduled here today.')).toBeInTheDocument();
  });
});
