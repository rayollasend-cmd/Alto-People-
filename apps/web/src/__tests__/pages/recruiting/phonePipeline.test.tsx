import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Candidate, CandidateStage } from '@alto-people/shared';
import { CandidateBoard } from '@/pages/recruiting/CandidateBoard';
import { offerShownStatus } from '@/pages/recruiting/recruitingLabels';

/**
 * PEOPLE-18 — the pipeline on a phone. Seven columns side by side showed
 * only Applied at 390px, the rest off-screen with no cue. A phone gets a
 * stage switcher with counts above one full-width list, and cards with
 * one-tap Call, Text and Move.
 */

const STAGES: CandidateStage[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'WITHDRAWN', 'REJECTED'];
const base = {
  email: 'x@example.com', phone: null, position: 'Cashier', source: 'indeed', notes: null, resumeUrl: null, linkedinUrl: null,
  hiredAssociateId: null, hiredClientId: null, hiredAt: null, rejectedReason: null, withdrawnReason: null,
  stageChangedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), jobPostingId: null, createdAt: '2026-09-30T12:00:00.000Z',
};
const cand = (id: string, firstName: string, stage: CandidateStage, phone: string | null = null): Candidate =>
  ({ ...base, id, firstName, lastName: 'Test', stage, phone }) as Candidate;

const columns = (cands: Candidate[]) =>
  STAGES.map((stage) => {
    const c = cands.filter((x) => x.stage === stage);
    return { stage, total: stage === 'APPLIED' ? c.length + 30 : c.length, candidates: c };
  });

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  // A phone: no min-width query matches.
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

function renderBoard(cands: Candidate[], extra: Partial<Parameters<typeof CandidateBoard>[0]> = {}) {
  const props = {
    columns: columns(cands),
    pendingId: null,
    canManage: true,
    onMove: vi.fn(),
    onOpen: vi.fn(),
    onLoadMore: vi.fn(),
    loadingMore: null,
    onSeeAll: vi.fn(),
    ...extra,
  };
  render(<CandidateBoard {...props} />);
  return { props, user: userEvent.setup() };
}

describe('the phone pipeline (PEOPLE-18)', () => {
  it('puts every stage one tap away, with its count, above one list', async () => {
    const { user, props } = renderBoard([cand('a1', 'Ana', 'APPLIED', '(305) 555-0101'), cand('o1', 'Omar', 'OFFER')]);
    expect(screen.getByTestId('phone-pipeline')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Applied31', 'Screening0', 'Interview0', 'Offer1', 'Hired0', 'Rejected0', 'Withdrawn0']);
    expect(screen.getByRole('tab', { name: /Applied/ })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Ana Test')).toBeInTheDocument();
    expect(within(panel).queryByText('Omar Test')).toBeNull();
    // The rest of the column is a tap away, from the server.
    await user.click(within(panel).getByRole('button', { name: 'Show more (30 left)' }));
    expect(props.onLoadMore).toHaveBeenCalledWith('APPLIED');

    await user.click(screen.getByRole('tab', { name: /Offer/ }));
    expect(within(screen.getByRole('tabpanel')).getByText('Omar Test')).toBeInTheDocument();
  });

  it('calls, texts and moves from the card, and opens the candidate on a tap', async () => {
    const { user, props } = renderBoard([cand('a1', 'Ana', 'APPLIED', '(305) 555-0101')]);
    expect(screen.getByRole('link', { name: 'Call Ana Test' })).toHaveAttribute('href', 'tel:+13055550101');
    expect(screen.getByRole('link', { name: 'Text Ana Test' })).toHaveAttribute('href', 'sms:+13055550101');
    await user.click(screen.getByRole('button', { name: 'Move Ana Test' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Screening' }));
    expect(props.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), 'SCREENING');
    await user.click(screen.getByRole('button', { name: "Open Ana Test's details" }));
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
  });

  it('starts on the first working stage with anyone in it, and says when a stage is empty', async () => {
    const { user } = renderBoard([cand('s1', 'Sam', 'SCREENING')], {});
    // Applied has 30 on the server (see columns()), so it leads.
    expect(screen.getByRole('tab', { name: /Applied/ })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: /Interview/ }));
    expect(screen.getByText('No one in Interview right now.')).toBeInTheDocument();
  });
});

describe('offerShownStatus (PEOPLE-13)', () => {
  it('reads a sent offer past its expiry as expired, and leaves the rest alone', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(offerShownStatus({ status: 'SENT', expiresAt: '2026-10-26T12:00:00Z' }, now)).toBe('EXPIRED');
    expect(offerShownStatus({ status: 'SENT', expiresAt: '2026-11-02T12:00:00Z' }, now)).toBe('SENT');
    expect(offerShownStatus({ status: 'SENT', expiresAt: null }, now)).toBe('SENT');
    expect(offerShownStatus({ status: 'ACCEPTED', expiresAt: '2026-10-26T12:00:00Z' }, now)).toBe('ACCEPTED');
  });
});

describe('a desk too narrow for the columns (1024 with the sidebar open)', () => {
  it('gets the stage switcher rather than a board cut off at Offer', () => {
    window.matchMedia = realMatchMedia; // a desktop: min-width queries match
    const RealRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        this.cb([{ contentRect: { width: 700 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
        void el;
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      renderBoard([cand('a1', 'Ana', 'APPLIED')]);
      expect(screen.getByTestId('phone-pipeline')).toBeInTheDocument();
    } finally {
      globalThis.ResizeObserver = RealRO;
    }
  });
});
