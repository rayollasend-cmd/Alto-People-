import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/auth', async () => {
  const React = await import('react');
  const auth = { user: { id: 'u1', role: 'OPERATIONS_MANAGER', email: 'ops@altohr.com' }, can: () => true };
  return { AuthContext: React.createContext(auth), useAuth: () => auth, useTerm: () => (k: string) => (k === 'site' ? 'Store' : k), useTenant: () => ({ modules: {}, terminology: {} }) };
});
vi.mock('@/lib/opsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/opsApi')>()),
  getOpsBoard: vi.fn(),
  getOpsFeed: vi.fn(),
  getOpsInsights: vi.fn(),
  getOpsScorecard: vi.fn(),
  getOpsStores: vi.fn(),
}));

import { getOpsBoard, getOpsFeed, getOpsInsights, getOpsScorecard, getOpsStores } from '@/lib/opsApi';
import { OpsBoard } from '@/pages/ops/OpsBoard';
import { ConfirmProvider } from '@/lib/confirm';

/**
 * F500 G2 — a quiet board: one line that says when the floor wakes up
 * (instead of three big empty cards), one line instead of three empty
 * charts, and an SOP trend that only plots the last 7 store days.
 */

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/ops?tab=board']}>
        <ConfirmProvider>
          <OpsBoard />
        </ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const inFive = new Date(Date.now() + 5 * 3_600_000).toISOString();

function mockQuiet(overrides: { sopTrend?: { dateKey: string; pct: number | null }[]; nextShift?: unknown } = {}) {
  vi.mocked(getOpsBoard).mockResolvedValue({
    dateKey: '2026-10-22',
    timezone: 'America/Chicago',
    generatedAt: new Date().toISOString(),
    active: [],
    closedToday: [],
    neverClosed: [],
    nextShift:
      overrides.nextShift === undefined
        ? { startsAt: inFive, position: 'Overnight stocker', store: 'Front Beach 218' }
        : (overrides.nextShift as never),
  });
  vi.mocked(getOpsFeed).mockResolvedValue({ generatedAt: '', hours: 36, events: [], photos: [] } as never);
  vi.mocked(getOpsInsights).mockResolvedValue({
    stores: [],
    tempSeries: [],
    hourly: [{ hour: '1 PM', count: 0 }],
    sopTrend: overrides.sopTrend ?? [],
    production: { readings: 0, units: 0 },
    metrics: [],
  } as never);
  vi.mocked(getOpsScorecard).mockResolvedValue(null as never);
  vi.mocked(getOpsStores).mockResolvedValue({ stores: [], unplaced: 0 });
}

describe('the quiet ops board', () => {
  it('collapses Live now, the photos and Closed today into one line naming the next shift', async () => {
    mockQuiet();
    renderBoard();
    const line = await screen.findByTestId('ops-quiet-line');
    expect(line).toHaveTextContent('Nothing running right now');
    expect(line).toHaveTextContent(/next shift opens .*\(in 5h\) — Overnight stocker at Front Beach 218/);
    expect(line).toHaveTextContent('nothing closed yet today');
    expect(screen.queryByText('Live now')).not.toBeInTheDocument();
    expect(screen.queryByText('Closed today')).not.toBeInTheDocument();
    expect(screen.queryByText('No photos yet')).not.toBeInTheDocument();
  });

  it('says so when nothing is scheduled in the next 24 hours', async () => {
    mockQuiet({ nextShift: null });
    renderBoard();
    expect(await screen.findByTestId('ops-quiet-line')).toHaveTextContent('no shift scheduled in the next 24 hours');
  });

  it('shows one line for three empty charts — and a closed shift that opened a month ago is outside "last 7 days"', async () => {
    mockQuiet({ sopTrend: [{ dateKey: '2026-09-18', pct: 60 }] });
    renderBoard();
    expect(await screen.findByTestId('ops-charts-empty')).toHaveTextContent(
      'No temperature readings or checklist completions in the last 24 hours, and no shifts closed in the last 7 days.',
    );
    expect(screen.queryByText(/Floor rhythm/)).not.toBeInTheDocument();
  });

  it('draws the SOP chart when a closed shift falls inside the window, and the rhythm card says it is empty in words', async () => {
    mockQuiet({ sopTrend: [{ dateKey: '2026-09-18', pct: 60 }, { dateKey: '2026-10-20', pct: 80 }] });
    renderBoard();
    const title = await screen.findByText(/SOP compliance — last 7 days/);
    const card = title.closest('.group\\/card, [class*="rounded"]') as HTMLElement;
    expect(within(card).queryByText('No shifts closed in the last 7 days.')).not.toBeInTheDocument();
    expect(screen.getByText('No checklist tasks completed in the last 24 hours.')).toBeInTheDocument();
    expect(screen.queryByTestId('ops-charts-empty')).not.toBeInTheDocument();
  });
});
