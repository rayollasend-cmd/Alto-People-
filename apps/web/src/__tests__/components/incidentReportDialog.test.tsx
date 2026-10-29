import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/floorApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/floorApi')>()),
  reportIncident: vi.fn().mockResolvedValue({ id: 'inc-1', isRecordable: true, photo: false }),
}));

import { reportIncident as reportIncidentMock } from '@/lib/floorApi';
import { IncidentReportDialog, occurredAtFromInput } from '@/components/floor/IncidentReportDialog';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderDialog(timeZone: string | null = 'America/Chicago') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <IncidentReportDialog open onOpenChange={() => {}} timeZone={timeZone} />
    </QueryClientProvider>,
  );
}

describe('Report an incident — when did it happen? (FLOOR-10)', () => {
  it('reads the time on the store’s clock and refuses the future', () => {
    const now = new Date('2026-10-29T05:30:00.000Z'); // 12:30 AM in Chicago, 10:30 PM the evening before in Los Angeles
    expect(occurredAtFromInput('2026-10-28T23:45', 'America/Chicago', now)).toEqual({ iso: '2026-10-29T04:45:00.000Z', future: false });
    expect(occurredAtFromInput('2026-10-29T01:00', 'America/Chicago', now)?.future).toBe(true);
    // Typed a few seconds after the minute it is: still now, not the future.
    expect(occurredAtFromInput('2026-10-29T00:30', 'America/Chicago', new Date('2026-10-29T05:30:40.000Z'))?.future).toBe(false);
    expect(occurredAtFromInput('', 'America/Chicago', now)).toBeNull();
  });

  it('defaults to now, and sends when it happened with the report', async () => {
    const user = userEvent.setup();
    renderDialog();
    const when = screen.getByLabelText(/When did it happen\?/) as HTMLInputElement;
    expect(when.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(screen.getByText(/^Store time \(CDT|^Store time \(CST/)).toBeInTheDocument();
    // An hour earlier, on the store's clock.
    const earlier = new Date(Date.now() - 3_600_000);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(earlier);
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    const value = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    await user.clear(when);
    await user.type(when, value);
    await user.type(screen.getByLabelText(/What happened/), 'Slipped on the dock, landed on the right wrist.');
    await user.click(screen.getByRole('button', { name: 'File incident' }));
    await waitFor(() => expect(reportIncidentMock).toHaveBeenCalled());
    const sent = vi.mocked(reportIncidentMock).mock.calls[0]![0];
    expect(sent.nearMiss).toBe(false);
    expect(Math.abs(Date.parse(sent.occurredAt!) - earlier.getTime())).toBeLessThan(60_000);
  });

  it('a time in the future says so and the report can’t be filed', async () => {
    const user = userEvent.setup();
    renderDialog(null);
    const when = screen.getByLabelText(/When did it happen\?/) as HTMLInputElement;
    await user.clear(when);
    await user.type(when, '2099-01-01T09:00');
    await user.type(screen.getByLabelText(/What happened/), 'Wet floor by dock 3, no sign out.');
    expect(screen.getByText(/hasn’t happened yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'File incident' })).toBeDisabled();
  });
});

describe('reportIncident', () => {
  it('sends the near-miss flag only when it is one — the API reads "false" as true', async () => {
    const { reportIncident } = await vi.importActual<typeof import('@/lib/floorApi')>('@/lib/floorApi');
    const bodies: FormData[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: FormData }) => {
        bodies.push(init.body);
        return new Response(JSON.stringify({ id: 'x', isRecordable: true, photo: false }), { status: 201 });
      }),
    );
    await reportIncident({ description: 'Slipped on the dock.', severity: 'MEDICAL_TREATMENT', nearMiss: false, occurredAt: '2026-10-29T04:45:00.000Z' });
    await reportIncident({ description: 'Wet floor by dock 3.', severity: 'FIRST_AID', nearMiss: true });
    expect(bodies[0]!.has('nearMiss')).toBe(false);
    expect(bodies[0]!.get('occurredAt')).toBe('2026-10-29T04:45:00.000Z');
    expect(bodies[1]!.get('nearMiss')).toBe('true');
  });
});
