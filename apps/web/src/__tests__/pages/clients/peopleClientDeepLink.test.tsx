import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * A client's "On assignment" tile links to /people?client=<id>&status=ACTIVE:
 * the directory opens filtered to that client's active people.
 */

const CLIENT = '00000000-0000-4000-8000-00000000c1a0';
const paths: string[] = [];
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (path: string) => {
      paths.push(path);
      if (path.split('?')[0] === '/people/directory') return { associates: [], nextCursor: null };
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});

import { PeopleDirectory } from '@/pages/people/PeopleDirectory';

afterEach(() => {
  window.history.replaceState({}, '', '/');
  try {
    window.localStorage.clear();
  } catch {
    // storage may be unavailable; nothing to clear
  }
});

describe('People directory — ?client= deep link', () => {
  it('filters the directory to the client and its active people', async () => {
    window.history.replaceState({}, '', `/people?client=${CLIENT}&status=ACTIVE`);
    renderAs('HR_ADMINISTRATOR', <PeopleDirectory />, `/people?client=${CLIENT}&status=ACTIVE`);
    await waitFor(() => {
      const call = paths.find((p) => p.startsWith('/people/directory') && p.includes(`clientId=${CLIENT}`));
      expect(call).toBeDefined();
      expect(call).toContain('status=ACTIVE');
    });
  });
});
