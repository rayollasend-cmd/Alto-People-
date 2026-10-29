import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../pages/hrPack/harness';
import type { CrewCard } from '@/lib/crewApi';

/**
 * FLOOR-17 — the shift supervisor's crew card. She leads the crew but
 * can't open People; tapping a face or a name opens a read-only card with
 * contact, availability, certifications, attendance, next shifts and the
 * emergency contact — and never pay.
 */

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: api.apiFetch }));

import { CrewFaces, CrewLink } from '@/components/floor/CrewCard';

const card: CrewCard = {
  id: 'a1',
  firstName: 'Ana',
  lastName: 'Lopez',
  name: 'Ana Lopez',
  hasPhoto: false,
  position: 'Cashier',
  hireDate: '2025-03-01',
  contact: { phone: '+1 850 555 0100', email: 'ana.lopez@example.com', messageUserId: 'u-ana' },
  sites: [{ id: 's1', name: 'Front Beach 218', timezone: 'America/Chicago' }],
  onClock: null,
  nextShifts: [
    { id: 'sh1', startsAt: '2026-11-02T11:00:00.000Z', endsAt: '2026-11-02T19:00:00.000Z', position: 'Cashier', siteName: 'Front Beach 218', timezone: 'America/Chicago' },
  ],
  availability: {
    weekly: [{ dayOfWeek: 1, startMinute: 360, endMinute: 840 }],
    unavailableDates: ['2026-11-05'],
    timeOff: [{ from: '2026-11-10', to: '2026-11-12' }],
  },
  credentials: [
    { id: 'c1', name: 'Forklift', isCert: true, acquiredOn: null, expiresOn: '2026-10-20', status: 'expired' },
    { id: 'c2', name: 'Food handler', isCert: true, acquiredOn: null, expiresOn: '2027-12-01', status: 'valid' },
  ],
  attendance: {
    points: 1.5,
    windowDays: 90,
    late: 1,
    earlyOut: 0,
    callOuts: 1,
    noShows: 0,
    recent: [
      { id: 'e1', kind: 'LATE', on: '2026-10-26', excused: false },
      { id: 'e2', kind: 'CALL_OUT', on: '2026-10-19', excused: true },
    ],
  },
  emergencyContact: { name: 'Rosa Lopez', relation: 'PARENT', phone: '+1 850 555 0199' },
  today: '2026-10-29',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.apiFetch.mockImplementation((path: string) => (path === '/crew/a1' ? Promise.resolve(card) : Promise.reject(new Error(`unexpected ${path}`))));
});

describe('the crew card', () => {
  it('a shift supervisor taps a name and reads contact, availability, certifications, attendance and the emergency contact', async () => {
    const user = userEvent.setup();
    renderAs('SHIFT_SUPERVISOR', <CrewLink associateId="a1" name="Ana Lopez">Ana Lopez</CrewLink>);
    await user.click(screen.getByRole('button', { name: 'Open Ana Lopez’s crew card' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.apiFetch).toHaveBeenCalledWith('/crew/a1');

    expect(await within(dialog).findByRole('link', { name: 'Call Ana' })).toHaveAttribute('href', 'tel:+18505550100');
    expect(within(dialog).getByRole('link', { name: 'Text Ana' })).toHaveAttribute('href', 'sms:+1 850 555 0100');
    expect(within(dialog).getByRole('link', { name: 'Message Ana' })).toHaveAttribute('href', '/messages?to=u-ana');
    expect(within(dialog).getByText('(850) 555-0100', { exact: false })).toBeInTheDocument();

    const avail = within(dialog).getByTestId('crew-availability');
    expect(avail).toHaveTextContent('Mon');
    expect(avail).toHaveTextContent('6:00 AM – 2:00 PM');
    expect(avail).toHaveTextContent('Can’t work Nov 5');
    expect(avail).toHaveTextContent('Off Nov 10 – 12, 2026');

    const creds = within(dialog).getByTestId('crew-credentials');
    expect(creds).toHaveTextContent('Forklift');
    expect(creds).toHaveTextContent('Expired Oct 20');
    expect(creds).toHaveTextContent('Food handler');

    const att = within(dialog).getByTestId('crew-attendance');
    expect(att).toHaveTextContent('1.5 points in the last 90 days');
    expect(att).toHaveTextContent('1 late · 1 call-out');
    expect(att).toHaveTextContent('Called out');
    expect(att).toHaveTextContent('excused');

    const ec = within(dialog).getByTestId('crew-emergency');
    expect(ec).toHaveTextContent('Rosa Lopez');
    expect(ec).toHaveTextContent('Parent');
    expect(within(ec).getByRole('link', { name: 'Call Rosa Lopez' })).toHaveAttribute('href', 'tel:+18505550199');

    expect(within(dialog).getByTestId('crew-shifts')).toHaveTextContent('Front Beach 218');
    // Never pay — and no record link for a role that can't open People.
    expect(dialog).not.toHaveTextContent(/\$|pay rate|hourly|wage/i);
    expect(within(dialog).queryByRole('link', { name: /full record/i })).toBeNull();
    expect(dialog).toHaveTextContent('Read-only. Pay and personal records stay with HR.');
  });

  it('an office lead who can open People also gets the full record link', async () => {
    const user = userEvent.setup();
    renderAs('OPERATIONS_MANAGER', <CrewLink associateId="a1" name="Ana Lopez">Ana Lopez</CrewLink>);
    await user.click(screen.getByRole('button', { name: 'Open Ana Lopez’s crew card' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('link', { name: /Open full record/ })).toHaveAttribute('href', '/people/a1');
  });

  it('a role without crew cards sees the plain name — no button, no request', () => {
    renderAs('CLIENT_PORTAL', <CrewLink associateId="a1" name="Ana Lopez">Ana Lopez</CrewLink>);
    expect(screen.getByText('Ana Lopez')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(api.apiFetch).not.toHaveBeenCalled();
  });

  it('the hero faces open a crew card each; a watch-only floor supervisor keeps the one link to the floor', async () => {
    const people = Array.from({ length: 10 }, (_, i) => ({ associateId: i === 0 ? 'a1' : `p${i}`, name: i === 0 ? 'Ana Lopez' : `Person ${i}` }));
    const user = userEvent.setup();
    const { unmount } = renderAs('SHIFT_SUPERVISOR', <CrewFaces people={people} moreTo="/today" />);
    expect(screen.getAllByRole('button', { name: /crew card/ })).toHaveLength(8);
    expect(screen.getByRole('link', { name: 'See everyone on the floor' })).toHaveAttribute('href', '/today');
    await user.click(screen.getByRole('button', { name: 'Open Ana Lopez’s crew card' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    unmount();

    renderAs('FLOOR_SUPERVISOR', <CrewFaces people={people} moreTo="/today" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'Who is in' })).toHaveAttribute('href', '/today');
  });
});
