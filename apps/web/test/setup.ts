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
