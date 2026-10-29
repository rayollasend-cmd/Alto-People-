import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ShiftPreview } from '@/pages/ops/OpsRunner';
import { setDisplayTimeZone } from '@/lib/format';
import { storeTime } from '@/pages/scheduling/viewerSites';

afterEach(() => setDisplayTimeZone(null));

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

  it('reads the crew’s times on the store’s clock, naming the zone only for a viewer elsewhere (FLOOR-20)', () => {
    const preview = {
      dateKey: '2026-10-29',
      timezone: 'America/Chicago',
      myShift: null,
      handover: [],
      sops: [],
      // 11:00Z = 6:00 AM in Chicago, 4:00 AM in Los Angeles.
      crew: [{ id: 's1', name: 'Tyler Alvarez', position: 'Cashier', startsAt: '2026-10-29T11:00:00.000Z', endsAt: '2026-10-29T19:00:00.000Z' }],
    };
    setDisplayTimeZone('America/Los_Angeles');
    const { unmount } = render(<ShiftPreview preview={preview} />);
    expect(screen.getByText(/^Cashier · 6:00\sAM CDT$/)).toBeInTheDocument();
    unmount();
    setDisplayTimeZone('America/Chicago');
    render(<ShiftPreview preview={preview} />);
    expect(screen.getByText(/^Cashier · 6:00\sAM$/)).toBeInTheDocument();
  });
});

describe('storeTime', () => {
  it('is the store’s wall clock, with the zone when the viewer’s differs', () => {
    setDisplayTimeZone('America/Los_Angeles');
    expect(storeTime('2026-10-29T04:00:00.000Z', 'America/Chicago')).toMatch(/^11:00\sPM CDT$/);
    expect(storeTime('2026-10-29T04:00:00.000Z', 'America/Los_Angeles')).toMatch(/^9:00\sPM$/);
  });
});

