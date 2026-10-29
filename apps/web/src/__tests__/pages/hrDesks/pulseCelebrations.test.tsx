import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';
import { ymdLocal } from '@/lib/format';

vi.mock('@/lib/pulseSurveys109Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/pulseSurveys109Api')>()),
  listPulseSurveys: vi.fn(),
  listMyOpenSurveys: vi.fn(),
  getPulseSummary: vi.fn(),
}));
vi.mock('@/lib/celebrations107Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/celebrations107Api')>()),
  listUpcomingCelebrations: vi.fn(),
}));

import { getPulseSummary, listMyOpenSurveys, listPulseSurveys } from '@/lib/pulseSurveys109Api';
import { listUpcomingCelebrations, type CelebrationItem } from '@/lib/celebrations107Api';
import { PulseHome } from '@/pages/pulse/PulseHome';
import { CelebrationsHome, bucketize } from '@/pages/celebrations/CelebrationsHome';

/**
 * Pulse opens whoever runs surveys on the results (score, response rate,
 * trend), and an associate on theirs with no one-tab tab bar. Celebrations
 * is one dated list, today first, with this week counted.
 */

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPulseSurveys).mockResolvedValue({ surveys: [] });
  vi.mocked(listMyOpenSurveys).mockResolvedValue({ surveys: [] });
  vi.mocked(getPulseSummary).mockResolvedValue({
    latest: { id: 's2', question: 'How was October?', scale: 'SCORE_1_5', isOpen: true, openUntil: '2026-10-25T00:00:00.000Z', responses: 19, audience: 50, responseRate: 38, score: 4.2, previousScore: 3.9 },
    trend: [
      { id: 's1', openFrom: '2026-09-01T00:00:00.000Z', responses: 20, score: 3.9 },
      { id: 's2', openFrom: '2026-10-20T00:00:00.000Z', responses: 19, score: 4.2 },
    ],
    openNow: 1,
  });
});

describe('Pulse', () => {
  it('lands an HR admin on the results: the latest score, response rate and what is open', async () => {
    renderAs('HR_ADMINISTRATOR', <PulseHome />, '/pulse');
    const strip = await screen.findByRole('group', { name: 'Latest pulse' });
    expect(within(strip).getByText('4.2 / 5')).toBeInTheDocument();
    expect(within(strip).getByText('How was October?')).toBeInTheDocument();
    expect(within(strip).getByText('38%')).toBeInTheDocument();
    expect(within(strip).getByText('19 of 50 people it went to · still open')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Surveys/, selected: true })).toBeInTheDocument();
  });

  it('gives an associate their surveys with no tab bar of one tab', async () => {
    renderAs('ASSOCIATE', <PulseHome />, '/pulse', { associateId: 'a1' });
    await waitFor(() => expect(listMyOpenSurveys).toHaveBeenCalled());
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(getPulseSummary).not.toHaveBeenCalled();
  });
});

describe('Celebrations', () => {
  it('puts today first and counts this week', async () => {
    // A Saturday — the first day of the company's workweek — so +3 and +5
    // are this week (Sat → Fri) whatever day the suite runs.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 24, 12) });
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return ymdLocal(d);
    };
    const item = (name: string, kind: 'BIRTHDAY' | 'ANNIVERSARY', offset: number, years: number | null = null): CelebrationItem =>
      ({ associateId: name, associateName: name, email: `${name}@example.com`, kind, date: day(offset), years, clientId: null, clientName: null, locationId: null, siteName: null }) as CelebrationItem;
    vi.mocked(listUpcomingCelebrations).mockResolvedValue({
      items: [item('Cy Later', 'BIRTHDAY', 20), item('Ben Soon', 'ANNIVERSARY', 3, 3), item('Ana Today', 'BIRTHDAY', 0), item('Dee Soon', 'BIRTHDAY', 5)],
    } as never);
    renderAs('HR_ADMINISTRATOR', <CelebrationsHome />, '/celebrations');
    expect(await screen.findByTestId('celebrations-week')).toHaveTextContent('This week: 2 birthdays · 1 anniversary');
    const sections = screen.getAllByRole('region');
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['Today', 'This week', 'This month']);
    expect(within(sections[0]!).getByText('Ana Today')).toBeInTheDocument();
    expect(within(sections[1]!).getByText('3 years')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Send a note to/ })).toHaveLength(4);
    vi.useRealTimers();
  });

  it('"This week" is the company’s workweek, Saturday → Friday — not a rolling seven days (FLOOR-24)', () => {
    const item = (name: string, date: string) =>
      ({ associateId: name, associateName: name, email: '', kind: 'BIRTHDAY', date, years: null, clientId: null, clientName: null, locationId: null, siteName: null }) as CelebrationItem;
    // Thursday Oct 29, 2026: the week ends Friday Oct 30.
    const b = bucketize([item('Fri', '2026-10-30'), item('Mon', '2026-11-02'), item('NextFri', '2026-11-06'), item('Sat2', '2026-11-07')], new Date(2026, 9, 29, 21));
    expect(b['This week']!.map((c) => c.associateName)).toEqual(['Fri']);
    expect(b['Next week']!.map((c) => c.associateName)).toEqual(['Mon', 'NextFri']);
    expect(b['This month']!.map((c) => c.associateName)).toEqual(['Sat2']);
  });
});
