import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { PageTitleProvider, useHeroHidden, usePageTitle } from '@/lib/pageTitle';
import { PageHeader } from '@/components/ui/PageHeader';

/**
 * One title at a time. While the page's own <h1> is on screen the chrome
 * stays quiet; the moment it scrolls away the compact title takes over —
 * the iOS large-title handoff. Showing both at once is what made every
 * page read as a web page inside an app frame.
 */

let observed: Array<{ el: Element; fire: (isIntersecting: boolean) => void }> = [];

class FakeIO {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    observed.push({
      el,
      fire: (isIntersecting: boolean) =>
        this.cb([{ isIntersecting, target: el } as IntersectionObserverEntry], this as never),
    });
  }
  disconnect() {
    observed = [];
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

// Stands in for the topbar: shows the page name only once the hero is gone.
function Chrome() {
  const title = usePageTitle();
  const heroHidden = useHeroHidden();
  return <div data-testid="chrome">{heroHidden ? (title ?? 'Alto People') : ''}</div>;
}

beforeEach(() => {
  observed = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the page title hands off to the chrome', () => {
  it('keeps the chrome quiet while the page’s own heading is on screen', () => {
    render(
      <PageTitleProvider>
        <Chrome />
        <PageHeader title="People directory" subtitle="Everyone Alto HR knows about." />
      </PageTitleProvider>,
    );

    // The hero is showing — the name belongs to the h1, not the bar.
    act(() => observed.forEach((o) => o.fire(true)));
    expect(screen.getByTestId('chrome')).toHaveTextContent('');
    expect(screen.getByRole('heading', { name: 'People directory' })).toBeInTheDocument();
  });

  it('takes the name up once the heading scrolls away', () => {
    render(
      <PageTitleProvider>
        <Chrome />
        <PageHeader title="People directory" subtitle="Everyone Alto HR knows about." />
      </PageTitleProvider>,
    );

    act(() => observed.forEach((o) => o.fire(true)));
    act(() => observed.forEach((o) => o.fire(false)));
    expect(screen.getByTestId('chrome')).toHaveTextContent('People directory');
  });

  it('observes the heading itself, so the handoff tracks what the user sees', () => {
    render(
      <PageTitleProvider>
        <PageHeader title="Scheduling" />
      </PageTitleProvider>,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]!.el.tagName).toBe('H1');
    expect(observed[0]!.el).toHaveTextContent('Scheduling');
  });

  it('a page with no hero of its own keeps its name in the chrome', () => {
    render(
      <PageTitleProvider>
        <Chrome />
      </PageTitleProvider>,
    );
    // Nothing published, nothing observed — the wordmark stands.
    expect(screen.getByTestId('chrome')).toHaveTextContent('Alto People');
  });
});
