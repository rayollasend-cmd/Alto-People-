import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import {
  urlBoolean,
  urlDay,
  urlList,
  urlNumber,
  useUrlFilters,
  useUrlParam,
  useUrlState,
  useUrlWriter,
} from '@/lib/useUrlState';

/**
 * View state in the URL (criterion 11): a default is never written, a value
 * the page doesn't know reads as the default, filters replace and tabs push,
 * the rest of the URL is kept, and two writes in one tick compose. Run under
 * a data router (createMemoryRouter + RouterProvider), the kind the app
 * uses, whose navigations land a beat after the call.
 */

const STATUSES = ['all', 'open', 'closed'] as const;
const TABS = ['overview', 'people', 'pay'] as const;
const DAYS = urlNumber({ min: 1, max: 365, integer: true });

function Page() {
  const [status, setStatus] = useUrlParam('status', 'all', STATUSES);
  const [tab, setTab] = useUrlParam('tab', 'overview', TABS, { history: 'push' });
  const [days, setDays] = useUrlState('days', 30, DAYS);
  const loc = useLocation();
  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="tab">{tab}</p>
      <p data-testid="days">{days}</p>
      <p data-testid="search">{loc.search}</p>
      <p data-testid="hash">{loc.hash}</p>
      <p data-testid="state">{JSON.stringify(loc.state)}</p>
      <button type="button" onClick={() => setStatus('open')}>open</button>
      <button type="button" onClick={() => setStatus('all')}>all</button>
      <button type="button" onClick={() => setTab('people')}>people tab</button>
      <button type="button" onClick={() => setTab('pay')}>pay tab</button>
      <button type="button" onClick={() => setDays(7)}>week</button>
      <button
        type="button"
        onClick={() => {
          // Two params from two hooks in one handler: both must land.
          setStatus('closed');
          setDays(90);
        }}
      >
        both
      </button>
      <button
        type="button"
        onClick={() => {
          setDays((d) => d + 1);
          setDays((d) => d + 1);
        }}
      >
        plus two
      </button>
    </div>
  );
}

