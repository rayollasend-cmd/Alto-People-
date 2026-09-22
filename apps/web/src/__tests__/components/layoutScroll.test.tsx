import { describe, expect, it } from 'vitest';

/**
 * A tab bar that forgets where you were is not a tab bar.
 *
 * Layout keeps two scroll stores. The original is keyed by history entry
 * and restores on POP, which covers Back and Forward. A bottom tab is a
 * <Link>, so tapping one is a PUSH with a fresh key — and every PUSH reset
 * to the top. Scroll halfway down Schedule, glance at Pay, tap Schedule:
 * back to the first row.
 *
 * The rule that fixes it has one subtlety worth pinning, which is WHICH
 * pushes get restored. Only section roots — the destinations the tab bar
 * and sidebar actually navigate to. A push into a detail screen is new
 * reading and still opens at the top, or every drill-down would land you
 * mid-page for no reason.
 *
 * Exercised through the decision function Layout itself calls — imported,
 * not copied, so the test cannot drift from the component. Mounting the
 * whole shell would drag in the live SSE channel, the command palette,
 * auth and a router, none of which participates in the rule.
 */

import { isSectionRoot, scrollTargetFor as scrollTarget } from '@/components/Layout';

describe('which navigations keep your place', () => {
  it('restores a section you are coming back to, even though it is a PUSH', () => {
    const seen = new Map([['/scheduling', 820]]);
    expect(
      scrollTarget({
        navigationType: 'PUSH',
        pathname: '/scheduling',
        sectionScroll: seen,
        keyScroll: undefined,
      }),
    ).toBe(820);
  });

  it('opens a detail screen at the top, even one pushed from a remembered section', () => {
    // /rides is remembered; /rides/42 is a different thing to read.
    const seen = new Map([['/rides', 400]]);
    expect(
      scrollTarget({
        navigationType: 'PUSH',
        pathname: '/rides/42',
        sectionScroll: seen,
        keyScroll: undefined,
      }),
    ).toBe(0);
  });

  it('opens a section never visited at the top', () => {
    expect(
      scrollTarget({
        navigationType: 'PUSH',
        pathname: '/payroll',
        sectionScroll: new Map(),
        keyScroll: undefined,
      }),
    ).toBe(0);
  });

  it('still lets Back restore the exact entry, not the section', () => {
    // The two stores can disagree: you were at 600 in THIS entry of
    // /people and at 90 the last time you left the section. Back means
    // this entry.
    const seen = new Map([['/people', 90]]);
    expect(
      scrollTarget({
        navigationType: 'POP',
        pathname: '/people',
        sectionScroll: seen,
        keyScroll: 600,
      }),
    ).toBe(600);
  });

  it('treats the dashboard root as a detail, not a section', () => {
    // "/" has no segments. Restoring it on every push would fight the
    // dashboard's own "start at the top" reading.
    expect(isSectionRoot('/')).toBe(false);
    expect(
      scrollTarget({
        navigationType: 'PUSH',
        pathname: '/',
        sectionScroll: new Map([['/', 300]]),
        keyScroll: undefined,
      }),
    ).toBe(0);
  });

  it('knows a section root from a drill-down', () => {
    expect(isSectionRoot('/rides')).toBe(true);
    expect(isSectionRoot('/transport')).toBe(true);
    expect(isSectionRoot('/rides/42')).toBe(false);
    expect(isSectionRoot('/payroll/compliance')).toBe(false);
  });
});
