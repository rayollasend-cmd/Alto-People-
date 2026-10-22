import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { LANGS, loadLanguagePack } from '@/lib/i18n';

// Every language but English is a lazy pack in the app; load them all up front
// so t() answers synchronously in every test, as it did when they were inline.
await Promise.all(LANGS.map((l) => loadLanguagePack(l)));

// jsdom is reused across tests; explicit cleanup prevents leakage.
afterEach(() => cleanup());

// jsdom has no matchMedia. Breakpoint-gated components (the perf fix that
// mounts only the desktop OR mobile variant of big lists) call it at
// render, so stub it as "desktop": min-width queries match, others don't.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: /min-width/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom has no scrollIntoView. Pages that scroll a section into view on the
// next animation frame (Settings' folds) otherwise throw after the test that
// opened them has finished, and the run fails on an unhandled error.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}

// Node 25 ships its own `localStorage` global — an empty object with no
// methods unless node runs with --localstorage-file — and it shadows
// jsdom's. Code under test then threw "localStorage.clear is not a
// function" (and every setItem was a silent no-op). Put jsdom's real,
// origin-scoped Storage back.
{
  const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
  const real = dom?.window.localStorage;
  if (real && typeof globalThis.localStorage?.clear !== 'function') {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      enumerable: true,
      get: () => real,
    });
  }
}