function setup(url = '/list', state?: unknown) {
  const router = createMemoryRouter([{ path: '/list', element: <Page /> }, { path: '/elsewhere', element: <p>elsewhere</p> }], {
    initialEntries: [state ? { pathname: url.split('?')[0]!, search: url.includes('?') ? `?${url.split('?')[1]!.split('#')[0]}` : '', hash: url.includes('#') ? `#${url.split('#')[1]}` : '', state } : url],
  });
  render(<RouterProvider router={router} />);
  return router;
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe('useUrlParam / useUrlState', () => {
  it('reads the default from a clean URL and never writes a default back', async () => {
    const router = setup();
    expect(text('status')).toBe('all');
    expect(text('days')).toBe('30');
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(router.state.location.search).toBe('?status=open');
    expect(text('status')).toBe('open');
    await userEvent.click(screen.getByRole('button', { name: 'all' }));
    // Back to the default: the param goes, the URL is clean.
    expect(router.state.location.search).toBe('');
  });

  it('a value it does not know reads as the default, and reading rewrites nothing', () => {
    const router = setup('/list?status=bogus&days=9999&tab=nope');
    expect(text('status')).toBe('all');
    expect(text('days')).toBe('30');
    expect(text('tab')).toBe('overview');
    expect(router.state.location.search).toBe('?status=bogus&days=9999&tab=nope');
  });

  it('survives a reload: a fresh router on the same URL shows the same view', async () => {
    const first = setup();
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    await userEvent.click(screen.getByRole('button', { name: 'week' }));
    const url = `${first.state.location.pathname}${first.state.location.search}`;
    document.body.innerHTML = '';
    setup(url);
    expect(text('status')).toBe('open');
    expect(text('days')).toBe('7');
  });

  it('filters replace the history entry; tabs push one, so Back returns to the last tab', async () => {
    const router = setup();
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(router.state.historyAction).toBe('REPLACE');
    await userEvent.click(screen.getByRole('button', { name: 'people tab' }));
    expect(router.state.historyAction).toBe('PUSH');
    await userEvent.click(screen.getByRole('button', { name: 'pay tab' }));
    expect(text('tab')).toBe('pay');
    await act(async () => {
      await router.navigate(-1);
    });
    expect(text('tab')).toBe('people');
    // The filter rode along on the same entries.
    expect(text('status')).toBe('open');
  });

  it('two writes in one tick both land — from two hooks, and from two updaters', async () => {
    const router = setup();
    await userEvent.click(screen.getByRole('button', { name: 'both' }));
    expect(new URLSearchParams(router.state.location.search).get('status')).toBe('closed');
    expect(new URLSearchParams(router.state.location.search).get('days')).toBe('90');
    await userEvent.click(screen.getByRole('button', { name: 'plus two' }));
    expect(text('days')).toBe('92');
  });

  it('keeps the rest of the URL: other params, the #hash and the history state', async () => {
    const router = setup('/list?client=c1#notes', { from: '/inbox' });
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(router.state.location.search).toBe('?client=c1&status=open');
    expect(text('hash')).toBe('#notes');
    expect(text('state')).toBe(JSON.stringify({ from: '/inbox' }));
  });

  it('after the router catches up, a Back press is not overridden by an old write', async () => {
    const router = setup();
    await userEvent.click(screen.getByRole('button', { name: 'people tab' }));
    await act(async () => {
      await router.navigate(-1);
    });
    expect(text('tab')).toBe('overview');
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    // Built on the URL Back left, not on the tab the earlier write went to.
    expect(router.state.location.search).toBe('?status=open');
  });
});

describe('codecs', () => {
  it('numbers keep to their bounds and integers', () => {
    expect(DAYS.parse('7')).toBe(7);
    expect(DAYS.parse('0')).toBeUndefined();
    expect(DAYS.parse('366')).toBeUndefined();
    expect(DAYS.parse('7.5')).toBeUndefined();
    expect(DAYS.parse('')).toBeUndefined();
    expect(DAYS.parse('abc')).toBeUndefined();
  });

  it('booleans read 1/0 and true/false, and write 1/0', () => {
    expect(urlBoolean.parse('1')).toBe(true);
    expect(urlBoolean.parse('false')).toBe(false);
    expect(urlBoolean.parse('yes')).toBeUndefined();
    expect(urlBoolean.serialize(true)).toBe('1');
  });

  it('a day must be a real calendar day', () => {
    expect(urlDay.parse('2026-10-22')).toBe('2026-10-22');
    expect(urlDay.parse('2026-02-30')).toBeUndefined();
    expect(urlDay.parse('10/22/2026')).toBeUndefined();
  });

  it('a list drops unknown and repeated items, and an empty list removes the param', () => {
    const codec = urlList(['open', 'late', 'paid'] as const);
    expect(codec.parse('open,bogus,late,open')).toEqual(['open', 'late']);
    expect(codec.serialize([])).toBeNull();
    expect(codec.serialize(['late', 'paid'])).toBe('late,paid');
  });
});

describe('useUrlFilters and useUrlWriter', () => {
  function Filters() {
    const { active, clear } = useUrlFilters(['status', 'site']);
    const write = useUrlWriter();
    const loc = useLocation();
    return (
      <div>
        <p data-testid="active">{active}</p>
        <p data-testid="search">{loc.search}</p>
        <button type="button" onClick={clear}>clear</button>
        <button type="button" onClick={() => write((p) => p.set('site', 's2'))}>site</button>
      </div>
    );
  }

  it('counts the filters in use and clears them all in one step, leaving everything else', async () => {
    const router = createMemoryRouter([{ path: '/list', element: <Filters /> }], { initialEntries: ['/list?status=open&q=ana'] });
    render(<RouterProvider router={router} />);
    expect(text('active')).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: 'site' }));
    expect(text('active')).toBe('2');
    await userEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(router.state.location.search).toBe('?q=ana');
    expect(text('active')).toBe('0');
  });
});
