import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExecOverview } from '@alto-people/shared';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

import { apiFetch } from '@/lib/api';
import { ymdLocal } from '@/lib/format';
import { ExecBoardPacksPage } from '@/pages/executive/BoardPacksPage';
import { boardPackFileName } from '@/pages/executive/packs/useBoardPackDownload';
import { COMPARISON, PERIOD, renderAsChairman, routeApi } from './execPagesHarness';

/**
 * The chairman's Board packs page: the period bar picks the pack, one
 * button fetches it (busy while it is made) and saves it under a name that
 * says the period and the day; what is inside, and how the Saturday
 * digest delivers it.
 */

const OVERVIEW = { period: PERIOD, comparison: COMPARISON, scorecard: [], changes: [], plan: { quarter: '2026-Q4', set: false }, notes: [] } as unknown as ExecOverview;

let saved: string[] = [];
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/overview': OVERVIEW }) as never);
  toasts.error.mockReset();
  saved = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:pack'), revokeObjectURL: vi.fn() });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the Board packs page', () => {
  it('names the pack the period bar chose and lists the seven pages and the Saturday delivery', async () => {
    renderAsChairman(<ExecBoardPacksPage />, { route: '/executive/board-packs' });
    const hero = await screen.findByTestId('exec-pack-hero');
    // Before the scorecard answers it names the frame in words; then the exact period.
    await waitFor(() => expect(hero).toHaveTextContent('Q4 to date · vs Q3, same days'));
    const inside = screen.getByTestId('exec-pack-contents');
    for (const page of ['Cover', 'Scorecard', 'Financials', 'Clients', 'Workforce', 'Risk register', 'Appendix']) expect(inside).toHaveTextContent(page);
    expect(screen.getByTestId('exec-pack-delivery')).toHaveTextContent('Every Saturday, after 8 AM Eastern.');
    expect(screen.getByText(/Figures marked est\. are estimates/)).toBeInTheDocument();
  });

  it('downloads the pack for the frame in the URL, busy until it is in hand', async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    vi.stubGlobal('fetch', fetchMock);
    renderAsChairman(<ExecBoardPacksPage />, { route: '/executive/board-packs?period=month&compare=plan' });
    const button = await screen.findByTestId('exec-pack-download');
    await userEvent.click(button);

    expect(fetchMock).toHaveBeenCalledWith('/api/executive/board-pack.pdf?period=month&compare=plan', { credentials: 'include' });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Preparing the pack…');

    resolve(new Response(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), { status: 200 }));
    await waitFor(() => expect(saved).toEqual([`board-pack-month-${ymdLocal()}.pdf`]));
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveTextContent('Download board pack');
  });

  it('asks for the default frame on a clean URL', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(new Blob(['%PDF']), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderAsChairman(<ExecBoardPacksPage />, { route: '/executive/board-packs' });
    await userEvent.click(await screen.findByTestId('exec-pack-download'));
    expect(fetchMock).toHaveBeenCalledWith('/api/executive/board-pack.pdf?period=quarter&compare=prior', { credentials: 'include' });
  });

  it('says so when the pack cannot be made, and saves nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))));
    renderAsChairman(<ExecBoardPacksPage />, { route: '/executive/board-packs' });
    await userEvent.click(await screen.findByTestId('exec-pack-download'));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Couldn’t make the board pack. Try again in a moment.'));
    expect(saved).toEqual([]);
  });

  it('names the file for the period and the day', () => {
    expect(boardPackFileName('year', new Date(2026, 9, 27, 9))).toBe('board-pack-year-2026-10-27.pdf');
  });

  it('a hotel’s pack has no Clients page and no client words', async () => {
    const { container } = renderAsChairman(<ExecBoardPacksPage />, { route: '/executive/board-packs', off: ['clientPortal', 'billRates'] });
    const inside = await screen.findByTestId('exec-pack-contents');
    expect(within(inside).getAllByRole('listitem')).toHaveLength(6);
    expect(inside).not.toHaveTextContent('Clients');
    expect(screen.getByTestId('exec-pack-hero')).toHaveTextContent('6 pages, made fresh when you download it.');
    expect(container.textContent).not.toMatch(/\bclients?\b/i);
  });
});
