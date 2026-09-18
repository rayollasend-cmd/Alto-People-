import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

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
